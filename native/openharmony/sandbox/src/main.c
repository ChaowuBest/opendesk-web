/* main.c — dynobox CLI.
 *
 * Subcommands:
 *   run         start a command inside the LD_PRELOAD sandbox
 *   endpoint    reference decision endpoint (HTTP and/or unix socket)
 *   debug-rules print the compiled policy / evaluate a path
 *   version
 */
#define _GNU_SOURCE
#include "dynobox.h"
#include "policy.h"
#include "pathmap.h"
#include "cfgio.h"
#include "endpoint.h"
#include "util.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/mman.h>

static const char *g_version = "1.0.0";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

static char *read_file(const char *path, char *err, size_t errsz)
{
    FILE *f = fopen(path, "rb");
    if (!f) { snprintf(err, errsz, "cannot open %s: %s", path, strerror(errno)); return NULL; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0 || n > 8 * 1024 * 1024) {
        fclose(f);
        snprintf(err, errsz, "%s: too large or unreadable", path);
        return NULL;
    }
    char *buf = dbox_malloc((size_t)n + 1);
    size_t rd = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[rd] = '\0';
    return buf;
}

static char *exe_dir(void)
{
    static char buf[PATH_MAX + 32];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
    if (n <= 0) return NULL;
    buf[n] = '\0';
    char *slash = strrchr(buf, '/');
    if (slash) *slash = '\0';
    return buf;
}

/* locate libdynobox.so next to the dynobox binary */
static char *find_preload_lib(void)
{
    static char buf[PATH_MAX + 32];
    const char *dir = getenv("DYNOBOX_LIB");
    if (dir && dir[0]) {
        snprintf(buf, sizeof buf, "%s", dir);
        return buf;
    }
    char *d = exe_dir();
    if (d) {
        int nw = snprintf(buf, sizeof buf, "%s", d);
        if (nw < 0 || (size_t)nw >= sizeof buf) return NULL;
        snprintf(buf + nw, sizeof buf - (size_t)nw, "/libdynobox.so");
        if (access(buf, R_OK) == 0) return buf;
    }
    snprintf(buf, sizeof buf, "./build/libdynobox.so");
    if (access(buf, R_OK) == 0) return buf;
    return NULL;
}

