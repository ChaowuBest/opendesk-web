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

/* ------------------------------------------------------------------ */
/* resolved-directory cache                                            */
/*                                                                     */
/* 逐组件符号链接解析是每次路径判定最贵的一段：n 个组件的路径要做 n 次  */
/* fstatat（每次都从根重走）+ n 次 readlink 探测。解压/安装类负载在同一 */
/* 目录下连续创建成千上万个文件，父目录链被反复重新验证。               */
/*                                                                     */
/* 这里缓存"从根到该目录的每一级都是真实目录（不是符号链接）"的词法路径。*/
/* 命中时父目录直接取用，只对最后一个组件做一次 fstatat——语义不变：     */
/*   - 最后一个组件永远实际 stat（ENOENT / 符号链接 / 新建文件不受影响）*/
/*   - 只在"解析结果 == 词法路径"（前面没经过链接）时记录，不会把链接前缀*/
/*     误记成真实目录                                             */
/*                                                                     */
/* 安全权衡（与 README 的 TOCTOU 边界一致）：TTL 内若某一级目录被替换成  */
/* 符号链接，解析沿用旧结论——最终打开的目标仍是此前判定过的同一路径，   */
/* 不产生越权；只是"链接改指向"不立即生效。500ms 的窗口把该差异压到与    */
/* 既有 fork/exec 竞争同一量级。                                       */
/* ------------------------------------------------------------------ */

#define PCACHE_SLOTS  512
#define PCACHE_PATH   256
#define PCACHE_TTL_MS 200

typedef struct {
    char    key[PCACHE_PATH];
    int64_t ts;          /* >0 = 该 key 的写入时刻；<=0 = 空/正在写入 */
} pcache_ent_t;

static pcache_ent_t g_pcache[PCACHE_SLOTS];

/* 写入中的哨兵（dbox_now_ms() 从 0 开始，用负数避免与合法时间戳冲突） */
#define PCACHE_TS_WRITING (-1)

/* seqlock 的读写端必须带屏障：aarch64 是弱内存序，普通 store 可能被 CPU
 * 重排到 key 的 memcpy 之前，读者就会看到"新时间戳 + 半新 key"。 */
#if defined(__GNUC__) || defined(__clang__)
#define PCACHE_STORE_TS(p, v) __atomic_store_n((p), (v), __ATOMIC_RELEASE)
#define PCACHE_LOAD_TS(p)     __atomic_load_n((p), __ATOMIC_ACQUIRE)
#else
#define PCACHE_STORE_TS(p, v) (*(p) = (v))
#define PCACHE_LOAD_TS(p)     (*(p))
#endif

static unsigned pcache_hash(const char *s)
{
    unsigned h = 2166136261u;
    while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; }
    return h % PCACHE_SLOTS;
}

static void pcache_put(const char *path, int64_t now_ms)
{
    size_t n = strlen(path);
    if (n == 0 || n >= PCACHE_PATH) return;   /* 超长路径不缓存 */
    pcache_ent_t *e = &g_pcache[pcache_hash(path)];
    PCACHE_STORE_TS(&e->ts, PCACHE_TS_WRITING);   /* seqlock: 进入写入 */
    memcpy(e->key, path, n + 1);
    PCACHE_STORE_TS(&e->ts, now_ms);
}

static int pcache_hit(const char *path, int64_t now_ms)
{
    size_t n = strlen(path);
    if (n == 0 || n >= PCACHE_PATH) return 0;
    pcache_ent_t *e = &g_pcache[pcache_hash(path)];
    int64_t t1 = PCACHE_LOAD_TS(&e->ts);
    if (t1 <= 0 || now_ms - t1 > PCACHE_TTL_MS) return 0;
    if (strcmp(e->key, path) != 0) return 0;
    return PCACHE_LOAD_TS(&e->ts) == t1;   /* seqlock: 期间未被改写 */
}

int dbox_dir_cache_hit(const char *path)
{
    if (!path || !path[0]) return 0;
    return pcache_hit(path, dbox_now_ms());
}

