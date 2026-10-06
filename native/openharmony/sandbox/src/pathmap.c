/* pathmap.c — identity-namespace path attribution and traversal-safe
 * symlink resolution.
 *
 * 虚拟路径 == 真实路径：沙箱不再映射任何路径，只按真实路径做策略判定。
 * 所有内核接触（fstatat / readlinkat）走 rawio 抽象（Linux 为绕过 LD_PRELOAD
 * 的 syscall，macOS 为 libc + interpose 豁免，Windows 为 Win32），避免递归
 * 进入被拦截的 libc 封装。
 */
#define _GNU_SOURCE
#include "pathmap.h"
#include "rawio.h"
#include "util.h"
#include "policy.h"

#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0x100
#endif

static int raw_fstatat(int fd, const char *p, struct stat *st, int flags)
{
    return dbox_raw_fstatat(fd, p, st, flags);
}

static ssize_t raw_readlinkat(int fd, const char *p, char *buf, size_t sz)
{
    return dbox_raw_readlinkat(fd, p, buf, sz);
}

/* ------------------------------------------------------------------ */
/* raw-space symlink resolution                                        */
/* ------------------------------------------------------------------ */

typedef struct {
    char **c;   /* component copies, front at index head */
    int n, head, cap;
} queue_t;

static void q_push_back(queue_t *q, char *s)
{
    if (q->n == q->cap) {
        q->cap = q->cap ? q->cap * 2 : 16;
        char **nc = dbox_malloc(sizeof(char *) * q->cap);
        int k = 0;
        for (int i = q->head; i < q->n; i++) nc[k++] = q->c[i];
        dbox_free(q->c);
        q->c = nc; q->n = k; q->head = 0;
    }
    q->c[q->n++] = s;
}

static char *q_pop_front(queue_t *q)
{
    if (q->head >= q->n) return NULL;
    return q->c[q->head++];
}

static void q_push_front_list(queue_t *q, const char *path)
{
    /* insert components of path at the front */
    queue_t tmp = {0};
    const char *p = path;
    while (*p) {
        while (*p == '/') p++;
        if (!*p) break;
        const char *st = p;
        while (*p && *p != '/') p++;
        q_push_back(&tmp, dbox_strndup(st, (size_t)(p - st)));
    }
    if (tmp.n) {
        int existing = q->n - q->head;
        if (existing > 0) {
            char **held = dbox_malloc(sizeof(char *) * existing);
            int k = 0;
            for (int i = q->head; i < q->n; i++) held[k++] = q->c[i];
            q->head = q->n = 0;
            for (int i = 0; i < existing; i++) q_push_back(q, held[i]);
            dbox_free(held);
        }
        int newn = tmp.n + (q->n - q->head);
        char **nc = dbox_malloc(sizeof(char *) * (newn + 8));
        int k = 0;
        for (int i = 0; i < tmp.n; i++) nc[k++] = tmp.c[i];
        for (int i = q->head; i < q->n; i++) nc[k++] = q->c[i];
        if (q->c) dbox_free(q->c);
        q->c = nc; q->n = newn; q->head = 0; q->cap = newn + 8;
        dbox_free(tmp.c);
    } else {
        dbox_free(tmp.c);
    }
}

static void out_pop(char *out)
{
    char *slash = strrchr(out, '/');
    if (slash == out) out[1] = '\0';
    else if (slash) *slash = '\0';
    else out[0] = '\0';
}