static void usage(FILE *out)
{
    fprintf(out,
"dynobox %s — LD_PRELOAD 文件访问控制沙箱 (OpenDesk dynobox 的 OpenHarmony 实现)\n"
"\n"
"用法（子命令与 Windows 版 dynobox 对齐）:\n"
"  dynobox run --policy <rules.toml> [选项] -- <命令> [参数...]\n"
"  dynobox endpoint [--port N] [--pipe 名字] [--unix PATH] [--default allow|deny] [--log FILE]\n"
"  dynobox debug-rules --policy <rules.toml> [--path P] [--access read|write|execute|all]\n"
"  dynobox network-status | network-ensure | network-setup --user-sid SID\n"
"  dynobox version\n"
"\n"
"run 选项（与 Windows 版同名同义）:\n"
"  --policy FILE      策略文件（TOML），规则直接使用真实路径\n"
"  --src DIR          兼容模式：仅切换子进程工作目录（无路径映射）\n"
"  --automount        接受但为 no-op（身份命名空间下恒等视图即默认行为）\n"
"  --upstream URL     ask 决策端点：http://host:port/path、unix://PATH、\n"
"                     或 pipe://名字（Windows 命名管道等价物，见 endpoint --pipe）\n"
"  --map OLD=NEW      接受但为 no-op（身份命名空间下无路径翻译）\n"
"  --del-to-trash     删除文件/目录时移入回收站目录（Windows 回收站等价物）\n"
"  --mount 盘符       接受但为 no-op（无盘符概念）\n"
"  --log FILE         沙箱诊断日志（--log-file 为别名；含全部拒绝记录）\n"
"  --tmp DIR          把沙箱内 /tmp 映射到宿主 DIR（可读可写，无需策略规则）\n"
"  -v                 每次放行也记录\n"
"\n"
"run 选项（扩展）:\n"
"  --default a|d      未命中规则的兜底（allow|deny），覆盖策略\n"
"  --net MODE         网络策略 allow|deny|loopback（默认 allow）\n"
"  --timeout-ms N     ask 超时（默认 2000，超时=拒绝，fail-closed）\n"
"  --cache-ttl N      ask 决策缓存秒数（默认 60，0=禁用）\n"
"  --grant-ttl N      端点子树授权默认 TTL 秒数（默认 300，上限 3600）\n"
"  --no-system-read   关闭内建系统目录读/执行允许清单\n"
"  --ro-dirs D1,D2     将宿主目录以只读方式暴露（身份命名空间下实现为\n"
"                      write/delete 拒绝，对应 FUSE 版的只读 bind 挂载）\n"
"  --tmp DIR           把沙箱内 /tmp（与 /tmp/*）映射到宿主 DIR：映射区总是\n"
"                      可读可写，无需策略规则（OpenHarmony 的 /tmp 为只读挂载）\n"
"  --del-to-trash      删除文件/目录时移入回收站目录（Windows 回收站等价物）\n"
"  --trash-dir DIR     回收站目录（OpenDesk 统一回收站，与 Windows/Linux 版同\n"
"                      格式；等价于 --trash）\n"
"  --trash-exclude DIR 删除分流命中该目录前缀时直接真删、不入回收站（可重复；\n"
"                      已知临时目录内建默认，宿主还会显式传入）\n"
"  --cwd DIR          子进程工作目录（默认：--src 模式为 DIR，否则当前目录）\n"
"\n"
"说明: mount 子命令不适用于 OpenHarmony（虚拟化逐进程生效，无虚拟卷/盘符）；\n"
"network-* 为兼容 Windows 启动脚本的 no-op（本平台回环访问默认可用）。\n"
, g_version);
}

/* ------------------------------------------------------------------ */
/* policy plumbing shared by run/debug-rules                            */
/* ------------------------------------------------------------------ */

typedef struct {
    const char *policy_file;
    const char *src_dir;        /* deprecated alias: chdir only */
    const char *upstream;
    int default_allow;   /* -1 unset */
    int net;             /* -1 unset; else NET_* */
    int timeout_ms, cache_ttl, grant_ttl;   /* -1 unset */
    int no_system_read;
    const char *cwd;
    const char *log_file;
    const char *ro_dirs;
    const char *tmp_dir;
    int del_to_trash;
    const char *trash_dir;
    /* --trash-exclude 累积（可重复）：':' 分隔拼接入 DYNOBOX_TRASH_EXCLUDE，
     * 原生删除分流命中清单直接真删（已知临时目录由宿主传入，内建默认见
     * preload.c 的 trash 排除初始化） */
    char trash_exclude[4096];
    int verbose;
} run_opts_t;

static int apply_opts(dbox_policy_t *p, const run_opts_t *o,
                      char *err, size_t errsz)
{
    if (o->upstream) {
        dbox_free(p->ask_endpoint);
        p->ask_endpoint = dbox_strdup(o->upstream);
    }
    if (o->default_allow >= 0)
        p->default_perm = o->default_allow ? PERM_ALLOW : PERM_DENY;
    if (o->net >= 0) p->net_mode = o->net;
    if (o->timeout_ms >= 0) p->ask_timeout_ms = o->timeout_ms;
    if (o->cache_ttl >= 0) p->cache_ttl_s = o->cache_ttl;
    if (o->grant_ttl >= 0) p->grant_ttl_s = o->grant_ttl;
    if (o->no_system_read) p->system_read = 0;
    return 0;
}

