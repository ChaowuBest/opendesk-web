/* util.c — small string/path helpers (no libc hooks here: this file is
 * linked into both the launcher CLI and the LD_PRELOAD library; inside the
 * preload library only *exported* libc symbols are interposed, so plain
 * malloc/strdup calls from this file are safe). */
#define _GNU_SOURCE
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <ctype.h>
#include <errno.h>
#include <sys/stat.h>
#ifndef _WIN32
#include <sys/socket.h>
#include <sys/un.h>
#endif

void *dbox_malloc(size_t n)
{
    void *p = malloc(n ? n : 1);
    if (!p) abort();
    return p;
}

void *dbox_realloc(void *p, size_t n)
{
    void *q = realloc(p, n ? n : 1);
    if (!q) abort();
    return q;
}

void dbox_free(void *p) { free(p); }

char *dbox_strdup(const char *s)
{
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *r = dbox_malloc(n);
    memcpy(r, s, n);
    return r;
}

char *dbox_strndup(const char *s, size_t n)
{
    if (!s) return NULL;
    char *r = dbox_malloc(n + 1);
    memcpy(r, s, n);
    r[n] = '\0';
    return r;
}

int dbox_str_ieq(const char *a, const char *b)
{
    if (!a || !b) return a == b;
    while (*a && *b) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
        a++; b++;
    }
    return *a == *b;
}

char *dbox_path_join(const char *dir, const char *name)
{
    size_t dl = strlen(dir), nl = strlen(name);
    while (dl > 1 && dir[dl - 1] == '/') dl--;   /* trim trailing slashes */
    if (dl == 0) return dbox_strdup(name);
    if (dl == 1 && dir[0] == '/') {
        char *r = dbox_malloc(1 + nl + 1);
        r[0] = '/';
        memcpy(r + 1, name, nl);
        r[1 + nl] = '\0';
        return r;
    }
    char *r = dbox_malloc(dl + 1 + nl + 1);
    memcpy(r, dir, dl);
    r[dl] = '/';
    memcpy(r + dl + 1, name, nl);
    r[dl + 1 + nl] = '\0';
    return r;
}

char *dbox_normpath(const char *path)
{
    if (!path) return dbox_strdup("");
    int absolute = path[0] == '/';
    size_t n = strlen(path);
    /* component split */
    const char **comps = dbox_malloc(sizeof(char *) * (n / 1 + 2));
    size_t *lens = dbox_malloc(sizeof(size_t) * (n + 2));
    size_t ncomp = 0;
    const char *p = path;
    while (*p) {
        while (*p == '/') p++;
        if (!*p) break;
        const char *st = p;
        while (*p && *p != '/') p++;
        size_t l = (size_t)(p - st);
        if (l == 1 && st[0] == '.') continue;            /* "." */
        if (l == 2 && st[0] == '.' && st[1] == '.') {     /* ".." */
            if (ncomp > 0 && !(lens[ncomp-1] == 2 && comps[ncomp-1][0] == '.' && comps[ncomp-1][1] == '.'))
                ncomp--;                              /* pop non-..".. " */
            else if (!absolute)
                { comps[ncomp] = st; lens[ncomp] = l; ncomp++; }  /* keep leading .. in relative */
            /* absolute: ".." above root is dropped (kernel clamps at "/") */
            continue;
        }
        comps[ncomp] = st; lens[ncomp] = l; ncomp++;
    }
    /* build */
    char *r = dbox_malloc(n + 2);
    size_t w = 0;
    if (absolute) r[w++] = '/';
    for (size_t i = 0; i < ncomp; i++) {
        if (w > 0 && !(w == 1 && absolute)) r[w++] = '/';
        memcpy(r + w, comps[i], lens[i]); w += lens[i];
    }
    if (w == 0) r[w++] = absolute ? '/' : '.';   /* "/" or "." */
    r[w] = '\0';
    dbox_free(comps); dbox_free(lens);
    return r;
}

int dbox_path_under(const char *path, const char *prefix)
{
    if (!prefix || !prefix[0]) return 0;
    size_t pl = strlen(prefix);
    while (pl > 1 && prefix[pl - 1] == '/') pl--;
    if (pl == 1 && prefix[0] == '/') return path[0] == '/';
    if (strncmp(path, prefix, pl) != 0) return 0;
    char c = path[pl];
    return c == '\0' || c == '/';
}

char *dbox_path_rel(const char *path, const char *prefix)
{
    if (!dbox_path_under(path, prefix)) return NULL;
    size_t pl = strlen(prefix);
    while (pl > 1 && prefix[pl - 1] == '/') pl--;
    const char *rest = path + pl;
    if (*rest == '/') rest++;
    return dbox_strdup(rest);
}

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t dbox_b64encode(const unsigned char *in, size_t n, char *out)
{
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = (unsigned)in[i] << 16;
        int pad = 0;
        if (i + 1 < n) v |= (unsigned)in[i+1] << 8; else pad++;
        if (i + 2 < n) v |= (unsigned)in[i+2]; else pad++;
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = pad >= 2 ? '=' : B64[(v >> 6) & 63];
        out[o++] = pad >= 1 ? '=' : B64[v & 63];
    }
    out[o] = '\0';
    return o;
}

