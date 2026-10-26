/* rawio_darwin.c — macOS 的 raw I/O 实现。
 *
 * macOS 沙箱是 DYLD_INSERT_LIBRARIES interpose：自身 I/O 的豁免由 boxdylib
 * 的 is_internal()（线程局部深度计数）守卫，不走 syscall——syscall(2) 在
 * macOS 10.12+ 已废弃，且 macOS 没有 Linux 风格的系统调用编号表。
 *
 * 调用约定：这些函数**只**在 boxdylib 的 internal 段内被调用（沙箱自身 I/O，
 * 如日志、ask 传输、回收站写入），由调用方保证豁免。
 */
#define _GNU_SOURCE
#include "rawio.h"

#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>

/* macOS 没有 AT_FDCWD 宏的稳定暴露，按 POSIX 定义（-100） */
#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif

int dbox_raw_fstatat(int dirfd, const char *path, struct stat *st, int flags)
{
    return fstatat(dirfd, path, st, flags);
}

ssize_t dbox_raw_readlinkat(int dirfd, const char *path, char *buf, size_t sz)
{
    return readlinkat(dirfd, path, buf, sz);
}

int dbox_raw_openat(int dirfd, const char *path, int flags, mode_t mode)
{
    return openat(dirfd, path, flags, mode);
}

ssize_t dbox_raw_write(int fd, const void *buf, size_t n)
{
    return write(fd, buf, n);
}

int dbox_raw_close(int fd)
{
    return close(fd);
}

int dbox_raw_socket(int domain, int type, int proto)
{
    return socket(domain, type, proto);
}

int dbox_raw_connect(int fd, const struct sockaddr *sa, socklen_t sl)
{
    return connect(fd, sa, sl);
}

int dbox_raw_setsockopt(int fd, int level, int optname, const void *optval,
                        socklen_t optlen)
{
    return setsockopt(fd, level, optname, optval, optlen);
}

int dbox_raw_getsockopt(int fd, int level, int optname, void *optval,
                        socklen_t *optlen)
{
    return getsockopt(fd, level, optname, optval, optlen);
}

ssize_t dbox_raw_sendto(int fd, const void *buf, size_t n, int flags,
                        const struct sockaddr *sa, socklen_t sl)
{
    return sendto(fd, buf, n, flags, sa, sl);
}

ssize_t dbox_raw_recvfrom(int fd, void *buf, size_t n, int flags,
                          struct sockaddr *sa, socklen_t *sl)
{
    return recvfrom(fd, buf, n, flags, sa, sl);
}

int dbox_raw_fcntl(int fd, int cmd, long arg)
{
    return fcntl(fd, cmd, arg);
}

int dbox_raw_poll(struct pollfd *fds, unsigned long nfds, int timeout_ms)
{
    return poll(fds, (nfds_t)nfds, timeout_ms);
}

/* -- memory map（shm attach 专用） ------------------------------------------ */

/* boxdylib 未 interpose mmap（2dd6618b 的 BUG-021 重入是 Linux LD_PRELOAD
 * 场景特有），libc mmap 在 ctor 期间同样安全。当前 darwin 侧无 shm attach
 * 调用方（dbox_shared_attach 仅 preload.c 使用），此实现保证链接完备性。 */
void *dbox_raw_mmap_rw_shared(int fd, size_t len)
{
    return mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
}

int dbox_raw_munmap(void *addr, size_t len)
{
    return munmap(addr, len);
}