int dbox_resolve_real(const char *abs, int flags, char *out, size_t outsz,
                      int *partial)
{
    out[0] = '\0';
    *partial = 0;
    int64_t now = dbox_now_ms();

    /* 快速路径：父目录已在 clean 集合中 → 只需解析最后一个组件。
     * clean 意味着"解析结果 == 词法路径"，故 out 可直接取父目录。
     *
     * 缓冲用 PCACHE_PATH（256）而非 DBOX_PATH_MAX：超过缓存键上限的路径
     * 本来就无法命中缓存，直接走完整解析即可——同时把信号处理器重入路径
     * 上的栈占用压回原来的量级（本函数已有两个 4KB 缓冲）。 */
    int fast = 0;
    size_t alen = strlen(abs);
    if (alen > 1 && alen + 1 <= (size_t)PCACHE_PATH) {
        char parent[PCACHE_PATH];
        memcpy(parent, abs, alen + 1);
        char *slash = strrchr(parent, '/');
        if (slash) {
            if (slash == parent) slash[1] = '\0';
            else *slash = '\0';
            size_t pl = strlen(parent);
            if (parent[0] && pl + 1 <= outsz && pcache_hit(parent, now)) {
                /* 缓存本身只证明"曾经是真实目录"。若它在 TTL 内被替换为符号
                 * 链接，按旧路径判定会让策略与实际访问目标不一致（内核按程序
                 * 传入的原始路径解析）——那就是一条绕过 deny 的路径。因此命中
                 * 后仍对父目录做一次 NOFOLLOW 校验：必须仍是实体目录，否则丢弃
                 * 缓存走完整解析。
                 *
                 * 代价是每次判定多 1 次 fstatat，但相对完整解析（n 次）仍把
                 * 每层路径的 syscall 从 n 降到 2。 */
                struct stat pst;
                if (raw_fstatat(AT_FDCWD, parent, &pst, AT_SYMLINK_NOFOLLOW) == 0 &&
                    S_ISDIR(pst.st_mode)) {
                    memcpy(out, parent, pl + 1);   /* 必须按 outsz 校验：公共 API */
                    fast = 1;
                }
            }
        }
    }

    queue_t q = {0};
    if (fast) {
        /* 只入队最后一个组件 */
        const char *last = strrchr(abs, '/');
        if (last && last[1]) q_push_back(&q, dbox_strdup(last + 1));
        else fast = 0;   /* 理论不可达（alen>1 且以 '/' 开头） */
        if (!fast) out[0] = '\0';
    }
    if (!fast) {
        const char *p = abs;
        while (*p) {
            while (*p == '/') p++;
            if (!*p) break;
            const char *st = p;
            while (*p && *p != '/') p++;
            q_push_back(&q, dbox_strndup(st, (size_t)(p - st)));
        }
    }

    int links = 0;
    int rc = 0;
    int link_seen = 0;   /* 一旦展开过符号链接，后续前缀不再是"词法 == 解析" */
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
                link_seen = 1;
                if (link[0] == '/') out[0] = '\0';   /* absolute link resets */
                q_push_front_list(&q, link);
                dbox_free(comp);
                continue;
            }
            if (strlen(cand) + 1 > outsz) { rc = -1; errno = ENAMETOOLONG; dbox_free(comp); break; }
            strcpy(out, cand);
            /* 记录 clean 目录前缀：仅在本次解析未经过任何符号链接
             * （解析结果 == 词法路径）时可信 */
            if (!link_seen && S_ISDIR(st.st_mode)) pcache_put(cand, now);
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
        /* identity namespace 下 vpath 与 real 内容相同：调用方不需要两份拷贝时
         * 传 out_real = NULL 即可省掉一次分配（拦截层热路径） */
        if (out_real) *out_real = dbox_strdup(resolved);
    } else {
        /* hard resolve error (EACCES/ELOOP/ENAMETOOLONG): attribute the
         * lexical path; the real syscall surfaces the authoritative kernel
         * error */
        *out_vpath = dbox_strdup(abs);
        if (out_real) *out_real = dbox_strdup(abs);
        partial = 0;
    }
    *out_partial = partial;


    dbox_free(abs);
    return 0;
}
