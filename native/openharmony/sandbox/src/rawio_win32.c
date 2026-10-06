/* rawio_win32.c — Windows 的 raw I/O 实现（Win32 API / UCRT）。
 *
 * Windows dynobox 是 Detours hook：自身 I/O 豁免由 HookGuard（线程局部）
 * 守卫，core 的 I/O 走 UCRT 即可（Detours hook 的 libc 入口在 inHook 时
 * 直通）。socket 部分 winsock2 与 POSIX 语义差异在此吸收：
 *   - close → closesocket（socket fd 与 libc fd 空间不同，调用方区分）
 *   - fcntl 非阻塞 → ioctlsocket FIONBIO
 *   - poll → WSAPoll
 */
#ifndef _WIN32
#error "rawio_win32.c is Windows-only"
#endif

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/stat.h>
#include <sys/types.h>

#include "rawio.h"

#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif

/* 判断 fd 是否为 socket（winsock 句柄空间）。UCRT 的 _close 对 socket 句柄
 * 未定义，需要 closesocket。ask 传输只用 socket；log 用文件 fd。 */
static int fd_is_socket(int fd)
{
    /* WSADuplicateSocket 对非 socket 返回 WSAENOTSOCK：用这个判定而不依赖
     * 未公开的 msvcrt 内部结构。 */
    WSAPROTOCOL_INFOW info;
    return WSADuplicateSocketW((SOCKET)(uintptr_t)fd, 0, &info) == 0;
}

int dbox_raw_fstatat(int dirfd, const char *path, struct stat *st, int flags)
{
    /* Windows 无 *at 语义：仅支持 AT_FDCWD（相对路径按进程 cwd 解析）。 */
    if (dirfd != AT_FDCWD) { errno = EBADF; return -1; }
    return _stat64(path, st) == 0 ? 0 : -1;
}

ssize_t dbox_raw_readlinkat(int dirfd, const char *path, char *buf, size_t sz)
{
    /* Windows 无 readlinkat；符号链接解析在 core 的调用方（pathmap）对
     * Windows 传入原始路径即可（NT 路径解析由 Win32 层处理）。 */
    (void)dirfd; (void)path; (void)buf; (void)sz;
    errno = EINVAL;
    return -1;
}

int dbox_raw_openat(int dirfd, const char *path, int flags, mode_t mode)
{
    if (dirfd != AT_FDCWD) { errno = EBADF; return -1; }
    return _open(path, flags, mode);
}

ssize_t dbox_raw_write(int fd, const void *buf, size_t n)
{
    return _write(fd, buf, n);
}

int dbox_raw_close(int fd)
{
    if (fd_is_socket(fd)) return closesocket((SOCKET)(uintptr_t)fd);
    return _close(fd);
}

int dbox_raw_socket(int domain, int type, int proto)
{
    SOCKET s = socket(domain, type, proto);
    return (int)(intptr_t)s;
}

int dbox_raw_connect(int fd, const struct sockaddr *sa, socklen_t sl)
{
    return connect((SOCKET)(uintptr_t)fd, sa, sl);
}

int dbox_raw_setsockopt(int fd, int level, int optname, const void *optval,
                        socklen_t optlen)
{
    return setsockopt((SOCKET)(uintptr_t)fd, level, optname, (const char *)optval, optlen);
}

int dbox_raw_getsockopt(int fd, int level, int optname, void *optval,
                        socklen_t *optlen)
{
    return getsockopt((SOCKET)(uintptr_t)fd, level, optname, (char *)optval, optlen);
}

ssize_t dbox_raw_sendto(int fd, const void *buf, size_t n, int flags,
                        const struct sockaddr *sa, socklen_t sl)
{
    int r = send((SOCKET)(uintptr_t)fd, (const char *)buf, (int)n, flags);
    return r < 0 ? -1 : (ssize_t)r;
}

ssize_t dbox_raw_recvfrom(int fd, void *buf, size_t n, int flags,
                          struct sockaddr *sa, socklen_t *sl)
{
    int r = recv((SOCKET)(uintptr_t)fd, (char *)buf, (int)n, flags);
    return r < 0 ? -1 : (ssize_t)r;
}

int dbox_raw_fcntl(int fd, int cmd, long arg)
{
    if (fd_is_socket(fd)) {
        u_long mode = arg ? 1 : 0;
        return ioctlsocket((SOCKET)(uintptr_t)fd, FIONBIO, &mode) == 0 ? 0 : -1;
    }
    /* 文件 fd：只支持非阻塞设置（core 用 F_GETFL/F_SETFL + O_NONBLOCK 于 socket） */
    errno = EINVAL;
    return -1;
}

int dbox_raw_poll(struct pollfd *fds, unsigned long nfds, int timeout_ms)
{
    return WSAPoll(fds, (ULONG)nfds, timeout_ms);
}