/* t_watch.c — 看护 fd 被宿主复用时，不得误判 launcher 死亡。
 *
 * 背景（devecocli 卡在 "Start generating p12" 的根因）：沙箱进程 exec 后会重新
 * 武装看护线程，它读的是 launcher 传下来的 DYNOBOX_WATCH_FD。宿主程序在 exec
 * 前后会"关闭该 fd + 复用同一数字"：node 的 spawn 用 close-on-exec 让内核关掉
 * 它，紧接着 JDK/node 的 open() 又把最小空闲 fd 占走。旧实现只校验 F_GETFD，
 * 于是把"读到普通文件 EOF"当成"launcher 已死"，kill(-pgid, SIGKILL) 抹掉整棵
 * 进程树 —— 外部表现就是命令毫无输出地消失。
 *
 * 关键细节：关闭必须用**裸 syscall**。走 libc 的 close() 会成为本进程的第一次
 * 钩子调用，dynobox 的 late_init 会在那一刻先武装看护（此时 fd 还是真管道），
 * 之后怎么改都晚了 —— 真实场景里这一步是内核在 exec 时完成的，不经过钩子。
 *
 * 退出码：0 = 正常存活；77 = 不在沙箱内（跳过）；其它 = 失败。
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void)
{
    const char *wf = getenv("DYNOBOX_WATCH_FD");
    if (!wf || !wf[0]) {
        printf("SKIP: not sandboxed (no DYNOBOX_WATCH_FD)\n");
        return 77;
    }
    int fd = atoi(wf);
    if (fd < 3 || fd > 1023) {
        printf("SKIP: unusable watch fd %d\n", fd);
        return 77;
    }

    /* 1) 内核在 exec 时关闭看护 fd —— 用裸 syscall，避免提前触发 late_init */
    syscall(SYS_close, fd);

    /* 2) 紧接着的 open 复用同一 fd 号（JDK/node 启动时的常见行为） */
    int dev = (int)syscall(SYS_openat, AT_FDCWD, "/dev/null", O_RDONLY, 0);
    if (dev < 0) {
        perror("open /dev/null");
        return 2;
    }
    if (dev != fd) {
        if (syscall(SYS_dup3, dev, fd, 0) < 0) {
            perror("dup3");
            return 2;
        }
        syscall(SYS_close, dev);
    }
    printf("watch_fd=%d opened=%d\n", fd, dev);
    fflush(stdout);
    {
        struct stat st;
        long r = syscall(SYS_newfstatat, fd, "", &st, 0x1000);
        printf("after-reuse: rc=%ld dev=%llu ino=%llu\n", r,
               (unsigned long long)st.st_dev, (unsigned long long)st.st_ino);
        fflush(stdout);
    }

    /* 3) 第一次走 libc 钩子：dynobox 在这里武装看护 */
    (void)access("/dev/null", F_OK);

    /* 4) 误判窗口：旧实现 250ms 轮询内即 kill 整组 */
    usleep(1200 * 1000);

    printf("alive\n");
    fflush(stdout);
    return 0;
}
