/* endpoint.c — reference decision endpoint.
 *
 * Mirrors the Windows dynobox demo endpoint: answers ask requests
 * (protocol v2) with a fixed demo table and can issue subtree grants.
 * Transports: HTTP (TCP) and unix stream socket (same JSON body; the unix
 * transport is length-prefixed like the Windows named-pipe framing).
 *
 * Demo table (first match wins):
 *   notes     "/notes/..."   read  -> allow + grant (notes read)
 *   scratch   "/scratch/..." all   -> allow + grant (scratch all)
 *   staging   "/staging/..." write -> allow + grant (staging write)
 *   reject    "/reject/..."  any   -> deny
 *   guarded   "/guarded/..." any   -> allow, no grants (every path asks)
 *   slow      "/slow/..."    any   -> sleep 8s, then allow (demonstrates the
 *                                     fail-closed timeout on the sandbox side)
 *   anything else            -> --default (deny unless configured allow)
 */
#define _GNU_SOURCE
#include "endpoint.h"
#include "dynobox.h"
#include "ask.h"
#include "util.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>

static volatile sig_atomic_t g_stop = 0;
static void on_signal(int sig) { (void)sig; g_stop = 1; }

#define AUDIT_MAX 512
static char *g_audit[AUDIT_MAX];
static int g_audit_n;
static pthread_mutex_t g_audit_mu = PTHREAD_MUTEX_INITIALIZER;
static FILE *g_audit_file;

static void audit_add(const char *line)
{
    pthread_mutex_lock(&g_audit_mu);
    if (g_audit_n == AUDIT_MAX) {
        dbox_free(g_audit[0]);
        memmove(g_audit, g_audit + 1, sizeof(char *) * (AUDIT_MAX - 1));
        g_audit_n--;
    }
    g_audit[g_audit_n++] = dbox_strdup(line);
    if (g_audit_file) {
        fprintf(g_audit_file, "%s\n", line);
        fflush(g_audit_file);
    }
    pthread_mutex_unlock(&g_audit_mu);
}

/* demo table entry */
typedef struct {
    const char *pat;
    int acc;        /* access the rule applies to (ACC_*), 0 = any */
    int allow;      /* 1 allow, 0 deny */
    const char *grant_pat;   /* optional subtree grant */
    int grant_acc;
} demo_t;

static const demo_t k_demo[] = {
    { "/**/slow/**",    0,        1,    NULL,         0        },
    { "/**/reject/**",  0,        0,    NULL,         0        },
    { "/**/notes/**",   ACC_READ, 1,    "/**/notes/**",  ACC_READ },
    { "/**/scratch/**", 0,        1,    "/**/scratch/**", ACC_ALL  },
    { "/**/staging/**", ACC_WRITE, 1,   "/**/staging/**", ACC_WRITE },
    { "/**/guarded/**", 0,        1,    NULL,         0        },
    { "/**/tools/ask/**", ACC_EXEC, 1,  NULL,         0        },
    { NULL, 0, 0, NULL, 0 }
};

static void resp_grant(char *out, size_t outsz, const char *pat, int acc,
                       long ttl)
{
    snprintf(out, outsz,
             "{\"decision\":\"allow\","
             "\"grants\":[{\"path\":\"%s\",\"access\":\"%s\",\"ttl\":%ld}]}",
             pat, dbox_access_name(acc), ttl);
}

static int g_default_allow = 0;   /* --default allow or deny */
static long g_grant_ttl = 300;    /* ttl (s) used in demo grant responses */

