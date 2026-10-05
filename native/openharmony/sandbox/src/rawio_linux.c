/* rawio_linux.c — Linux/OpenHarmony 的 raw I/O 实现。
 *
 * 全部通过裸 syscall 完成：沙箱自身 I/O 必须绕过被 LD_PRELOAD 拦截的 libc
 * 封装（否则递归进入策略判定）。与历史实现完全一致，仅从各文件迁移集中。
 */
#define _GNU_SOURCE
#include "rawio.h"

#include <fcntl.h>
#include <errno.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Linux syscall 编号在新架构（aarch64 等）上可能没有部分 *at 变体，
 * musl/glibc 对缺失的用 ppoll 等替代；此处沿用 core 原有约定。 */
#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0x100
#endif

int dbox_raw_fstatat(int dirfd, const char *path, struct stat *st, int flags)
{
    return (int)syscall(SYS_newfstatat, dirfd, path, st, flags);
}

ssize_t dbox_raw_readlinkat(int dirfd, const char *path, char *buf, size_t sz)
{
    return syscall(SYS_readlinkat, dirfd, path, buf, sz);
}

int dbox_raw_openat(int dirfd, const char *path, int flags, mode_t mode)
{
    return (int)syscall(SYS_openat, dirfd, path, flags, mode);
}

ssize_t dbox_raw_write(int fd, const void *buf, size_t n)
{
    return syscall(SYS_write, fd, buf, n);
}

int dbox_raw_close(int fd)
{
    return (int)syscall(SYS_close, fd);
}

int dbox_raw_socket(int domain, int type, int proto)
{
    return (int)syscall(SYS_socket, domain, type, proto);
}

int dbox_raw_connect(int fd, const struct sockaddr *sa, socklen_t sl)
{
    return (int)syscall(SYS_connect, fd, sa, sl);
}

int dbox_raw_setsockopt(int fd, int level, int optname, const void *optval,
                        socklen_t optlen)
{
    return (int)syscall(SYS_setsockopt, fd, level, optname, optval, optlen);
}

int dbox_raw_getsockopt(int fd, int level, int optname, void *optval,
                        socklen_t *optlen)
{
    return (int)syscall(SYS_getsockopt, fd, level, optname, optval, optlen);
}

ssize_t dbox_raw_sendto(int fd, const void *buf, size_t n, int flags,
                        const struct sockaddr *sa, socklen_t sl)
{
    return syscall(SYS_sendto, fd, buf, n, flags, sa, sl);
}

ssize_t dbox_raw_recvfrom(int fd, void *buf, size_t n, int flags,
                          struct sockaddr *sa, socklen_t *sl)
{
    return syscall(SYS_recvfrom, fd, buf, n, flags, sa, sl);
}

int dbox_raw_fcntl(int fd, int cmd, long arg)
{
    return (int)syscall(SYS_fcntl, fd, cmd, arg);
}

int dbox_raw_poll(struct pollfd *fds, unsigned long nfds, int timeout_ms)
{
#ifdef SYS_poll
    return (int)syscall(SYS_poll, fds, nfds, timeout_ms);
#else
    struct timespec ts = { timeout_ms / 1000,
                           (long)(timeout_ms % 1000) * 1000000L };
    return (int)syscall(SYS_ppoll, fds, nfds, &ts, 0, 0);
#endif
}