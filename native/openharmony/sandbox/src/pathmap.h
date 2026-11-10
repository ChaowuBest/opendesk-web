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

/* 目录前缀缓存查询：path 最近（TTL 内）被验证为"从根到它的每一级都是真实目录"。
 *
 * 只可用于**跳过无副作用的探测**（典型：写打开前的父链缺失探测——父目录存在
 * 与否只影响是否需要 ask，实际写仍交给内核返回权威错误）。
 *
 * **不得**用于"目标已存在 ⇒ 本次调用无副作用"这类会跳过 allow/ask 判定的捷径
 * （例如 mkdir 目标存在性）：缓存可能滞后于实际删除，那样会把本该 ask 的写
 * 操作静默放行（审批绕过）。
 *
 * 也不建议用于策略归属判定：缓存不含 inode，无法发现"目录在 TTL 内被替换为
 * 符号链接"。路径解析（dbox_resolve_real）因此对父目录做了额外的 NOFOLLOW
 * 校验，而不是直接信任本函数。 */
int dbox_dir_cache_hit(const char *path);

#endif