static void handle_decide(const char *body, char *resp, size_t rsz)
{
    char vpath[2048] = "";
    char access[32] = "";
    /* escape-aware extraction via the shared protocol parser (handles
     * quotes and other escapes inside filenames) */
    dbox_json_get_string(body, "path", vpath, sizeof vpath);
    dbox_json_get_string(body, "access", access, sizeof access);
    int acc = ACC_ALL;
    if (dbox_str_ieq(access, "read")) acc = ACC_READ;
    else if (dbox_str_ieq(access, "write")) acc = ACC_WRITE;
    else if (dbox_str_ieq(access, "execute")) acc = ACC_EXEC;

    int allow = -1;
    const char *grant_pat = NULL;
    int grant_acc = 0;
    for (int i = 0; k_demo[i].pat; i++) {
        if (k_demo[i].acc && !(k_demo[i].acc & acc)) continue;
        if (!dbox_glob_match(k_demo[i].pat, vpath)) continue;
        allow = k_demo[i].allow;
        grant_pat = k_demo[i].grant_pat;
        grant_acc = k_demo[i].grant_acc;
        break;
    }
    if (allow < 0) allow = g_default_allow;


    char line[2300];
    if (allow == 1) {
        if (grant_pat) resp_grant(resp, rsz, grant_pat, grant_acc, g_grant_ttl);
        else snprintf(resp, rsz, "{\"decision\":\"allow\"}");
        /* slow demo: force a timeout on the sandbox side */
        if (dbox_glob_match("/**/slow/**", vpath)) {
            struct timespec ts = { 8, 0 };
            nanosleep(&ts, NULL);
        }
    } else {
        snprintf(resp, rsz, "{\"decision\":\"deny\"}");
    }
    snprintf(line, sizeof line, "decide path=%s access=%s -> %s",
             vpath, access, allow ? "allow" : "deny");
    audit_add(line);
}

static void audit_log_text(char *out, size_t outsz)
{
    size_t o = 0;
    pthread_mutex_lock(&g_audit_mu);
    for (int i = 0; i < g_audit_n && o + 2 < outsz; i++) {
        size_t l = strlen(g_audit[i]);
        if (o + l + 2 >= outsz) break;
        memcpy(out + o, g_audit[i], l);
        o += l;
        out[o++] = '\n';
    }
    pthread_mutex_unlock(&g_audit_mu);
    out[o] = '\0';
}

typedef struct {
    int fd;                    /* accepted connection */
    int unix_mode;             /* length-prefixed framing */
    const dbox_endpoint_opts_t *opts;
} conn_t;

static void conn_serve(conn_t *c);
static void *conn_serve_thread(void *arg)
{
    conn_serve((conn_t *)arg);
    return NULL;
}