int dbox_resolve_real(const char *abs, int flags, char *out, size_t outsz,
                      int *partial)
{
    out[0] = '\0';
    *partial = 0;
    queue_t q = {0};
    const char *p = abs;
    while (*p) {
        while (*p == '/') p++;
        if (!*p) break;
        const char *st = p;
        while (*p && *p != '/') p++;
        q_push_back(&q, dbox_strndup(st, (size_t)(p - st)));
    }

    int links = 0;
    int rc = 0;
    char link[DBOX_PATH_MAX];

    while (q.head < q.n) {
        char *comp = q_pop_front(&q);
        int last = (q.head == q.n);
        if (strcmp(comp, ".") == 0) { dbox_free(comp); continue; }
        if (strcmp(comp, "..") == 0) {
            if (out[0]) out_pop(out);
            dbox_free(comp);
            continue;
        }
        size_t ol = strlen(out);
        char cand[DBOX_PATH_MAX];
        if (ol == 0 || (ol == 1 && out[0] == '/')) {
            /* at the root: appending to "/" must not produce "//comp",
             * otherwise policy prefixes such as "/data" stop matching */
            if (1 + strlen(comp) + 1 > sizeof cand) { rc = -1; errno = ENAMETOOLONG; dbox_free(comp); break; }
            cand[0] = '/'; strcpy(cand + 1, comp);
        } else if (ol + 1 + strlen(comp) + 1 > sizeof cand) {
            rc = -1; errno = ENAMETOOLONG; dbox_free(comp); break;
        } else {
            memcpy(cand, out, ol);
            cand[ol] = '/';
            strcpy(cand + ol + 1, comp);
        }
        struct stat st;
        if (raw_fstatat(AT_FDCWD, cand, &st, AT_SYMLINK_NOFOLLOW) == 0) {
            if (S_ISLNK(st.st_mode) && last && (flags & DBOX_NOFOLLOW_LAST)) {
                /* NOFOLLOW_LAST: keep the link itself as the final component */
                if (strlen(cand) + 1 > outsz) { rc = -1; errno = ENAMETOOLONG; dbox_free(comp); break; }
                strcpy(out, cand);
                dbox_free(comp);
                break;
            }
            if (S_ISLNK(st.st_mode)) {
                ssize_t n = raw_readlinkat(AT_FDCWD, cand, link, sizeof(link) - 1);
                if (n < 0) { rc = -1; dbox_free(comp); break; }
                link[n] = '\0';
                if (++links > 40) { rc = -1; errno = ELOOP; dbox_free(comp); break; }
                if (link[0] == '/') out[0] = '\0';   /* absolute link resets */
                q_push_front_list(&q, link);
                dbox_free(comp);
                continue;
            }
            if (strlen(cand) + 1 > outsz) { rc = -1; errno = ENAMETOOLONG; dbox_free(comp); break; }
            strcpy(out, cand);
        } else {
            int e = errno;
            if (e == ENOENT) {
                /* tail missing: keep cand plus every remaining pending
                 * component literally, so the policy sees the FULL path
                 * (the kernel produces the authoritative error, or creates
                 * the file for O_CREAT on the last component) */
                if (strlen(cand) + 1 > outsz) { rc = -1; errno = ENAMETOOLONG; dbox_free(comp); break; }
                strcpy(out, cand);
                while (q.head < q.n) {
                    char *rest = q.c[q.head++];
                    size_t ol2 = strlen(out);
                    size_t rl = strlen(rest);
                    if (ol2 + 1 + rl + 1 > outsz) { rc = -1; errno = ENAMETOOLONG; dbox_free(rest); break; }
                    out[ol2] = '/';
                    memcpy(out + ol2 + 1, rest, rl + 1);
                    dbox_free(rest);
                }
                *partial = 1;
                dbox_free(comp);
                break;
            }
            rc = -1;
            errno = e;
            dbox_free(comp);
            break;
        }
        dbox_free(comp);
    }

    while (q.head < q.n) dbox_free(q.c[q.head++]);
    dbox_free(q.c);
    if (rc == 0 && out[0] == '\0') strcpy(out, "/");   /* resolved to root */
    return rc;
}

/* ------------------------------------------------------------------ */
/* planning (identity namespace)                                       */
/* ------------------------------------------------------------------ */

int dbox_plan_path(const dbox_ctx_t *ctx, const char *input, int flags,
                   char **out_vpath, char **out_real,
                   int *out_partial)
{
    *out_vpath = NULL;
    if (out_real) *out_real = NULL;
    if (out_partial) *out_partial = 0;
    if (!input || !input[0]) { errno = ENOENT; return -1; }

    char *abs;
    if (input[0] == '/') {
        abs = dbox_normpath(input);
    } else {
        char *joined = dbox_path_join(ctx->rpwd, input);
        abs = dbox_normpath(joined);
        dbox_free(joined);
    }

    /* Resolve symlinks for policy attribution. The program's own path is
     * always handed to the kernel, so O_NOFOLLOW / AT_SYMLINK_* semantics
     * are preserved; only attribution uses the resolved form. */
    char resolved[DBOX_PATH_MAX];
    int partial = 0;
    int ok = (dbox_resolve_real(abs, flags, resolved, sizeof resolved, &partial) == 0);
    if (ok) {
        /* `resolved` is the correct attribution in both cases: fully
         * resolved, or the resolved prefix followed by the missing tail.
         * Falling back to the lexical path when the tail is missing would
         * attribute a path that traverses a symlink to the wrong tree — it
         * mis-denies system paths (a missing /etc/ssl/x.cnf is ENOENT, not
         * EACCES) and can also let a rule written against the symlink name
         * miss the real target (or the other way round). */
        *out_vpath = dbox_strdup(resolved);
        *out_real = dbox_strdup(resolved);
    } else {
        /* hard resolve error (EACCES/ELOOP/ENAMETOOLONG): attribute the
         * lexical path; the real syscall surfaces the authoritative kernel
         * error */
        *out_vpath = dbox_strdup(abs);
        *out_real = dbox_strdup(abs);
        partial = 0;
    }
    *out_partial = partial;


    dbox_free(abs);
    return 0;
}