static int load_policy(const run_opts_t *o, dbox_policy_t *p,
                       char *err, size_t errsz)
{
    dbox_policy_init(p);
    if (o->policy_file) {
        char *text = read_file(o->policy_file, err, errsz);
        if (!text) return -1;
        if (dbox_policy_load_toml(text, p, err, errsz) != 0) {
            dbox_free(text);
            return -1;
        }
        dbox_free(text);
    }
    return 0;
    return 0;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

static volatile sig_atomic_t g_sig = 0;
static volatile sig_atomic_t g_child_pgid = 0;
static void on_sig(int s) { g_sig = s; }

/* mkdir -p：逐组件创建目录（回收站目录自动创建用） */
static int mkdir_p(const char *path)
{
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s", path);
    size_t len = strlen(tmp);
    while (len > 1 && tmp[len - 1] == '/') tmp[--len] = 0;
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST) { *p = '/'; return -1; }
            *p = '/';
        }
    }
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST) return -1;
    return access(tmp, R_OK | W_OK) == 0 ? 0 : -1;
}

static int cmd_run(int argc, char **argv)
{
    run_opts_t o;
    memset(&o, 0, sizeof o);
    o.default_allow = -1;
    o.net = -1;
    o.timeout_ms = o.cache_ttl = o.grant_ttl = -1;
    int automount = 0, have_mount = 0;

    int cmdi = -1;
    for (int i = 0; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { cmdi = i + 1; break; }
        if (strcmp(argv[i], "--policy") == 0 && i + 1 < argc) o.policy_file = argv[++i];
        else if (strcmp(argv[i], "--src") == 0 && i + 1 < argc) o.src_dir = argv[++i];
        else if (strcmp(argv[i], "--upstream") == 0 && i + 1 < argc) o.upstream = argv[++i];
        else if (strcmp(argv[i], "--automount") == 0) automount = 1;
        else if (strcmp(argv[i], "--del-to-trash") == 0) {
            /* 删除落到回收站目录（Windows 回收站的等价物） */
            o.del_to_trash = 1;
        }
        else if (strcmp(argv[i], "--trash") == 0 && i + 1 < argc) o.trash_dir = argv[++i];
        else if (strcmp(argv[i], "--trash-dir") == 0 && i + 1 < argc) o.trash_dir = argv[++i];
        else if (strcmp(argv[i], "--trash-exclude") == 0 && i + 1 < argc) {
            /* 可重复：逐条归一化拼接（':' 分隔）；条数/总长超限时拒绝启动
             * 而非静默截断（截断会把"排除"变成"部分排除"，用户难以察觉） */
            char *n = dbox_normpath(argv[++i]);
            if (!n || n[0] != '/') {
                fprintf(stderr, "dynobox: --trash-exclude 需要绝对路径: %s\n", argv[i]);
                free(n);
                return 2;
            }
            {
                size_t used = strlen(o.trash_exclude);
                size_t need = strlen(n) + 2;
                if (used + need >= sizeof o.trash_exclude) {
                    fprintf(stderr, "dynobox: --trash-exclude 条目过多（上限 %zu 字节）\n",
                            sizeof o.trash_exclude);
                    free(n);
                    return 2;
                }
                if (used > 0) o.trash_exclude[used++] = ':';
                snprintf(o.trash_exclude + used, sizeof o.trash_exclude - used, "%s", n);
            }
            dbox_free(n);
        }
        else if (strcmp(argv[i], "--mount") == 0 && i + 1 < argc) {
            have_mount = 1; i++;
        }
        else if (strcmp(argv[i], "--map") == 0) {
            /* mapping removed in the identity namespace: accepted as no-op */
            fprintf(stderr, "dynobox: --map 在本平台上为 no-op（无路径映射）\n");
            if (i + 1 < argc) i++;
        }
        else if (strcmp(argv[i], "--default") == 0 && i + 1 < argc) {
            i++;
            if (strcmp(argv[i], "allow") == 0) o.default_allow = 1;
            else if (strcmp(argv[i], "deny") == 0) o.default_allow = 0;
            else { fprintf(stderr, "dynobox: --default 取值 allow|deny\n"); return 2; }
        }
        else if (strcmp(argv[i], "--net") == 0 && i + 1 < argc) {
            i++;
            if (strcmp(argv[i], "allow") == 0) o.net = NET_ALLOW;
            else if (strcmp(argv[i], "deny") == 0) o.net = NET_DENY;
            else if (strcmp(argv[i], "loopback") == 0) o.net = NET_LOOPBACK;
            else { fprintf(stderr, "dynobox: --net 取值 allow|deny|loopback\n"); return 2; }
        }
        else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) o.timeout_ms = atoi(argv[++i]);
        else if (strcmp(argv[i], "--cache-ttl") == 0 && i + 1 < argc) o.cache_ttl = atoi(argv[++i]);
        else if (strcmp(argv[i], "--grant-ttl") == 0 && i + 1 < argc) o.grant_ttl = atoi(argv[++i]);
        else if (strcmp(argv[i], "--no-system-read") == 0) o.no_system_read = 1;
        else if (strcmp(argv[i], "--ro-dirs") == 0 && i + 1 < argc) o.ro_dirs = argv[++i];
        else if (strcmp(argv[i], "--cwd") == 0 && i + 1 < argc) o.cwd = argv[++i];
        else if ((strcmp(argv[i], "--log") == 0 || strcmp(argv[i], "--log-file") == 0) && i + 1 < argc) o.log_file = argv[++i];
        else if (strcmp(argv[i], "--tmp") == 0 && i + 1 < argc) o.tmp_dir = argv[++i];
        else if (strcmp(argv[i], "-v") == 0) o.verbose = 1;
        else {
            fprintf(stderr, "dynobox run: 未知参数 `%s`\n", argv[i]);
            usage(stderr);
            return 2;
        }
    }
    if (cmdi < 0 || cmdi >= argc) {
        fprintf(stderr, "dynobox run: `--` 后缺少要执行的命令\n");
        return 2;
    }
    if (have_mount)
        fprintf(stderr, "dynobox: --mount 在本平台上为 no-op（无盘符概念，虚拟化逐进程生效）\n");

    char err[512];
    dbox_policy_t pol;
    if (load_policy(&o, &pol, err, sizeof err) != 0) {
        fprintf(stderr, "dynobox: %s\n", err);
        return 2;
    }
    if (automount) {
        /* identity namespace is the default view; --automount is accepted
         * for Windows-parity command lines and is effectively a no-op */
        fprintf(stderr, "dynobox: --automount 为本平台默认行为（恒等视图），no-op\n");
    }
    if (apply_opts(&pol, &o, err, sizeof err) != 0) {
        fprintf(stderr, "dynobox: %s\n", err);
        return 2;
    }
    /* --ro-dirs: inject read-only directories as leading write-deny rules
     * (identity namespace has no mount primitive; must happen before
     * dbox_cfg_encode serializes the policy into the child environment) */
    if (dbox_policy_prepend_ro_dirs(&pol, o.ro_dirs) != 0) {
        fprintf(stderr, "dynobox: --ro-dirs 规则注入失败（内存不足）\n");
        dbox_policy_free(&pol);
        return 2;
    }

    char *lib = find_preload_lib();
    if (!lib) {
        fprintf(stderr, "dynobox: 找不到 libdynobox.so（可用 DYNOBOX_LIB 指定）\n");
        return 2;
    }
    char *lib_abs = dbox_normpath(lib);
    if (lib_abs[0] != '/') {
        char cwd[PATH_MAX];
        if (getcwd(cwd, sizeof cwd) == NULL) cwd[0] = 0;
        char *j = dbox_path_join(cwd, lib_abs);
        dbox_free(lib_abs);
        lib_abs = j;
    }

    char *cfg = dbox_cfg_encode(&pol);
    if (!cfg) { fprintf(stderr, "dynobox: 配置序列化失败\n"); return 2; }

    /* BUG-015：编码后的策略注入 DYNOBOX_CFG（base64，约 ×4/3 膨胀）。超过 64KB
     * 会溢出沙箱侧固定缓冲并被静默截断，导致策略失效（fail-open）。此处主动检查
     * 并 fail-loud 报错退出，而不是让子进程"看似沙箱化、实则裸奔"地继续执行。 */
    if (strlen(cfg) >= 65536) {
        fprintf(stderr,
                "dynobox: 策略序列化后为 %zu 字节，超过 64KB 上限（沙箱无法承载）。\n"
                "  请精简策略：拆分过长的 endpoint URL / path，或减少规则数量。\n",
                strlen(cfg));
        dbox_free(cfg);
        dbox_policy_free(&pol);
        return 2;
    }

    /* child environment */
    setenv("LD_PRELOAD", lib_abs, 1);
    setenv("DYNOBOX_CFG", cfg, 1);
    setenv("DYNOBOX_SANDBOX", "1", 1);
    setenv("SBX_ROOT", "/", 1);
    if (o.src_dir) {
        char *abs = dbox_normpath(o.src_dir);
        if (abs[0] != '/') {
            char cwd[PATH_MAX];
            if (getcwd(cwd, sizeof cwd) == NULL) cwd[0] = 0;
            char *j = dbox_path_join(cwd, abs);
            dbox_free(abs);
            abs = j;
        }
        setenv("SBX_REAL_SRC", abs, 1);
        dbox_free(abs);
    } else {
        unsetenv("SBX_REAL_SRC");
    }
    if (o.log_file) setenv("DYNOBOX_LOG", o.log_file, 1);
    if (o.tmp_dir) {
        char *n = dbox_normpath(o.tmp_dir);
        if (!n || n[0] != '/' || access(n, R_OK | W_OK) != 0) {
            fprintf(stderr, "dynobox: --tmp 目录不可用（需已存在且可读写）: %s\n",
                    o.tmp_dir);
            dbox_free(n);
            dbox_policy_free(&pol);
            return 2;
        }
        setenv("DYNOBOX_TMP", n, 1);
        dbox_free(n);
    }
    if (o.del_to_trash) {
        /* 回收站目录优先级：--trash/--trash-dir 显式参数 > 已注入的
         * DYNOBOX_TRASH 环境变量 > $HOME/Trash 兜底。历史问题（BUG-021）：
         * 用户在 launcher 层设了 DYNOBOX_TRASH 后再加 --del-to-trash（无
         * --trash-dir），原实现直接用 $HOME/Trash 覆盖用户 env，导致三种
         * 配置方式行为不一致。现在显式参数优先、env 次之、兜底最后。 */
        char tb[PATH_MAX];
        const char *td = o.trash_dir;
        if (!td || !td[0]) td = getenv("DYNOBOX_TRASH");
        if (!td || !td[0]) {
            const char *home = getenv("HOME");
            if (home && home[0]) {
                snprintf(tb, sizeof tb, "%s/Trash", home);
                td = tb;
            }
        }
        if (!td || !td[0]) {
            fprintf(stderr, "dynobox: --del-to-trash 需要 --trash 目录或 HOME\n");
            dbox_policy_free(&pol);
            return 2;
        }
        char *n = dbox_normpath(td);
        if (!n || n[0] != '/' || mkdir_p(n) != 0 || access(n, R_OK | W_OK) != 0) {
            fprintf(stderr, "dynobox: 回收站目录不可用（已尝试创建但不可读写）: %s\n", td);
            dbox_free(n);
            dbox_policy_free(&pol);
            return 2;
        }
        setenv("DYNOBOX_TRASH", n, 1);
        dbox_free(n);
    }
    if (o.trash_exclude[0]) setenv("DYNOBOX_TRASH_EXCLUDE", o.trash_exclude, 1);
    if (o.verbose) setenv("DYNOBOX_VERBOSE", "1", 1);

    /* watchdog pipe: launcher holds the write end; sandboxed processes
     * inherit the read end and kill their subtree when it EOFs */
    int pfd[2];
    if (pipe2(pfd, 0) != 0) { perror("pipe2"); return 2; }
    int rfd = pfd[0], wfd = pfd[1];
    fcntl(wfd, F_SETFD, FD_CLOEXEC);          /* must not leak past exec */
    fcntl(rfd, F_SETFD, 0);                    /* must survive exec */
    char wfdenv[32];
    snprintf(wfdenv, sizeof wfdenv, "%d", rfd);
    setenv("DYNOBOX_WATCH_FD", wfdenv, 1);

    /* 看护 fd 的身份指纹 + launcher pid。exec 后该 fd 号可能被宿主程序关闭并
     * 复用（node spawn 的 close_fds 关掉它，紧接着 JDK/node 的 open() 又把同一
     * 个数字占走），子进程里光看 F_GETFD 分不清"还是那条看护管道"与"已被复用"，
     * 会把读到别的对象 EOF 误判成 launcher 退出而 kill 整棵树。把读端的
     * st_dev/st_ino 与 launcher pid 一并传下去，看护据此校验。 */
    struct stat wst;
    if (fstat(rfd, &wst) == 0) {
        char wid[64];
        snprintf(wid, sizeof wid, "%llu:%llu",
                 (unsigned long long)wst.st_dev,
                 (unsigned long long)wst.st_ino);
        setenv("DYNOBOX_WATCH_ID", wid, 1);
    }

    /* shared ask-state region: grants + decision cache shared by the whole
     * sandbox tree (parity: the Windows manager holds this state) */
    int shm_fd = dbox_shared_create();
    if (shm_fd >= 0) {
        fcntl(shm_fd, F_SETFD, 0);             /* must survive exec */
        char shmenv[32];
        snprintf(shmenv, sizeof shmenv, "%d", shm_fd);
        setenv("DYNOBOX_SHM_FD", shmenv, 1);
    }

    /* child cwd */
    const char *chdir_to = o.cwd;
    if (!chdir_to && o.src_dir) chdir_to = o.src_dir;

    fflush(NULL);
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 2; }
    if (pid == 0) {
        /* child */
        close(wfd);
        setpgid(0, 0);
#if defined(__linux__)
        prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
#endif
        if (chdir_to && chdir(chdir_to) != 0) {
            fprintf(stderr, "dynobox: chdir %s: %s\n", chdir_to, strerror(errno));
            _exit(126);
        }
    execvp(argv[cmdi], &argv[cmdi]);
    fprintf(stderr, "dynobox: exec %s: %s\n", argv[cmdi], strerror(errno));
    _exit(126);
}

    /* parent */
    close(rfd);
    setpgid(pid, pid);          /* in case the child raced us */
    g_child_pgid = pid;

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_sig;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    int status = 0;
    for (;;) {
        if (g_sig) {
            kill(-g_child_pgid, SIGKILL);
            g_sig = 0;
        }
        pid_t r = waitpid(pid, &status, 0);
        if (r == pid) break;
        if (r < 0 && errno == EINTR) continue;
        if (r < 0) { status = -1; break; }
    }

    /* reap stragglers: kill the whole group, then close the watchdog pipe
     * so any setsid'd descendants with a watchdog thread also die */
    kill(-g_child_pgid, SIGKILL);
    close(wfd);
    unsetenv("LD_PRELOAD");
    dbox_free(lib_abs);
    dbox_free(cfg);
    dbox_policy_free(&pol);

    if (status < 0) return 127;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 127;
}