static void conn_serve(conn_t *c)
{
    char buf[65536];
    size_t got = 0;

    if (c->unix_mode) {
        /* frame: 4-byte LE length + body */
        unsigned char f4[4];
        size_t have = 0;
        while (have < 4 && got < sizeof buf) {
            ssize_t n = recv(c->fd, buf + got, sizeof buf - got, 0);
            if (n <= 0) goto done;
            if (have < 4) {
                size_t take = (size_t)n < 4 - have ? (size_t)n : 4 - have;
                memcpy(f4 + have, buf + got, take);
                have += take;
            }
            got += (size_t)n;
        }
        if (have < 4) goto done;
        size_t blen = f4[0] | (f4[1] << 8) | ((size_t)f4[2] << 16) | ((size_t)f4[3] << 24);
        if (blen >= sizeof buf - 4) goto done;
        while (got < blen + 4) {
            ssize_t n = recv(c->fd, buf + got, blen + 4 - got, 0);
            if (n <= 0) goto done;
            got += (size_t)n;
        }
        buf[4 + blen] = '\0';
        char resp[4096];
        /* the 4-byte length prefix holds NUL bytes: parse past it */
        handle_decide(buf + 4, resp, sizeof resp);
        size_t rl = strlen(resp);
        unsigned char of[4] = {
            (unsigned char)(rl & 0xff), (unsigned char)((rl >> 8) & 0xff),
            (unsigned char)((rl >> 16) & 0xff), (unsigned char)((rl >> 24) & 0xff)
        };
        send(c->fd, of, 4, 0);
        send(c->fd, resp, rl, 0);
        goto done;
    }

    /* HTTP: read headers, then keep reading until the full body arrived */
    while (got < sizeof buf - 1) {
        ssize_t n = recv(c->fd, buf + got, sizeof buf - 1 - got, 0);
        if (n <= 0) goto done;
        got += (size_t)n;
        buf[got] = '\0';
        if (strstr(buf, "\r\n\r\n")) break;
    }
    buf[got] = '\0';
    char method[16] = "", path[512] = "";
    sscanf(buf, "%15s %511s", method, path);
    size_t clen = 0;
    const char *cl = strstr(buf, "Content-Length:");
    if (!cl) cl = strstr(buf, "content-length:");
    if (cl) clen = (size_t)strtoul(cl + 15, NULL, 10);
    const char *hdr_end = strstr(buf, "\r\n\r\n");
    while (hdr_end && got - (size_t)(hdr_end + 4 - buf) < clen &&
           got < sizeof buf - 1) {
        ssize_t n = recv(c->fd, buf + got, sizeof buf - 1 - got, 0);
        if (n <= 0) break;
        got += (size_t)n;
        buf[got] = '\0';
        hdr_end = strstr(buf, "\r\n\r\n");
    }
    const char *body = strstr(buf, "\r\n\r\n");
    body = body ? body + 4 : buf;

    char resp[4096];
    if (strcmp(method, "POST") == 0) {
        handle_decide(body, resp, sizeof resp);
        char out[4600];
        snprintf(out, sizeof out,
                 "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                 "Content-Length: %zu\r\nConnection: close\r\n\r\n%s",
                 strlen(resp), resp);
        send(c->fd, out, strlen(out), 0);
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/log") == 0) {
        char text[16384];
        audit_log_text(text, sizeof text);
        char out[16640];
        snprintf(out, sizeof out,
                 "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
                 "Content-Length: %zu\r\nConnection: close\r\n\r\n%s",
                 strlen(text), text);
        send(c->fd, out, strlen(out), 0);
    } else if (strcmp(method, "GET") == 0) {
        const char *msg = "dynobox decision endpoint\n";
        char out[256];
        snprintf(out, sizeof out,
                 "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
                 "Content-Length: %zu\r\nConnection: close\r\n\r\n%s",
                 strlen(msg), msg);
        send(c->fd, out, strlen(out), 0);
    }
done:
    close(c->fd);
    dbox_free(c);
}

static void *http_accept_loop(void *arg)
{
    int lfd = (int)(intptr_t)arg;
    while (!g_stop) {
        int fd = accept(lfd, NULL, NULL);
        if (fd < 0) { if (errno == EINTR) continue; break; }
        conn_t *c = dbox_malloc(sizeof(conn_t));
        c->fd = fd;
        c->unix_mode = 0;
        pthread_t t;
        pthread_attr_t a;
        pthread_attr_init(&a);
        pthread_attr_setdetachstate(&a, PTHREAD_CREATE_DETACHED);
        pthread_create(&t, &a, conn_serve_thread, c);
        pthread_attr_destroy(&a);
    }
    return NULL;
}

static void *unix_accept_loop(void *arg)
{
    int lfd = (int)(intptr_t)arg;
    while (!g_stop) {
        int fd = accept(lfd, NULL, NULL);
        if (fd < 0) { if (errno == EINTR) continue; break; }
        conn_t *c = dbox_malloc(sizeof(conn_t));
        c->fd = fd;
        c->unix_mode = 1;
        pthread_t t;
        pthread_attr_t a;
        pthread_attr_init(&a);
        pthread_attr_setdetachstate(&a, PTHREAD_CREATE_DETACHED);
        pthread_create(&t, &a, conn_serve_thread, c);
        pthread_attr_destroy(&a);
    }
    return NULL;
}

