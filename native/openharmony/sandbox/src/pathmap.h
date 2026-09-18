/* pathmap.h — path attribution for the identity namespace.
 *
 * Linux 版设计（v1.1）：**虚拟路径与真实路径相同**，不做任何映射——
 * 沙箱只按真实路径控制权限。本模块负责：
 *   - 把程序给定的路径（相对/绝对）归一化为绝对真实路径供策略判定
 *   - 通过 raw syscall 解析符号链接（防穿越），尾段缺失时保留字面量
 *   - 工作目录跟踪（chdir/fchdir 后相对路径判定的基准）
 */
#ifndef DYNOBOX_PATHMAP_H
#define DYNOBOX_PATHMAP_H

#include "dynobox.h"
#include <stddef.h>

#define DBOX_PATH_MAX 4096

/* Per-process sandbox context (owned by the preload library). */
typedef struct {
    dbox_policy_t pol;      /* parsed policy */
    char     rpwd[DBOX_PATH_MAX];  /* current working directory (real) */
    const char *self_so;    /* absolute path of libdynobox.so */
} dbox_ctx_t;

/* Resolution flags */
enum {
    DBOX_FOLLOW_ALL    = 0,  /* resolve symlinks incl. final component */
    DBOX_NOFOLLOW_LAST = 1   /* leave the final component unresolved
                                 (lstat/unlink/rename/link/... semantics) */
};

/* Plan one path operation (identity namespace: virtual == real).
 *
 * `input`      : path as the program passed it (relative resolved against
 *                ctx->rpwd, absolute used as-is), lexically normalized.
 * `out_vpath`  : policy path — identical to the real path (malloc'd).
 * `out_real`   : malloc'd resolved real path (used for fd attribution).
 * `out_partial`: 1 when the tail of the path does not (yet) exist.
 *
 * Returns 0, or -1 when the input is unusable (caller denies).
 */
int dbox_plan_path(const dbox_ctx_t *ctx, const char *input, int flags,
                   char **out_vpath, char **out_real, int *out_partial);

/* Resolve `abs` (absolute + lexically normalized) in real space.
 * On success returns 0 and fills `out`; *partial is set when a tail
 * component was missing (ENOENT). Returns -1 on hard errors (ELOOP,
 * EACCES, ENAMETOOLONG, ...). Uses raw syscalls only. */
int dbox_resolve_real(const char *abs, int flags, char *out, size_t outsz,
                      int *partial);

#endif
