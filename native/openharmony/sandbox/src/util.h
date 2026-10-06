/* util.h — small string/path helpers */
#ifndef DYNOBOX_UTIL_H
#define DYNOBOX_UTIL_H

#include <stddef.h>
#include <time.h>
#ifndef _WIN32
#include <unistd.h>

/* 沙箱自身 I/O 原语（dbox_raw_poll 等）统一由 rawio 抽象层提供。
 * Linux/OH: syscall 绕 LD_PRELOAD；macOS: libc + interpose 豁免；
 * Windows: Win32。util.h 历史上直接暴露 dbox_raw_poll，这里透传以保持
 * 既有调用方（ask.c / preload.c）无需改动。 */
#include "rawio.h"
#endif

char *dbox_strdup(const char *s);
char *dbox_strndup(const char *s, size_t n);
void *dbox_malloc(size_t n);
void *dbox_realloc(void *p, size_t n);
void  dbox_free(void *p);

int   dbox_str_ieq(const char *a, const char *b);   /* case-insensitive eq */

/* Join directory + name into malloc'd buffer ("/" separated). */
char *dbox_path_join(const char *dir, const char *name);

/* Lexical normalization (POSIX style):
 *  - collapses "//" and "/./"
 *  - resolves "name/.." lexically
 *  - keeps a leading "/" ; relative input stays relative
 *  - ".." above the top yields the path starting at ".." (caller decides
 *    whether that is an escape)
 * Returns malloc'd string. */
char *dbox_normpath(const char *path);

/* 1 if `path` is inside `prefix` at a component boundary. Empty prefix
 * ("" ) never matches; "/" matches every absolute path. */
int   dbox_path_under(const char *path, const char *prefix);

/* If `path` is under `prefix`, return malloc'd remainder WITHOUT the
 * leading slash ("" when equal), else NULL. */
char *dbox_path_rel(const char *path, const char *prefix);

/* Base64 (RFC 4648, with padding). out must hold 4*ceil(n/3)+1 bytes. */
size_t dbox_b64encode(const unsigned char *in, size_t n, char *out);
/* Returns malloc'd buffer and sets *outlen, or NULL on bad input. */
unsigned char *dbox_b64decode(const char *in, size_t *outlen);

/* Windows named-pipe parity: pipe://NAME on Linux maps to a unix socket at
 * <pipe dir>/<NAME>.sock. The directory defaults to /tmp/dynobox-pipes and
 * falls back to a local tmpfs where that cannot be created (HarmonyOS mounts
 * /tmp read-only); DYNOBOX_PIPE_DIR overrides the choice. */
const char *dbox_pipe_dir(void);
void dbox_pipe_path(const char *name, char *out, size_t outsz);

/* 删除目标是否值得进入回收站（--del-to-trash 分流，三平台语义一致）：
 * 目录（rmdir / RemoveDirectory 语义只删空目录，rm -rf 收尾产生大量空壳）
 * 与 0 字节普通文件（构建零时文件）无恢复价值，返回 0 由调用方直接真删；
 * 其余（非空普通文件、符号链接、fifo 等）返回 1 入站。
 * mode/size 取 lstat 语义的 st_mode/st_size；取不到属性时调用方不得调用
 * 本函数（必须保守入站，绝不因 stat 失败真删可能有内容的对象）。 */
int dbox_trash_worth_keeping(unsigned int mode, long long size);

/* 删除目标是否命中回收站排除清单（--del-to-trash 分流的 --trash-exclude
 * 选项）。list 为 sep 分隔的目录前缀清单（由生成方保证规范形态：dbox_normpath、
 * 无尾斜杠、无空段），path 命中任一前缀（组件边界，dbox_path_under 同语义）
 * 返回 1——调用方直接真实删除、不入回收站。任一参数为空返回 0。
 * 放在独立编译单元供单测（unit_policy）与全平台复用。 */
int dbox_trash_excluded(const char *path, const char *list, char sep);

/* NULL 安全的路径内容检查（拦截层入口专用）：glibc 头对 open/statx 等
 * 声明 __nonnull(path)，拦截层重定义这些符号时编译器会把入口处的 `!path`
 * 守卫按"恒非空"折叠掉，调用方真传 NULL 时裸读即崩（regression probe 的
 * NULL/empty path 场景、node/libuv 的 statx(NULL) 均可触发）。守卫放在
 * 独立编译单元（本文件），调用点无法基于 nonnull 推断内联折叠，检查必然
 * 保留。返回 1 表示 path 非 NULL 且首字节非 '\0'。 */
int dbox_path_has_content(const char *p);

/* 仅判非 NULL（不读内容）：语义对应内核层"路径指针有效性"，与
 * dbox_path_has_content 同样的折叠免疫设计。 */
int dbox_ptr_set(const void *p);

#endif