/* ------------------------------------------------------------------ */
/* endpoint                                                            */
/* ------------------------------------------------------------------ */

static int cmd_endpoint(int argc, char **argv)
{
    dbox_endpoint_opts_t o;
    memset(&o, 0, sizeof o);
    o.port = 0;
    o.unix_path = "";
    o.default_perm = PERM_DENY;
    const char *pipe_name = NULL;
    int port_given = 0;
    for (int i = 0; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) { o.port = atoi(argv[++i]); port_given = 1; }
        else if (strcmp(argv[i], "--unix") == 0 && i + 1 < argc) o.unix_path = argv[++i];
        else if (strcmp(argv[i], "--pipe") == 0 && i + 1 < argc) pipe_name = argv[++i];
        else if (strcmp(argv[i], "--grant-ttl") == 0 && i + 1 < argc) o.grant_ttl = atol(argv[++i]);
        else if (strcmp(argv[i], "--log") == 0 || strcmp(argv[i], "--log-file") == 0) {
            if (i + 1 < argc) o.log_file = argv[++i];
        }
        else if (strcmp(argv[i], "--default") == 0 && i + 1 < argc) {
            i++;
            if (strcmp(argv[i], "allow") == 0) o.default_perm = PERM_ALLOW;
            else if (strcmp(argv[i], "deny") == 0) o.default_perm = PERM_DENY;
            else { fprintf(stderr, "dynobox: --default 取值 allow|deny\n"); return 2; }
        } else {
            fprintf(stderr, "dynobox endpoint: 未知参数 `%s`\n", argv[i]);
            return 2;
        }
    }
    if (pipe_name) {
        /* Windows named pipe parity: \\.\pipe\NAME -> <pipe dir>/NAME.sock */
        (void)dbox_pipe_dir();   /* creates the directory */
        static char pp[256];
        dbox_pipe_path(pipe_name, pp, sizeof pp);
        o.unix_path = pp;
        unlink(pp);
    }
    /* Windows default: endpoint listens on 8080 when no transport is given */
    if (!port_given && !o.unix_path[0]) o.port = 8080;
    return dbox_endpoint_serve(&o);
}

