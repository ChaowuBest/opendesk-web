/* ask.c — upstream decision endpoint client (protocol v2).
 *
 * Used from inside the LD_PRELOAD library: every socket operation below
 * goes through raw syscalls so the ask transport can never recurse into
 * the sandbox's own interposed wrappers.
 *
 * fail-closed: any timeout, connection error, non-200 status or malformed
 * response => deny, and failed decisions are never cached (policy.c).
 */
#define _GNU_SOURCE
#include "ask.h"
#include "policy.h"
#include "pathmap.h"
#include "util.h"
#include "log.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/un.h>
#include <arpa/inet.h>
#include <poll.h>

/* ------------------------------------------------------------------ */
/* raw socket helpers (bypass our own hooks)                           */
/* ------------------------------------------------------------------ */

static int raw_socket(int domain, int type, int proto)
{
    return (int)syscall(SYS_socket, domain, type, proto);
}

static int raw_connect(int fd, const struct sockaddr *sa, socklen_t sl,
                       int timeout_ms)
{
    int fl = (int)syscall(SYS_fcntl, fd, F_GETFL, 0);
    syscall(SYS_fcntl, fd, F_SETFL, fl | O_NONBLOCK);
    int rc = (int)syscall(SYS_connect, fd, sa, sl);
    if (rc != 0 && errno == EINPROGRESS) {
        struct pollfd p = { .fd = fd, .events = POLLOUT };
        for (;;) {
            rc = dbox_raw_poll(&p, 1, timeout_ms);
            if (rc >= 0 || errno != EINTR) break;
        }
        if (rc == 0) { errno = ETIMEDOUT; return -1; }
        if (rc < 0) return -1;
        int err = 0; socklen_t el = sizeof err;
        if (syscall(SYS_getsockopt, fd, SOL_SOCKET, SO_ERROR, &err, &el) < 0) return -1;
        if (err) { errno = err; return -1; }
    } else if (rc != 0) {
        return -1;
    }
    syscall(SYS_fcntl, fd, F_SETFL, fl);
    struct timeval tv = { .tv_sec = timeout_ms / 1000,
                          .tv_usec = (timeout_ms % 1000) * 1000 };
    syscall(SYS_setsockopt, fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    syscall(SYS_setsockopt, fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    return 0;
}

static ssize_t raw_send(int fd, const void *buf, size_t n)
{
    return syscall(SYS_sendto, fd, buf, n, 0, NULL, 0);
}

static ssize_t raw_recv(int fd, void *buf, size_t n)
{
    return syscall(SYS_recvfrom, fd, buf, n, 0, NULL, NULL);
}

/* ------------------------------------------------------------------ */
/* endpoint URL parsing                                                */
/* ------------------------------------------------------------------ */

typedef enum { EP_HTTP, EP_UNIX } ep_kind_t;

typedef struct {
    ep_kind_t kind;
    char host[256];
    char port[16];
    char path[512];      /* http request path, default "/" */
    char unix_path[108]; /* "\0name" for abstract sockets */
    socklen_t unix_len;
} endpoint_t;

static int parse_endpoint(const char *url, endpoint_t *ep)
{
    memset(ep, 0, sizeof *ep);
    if (strncmp(url, "http://", 7) == 0) {
        ep->kind = EP_HTTP;
        const char *h = url + 7;
        const char *slash = strchr(h, '/');
        const char *hostend = slash ? slash : h + strlen(h);
        const char *colon = memchr(h, ':', (size_t)(hostend - h));
        size_t hl = colon ? (size_t)(colon - h) : (size_t)(hostend - h);
        if (hl == 0 || hl >= sizeof ep->host) return -1;
        memcpy(ep->host, h, hl);
        if (colon) {
            size_t pl = (size_t)(hostend - colon - 1);
            if (pl == 0 || pl >= sizeof ep->port) return -1;
            memcpy(ep->port, colon + 1, pl);
        } else {
            strcpy(ep->port, "80");
        }
        if (slash && slash[1]) snprintf(ep->path, sizeof ep->path, "%s", slash);
        else strcpy(ep->path, "/");
        return 0;
    }
    if (strncmp(url, "unix://", 7) == 0 || strncmp(url, "pipe://", 7) == 0) {
        ep->kind = EP_UNIX;
        const char *p = url + 7;
        if (url[0] == 'p') {
            /* Windows named-pipe parity: pipe://NAME -> shared convention path */
            dbox_pipe_path(p, ep->unix_path, sizeof ep->unix_path);
            ep->unix_len = (socklen_t)sizeof(struct sockaddr_un);
            return 0;
        }
        struct sockaddr_un sa;
        memset(&sa, 0, sizeof sa);
        sa.sun_family = AF_UNIX;
        if (p[0] == '@') {
            /* abstract namespace */
            size_t n = strlen(p + 1);
            if (n >= sizeof sa.sun_path - 1) return -1;
            sa.sun_path[0] = '\0';
            memcpy(sa.sun_path + 1, p + 1, n);
            ep->unix_len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + n);
        } else {
            size_t n = strlen(p);
            if (n == 0 || n >= sizeof sa.sun_path) return -1;
            memcpy(sa.sun_path, p, n + 1);
            ep->unix_len = (socklen_t)sizeof sa;
        }
        memcpy(ep->unix_path, sa.sun_path, sizeof sa.sun_path);
        return 0;
    }
    return -1;
}

/* ------------------------------------------------------------------ */
/* JSON helpers (subset: the protocol documents exactly these shapes)  */
/* ------------------------------------------------------------------ */

static void json_escape(const char *in, char *out, size_t outsz)
{
    size_t o = 0;
    for (; *in && o + 8 < outsz; in++) {
        unsigned char c = (unsigned char)*in;
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = (char)c; }
        else if (c == '\n') { out[o++] = '\\'; out[o++] = 'n'; }
        else if (c == '\t') { out[o++] = '\\'; out[o++] = 't'; }
        else if (c < 0x20) { o += (size_t)snprintf(out + o, outsz - o, "\\u%04x", c); }
        else out[o++] = (char)c;
    }
    out[o] = '\0';
}

