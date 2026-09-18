/* t_adversarial.c — 对抗性边界探针（在沙箱内运行）。
 *
 * 每个子命令尝试一种绕过手段去读取"禁读哨兵文件"，输出结果并按 README
 * 「安全边界」的声明判定是否**符合预期**：
 *
 *   must-block : 协作式程序经受控 API 的正常请求，策略必须拦住
 *                -> 结果为 blocked 才算通过
 *   boundary   : README 已声明的机制限制（内联 syscall / 裸 exec / 显式
 *                dlopen libc 取原始符号），绕过属预期
 *                -> 结果为 leaked 才算通过（边界若被意外堵上会报出来，
 *                   便于同步更新文档）
 *
 * 退出码：0 = 与预期一致，1 = 不一致，2 = 用法错误。
 * 输出：  ADV <technique> expect=<must-block|boundary> result=<blocked|leaked>
 *
 * 用法：t_adversarial <technique> <sentinel-path> <allow-dir>
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <dlfcn.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <linux/stat.h>

#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif
/* musl 不声明 statx()：这里走 libc 入口（会被拦截层看到）而非裸 syscall */
extern int statx(int, const char *, int, unsigned int, struct statx *)
    __attribute__((weak));

#define MARK "TOP-SECRET"

static const char *g_sent, *g_allow;

static int has_mark(const char *b, ssize_t n)
{
    return n > 0 && strstr(b, MARK) != NULL;
}

static int slurp(int fd)
{
    char b[256];
    if (fd < 0) return 0;
    ssize_t n = read(fd, b, sizeof b - 1);
    close(fd);
    if (n <= 0) return 0;
    b[n] = 0;
    return has_mark(b, n);
}

/* fork+exec 捕获子进程 stdout，判断是否泄露。
 * raw_exec=1 时用裸 syscall execve（绕过 libc execve 钩子）。 */
static int run_capture(char *const argv[], int raw_exec, int wipe_preload)
{
    int pfd[2];
    if (pipe(pfd) != 0) return 0;
    pid_t p = fork();
    if (p == 0) {
        dup2(pfd[1], 1);
        close(pfd[0]);
        close(pfd[1]);
        if (wipe_preload) unsetenv("LD_PRELOAD");
        if (raw_exec) {
            char *ev[] = { (char *)"PATH=/bin:/usr/bin", NULL };
            syscall(SYS_execve, argv[0], argv, ev);
        } else {
            execv(argv[0], argv);
        }
        _exit(127);
    }
    close(pfd[1]);
    char b[512];
    ssize_t n = read(pfd[0], b, sizeof b - 1);
    close(pfd[0]);
    int st;
    waitpid(p, &st, 0);
    if (n > 0) { b[n] = 0; return has_mark(b, n); }
    return 0;
}

/* 输出结果并按预期给出退出码 */
static int finish(const char *tech, int expect_blocked, int leaked)
{
    printf("ADV %-16s expect=%-10s result=%s\n", tech,
           expect_blocked ? "must-block" : "boundary",
           leaked ? "leaked" : "blocked");
    fflush(stdout);
    return (expect_blocked ? !leaked : leaked) ? 0 : 1;
}

#define MUST_BLOCK 1
#define BOUNDARY   0

