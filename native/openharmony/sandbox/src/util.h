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

#endif