/* ------------------------------------------------------------------ */
/* debug-rules                                                         */
/* ------------------------------------------------------------------ */

static int parse_access_cli(const char *s, int *acc)
{
    if (strcmp(s, "read") == 0) *acc = ACC_READ;
    else if (strcmp(s, "write") == 0) *acc = ACC_WRITE;
    else if (strcmp(s, "execute") == 0) *acc = ACC_EXEC;
    else if (strcmp(s, "all") == 0) *acc = ACC_ALL;
    else return -1;
    return 0;
}


static int cmd_debug_rules(int argc, char **argv)
{
    run_opts_t o;
    memset(&o, 0, sizeof o);
    o.default_allow = -1;
    const char *probe_path = NULL;
    const char *probe_access = NULL;
    for (int i = 0; i < argc; i++) {
        if (strcmp(argv[i], "--policy") == 0 && i + 1 < argc) o.policy_file = argv[++i];
        else if (strcmp(argv[i], "--src") == 0 && i + 1 < argc) o.src_dir = argv[++i];
        else if (strcmp(argv[i], "--path") == 0 && i + 1 < argc) probe_path = argv[++i];
        else if (strcmp(argv[i], "--access") == 0 && i + 1 < argc) probe_access = argv[++i];
        else if (strcmp(argv[i], "--upstream") == 0 && i + 1 < argc) o.upstream = argv[++i];
        else if (strcmp(argv[i], "--default") == 0 && i + 1 < argc) {
            i++;
            o.default_allow = strcmp(argv[i], "allow") == 0;
        } else {
            fprintf(stderr, "dynobox debug-rules: 未知参数 `%s`\n", argv[i]);
            return 2;
        }
    }
    char err[512];
    dbox_policy_t pol;
    if (load_policy(&o, &pol, err, sizeof err) != 0) {
        fprintf(stderr, "dynobox: %s\n", err);
        return 2;
    }
    if (apply_opts(&pol, &o, err, sizeof err) != 0) {
        fprintf(stderr, "dynobox: %s\n", err);
        return 2;
    }

    printf("default = %s   system_read = %s   net = %s\n",
           dbox_perm_name(pol.default_perm),
           pol.system_read ? "on" : "off",
           pol.net_mode == NET_ALLOW ? "allow" :
           pol.net_mode == NET_DENY ? "deny" : "loopback");
    if (pol.ask_endpoint)
        printf("ask = %s (timeout %dms, cache %ds, grant-ttl %ds)\n",
               pol.ask_endpoint, pol.ask_timeout_ms, pol.cache_ttl_s,
               pol.grant_ttl_s);
    printf("namespace = identity (paths are used as-is)\n");
    for (int i = 0; i < pol.nrules; i++)
        printf("rule  %-30s %-7s %s\n", pol.rules[i].path,
               dbox_access_name(pol.rules[i].acc),
               dbox_perm_name(pol.rules[i].perm));

    if (probe_path) {
        int acc = ACC_ALL;
        if (probe_access) {
            if (parse_access_cli(probe_access, &acc) != 0) {
                fprintf(stderr, "dynobox: 无效 access `%s`\n", probe_access);
                return 2;
            }
        }
        char *vn = dbox_normpath(probe_path);
        printf("\nprobe %s (%s)\n", vn, dbox_access_name(acc));
        for (int i = 0; i < pol.nrules; i++) {
            if (!(pol.rules[i].acc & acc)) continue;
            int m = dbox_glob_match(pol.rules[i].path, vn);
            printf("  rule[%d] %-24s %-7s %s  %s\n", i, pol.rules[i].path,
                   dbox_access_name(pol.rules[i].acc),
                   dbox_perm_name(pol.rules[i].perm),
                   m ? "<== MATCH" : "");
            if (m) break;
        }
        dperm_t r = dbox_policy_eval_static(&pol, vn, acc);
        const char *via = "";
        if (r == PERM_ALLOW && pol.system_read && dbox_system_allow(vn, acc))
            via = " (system allowlist)";
        printf("  static => %s%s\n", dbox_perm_name(r), via);
    }
    return 0;
}