static int b64val(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

unsigned char *dbox_b64decode(const char *in, size_t *outlen)
{
    size_t n = strlen(in);
    while (n > 0 && (in[n-1] == '\n' || in[n-1] == '\r' || in[n-1] == ' ')) n--;
    if (n % 4) return NULL;
    size_t max = n / 4 * 3;
    unsigned char *r = dbox_malloc(max);
    size_t o = 0;
    for (size_t i = 0; i < n; i += 4) {
        int pad = 0;
        int v[4];
        for (int k = 0; k < 4; k++) {
            char c = in[i + k];
            if (c == '=' && i + 4 == n) { pad++; v[k] = 0; }
            else { v[k] = b64val(c); if (v[k] < 0) { dbox_free(r); return NULL; } }
        }
        unsigned u = ((unsigned)v[0] << 18) | ((unsigned)v[1] << 12) |
                     ((unsigned)v[2] << 6) | (unsigned)v[3];
        r[o++] = (u >> 16) & 0xff;
        if (pad < 2) r[o++] = (u >> 8) & 0xff;
        if (pad < 1) r[o++] = u & 0xff;
        if (pad && i + 4 != n) { dbox_free(r); return NULL; }
    }
    *outlen = o;
    return r;
}

#ifndef _WIN32
/* Can a unix socket actually be bound in this directory? Directory
 * existence/writability is not enough: HarmonyOS rejects bind() on HMDFS
 * (EPERM) and on tmpfs mounts such as /dev/shm (EACCES by SELinux). */
static int dir_hosts_sockets(const char *dir)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    struct sockaddr_un sa;
    /* sun_path 容量为 108（Linux/glibc）；超长路径本就无法 bind unix socket，
     * 探测失败返回 0，避免截断后 bind 到错误路径误判目录可用。 */
    char p[sizeof sa.sun_path];
    int plen = snprintf(p, sizeof p, "%s/.dynobox-probe-%ld", dir, (long)getpid());
    if (plen < 0 || (size_t)plen >= sizeof p) { close(fd); return 0; }
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    memcpy(sa.sun_path, p, (size_t)plen + 1);
    int ok = bind(fd, (struct sockaddr *)&sa, sizeof sa) == 0;
    if (ok) unlink(p);
    close(fd);
    return ok;
}

const char *dbox_pipe_dir(void)
{
    static char cached[256];
    if (cached[0]) return cached;

    const char *env = getenv("DYNOBOX_PIPE_DIR");
    if (env && env[0]) {
        snprintf(cached, sizeof cached, "%s", env);
        return cached;
    }
    const char *tmpdir = getenv("TMPDIR");
    char tmpcand[256];
    tmpcand[0] = '\0';
    if (tmpdir && tmpdir[0])
        snprintf(tmpcand, sizeof tmpcand, "%s/dynobox-pipes", tmpdir);
    /* /tmp is the historical location (parity with the Windows named pipe
     * namespace) but it is a read-only mount on HarmonyOS, and several other
     * filesystems reject unix sockets outright, so the directory is chosen by
     * probing rather than assumed. */
    const char *cands[] = {
        tmpcand[0] ? tmpcand : NULL,
        "/tmp/dynobox-pipes", "/dev/shm/dynobox-pipes", NULL
    };
    for (int i = 0; cands[i]; i++) {
        if (mkdir(cands[i], 0755) != 0 && errno != EEXIST) continue;
        struct stat st;
        if (stat(cands[i], &st) != 0 || !S_ISDIR(st.st_mode)) continue;
        if (!dir_hosts_sockets(cands[i])) continue;
        snprintf(cached, sizeof cached, "%s", cands[i]);
        return cached;
    }
    snprintf(cached, sizeof cached, "%s", "/tmp/dynobox-pipes");
    return cached;
}

void dbox_pipe_path(const char *name, char *out, size_t outsz)
{
    snprintf(out, outsz, "%s/%s.sock", dbox_pipe_dir(), name);
}
#else
/* Windows：pipe:// 由既有 ask.cpp 的命名管道传输实现，core 侧无需 unix
 * socket 探测。提供 getenv 兜底避免链接错误（bridge 不调用时为死代码）。 */
const char *dbox_pipe_dir(void)
{
    static char cached[256];
    if (cached[0]) return cached;
    const char *env = getenv("DYNOBOX_PIPE_DIR");
    if (env && env[0]) { snprintf(cached, sizeof cached, "%s", env); return cached; }
    snprintf(cached, sizeof cached, "\\\\.\\pipe\\dynobox-pipes");
    return cached;
}

void dbox_pipe_path(const char *name, char *out, size_t outsz)
{
    snprintf(out, outsz, "%s\\%s", dbox_pipe_dir(), name);
}
#endif

int dbox_trash_worth_keeping(unsigned int mode, long long size)
{
    if (S_ISDIR(mode)) return 0;               /* 空壳目录（rmdir 语义保证为空） */
    if (S_ISREG(mode) && size == 0) return 0;  /* 0 字节普通文件 */
    return 1;
}

int dbox_trash_excluded(const char *path, const char *list, char sep)
{
    if (!path || !path[0] || !list || !list[0]) return 0;
    const char *start = list;
    for (const char *p = list;; p++) {
        if (*p == sep || *p == '\0') {
            size_t len = (size_t)(p - start);
            if (len > 0 && len < 1024) {
                char seg[1024];
                memcpy(seg, start, len);
                seg[len] = '\0';
                if (dbox_path_under(path, seg)) return 1;
            }
            if (*p == '\0') break;
            start = p + 1;
        }
    }
    return 0;
}

int dbox_path_has_content(const char *p)
{
    return p && p[0] != '\0';
}

int dbox_ptr_set(const void *p)
{
    return p != NULL;
}