int main(int argc, char **argv)
{
    if (argc < 4) {
        fprintf(stderr, "usage: t_adversarial <technique> <sentinel> <allow-dir>\n");
        return 2;
    }
    const char *t = argv[1];
    g_sent = argv[2];
    g_allow = argv[3];

    char p[1024], q[1024];
    int leak = 0;

    /* ---------------- must-block：受控 API 的正常请求 ---------------- */
    if (!strcmp(t, "open")) {
        leak = slurp(open(g_sent, O_RDONLY));
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "openat")) {
        leak = slurp(openat(AT_FDCWD, g_sent, O_RDONLY));
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "fopen")) {
        FILE *f = fopen(g_sent, "r");
        if (f) {
            char b[256];
            leak = fgets(b, sizeof b, f) && has_mark(b, (ssize_t)strlen(b));
            fclose(f);
        }
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "access")) {
        leak = (access(g_sent, R_OK) == 0);
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "statx")) {
        struct statx st;
        leak = statx && statx(AT_FDCWD, g_sent, 0, STATX_BASIC_STATS, &st) == 0;
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "symlink")) {
        /* 链接建在允许区，但解析后指向禁区 -> 必须按真实路径拒绝 */
        snprintf(p, sizeof p, "%s/adv-escape-link", g_allow);
        unlink(p);
        symlink(g_sent, p);
        leak = slurp(open(p, O_RDONLY));
        unlink(p);
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "hardlink")) {
        snprintf(p, sizeof p, "%s/adv-escape-hard", g_allow);
        unlink(p);
        if (link(g_sent, p) == 0) { leak = slurp(open(p, O_RDONLY)); unlink(p); }
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "rename")) {
        snprintf(p, sizeof p, "%s/adv-escape-mv", g_allow);
        if (rename(g_sent, p) == 0) { leak = slurp(open(p, O_RDONLY)); rename(p, g_sent); }
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "chmod")) {
        chmod(g_sent, 0777);
        leak = slurp(open(g_sent, O_RDONLY));
        chmod(g_sent, 0644);
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "dotdot")) {
        snprintf(p, sizeof p, "%s/../%s", g_allow, "denied/secret.txt");
        leak = slurp(open(p, O_RDONLY));
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "cwd-rel")) {
        chdir(g_allow);
        leak = slurp(open("../denied/secret.txt", O_RDONLY));
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "proc-root")) {
        snprintf(p, sizeof p, "/proc/self/root%s", g_sent);
        leak = slurp(open(p, O_RDONLY));
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "proc-cwd")) {
        chdir(g_allow);
        leak = slurp(open("/proc/self/cwd/../denied/secret.txt", O_RDONLY));
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "exec-cat")) {
        char *av[] = { (char *)"/bin/cat", (char *)g_sent, NULL };
        leak = run_capture(av, 0, 0);
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "popen")) {
        snprintf(p, sizeof p, "/bin/cat %s", g_sent);
        FILE *f = popen(p, "r");
        if (f) {
            char b[256];
            leak = fgets(b, sizeof b, f) && has_mark(b, (ssize_t)strlen(b));
            pclose(f);
        }
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "system")) {
        snprintf(q, sizeof q, "%s/adv-sys-out", g_allow);
        unlink(q);
        snprintf(p, sizeof p, "/bin/cat %s > %s", g_sent, q);
        system(p);
        leak = slurp(open(q, O_RDONLY));
        unlink(q);
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "dlopen-lib")) {
        /* 经 dlopen 载入的第三方库内部发起 open，同样应受控 */
        snprintf(p, sizeof p, "%s/libadv_helper.so", g_allow);
        void *h = dlopen(p, RTLD_NOW);
        if (h) {
            int (*fn)(const char *) = (int (*)(const char *))dlsym(h, "adv_read_helper");
            if (fn) leak = fn(g_sent);
            dlclose(h);
        } else {
            fprintf(stderr, "dlopen(%s) failed: %s\n", p, dlerror());
        }
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "fork-noexec")) {
        /* fork 后不 exec：子进程继承沙箱状态，仍须受控 */
        int pfd[2];
        pipe(pfd);
        pid_t p = fork();
        if (p == 0) {
            int fd = open(g_sent, O_RDONLY);
            char b[128];
            ssize_t n = fd >= 0 ? read(fd, b, sizeof b - 1) : -1;
            if (n > 0) write(pfd[1], b, (size_t)n);
            _exit(0);
        }
        close(pfd[1]);
        char b[256];
        ssize_t n = read(pfd[0], b, sizeof b - 1);
        close(pfd[0]);
        int st;
        waitpid(p, &st, 0);
        if (n > 0) { b[n] = 0; leak = has_mark(b, n); }
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "wipe-preload")) {
        /* 清 LD_PRELOAD 后仍走 libc execve：exec 时应被重新注入 */
        char *av[] = { (char *)"/bin/cat", (char *)g_sent, NULL };
        leak = run_capture(av, 0, 1);
        return finish(t, MUST_BLOCK, leak);
    }
    if (!strcmp(t, "tamper-cfg")) {
        /* 改写 DYNOBOX_CFG 后再 exec：原策略应被重新注入，篡改无效 */
        setenv("DYNOBOX_CFG", "dGFtcGVyZWQ=", 1);
        char *av[] = { (char *)"/bin/cat", (char *)g_sent, NULL };
        leak = run_capture(av, 0, 0);
        return finish(t, MUST_BLOCK, leak);
    }

    if (!strcmp(t, "dlsym-next")) {
        /* dlsym(RTLD_NEXT) 从调用者之后搜索，命中的仍是本拦截层的 open，
         * 因此拿不到"原始"入口 —— 属于受控范围。 */
        int (*o)(const char *, int, ...) =
            (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open");
        leak = o ? slurp(o(g_sent, O_RDONLY)) : 0;
        return finish(t, MUST_BLOCK, leak);
    }

    /* ---------------- boundary：README 已声明的机制限制 ---------------- */
    if (!strcmp(t, "raw-openat")) {
#ifdef SYS_openat
        leak = slurp((int)syscall(SYS_openat, AT_FDCWD, g_sent, O_RDONLY, 0));
#endif
        return finish(t, BOUNDARY, leak);
    }
    if (!strcmp(t, "raw-statx")) {
#ifdef SYS_statx
        struct statx st;
        leak = syscall(SYS_statx, AT_FDCWD, g_sent, 0, STATX_BASIC_STATS, &st) == 0;
#endif
        return finish(t, BOUNDARY, leak);
    }
    if (!strcmp(t, "dlopen-libc")) {
        /* 显式加载 libc 本体并取其中的 open：完全绕开拦截层 */
        void *h = dlopen("/lib/ld-musl-aarch64.so.1", RTLD_LAZY);
        if (!h) h = dlopen("libc.so.6", RTLD_LAZY);
        if (!h) h = dlopen("libc.so", RTLD_LAZY);
        int (*o)(const char *, int, ...) = NULL;
        if (h) o = (int (*)(const char *, int, ...))dlsym(h, "open");
        leak = o ? slurp(o(g_sent, O_RDONLY)) : 0;
        return finish(t, BOUNDARY, leak);
    }
    if (!strcmp(t, "raw-exec")) {
        /* 裸 syscall execve + 清 LD_PRELOAD：子进程脱离沙箱 */
        char *av[] = { (char *)"/bin/cat", (char *)g_sent, NULL };
        leak = run_capture(av, 1, 1);
        return finish(t, BOUNDARY, leak);
    }

    fprintf(stderr, "unknown technique: %s\n", t);
    return 2;
}
