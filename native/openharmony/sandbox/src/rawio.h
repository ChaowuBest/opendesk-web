/* rawio.h — 沙箱自身 I/O 的平台抽象（core 的"绕自身 hook"原语）。
 *
 * 背景：core（policy/pathmap/ask/log）在 Linux/OpenHarmony 上通过裸 syscall
 * 完成自身 I/O，避免递归进入被 LD_PRELOAD 拦截的 libc 封装。该机制在
 * macOS（DYLD interpose + is_internal 豁免）与 Windows（Detours + HookGuard）
 * 上不适用——那两个平台的豁免由各自的 hook 守卫实现，自身 I/O 走 libc /
 * Win32 即可。
 *
 * 本头文件定义跨平台接口，各平台提供实现：
 *   - Linux/OpenHarmony: rawio_linux.c（syscall，绕 LD_PRELOAD）
 *   - macOS:             rawio_darwin.c（libc，配合 is_internal 由 boxdylib 守卫）
 *   - Windows:           rawio_win32.c（Win32 API）
 *
 * 返回语义与 libc 对应函数一致（返回值 / errno）。
 */
#ifndef DYNOBOX_RAWIO_H
#define DYNOBOX_RAWIO_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <poll.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -- path / meta ---------------------------------------------------------- */

/* fstatat（dirfd 为 -100=AT_FDCWD 兼容宏）。Linux 走 SYS_newfstatat；其余平台
 * 走 libc fstatat。 */
int dbox_raw_fstatat(int dirfd, const char *path, struct stat *st, int flags);

/* readlinkat。 */
ssize_t dbox_raw_readlinkat(int dirfd, const char *path, char *buf, size_t sz);

/* -- fd I/O --------------------------------------------------------------- */

int dbox_raw_openat(int dirfd, const char *path, int flags, mode_t mode);
ssize_t dbox_raw_write(int fd, const void *buf, size_t n);
int dbox_raw_close(int fd);

/* -- socket（ask 传输） ----------------------------------------------------- */

int dbox_raw_socket(int domain, int type, int proto);
int dbox_raw_connect(int fd, const struct sockaddr *sa, socklen_t sl);
int dbox_raw_setsockopt(int fd, int level, int optname, const void *optval,
                        socklen_t optlen);
int dbox_raw_getsockopt(int fd, int level, int optname, void *optval,
                        socklen_t *optlen);
ssize_t dbox_raw_sendto(int fd, const void *buf, size_t n, int flags,
                        const struct sockaddr *sa, socklen_t sl);
ssize_t dbox_raw_recvfrom(int fd, void *buf, size_t n, int flags,
                          struct sockaddr *sa, socklen_t *sl);
int dbox_raw_fcntl(int fd, int cmd, long arg);

/* poll（超时毫秒）。Linux 走 SYS_poll/ppoll；macOS 走 libc poll（配合内部
 * 守卫）；Windows 用 WSAPoll。 */
int dbox_raw_poll(struct pollfd *fds, unsigned long nfds, int timeout_ms);

/* -- memory map（shm attach 专用） ----------------------------------------- */

/* PROT_READ|PROT_WRITE 的 MAP_SHARED 匿名/文件映射，语义与 libc mmap
 * 一致（失败返回 MAP_FAILED + errno）。shm attach 发生在本库构造函数
 * 期间，必须绕过自身 interposed mmap（BUG-021：ctor 期钩子重入）。 */
void *dbox_raw_mmap_rw_shared(int fd, size_t len);
int dbox_raw_munmap(void *addr, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* DYNOBOX_RAWIO_H */