int dbox_ask_build_request(char *out, size_t outsz, const char *vpath, int acc,
                           const char *token)
{
    char jp[DBOX_PATH_MAX];
    json_escape(vpath, jp, sizeof jp);
    if (token && token[0]) {
        char jt[256];
        json_escape(token, jt, sizeof jt);
        return snprintf(out, outsz,
                        "{\"path\":\"%s\",\"access\":\"%s\",\"token\":\"%s\"}",
                        jp, dbox_access_name(acc & ACC_ALL), jt) < 0 ? -1 : 0;
    }
    return snprintf(out, outsz, "{\"path\":\"%s\",\"access\":\"%s\"}",
                    jp, dbox_access_name(acc & ACC_ALL)) < 0 ? -1 : 0;
}

/* find `"key"` then ':' then a JSON string; returns pointer to the value
 * start and sets *vlen (length without quotes) */
static const char *json_find_string(const char *s, const char *end,
                                    const char *key, size_t *vlen)
{
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = s;
    size_t pl = strlen(pat);
    while (p + pl < end) {
        if (memcmp(p, pat, pl) == 0) {
            const char *q = p + pl;
            while (q < end && (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r')) q++;
            if (q < end && *q == ':') {
                q++;
                while (q < end && (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r')) q++;
                if (q < end && *q == '"') {
                    q++;
                    const char *st = q;
                    while (q < end && *q != '"') { if (*q == '\\' && q + 1 < end) q++; q++; }
                    if (q < end && *q == '"') { if (vlen) *vlen = (size_t)(q - st); return st; }
                }
            }
        }
        p++;
    }
    return NULL;
}

static void json_find_int(const char *s, const char *end,
                          const char *key, long *out)
{
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = s;
    size_t pl = strlen(pat);
    while (p + pl < end) {
        if (memcmp(p, pat, pl) == 0) {
            const char *q = p + pl;
            while (q < end && (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r')) q++;
            if (q < end && *q == ':') {
                q++;
                while (q < end && (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r')) q++;
                if (q < end && (*q == '-' || (*q >= '0' && *q <= '9'))) {
                    *out = strtol(q, NULL, 10);
                    return;
                }
            }
        }
        p++;
    }
}

static void json_unescape(const char *s, size_t n, char *out, size_t outsz)
{
    size_t o = 0;
    for (size_t i = 0; i < n && o + 1 < outsz; i++) {
        if (s[i] == '\\' && i + 1 < n) {
            i++;
            switch (s[i]) {
            case 'n': out[o++] = '\n'; break;
            case 't': out[o++] = '\t'; break;
            case 'r': out[o++] = '\r'; break;
            case '"': out[o++] = '"'; break;
            case '\\': out[o++] = '\\'; break;
            case '/': out[o++] = '/'; break;
            default: out[o++] = s[i]; break;
            }
        } else {
            out[o++] = s[i];
        }
    }
    out[o] = '\0';
}

int dbox_json_get_string(const char *body, const char *key,
                         char *out, size_t outsz)
{
    const char *end = body + strlen(body);
    size_t vl = 0;
    const char *v = json_find_string(body, end, key, &vl);
    if (!v) return 0;
    json_unescape(v, vl > outsz - 1 ? outsz - 1 : vl, out, outsz);
    return 1;
}

int dbox_ask_parse_response(const char *body, dbox_policy_t *p, int64_t now_ms)
{
    const char *end = body + strlen(body);
    size_t dl = 0;
    const char *d = json_find_string(body, end, "decision", &dl);
    if (!d) return 0;
    char decision[32];
    json_unescape(d, dl > sizeof decision - 1 ? sizeof decision - 1 : dl,
                  decision, sizeof decision);
    if (strcmp(decision, "allow") != 0) return 0;

    /* optional grants: [{"path":..,"access":..,"ttl":..}, ...] */
    const char *g = strstr(body, "\"grants\"");
    if (g && g < end) {
        const char *arr = strchr(g, '[');
        const char *arr_end = arr ? strchr(arr, ']') : NULL;
        if (arr && arr_end && arr < arr_end) {
            const char *obj = arr + 1;
            while (obj < arr_end) {
                const char *ob = strchr(obj, '{');
                if (!ob || ob >= arr_end) break;
                const char *oe = strchr(ob, '}');
                if (!oe || oe > arr_end) break;
                size_t pl = 0, al = 0;
                const char *pv = json_find_string(ob, oe, "path", &pl);
                const char *av = json_find_string(ob, oe, "access", &al);
                if (pv && av) {
                    char gp[DBOX_PATH_MAX], ga[32];
                    json_unescape(pv, pl > sizeof gp - 1 ? sizeof gp - 1 : pl, gp, sizeof gp);
                    json_unescape(av, al > sizeof ga - 1 ? sizeof ga - 1 : al, ga, sizeof ga);
                    int acc;
                    if (dbox_str_ieq(ga, "read")) acc = ACC_READ;
                    else if (dbox_str_ieq(ga, "write")) acc = ACC_WRITE;
                    else if (dbox_str_ieq(ga, "execute")) acc = ACC_EXEC;
                    else if (dbox_str_ieq(ga, "all")) acc = ACC_ALL;
                    else acc = ACC_ALL;
                    long ttl = 0;
                    json_find_int(ob, oe, "ttl", &ttl);
                    dbox_grant_add(p, gp, acc, ttl, now_ms);
                }
                obj = oe + 1;
            }
        }
    }
    return 1;
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

#define ASK_IO_BUF 65536

static int ask_roundtrip(const endpoint_t *ep, const char *req,
                         char *resp, size_t rsz, int timeout_ms,
                         const char *token,
                         char *err, size_t errsz)
{
    int fd;
    if (ep->kind == EP_UNIX) {
        fd = raw_socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) { snprintf(err, errsz, "socket: %s", strerror(errno)); return -1; }
        struct sockaddr_un sa;
        memset(&sa, 0, sizeof sa);
        sa.sun_family = AF_UNIX;
        memcpy(sa.sun_path, ep->unix_path, sizeof sa.sun_path);
        if (raw_connect(fd, (struct sockaddr *)&sa, ep->unix_len, timeout_ms) != 0) {
            snprintf(err, errsz, "connect %s: %s",
                     ep->unix_path[0] ? ep->unix_path : "(abstract)",
                     strerror(errno));
            syscall(SYS_close, fd);
            return -1;
        }
    } else {
        struct addrinfo hints;
        struct addrinfo *res = NULL;
        memset(&hints, 0, sizeof hints);
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        int rc = getaddrinfo(ep->host, ep->port, &hints, &res);
        if (rc != 0 || !res) {
            snprintf(err, errsz, "resolve %s: %s", ep->host,
                     rc ? gai_strerror(rc) : "no result");
            return -1;
        }
        fd = raw_socket(res->ai_family, res->ai_socktype, res->ai_protocol);
        if (fd < 0) { snprintf(err, errsz, "socket: %s", strerror(errno)); freeaddrinfo(res); return -1; }
        if (raw_connect(fd, res->ai_addr, res->ai_addrlen, timeout_ms) != 0) {
            snprintf(err, errsz, "connect %s:%s: %s", ep->host, ep->port, strerror(errno));
            freeaddrinfo(res);
            syscall(SYS_close, fd);
            return -1;
        }
        freeaddrinfo(res);
    }

    if (ep->kind == EP_HTTP) {
        char hdr[4096];
        size_t nreq = strlen(req);
        int n = snprintf(hdr, sizeof hdr,
                         "POST %s HTTP/1.1\r\nHost: %s:%s\r\n",
                         ep->path, ep->host, ep->port);
        if (token && token[0])
            n += snprintf(hdr + n, sizeof hdr - n,
                          "Authorization: Bearer %s\r\n", token);
        n += snprintf(hdr + n, sizeof hdr - n,
                      "Content-Type: application/json\r\nContent-Length: %zu\r\n"
                      "Connection: close\r\n\r\n", nreq);
        int ok = n > 0 && (size_t)n < sizeof hdr
                 && raw_send(fd, hdr, (size_t)n) == n
                 && raw_send(fd, req, nreq) == (ssize_t)nreq;
        if (!ok) {
            snprintf(err, errsz, "send: %s", strerror(errno));
            syscall(SYS_close, fd);
            return -1;
        }
    } else {
        /* unix transport carries the same JSON, length-prefixed like the
         * Windows named-pipe protocol: 4-byte little-endian length + body */
        unsigned char frame[4];
        size_t n = strlen(req);
        frame[0] = (unsigned char)(n & 0xff);
        frame[1] = (unsigned char)((n >> 8) & 0xff);
        frame[2] = (unsigned char)((n >> 16) & 0xff);
        frame[3] = (unsigned char)((n >> 24) & 0xff);
        if (raw_send(fd, frame, 4) != 4 || (size_t)raw_send(fd, req, n) != n) {
            snprintf(err, errsz, "send: %s", strerror(errno));
            syscall(SYS_close, fd);
            return -1;
        }
    }

    size_t got = 0;
    for (;;) {
        if (got + 1 >= rsz) break;
        ssize_t n = raw_recv(fd, resp + got, rsz - 1 - got);
        if (n < 0) {
            if (errno == EINTR) continue;
            snprintf(err, errsz, "recv: %s", strerror(errno));
            syscall(SYS_close, fd);
            return -1;
        }
        if (n == 0) break;
        got += (size_t)n;
    }
    syscall(SYS_close, fd);
    resp[got] = '\0';
    if (got == 0) { snprintf(err, errsz, "empty response"); return -1; }

    if (ep->kind == EP_UNIX && got >= 4) {
        /* strip the 4-byte length prefix (which contains NUL bytes) */
        size_t blen = (size_t)resp[0] | ((size_t)resp[1] << 8) |
                      ((size_t)resp[2] << 16) | ((size_t)resp[3] << 24);
        if (blen > got - 4) blen = got - 4;
        memmove(resp, resp + 4, blen);
        resp[blen] = '\0';
    }
    return 0;
}

/* extract body from an HTTP response: skip to CRLFCRLF; return body ptr,
 * NULL when status line is not 200 */
static const char *http_body(const char *resp, const char *resp_end)
{
    const char *p = memchr(resp, '\r', (size_t)(resp_end - resp));
    if (!p) return NULL;
    const char *line_end = p;
    if (strncmp(line_end, "\r\n", 2) != 0) return NULL;
    /* status = "HTTP/1.x NNN ..." */
    const char *sp = memchr(resp, ' ', (size_t)(line_end - resp));
    if (!sp || line_end - sp < 4) return NULL;
    if (strncmp(sp + 1, "200", 3) != 0) return NULL;
    const char *b = strstr(line_end, "\r\n\r\n");
    if (!b) return NULL;
    return b + 4;
}

int dbox_ask(const dbox_policy_t *p, const char *vpath, int acc,
             char *err, size_t errsz)
{
    endpoint_t ep;
    if (!p->ask_endpoint || parse_endpoint(p->ask_endpoint, &ep) != 0) {
        snprintf(err, errsz, "bad endpoint url");
        return 0;   /* fail-closed */
    }
    char req[DBOX_PATH_MAX + 256];
    if (dbox_ask_build_request(req, sizeof req, vpath, acc, p->ask_token) != 0) {
        snprintf(err, errsz, "request build failed");
        return 0;
    }
    static _Thread_local char resp[ASK_IO_BUF];
    int tmo = p->ask_timeout_ms > 0 ? p->ask_timeout_ms : 2000;
    if (ask_roundtrip(&ep, req, resp, sizeof resp, tmo, p->ask_token, err, errsz) != 0) {
        dbox_logf("ask transport failed: %s", err);
        return 0;   /* fail-closed */
    }

    const char *body = resp;
    if (ep.kind == EP_HTTP) {
        body = http_body(resp, resp + strlen(resp));
        if (!body) { snprintf(err, errsz, "bad http response"); dbox_logf("ask %s", err); return 0; }
    }
    int64_t now = dbox_now_ms();
    int rc = dbox_ask_parse_response(body, (dbox_policy_t *)p, now);
    if (!rc) {
        snprintf(err, errsz, "endpoint denied or bad response");
        dbox_logf("ask denied: %s (body: %.80s)", err, body);
    } else {
        dbox_logf("ask allow: %s %s", dbox_access_name(acc & ACC_ALL), vpath);
    }
    return rc;
}