/* ------------------------------------------------------------------ */

/* ---- Windows loopback-exemption subcommands -------------------------- *
 * On Windows, AppContainer needs a one-time admin "network-ensure" step to
 * grant loopback access. On this platform (OpenHarmony) sandboxed
 * processes have loopback access by default (subject to [network] policy),
 * so these exist only to keep cross-platform launch scripts working. */
static int cmd_network_status(int argc, char **argv)
{
    (void)argc; (void)argv;
    printf("{\"configured\": true, \"userSid\": null, "
           "\"note\": \"loopback access needs no setup on this platform\"}\n");
    return 0;
}

static int cmd_network_ensure(int argc, char **argv)
{
    (void)argc; (void)argv;
    printf("configured=true\n");
    return 0;
}

static int cmd_network_setup(int argc, char **argv)
{
    const char *sid = NULL;
    for (int i = 0; i < argc; i++) {
        if (strcmp(argv[i], "--user-sid") == 0 && i + 1 < argc) sid = argv[++i];
        else { fprintf(stderr, "dynobox network-setup: 未知参数 `%s`\n", argv[i]); return 2; }
    }
    printf("ok (linux: no-op%s%s)\n", sid ? " for " : "", sid ? sid : "");
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 2) { usage(stderr); return 2; }
    if (strcmp(argv[1], "run") == 0) return cmd_run(argc - 2, argv + 2);
    if (strcmp(argv[1], "endpoint") == 0) return cmd_endpoint(argc - 2, argv + 2);
    if (strcmp(argv[1], "debug-rules") == 0) return cmd_debug_rules(argc - 2, argv + 2);
    if (strcmp(argv[1], "network-status") == 0) return cmd_network_status(argc - 2, argv + 2);
    if (strcmp(argv[1], "network-ensure") == 0) return cmd_network_ensure(argc - 2, argv + 2);
    if (strcmp(argv[1], "network-setup") == 0) return cmd_network_setup(argc - 2, argv + 2);
    if (strcmp(argv[1], "mount") == 0) {
        fprintf(stderr,
                "dynobox: mount 子命令不适用于 OpenHarmony —— 虚拟化是逐进程的"
                "（无虚拟卷/盘符），请使用 `dynobox run`\n");
        return 2;
    }
    if (strcmp(argv[1], "version") == 0 || strcmp(argv[1], "--version") == 0) {
        printf("dynobox %s\n", g_version);
        return 0;
    }
    if (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "help") == 0) {
        usage(stdout);
        return 0;
    }
    usage(stderr);
    return 2;
}