int dbox_endpoint_serve(const dbox_endpoint_opts_t *opts)
{
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);
    g_default_allow = opts->default_perm == PERM_ALLOW;
    g_grant_ttl = opts->grant_ttl > 0 ? opts->grant_ttl : 300;

    if (opts->log_file) {
        g_audit_file = fopen(opts->log_file, "a");
        if (!g_audit_file) {
            fprintf(stderr, "dynobox endpoint: cannot open log %s\n", opts->log_file);
            return 1;
        }
    }

    pthread_t th_http = 0, th_unix = 0;
    int lfd_http = -1, lfd_unix = -1;

    if (opts->port > 0) {
        lfd_http = socket(AF_INET, SOCK_STREAM, 0);
        if (lfd_http < 0) { perror("socket"); return 1; }
        int one = 1;
        setsockopt(lfd_http, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        struct sockaddr_in sa;
        memset(&sa, 0, sizeof sa);
        sa.sin_family = AF_INET;
        sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        sa.sin_port = htons((uint16_t)opts->port);
        if (bind(lfd_http, (struct sockaddr *)&sa, sizeof sa) != 0) {
            perror("bind");
            return 1;
        }
        if (listen(lfd_http, 64) != 0) { perror("listen"); return 1; }
        fprintf(stderr, "dynobox endpoint: http://127.0.0.1:%d/decide (default %s)\n",
                opts->port, opts->default_perm == PERM_ALLOW ? "allow" : "deny");
        pthread_create(&th_http, NULL, http_accept_loop, (void *)(intptr_t)lfd_http);
    }
    int unix_abstract = opts->unix_path && opts->unix_path[0] == '@';
    if (opts->unix_path && opts->unix_path[0]) {
        if (!unix_abstract) unlink(opts->unix_path);
        lfd_unix = socket(AF_UNIX, SOCK_STREAM, 0);
        if (lfd_unix < 0) { perror("socket(unix)"); return 1; }
        struct sockaddr_un sa;
        memset(&sa, 0, sizeof sa);
        sa.sun_family = AF_UNIX;
        socklen_t unix_len = sizeof sa;
        if (unix_abstract) {
            /* abstract namespace: "@name" -> leading NUL, no filesystem */
            size_t n = strlen(opts->unix_path + 1);
            if (n >= sizeof sa.sun_path - 1) {
                fprintf(stderr, "dynobox endpoint: abstract name too long\n");
                return 1;
            }
            sa.sun_path[0] = '\0';
            memcpy(sa.sun_path + 1, opts->unix_path + 1, n);
            unix_len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + n);
        } else {
            snprintf(sa.sun_path, sizeof sa.sun_path, "%s", opts->unix_path);
        }
        if (bind(lfd_unix, (struct sockaddr *)&sa, unix_len) != 0) {
            perror("bind(unix)");
            return 1;
        }
        if (listen(lfd_unix, 64) != 0) { perror("listen(unix)"); return 1; }
        fprintf(stderr, "dynobox endpoint: unix://%s (default %s)\n",
                opts->unix_path, opts->default_perm == PERM_ALLOW ? "allow" : "deny");
        pthread_create(&th_unix, NULL, unix_accept_loop, (void *)(intptr_t)lfd_unix);
    }
    if (lfd_http < 0 && lfd_unix < 0) {
        fprintf(stderr, "dynobox endpoint: specify --port and/or --unix\n");
        return 1;
    }

    while (!g_stop) pause();

    fprintf(stderr, "\ndynobox endpoint: shutting down\n");
    if (lfd_http >= 0) { shutdown(lfd_http, SHUT_RDWR); close(lfd_http); }
    if (lfd_unix >= 0) {
        shutdown(lfd_unix, SHUT_RDWR);
        close(lfd_unix);
        if (!unix_abstract) unlink(opts->unix_path);
    }
    if (g_audit_file) fclose(g_audit_file);
    return 0;
}
