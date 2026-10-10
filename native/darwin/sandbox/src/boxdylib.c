/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the software at http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/*
 * dynobox-darwin: 轻量动态沙箱（DYLD_INSERT_LIBRARIES interposing 实现）。
 *
 * 与 Linux/Windows dynobox 功能对齐：
 * - 沙箱内文件系统布局与宿主一致（透明路径，无虚拟根）；
 * - 读默认放行、工作区写放行、其余写按策略 ask/deny；
 * - 删除可送 OpenDesk 统一回收站（<opendesk>/trash/<taskId>），沙箱实例内新建
 *   文件删除时直接清除；
 * - exec 拦截：平台二进制（arm64e）/带库校验的二进制经 复制+adhoc 重签+缓存 后
 *   再 exec（否则 DYLD 插入被 dyld 静默忽略或被 AMFI 终止）；shebang 脚本改写为
 *   直接 exec 解释器，避免内核直接加载平台解释器绕过沙箱。
 *
 * 已知边界（与 LD_PRELOAD 类沙箱同级）：进程内直接 syscall、已打开 fd 的后续
 * 读写不在拦截范围；策略按调用时路径做检查。
 *
 * 配置（环境变量，由宿主 TS 层注入）：
 *   OPENDESK_SANDBOX_POLICY  策略 TOML 路径（缺省时整体 passthrough）
 *   OPENDESK_SANDBOX_LOG     日志路径（可省略）
 *   OPENDESK_SANDBOX_TRASH   =1 时删除送 OpenDesk 统一回收站
 *   OPENDESK_SANDBOX_TRASH_DIR  回收站目录（<opendesk>/trash/<taskId>，宿主每次
 *      拉起都注入；缺省回退 $HOME/.Trash）
 *   OPENDESK_SANDBOX_EXEC_CACHE  平台二进制重签缓存目录
 *       （默认 /Library/Caches/com.opendesk.sandbox/exec）
 */

#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld_images.h>
#include <mach-o/dyld.h>
#include <mach-o/fat.h>
#include <mach-o/getsect.h>
#include <mach-o/loader.h>
#include <mach/machine.h>
#include <pthread.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/attr.h>
#include <sys/event.h>
#include <signal.h>
#include <sys/param.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <sys/file.h>
#include <time.h>
#include <unistd.h>
#include <stdatomic.h>
#include <CommonCrypto/CommonDigest.h>

/* 共享 core（native/openharmony/sandbox/src，与 Linux/OpenHarmony 同一份源码）：
 * 策略 TOML 解析、路径 glob 匹配、小工具函数。I/O 经 rawio 抽象
 * （rawio_darwin.c 用 libc + boxdylib 的 is_internal 豁免）。 */
#include "dynobox.h"
#include "policy.h"
#include "ask.h"
#include "util.h"
#include "rawio.h"

/* <security/codesigning.h> 不在公开 SDK 中，内联所需的常量 */
#define CSMAGIC_EMBEDDED_SIGNATURE 0xfade0cc0

#ifndef PATH_MAX
#define PATH_MAX 1024
#endif

/*
 * libsystem_kernel 的原生 execve：interpose 环境下 dlsym(RTLD_NEXT) 会解析回
 * 替换函数自身（导致递归），所有 exec 路径必须经此直通内核。
 */
extern int __execve(const char *path, char *const argv[], char *const envp[]);
/* 本 dylib 的绝对路径（构造函数记录）：子进程注入强制重注入的来源。
 * macOS 蓝队 M4：沙箱内进程清掉 DYLD_INSERT_LIBRARIES 后 exec，新进程无注入
 * 完全脱管（Linux/OH 版的 build_envp 有强制重注入对齐）。exec 家族传 envp 时
 * 必须经 build_reinjected_env 强制补回本 dylib（strip_dyld_env 的刻意脱管除外）。 */
static char g_self_dylib[PATH_MAX] = { 0 };

static void record_self_dylib(void)
{
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
        const char *img = _dyld_get_image_name(i);
        if (!img) continue;
        /* 本 dylib 的特征：文件名 dynobox-darwin.dylib（打包/测试同名） */
        const char *slash = strrchr(img, '/');
        if (slash && strstr(slash, "dynobox-darwin.dylib")) {
            snprintf(g_self_dylib, sizeof g_self_dylib, "%s", img);
            return;
        }
    }
}

/* 构造剥离 DYLD_INSERT_LIBRARIES 的 envp（放行的工具链进程脱离沙箱注入） */
static char **build_stripped_env(char *const *envp)
{
    size_t count = 0;
    while (envp[count]) count++;
    char **out = malloc((count + 1) * sizeof(char *));
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < count; i++) {
        if (strncmp(envp[i], "DYLD_INSERT_LIBRARIES=", 22) == 0) continue;
        out[o++] = envp[i];
    }
    out[o] = NULL;
    return out;
}

/* 构造强制重注入的 envp：DYLD_INSERT_LIBRARIES 恒为本 dylib（覆盖调用方的
 * 篡改/缺失）。返回 malloc 数组（调用方 free）。g_self_dylib 未记录时原样
 * 复制（构造函数早期 exec 的窗口，此时注入必然由父进程 env 携带）。 */
static char **build_reinjected_env(char *const *envp)
{
    size_t count = 0;
    while (envp[count]) count++;
    char **out = malloc((count + 2) * sizeof(char *));
    if (!out) return NULL;
    size_t o = 0;
    bool have = false;
    for (size_t i = 0; i < count; i++) {
        if (strncmp(envp[i], "DYLD_INSERT_LIBRARIES=", 22) == 0) {
            if (!g_self_dylib[0]) { out[o++] = envp[i]; have = true; continue; }
            size_t need = 22 + strlen(g_self_dylib) + 1;
            char *entry = malloc(need);
            if (!entry) { out[o++] = envp[i]; have = true; continue; }
            snprintf(entry, need, "DYLD_INSERT_LIBRARIES=%s", g_self_dylib);
            out[o++] = entry;
            have = true;
        } else {
            out[o++] = envp[i];
        }
    }
    if (!have && g_self_dylib[0]) {
        size_t need = 22 + strlen(g_self_dylib) + 1;
        char *entry = malloc(need);
        if (entry) {
            snprintf(entry, need, "DYLD_INSERT_LIBRARIES=%s", g_self_dylib);
            out[o++] = entry;
        }
    }
    out[o] = NULL;
    return out;
}

static void bridge_executable_path_deps(const char *original, const char *copy);

/* 构造追加/覆盖 PYTHONHOME 的 envp（返回 malloc 数组，调用方 free） */
static char **envp_with_python_home(char *const *envp, const char *home)
{
    size_t count = 0;
    while (envp[count]) count++;
    size_t need = strlen(home) + 32;
    char *entry = malloc(need);
    if (!entry) return NULL;
    snprintf(entry, need, "PYTHONHOME=%s", home);
    char **out = malloc((count + 2) * sizeof(char *));
    if (!out) {
        free(entry);
        return NULL;
    }
    size_t o = 0;
    bool replaced = false;
    for (size_t i = 0; i < count; i++) {
        if (strncmp(envp[i], "PYTHONHOME=", 11) == 0) {
            out[o++] = entry; /* 覆盖：位置不变，值用新的 */
            replaced = true;
        } else {
            out[o++] = envp[i];
        }
    }
    if (!replaced) out[o++] = entry;
    out[o] = NULL;
    return out;
}

/* 释放 envp_with_python_home 的产出（只 free entry 和数组本身，其余引用原 envp） */
static void free_python_home_envp(char **envp_out)
{
    if (!envp_out) return;
    for (size_t i = 0; envp_out[i]; i++) {
        if (strncmp(envp_out[i], "PYTHONHOME=", 11) == 0) {
            free(envp_out[i]);
            /* 覆盖场景可能有多个 entry 指向同一块——break 防重复 free */
            break;
        }
    }
    free(envp_out);
}
static int scan_executable_path_max_ups(const char *original);
static char **envp_with_python_home(char *const *envp, const char *home);
static char **build_stripped_env(char *const *envp);
static void free_python_home_envp(char **envp_out);
static __thread int g_in_libc_spawn = 0;
extern int __posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                         const posix_spawnattr_t *attr, char *const argv[], char *const envp[]);

/* stat 时间戳：Linux 风格 st_mtim/st_birthtim 在 macOS 上的对应宏 */
#define ST_MTIM_SEC(st) ((st)->st_mtimespec.tv_sec)
#define ST_MTIM_NSEC(st) ((st)->st_mtimespec.tv_nsec)
#define ST_BIRTHTIM_SEC(st) ((st)->st_birthtimespec.tv_sec)
#define ST_BIRTHTIM_NSEC(st) ((st)->st_birthtimespec.tv_nsec)

#define ENV_POLICY "OPENDESK_SANDBOX_POLICY"
#define ENV_LOG "OPENDESK_SANDBOX_LOG"
#define ENV_TRASH "OPENDESK_SANDBOX_TRASH"
#define ENV_TRASH_DIR "OPENDESK_SANDBOX_TRASH_DIR"
#define ENV_TRASH_EXCLUDE "OPENDESK_SANDBOX_TRASH_EXCLUDE"
#define ENV_EXEC_CACHE "OPENDESK_SANDBOX_EXEC_CACHE"

#define DEFAULT_EXEC_CACHE "/private/tmp/opendesk-sandbox-exec"

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

static char g_log_path[PATH_MAX] = { 0 };
static pthread_mutex_t g_log_mutex = PTHREAD_MUTEX_INITIALIZER;

/* 线程局部内部操作深度：日志/缓存/回收站等沙箱自身 IO 不得再走策略检查 */
static __thread int g_internal_depth = 0;
static bool is_internal(void);
static void internal_begin(void);
static void internal_end(void);

static void slog(const char *fmt, ...)
{
    if (!g_log_path[0]) return;
    g_internal_depth++;
    va_list ap;
    va_start(ap, fmt);
    char prefix[160];
    struct timeval tv;
    gettimeofday(&tv, NULL);
    snprintf(prefix, sizeof(prefix), "[%ld.%03d pid=%d] ", (long)tv.tv_sec, (int)(tv.tv_usec / 1000), getpid());
    char body[1024];
    int blen = vsnprintf(body, sizeof(body), fmt, ap);
    va_end(ap);
    if (blen < 0) {
        g_internal_depth--; /* 提前返回也必须回退深度，否则该线程永久豁免策略 */
        return;
    }
    if (blen >= (int)sizeof(body)) blen = (int)sizeof(body) - 1;
    pthread_mutex_lock(&g_log_mutex);
    int fd = open(g_log_path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd >= 0) {
        /* 单次 write 拼接后输出，避免多线程交错 */
        char buf[1400];
        int total = snprintf(buf, sizeof(buf), "%s%.*s\n", prefix, blen, body);
        if (total > 0) (void)write(fd, buf, (size_t)(total < (int)sizeof(buf) ? total : (int)sizeof(buf) - 1));
        close(fd);
    }
    pthread_mutex_unlock(&g_log_mutex);
    g_internal_depth--;
}

static char *xstrdup(const char *s)
{
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

/* ── 策略引擎：复用共享 core（native/openharmony/sandbox/src） ──────────────
 * TOML 解析与路径 glob 匹配不再内嵌，改用 core：
 *   - dbox_policy_init / dbox_policy_load_toml（mini_toml 完整解析，含
 *     [[rules]]/[ask]/[network] 与未知表名 fail-loud 校验）
 *   - dbox_glob_match（路径 glob：** 跨层、* 单层、? 单字符）
 * 保留 macOS 特有判定外壳：/var↔/private/var 别名竞争、most-specific（最长
 * 模式前缀优先）语义、curl ask 传输——多年沉淀的行为，不因换引擎而改变。
 *
 * access 位：core ACC_READ/ACC_WRITE/ACC_EXEC 与旧 ACCESS_* 数值一致，直接用
 * core 名字。perm：core（ALLOW=0/ASK=1/DENY=2）与 boxdylib 历史值（DENY=0/
 * ASK=1/ALLOW=2）不同——most-specific 排序（同长度 deny>ask>allow）依赖
 * 历史数值，保留 _box 后缀常量并在加载时从 core 值换算。
 */
enum { PERM_DENY_box = 0, PERM_ASK_box = 1, PERM_ALLOW_box = 2 };

typedef struct {
    char *path; /* 绝对路径前缀，** 结尾表示整棵子树 */
    int access; /* ACC_* 位或 */
    int perm;   /* PERM_*_box */
} PolicyRule;

typedef struct {
    char *endpoint;
    char *token;
    long timeout_ms;
    PolicyRule *rules;
    size_t rule_count;
    size_t rule_capacity;
} Policy;

static Policy g_policy = { 0 };
static char g_policy_error[256] = { 0 };

static void policy_add_rule(Policy *p, const char *path, int access, int perm)
{
    if (p->rule_count == p->rule_capacity) {
        size_t cap = p->rule_capacity ? p->rule_capacity * 2 : 16;
        PolicyRule *grown = realloc(p->rules, cap * sizeof(PolicyRule));
        if (!grown) {
            /* OOM 静默丢规则会造成"该 deny 的没 deny"：记为解析错误 fail closed */
            snprintf(g_policy_error, sizeof(g_policy_error), "out of memory adding rule");
            return;
        }
        p->rules = grown;
        p->rule_capacity = cap;
    }
    PolicyRule *r = &p->rules[p->rule_count];
    char *copy = xstrdup(path);
    if (!copy) {
        snprintf(g_policy_error, sizeof(g_policy_error), "out of memory copying rule path");
        return; /* 不递增 rule_count：宁缺勿错（缺规则走兜底 ask，比 NULL 解引用安全） */
    }
    r->path = copy;
    r->access = access;
    r->perm = perm;
    p->rule_count++;
}

/* 经 core 的 dbox_policy_load_toml 解析（语法 + 表名 fail-loud 校验），
 * 再把规则平移进 boxdylib 的 Policy 视图（most-specific 判定需逐规则遍历，
 * 且 perm 数值体系不同）。返回 0 成功；-1 失败（g_policy_error 有原因）。 */
static int policy_parse(Policy *p, const char *text)
{
    char err[512];
    dbox_policy_t core_policy;
    dbox_policy_init(&core_policy);
    if (dbox_policy_load_toml(text, &core_policy, err, sizeof err) != 0) {
        snprintf(g_policy_error, sizeof(g_policy_error), "%s", err);
        dbox_policy_free(&core_policy);
        return -1;
    }
    /* [ask] 段（core 解析结果 → boxdylib 历史字段） */
    dbox_free(p->endpoint);
    dbox_free(p->token);
    p->endpoint    = core_policy.ask_endpoint ? xstrdup(core_policy.ask_endpoint) : NULL;
    p->token       = core_policy.ask_token ? xstrdup(core_policy.ask_token) : NULL;
    p->timeout_ms  = core_policy.ask_timeout_ms > 0 ? core_policy.ask_timeout_ms : 0;

    /* 规则平移：core PERM_ALLOW=0/ASK=1/DENY=2 → box DENY=0/ASK=1/ALLOW=2。
     * 注意 case 匹配的是 core 的枚举值，不能写成 _box 名（否则永远不命中）。 */
    for (int i = 0; i < core_policy.nrules; i++) {
        int perm_box;
        switch (core_policy.rules[i].perm) {
            case PERM_ALLOW: perm_box = PERM_ALLOW_box; break; /* core 0 → box 2 */
            case PERM_ASK:   perm_box = PERM_ASK_box;   break; /* core 1 → box 1 */
            default:         perm_box = PERM_DENY_box;  break; /* core 2 → box 0 */
        }
        policy_add_rule(p, core_policy.rules[i].path, core_policy.rules[i].acc, perm_box);
    }
    dbox_policy_free(&core_policy);
    if (g_policy_error[0]) return -1; /* 平移期间 OOM：fail closed */
    if (p->endpoint && p->token && p->timeout_ms <= 0) p->timeout_ms = 330000;
    return 0;
}

/*
 * 路径匹配语义（经 core 的 dbox_glob_match，glob 语义一致）：
 * pattern "**"      → 匹配一切
 * pattern "/a/星"   → 匹配 /a 与 /a 下整棵子树（星 = 双星号）
 * pattern "/a/b"    → 仅匹配 /a/b
 * 匹配基于调用时路径（不解析符号链接，与调用时路径语义一致）。
 */
static bool pattern_matches(const char *pattern, const char *path)
{
    return dbox_glob_match(pattern, path) != 0;
}

/*
 * 命中语义：最长模式前缀（最具体规则）优先，同长度按 deny > ask > allow。
 * 若纯按"最严优先"，工作区 allow 永远被兜底 / ** ask 遮蔽，Linux 端亦然（工作区
 * 写不弹审批），因此以模式长度为主排序键。
 */
static size_t pattern_base_len(const char *pattern)
{
    size_t plen = strlen(pattern);
    if (plen >= 3 && strcmp(pattern + plen - 3, "/**") == 0) return plen - 3;
    return plen;
}

/* 带模式长度的命中结果：perm + 匹配模式的 base 长度（用于跨别名比较特异性） */
struct PolicyHit {
    int perm;      /* -1 = 未命中 */
    size_t base_len;
};

static struct PolicyHit policy_lookup_detailed(const char *path, int access)
{
    struct PolicyHit hit = { -1, 0 };
    for (size_t i = 0; i < g_policy.rule_count; i++) {
        PolicyRule *r = &g_policy.rules[i];
        if ((r->access & access) == 0) continue;
        if (!pattern_matches(r->path, path)) continue;
        size_t len = pattern_base_len(r->path);
        slog("rule[%zu] hit: path=%s access=%d perm=%d (len=%zu) for %s", i, r->path, r->access, r->perm, len, path);
        if (hit.perm < 0 || len > hit.base_len || (len == hit.base_len && r->perm < hit.perm)) {
            hit.perm = r->perm;
            hit.base_len = len;
        }
    }
    return hit;
}


/* ── HTTP ask（curl 子进程；libcurl 链接进每个进程反而增重） ────────────── */
/* 请求构造（dbox_ask_build_request）与响应解析（dbox_ask_parse_response）
 * 走共享 core 的协议实现；本文件只负责 curl 传输。 */

/*
 * 同步 ask：POST {endpoint}，body {"token","path","access"}，响应 {"decision"}。
 * 返回 PERM_ALLOW_box / PERM_DENY_box；异常一律 DENY（fail closed）。
 * 经 posix_spawn 执行 /usr/bin/curl（系统工具不插桩，无递归风险）。
 */
static int ask_remote_internal(const char *path, int access);

static int ask_remote(const char *path, int access)
{
    /*
     * curl 的 spawn 与输出管道读取属于沙箱内部 IO，豁免策略检查防递归。
     * 串行化：多线程同时触发同一批 ask 时避免弹出重复审批（宿主 decide
     * 端点对同 key 有 pending 去重，但两个 curl 并发仍可能挤占弹窗队列）。
     */
    static pthread_mutex_t ask_mutex = PTHREAD_MUTEX_INITIALIZER;
    pthread_mutex_lock(&ask_mutex);
    internal_begin();
    int result = ask_remote_internal(path, access);
    internal_end();
    pthread_mutex_unlock(&ask_mutex);
    return result;
}

static int ask_remote_internal(const char *path, int access)
{
    if (!g_policy.endpoint || !g_policy.token) return PERM_DENY_box;
    /* 请求构造与响应解析统一走共享 core 的协议函数（与 Linux/OH/endpoint
     * 同一份实现）：严格 JSON 解析替代历史的 strstr("allow") 宽松子串匹配
     * （响应中任意位置的 "allow" 子串都会误判为放行），并支持 grants 下发
     * （响应携带的子树授权与 Linux/OH 语义一致地安装进策略）。 */
    char payload[PATH_MAX * 6 + 256];
    if (dbox_ask_build_request(payload, sizeof payload, path, access, g_policy.token) != 0) {
        return PERM_DENY_box;
    }
    size_t plen = strlen(payload);
    if (plen == 0 || plen >= sizeof(payload) - 1) return PERM_DENY_box;

    /* macOS curl 8.x 对 "--opt=VALUE" 粘连式解析有回归，统一 -m 空格分隔 */
    char max_time[32];
    snprintf(max_time, sizeof(max_time), "%ld", g_policy.timeout_ms / 1000 + 5);

    extern char **environ;
    posix_spawn_file_actions_t actions;
    if (posix_spawn_file_actions_init(&actions) != 0) return PERM_DENY_box;
    /* stdout/stderr → /dev/null，避免 curl 输出污染命令输出流 */
    if (posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) != 0 ||
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) != 0) {
        posix_spawn_file_actions_destroy(&actions);
        return PERM_DENY_box;
    }
    int pipefd[2];
    bool have_pipe = pipe(pipefd) == 0;
    if (have_pipe) {
        fcntl(pipefd[0], F_SETFD, FD_CLOEXEC);
        posix_spawn_file_actions_adddup2(&actions, pipefd[1], STDOUT_FILENO);
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
    }
    char *argv[] = { "curl", "-sS", "-X", "POST", "-H", NULL, "-d", payload, "-m", max_time, g_policy.endpoint, NULL };
    /* token 为 64 hex（宿主 crypto.randomBytes(32)），留余量防格式变化截断错配 */
    size_t token_len = strlen(g_policy.token);
    size_t auth_size = token_len + 32;
    char *auth_header = malloc(auth_size);
    if (!auth_header) return PERM_DENY_box;
    snprintf(auth_header, auth_size, "Authorization: Bearer %s", g_policy.token);
    argv[5] = auth_header;
    pid_t pid = -1;
    extern char **environ;
    int spawn_rc = posix_spawn(&pid, "/usr/bin/curl", &actions, NULL, argv, environ);
    posix_spawn_file_actions_destroy(&actions);
    free(auth_header); /* argv 已拷贝进子进程，宿主侧立即释放 */
    if (have_pipe) close(pipefd[1]);
    if (spawn_rc != 0) {
        if (have_pipe) close(pipefd[0]);
        return PERM_DENY_box;
    }
    char response[256];
    size_t got = 0;
    if (have_pipe) {
        while (got < sizeof(response) - 1) {
            ssize_t n = read(pipefd[0], response + got, sizeof(response) - 1 - got);
            if (n <= 0) break;
            got += (size_t)n;
        }
        close(pipefd[0]);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 || got == 0) return PERM_DENY_box;
    response[got] = '\0';
    /* 响应解析走 core 协议函数：严格 decision 校验 + grants 安装（semantics
     * 与 Linux/OH 完全一致）。解析失败/decision 非 allow 一律 DENY（fail-closed）。
     * 注意 grants 安装进 core 侧策略——boxdylib 的 most-specific 判定目前不
     * 消费 grants（curl 路径维持既有行为），后续 most-specific 统一时接入。 */
    {
        dbox_policy_t core_policy;
        dbox_policy_init(&core_policy);
        int64_t now = dbox_now_ms();
        int prc = dbox_ask_parse_response(response, &core_policy, now);
        dbox_policy_free(&core_policy);
        if (prc) return PERM_ALLOW_box;
    }
    return PERM_DENY_box;
}

/*
 * macOS 符号链接别名对：/var ↔ /private/var、/tmp ↔ /private/tmp。
 * 用户命令常用 /var/... 短路径，而 getcwd/策略生成用 realpath 后的
 * /private/... 长路径——只查其一会让另一半被误判为"未命中"。
 */
static bool path_alias_variant(const char *path, char *out, size_t cap)
{
    static const struct {
        const char *from;
        const char *to;
    } aliases[] = {
        { "/var/", "/private/var/" },
        { "/tmp/", "/private/tmp/" },
        { "/private/var/", "/var/" },
        { "/private/tmp/", "/tmp/" },
    };
    for (size_t i = 0; i < sizeof(aliases) / sizeof(aliases[0]); i++) {
        size_t from_len = strlen(aliases[i].from);
        if (strncmp(path, aliases[i].from, from_len) == 0) {
            snprintf(out, cap, "%s%s", aliases[i].to, path + from_len);
            return true;
        }
    }
    return false;
}

/* 回收站写保护（对齐 Linux/OH core 的 trash-protected / Windows hook 的
 * trash DENY）：回收站目录内的任何写操作一律拒绝——沙箱进程可写即可清空
 * 整个回收站（macOS 蓝队 M8 发现缺失）。--del-to-trash 的 rename 移动由
 * trash_or_remove 的 internal 豁免完成，不经 policy_check，不受影响。 */
static bool path_in_trash(const char *path)
{
    const char *trash = getenv(ENV_TRASH_DIR);
    if (!trash || !*trash || !path || !*path) return false;
    size_t tn = strlen(trash);
    while (tn > 1 && trash[tn - 1] == '/') tn--;
    size_t pn = strlen(path);
    while (pn > 1 && path[pn - 1] == '/') pn--;
    if (pn < tn) return false;
    if (strncmp(path, trash, tn) != 0) return false;
    /* 组件边界：恰好等于目录本身，或后随 '/' */
    return pn == tn || path[tn] == '/';
}

/* 回收站排除清单匹配（--trash-exclude / OPENDESK_SANDBOX_TRASH_EXCLUDE，
 * ':' 分隔）：命中任一目录前缀（组件边界，同 path_in_trash 的比较模式）
 * 返回 true——删除分流直接真删、不入回收站。内建临时目录 + 宿主传入清单。
 * 清单截断只缩小保护面（漏排除多入站），不会误删清单外路径。 */
static bool trash_excluded(const char *path)
{
    if (!path || !*path) return false;
    char list[4096];
    const char *built = "/tmp:/var/tmp:/private/var/tmp:/private/var/folders";
    const char *user = getenv(ENV_TRASH_EXCLUDE);
    const char *tmpdir = getenv("TMPDIR");
    size_t off = (size_t)snprintf(list, sizeof list, "%s", built);
    if (tmpdir && *tmpdir && off + 1 < sizeof list)
        off += (size_t)snprintf(list + off, sizeof list - off, ":%s", tmpdir);
    if (user && *user && off + 1 < sizeof list)
        snprintf(list + off, sizeof list - off, ":%s", user);
    const char *start = list;
    for (const char *p = list;; p++) {
        if (*p == ':' || *p == '\0') {
            size_t tn = (size_t)(p - start);
            while (tn > 1 && start[tn - 1] == '/') tn--;
            size_t pn = strlen(path);
            while (pn > 1 && path[pn - 1] == '/') pn--;
            if (tn > 0 && pn >= tn && strncmp(path, start, tn) == 0 &&
                (pn == tn || path[tn] == '/'))
                return true;
            if (*p == '\0') break;
            start = p + 1;
        }
    }
    return false;
}

/* 策略判定主入口：0=放行，非 0=拒绝（errno=EACCES） */
static int policy_check(const char *path, int access)
{
    if ((access & ACC_WRITE) != 0 && path_in_trash(path)) {
        slog("trash-protected DENY: %s", path);
        return EACCES;
    }
    struct PolicyHit hit = policy_lookup_detailed(path, access);
    /*
     * macOS 别名路径（/var ↔ /private/var 等）：用户命令常用短路径而策略
     * 用 realpath 长路径生成。别名命中与原路径命中是同一路径的两种写法，
     * 按"最具体模式"统一竞争（与单次 lookup 内部规则一致）——否则别名侧
     * 的兜底 / ** ask 会覆盖原侧的具体 allow。
     */
    char alias[PATH_MAX];
    if (path_alias_variant(path, alias, sizeof(alias))) {
        struct PolicyHit alias_hit = policy_lookup_detailed(alias, access);
        if (alias_hit.perm >= 0 &&
            (hit.perm < 0 || alias_hit.base_len > hit.base_len ||
             (alias_hit.base_len == hit.base_len && alias_hit.perm < hit.perm))) {
            hit = alias_hit;
        }
    }
    if (hit.perm == PERM_ALLOW_box) return 0;
    if (hit.perm == PERM_DENY_box) return EACCES;
    if (hit.perm == PERM_ASK_box) return ask_remote(path, access) == PERM_ALLOW_box ? 0 : EACCES;
    /* 未命中任何规则：读放行、写/执行询问（与 policyTextLinux 兜底一致） */
    if (access == ACC_READ) return 0;
    return ask_remote(path, access) == PERM_ALLOW_box ? 0 : EACCES;
}


/* ── 平台二进制处理：探测 → 复制+adhoc 重签+缓存 → exec ─────────────────── */

/*
 * dyld 对不同二进制的 DYLD_INSERT 行为：
 * - 平台二进制（CodeDirectory flags & CS_ADHOC==0 且 platform binary）：静默忽略；
 * - 平台 arm64e 二进制插入 arm64 dylib：直接终止；
 * - hardened runtime（CS_RUNTIME）第三方二进制：默认终止（无 get-task-allow）；
 * - 普通 adhoc/开发者签名的第三方二进制：允许注入。
 * 因此：非平台且非 hardened 的二进制直接注入；其余复制到缓存目录并 adhoc 重签
 * （adhoc 签名既不是平台二进制也不带 CS_RUNTIME，dyld 恢复插入行为）。
 */
#define CS_ADHOC 0x00000002
#define CS_LINKER_SIGNED 0x20000
#define CS_RUNTIME 0x10000

/* 读 Mach-O CodeDirectory 特性 flags（含 fat 架构选择）。失败返回 false */
static bool read_code_flags(const char *path, uint32_t *flags)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    uint32_t header[8];
    ssize_t got = read(fd, header, sizeof(header));
    if (got < (ssize_t)sizeof(uint32_t) * 4) {
        close(fd);
        return false;
    }
    uint32_t magic = header[0];
    bool is_fat = magic == FAT_MAGIC || magic == FAT_CIGAM || magic == FAT_MAGIC_64 || magic == FAT_CIGAM_64;
    if (is_fat) {
        /* fat_header 只有 8 字节，arch entries 从 offset 8 开始；重读对齐 */
        if (lseek(fd, 0, SEEK_SET) < 0 || read(fd, header, sizeof(uint32_t) * 2) < (ssize_t)sizeof(uint32_t) * 2) {
            close(fd);
            return false;
        }
    }
    off_t arch_offset = 0;
    cpu_type_t want_cputype = 0;
#if defined(__arm64__) || defined(__aarch64__)
    want_cputype = CPU_TYPE_ARM64;
#elif defined(__x86_64__)
    want_cputype = CPU_TYPE_X86_64;
#endif
    if (magic == FAT_MAGIC || magic == FAT_CIGAM || magic == FAT_MAGIC_64 || magic == FAT_CIGAM_64) {
        bool swap = magic == FAT_CIGAM || magic == FAT_CIGAM_64;
        /* fat_header = {magic, nfat_arch, ...}：nfat 在 header[1] */
        uint32_t nfat = swap ? __builtin_bswap32(header[1]) : header[1];
        if (nfat > 16) {
            close(fd);
            return false;
        }
        bool found = false;
        bool fat64 = magic == FAT_MAGIC_64 || magic == FAT_CIGAM_64;
        for (uint32_t i = 0; i < nfat && !found; i++) {
            if (fat64) {
                struct fat_arch_64 e;
                if (read(fd, &e, sizeof(e)) != (ssize_t)sizeof(e)) break;
                uint32_t cputype = swap ? __builtin_bswap32(e.cputype) : e.cputype;
                if ((int)cputype == want_cputype) {
                    arch_offset = (off_t)(swap ? __builtin_bswap64(e.offset) : e.offset);
                    found = true;
                }
            } else {
                struct fat_arch e;
                if (read(fd, &e, sizeof(e)) != (ssize_t)sizeof(e)) break;
                uint32_t cputype = swap ? __builtin_bswap32(e.cputype) : e.cputype;
                if ((int)cputype == want_cputype) {
                    arch_offset = (off_t)(swap ? __builtin_bswap32(e.offset) : e.offset);
                    found = true;
                }
            }
        }
        if (!found) {
            close(fd);
            return false;
        }
        if (lseek(fd, arch_offset, SEEK_SET) < 0 ||
            read(fd, header, sizeof(uint32_t) * 5) < (ssize_t)sizeof(uint32_t) * 5) {
            close(fd);
            return false;
        }
        magic = header[0];
    }
    if (magic != MH_MAGIC_64 && magic != MH_CIGAM_64 && magic != MH_MAGIC && magic != MH_CIGAM) {
        close(fd);
        return false;
    }
    /* slice 层字节序按自身 magic 判定，不沿用 fat 层的 swap 标志 */
    bool mswap = magic == MH_CIGAM_64 || magic == MH_CIGAM;
    /* mach_header: magic(0) cputype(1) cpusubtype(2) filetype(3) ncmds(4) */
    uint32_t ncmds = mswap ? __builtin_bswap32(header[4]) : header[4];
    if (ncmds > 4096) {
        close(fd);
        return false;
    }
    off_t pos = arch_offset + (magic == MH_MAGIC_64 || magic == MH_CIGAM_64 ? sizeof(struct mach_header_64)
                                                                            : sizeof(struct mach_header));
    bool ok = false;
    for (uint32_t i = 0; i < ncmds; i++) {
        struct load_command lc;
        if (pread(fd, &lc, sizeof(lc), pos) != (ssize_t)sizeof(lc)) break;
        uint32_t cmd = mswap ? __builtin_bswap32(lc.cmd) : lc.cmd;
        uint32_t cmdsize = mswap ? __builtin_bswap32(lc.cmdsize) : lc.cmdsize;
        if (cmdsize < sizeof(lc) || cmdsize > 0x1000000u) break;
        if (cmd == LC_CODE_SIGNATURE) {
            struct linkedit_data_command sig;
            if (pread(fd, &sig, sizeof(sig), pos) != (ssize_t)sizeof(sig)) break;
            uint32_t dataoff = mswap ? __builtin_bswap32(sig.dataoff) : sig.dataoff;
            /* dataoff 相对 slice 起点；签名 blob 结构统一大端编码（CS 规范） */
            uint32_t prefix[3];
            if (pread(fd, prefix, sizeof(prefix), arch_offset + (off_t)dataoff) != (ssize_t)sizeof(prefix)) break;
            uint32_t magic2 = __builtin_bswap32(prefix[0]);
            if (magic2 != CSMAGIC_EMBEDDED_SIGNATURE) break;
            uint32_t count = __builtin_bswap32(prefix[2]);
            bool cd_found = false;
            for (uint32_t s = 0; s < count && s < 16 && !cd_found; s++) {
                struct BlobIndex {
                    uint32_t type;
                    uint32_t offset;
                } idx;
                /* CS_SuperBlob = {magic, length, count, index[]}：index 从 +12 开始 */
                off_t slot = arch_offset + (off_t)dataoff + (off_t)sizeof(uint32_t) * 3 +
                             (off_t)(s * sizeof(idx));
                if (pread(fd, &idx, sizeof(idx), slot) != (ssize_t)sizeof(idx)) break;
                uint32_t type = __builtin_bswap32(idx.type);
                if (type != 0) continue; /* 0 = CSSLOT_CODEDIRECTORY */
                uint32_t cd_offset = __builtin_bswap32(idx.offset);
                off_t cd_slot = arch_offset + (off_t)dataoff + (off_t)cd_offset;
                struct CodeDirectory {
                    uint32_t magic;
                    uint32_t length;
                    uint32_t version;
                    uint32_t flags;
                } cd;
                if (pread(fd, &cd, sizeof(cd), cd_slot) != (ssize_t)sizeof(cd)) break;
                *flags = __builtin_bswap32(cd.flags);
                cd_found = true;
                ok = true;
            }
            break;
        }
        pos += cmdsize;
    }
    close(fd);
    return ok;
}

/* 简易 SHA-256（CommonCrypto）→ 32 hex */
static bool sha256_hex(const char *path, char *out /* 65 bytes */)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    CC_SHA256_CTX ctx;
    CC_SHA256_Init(&ctx);
    unsigned char buf[65536];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf))) > 0) CC_SHA256_Update(&ctx, buf, (CC_LONG)n);
    close(fd);
    if (n < 0) return false;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &ctx);
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
        out[i * 2] = hex[digest[i] >> 4];
        out[i * 2 + 1] = hex[digest[i] & 0xf];
    }
    out[64] = '\0';
    return true;
}

static void exec_cache_dir(char *out, size_t cap)
{
    const char *override = getenv(ENV_EXEC_CACHE);
    if (override && *override) {
        snprintf(out, cap, "%s", override);
        return;
    }
    const char *home = getenv("HOME");
    snprintf(out, cap, "%s/Library/Caches/com.opendesk.sandbox/exec", home && *home ? home : DEFAULT_EXEC_CACHE);
}

/*
 * 平台二进制/沙箱重签：复制到 exec 缓存（SHA-256 命名，跨实例复用），codesign
 * adhoc 重签，返回缓存路径。宿主 TS 侧（shell 启动）使用同一命名规则，保证
 * 沙箱内 exec 与宿主直接启动拿到同一缓存副本。失败返回 NULL（调用方原样 exec，
 * 由系统 dyld 决定忽略注入或终止——与不拦截行为一致）。
 */
static char *resign_copy_for_exec_internal(const char *path);

/* 读取重签副本所在目录的 .opendesk-framework-home 标记。
 * 返回 malloc 的框架 prefix（调用方 free）；无标记/读取失败返回 NULL。 */
static char *read_python_home_marker(const char *copy_dir)
{
    char marker[PATH_MAX];
    snprintf(marker, sizeof(marker), "%s/.opendesk-framework-home", copy_dir);
    struct stat st;
    if (stat(marker, &st) != 0 || st.st_size <= 0) return NULL;
    char content[PATH_MAX];
    int mfd = open(marker, O_RDONLY | O_CLOEXEC);
    if (mfd < 0) return NULL;
    ssize_t n = read(mfd, content, sizeof(content) - 1);
    close(mfd);
    if (n <= 0) return NULL;
    content[n] = '\0';
    return xstrdup(content);
}

/* 在重签副本所在目录写入/清除 .opendesk-framework-home 标记。
 * 仅当二进制属于某个 Python.framework（Apple/CLT 的 Python3.framework 或
 * Homebrew 的 Python.framework）时写入其 Versions/<ver> prefix；其余二进制
 * 清除历史标记。每次返回副本（含缓存命中短路）都调用，保证旧版本写入的
 * 脏标记（曾无条件硬编码 CLT 3.9）被及时纠正。标记与副本同目录，
 * 读取方（dirname(副本路径)）对带镜像子目录的 stub 同样成立。 */
static void update_python_home_marker(const char *copy_dir, const char *path)
{
    char marker[PATH_MAX];
    snprintf(marker, sizeof(marker), "%s/.opendesk-framework-home", copy_dir);
    char resolved_orig_py[PATH_MAX];
    char py_home[PATH_MAX];
    bool found_prefix = false;
    /* realpath 解析 symlink/hardlink（/usr/bin/python3 → CLT、
     * /opt/homebrew/bin/python3 → Homebrew）到真实二进制，再向上定位其所属
     * Python.framework 的 Versions/<ver> 层。stub 二进制多一层
     * Resources/Python.app/Contents/MacOS，统一回溯到最近的 "Versions" 段。
     * 非 Framework 布局（venv/静态安装等）不注入，让解释器自行定位 stdlib。 */
    if (realpath(path, resolved_orig_py) != NULL) {
        char *homebrew_pos = strstr(resolved_orig_py, "/Python.framework/");
        char *apple_pos = strstr(resolved_orig_py, "/Python3.framework/");
        char *framework_pos = homebrew_pos ? homebrew_pos : apple_pos;
        if (framework_pos) {
            const char *rel = (framework_pos == homebrew_pos) ? "/Python.framework/" : "/Python3.framework/";
            const char *after = framework_pos + strlen(rel);
            char *versions = strstr(after, "Versions/");
            if (versions) {
                char *ver = versions + strlen("Versions/");
                char *end = strchr(ver, '/');
                if (end && end > ver) {
                    size_t prefix_len = (size_t)(end - resolved_orig_py);
                    if (prefix_len < sizeof(py_home)) {
                        memcpy(py_home, resolved_orig_py, prefix_len);
                        py_home[prefix_len] = '\0';
                        struct stat st2;
                        if (stat(py_home, &st2) == 0 && S_ISDIR(st2.st_mode)) found_prefix = true;
                    }
                }
            }
        }
    }
    if (!found_prefix) {
        /* 清除历史标记：旧版本曾无条件写 CLT 3.9 路径，非框架二进制不应携带 */
        unlink(marker);
        return;
    }
    size_t home_len = strlen(py_home);
    /* 内容未变则跳过写入：缓存命中路径每次 exec 都会到这里，避免无谓 IO，
     * 同时缩小并发 exec 一写一读的竞态窗口 */
    char current[PATH_MAX];
    int rfd = open(marker, O_RDONLY | O_CLOEXEC);
    if (rfd >= 0) {
        ssize_t n = read(rfd, current, sizeof(current) - 1);
        close(rfd);
        if (n == (ssize_t)home_len && memcmp(current, py_home, home_len) == 0) return;
    }
    /* 原子写入（tmp + rename）：并发 exec 同一二进制时，读方
     * （read_python_home_marker）读到空/半截标记会被当成"无需注入"，
     * framework Python 随即因定位不到 stdlib 启动失败 */
    char tmp[PATH_MAX];
    static _Atomic uint32_t marker_seq = 0;
    snprintf(tmp, sizeof(tmp), "%s.tmp.%d.%u", marker, (int)getpid(),
             atomic_fetch_add(&marker_seq, 1));
    int mfd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (mfd < 0) return;
    ssize_t written = write(mfd, py_home, home_len);
    close(mfd);
    if (written == (ssize_t)home_len) {
        if (rename(tmp, marker) != 0) unlink(tmp);
    } else {
        unlink(tmp);
    }
}

static char *resign_copy_for_exec(const char *path)
{
    internal_begin();
    char *result = resign_copy_for_exec_internal(path);
    internal_end();
    return result;
}

/* (dev,ino,size,mtime) → hex 的轻量缓存：exec 热路径避免每次全文件哈希。
 * 文件被替换时 inode/mtime/size 至少一项变化 → 重新哈希。 */
struct ExecHashCacheEntry {
    dev_t dev;
    ino_t ino;
    off_t size;
    struct timespec mtime;
    char hex[65];
};
#define EXEC_HASH_CACHE_SIZE 32
static struct ExecHashCacheEntry g_exec_hash_cache[EXEC_HASH_CACHE_SIZE];
static size_t g_exec_hash_cache_next;
static pthread_mutex_t g_exec_hash_cache_mutex = PTHREAD_MUTEX_INITIALIZER;

static bool exec_hash_cache_lookup(const struct stat *st, char *hex)
{
    pthread_mutex_lock(&g_exec_hash_cache_mutex);
    for (size_t i = 0; i < EXEC_HASH_CACHE_SIZE; i++) {
        struct ExecHashCacheEntry *e = &g_exec_hash_cache[i];
        if (e->dev == st->st_dev && e->ino == st->st_ino && e->size == st->st_size &&
            e->mtime.tv_sec == st->st_mtimespec.tv_sec && e->mtime.tv_nsec == st->st_mtimespec.tv_nsec) {
            memcpy(hex, e->hex, 65);
            pthread_mutex_unlock(&g_exec_hash_cache_mutex);
            return true;
        }
    }
    pthread_mutex_unlock(&g_exec_hash_cache_mutex);
    return false;
}

static void exec_hash_cache_store(const struct stat *st, const char *hex)
{
    pthread_mutex_lock(&g_exec_hash_cache_mutex);
    struct ExecHashCacheEntry *e = &g_exec_hash_cache[g_exec_hash_cache_next];
    g_exec_hash_cache_next = (g_exec_hash_cache_next + 1) % EXEC_HASH_CACHE_SIZE;
    e->dev = st->st_dev;
    e->ino = st->st_ino;
    e->size = st->st_size;
    e->mtime.tv_sec = st->st_mtimespec.tv_sec;
    e->mtime.tv_nsec = st->st_mtimespec.tv_nsec;
    memcpy(e->hex, hex, 65);
    pthread_mutex_unlock(&g_exec_hash_cache_mutex);
}

static char *resign_copy_for_exec_internal(const char *path)
{
    char cache_dir[PATH_MAX];
    exec_cache_dir(cache_dir, sizeof(cache_dir));
    char hex[65];
    struct stat path_st;
    if (stat(path, &path_st) != 0) return NULL;
    if (!exec_hash_cache_lookup(&path_st, hex)) {
        if (sha256_hex(path, hex) != true) return NULL;
        exec_hash_cache_store(&path_st, hex);
    }
    /*
     * 副本布局：cache/<hash>/<镜像层级...>/<原basename>。两层需求：
     * 1. 目录化（非平铺 <hash>.bin）：xcode-select 的 tool-shim（/usr/bin/python3
     *    等）运行时按自身 basename 到 CLT usr/bin/ 找真实工具，平铺名对不上会
     *    报 "Failed to locate ..."（exit 72）；
     * 2. 镜像层级：@executable_path/../../../X 依赖从副本出发上跳 N 级解析，
     *    副本目录深度必须与原文件一致，否则依赖解析越出缓存根。
     *    副本层级 = cache/<hash>/<原目录最后 max_ups 级>/<basename>，依赖链接
     *    建在 cache/<hash>/ 层正好命中。
     */
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    if (!*base) return NULL;
    char resolved_path_buf[PATH_MAX];
    if (realpath(path, resolved_path_buf) == NULL) return NULL;
    int max_ups = scan_executable_path_max_ups(resolved_path_buf);
    char hash_dir[PATH_MAX];
    snprintf(hash_dir, sizeof(hash_dir), "%s/%s", cache_dir, hex);
    if (mkdir(cache_dir, 0755) != 0 && errno != EEXIST) {
        slog("resign mkdir failed: %s errno=%d", cache_dir, errno);
        return NULL;
    }
    if (mkdir(hash_dir, 0755) != 0 && errno != EEXIST) {
        slog("resign mkdir failed: %s errno=%d", hash_dir, errno);
        return NULL;
    }
    /* 镜像原目录最后 max_ups 级到 hash_dir 下 */
    char mid_dirs[PATH_MAX] = { 0 };
    if (max_ups > 0) {
        char orig_real[PATH_MAX];
        if (realpath(path, orig_real) != NULL) {
            /* 收集原目录的最后 max_ups 级段名 */
            const char *segments[64];
            int seg_count = 0;
            char orig_dir_copy[PATH_MAX];
            snprintf(orig_dir_copy, sizeof(orig_dir_copy), "%s", orig_real);
            char *sp = strrchr(orig_dir_copy, '/');
            if (sp) *sp = '\0';
            char *tok_save = NULL;
            for (char *tok = strtok_r(orig_dir_copy, "/", &tok_save); tok; tok = strtok_r(NULL, "/", &tok_save)) {
                if (seg_count < 64) segments[seg_count++] = tok;
            }
            size_t mid_len = 0;
            int start = seg_count - max_ups > 0 ? seg_count - max_ups : 0;
            for (int s = start; s < seg_count; s++) {
                size_t sl = strlen(segments[s]);
                if (mid_len + sl + 2 >= sizeof(mid_dirs)) break;
                mid_dirs[mid_len++] = '/';
                memcpy(mid_dirs + mid_len, segments[s], sl);
                mid_len += sl;
            }
            mid_dirs[mid_len] = '\0';
        }
    }
    char full_dir[PATH_MAX];
    if (mid_dirs[0]) snprintf(full_dir, sizeof(full_dir), "%s%s", hash_dir, mid_dirs);
    else snprintf(full_dir, sizeof(full_dir), "%s", hash_dir);
    /* 逐级建镜像目录 */
    for (char *p = full_dir + strlen(cache_dir) + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(full_dir, 0755);
            *p = '/';
        }
    }
    mkdir(full_dir, 0755);
    size_t need = strlen(full_dir) + strlen(base) + 4;
    char *cached = malloc(need);
    if (!cached) return NULL;
    snprintf(cached, need, "%s/%s", full_dir, base);
    struct stat st;
    if (stat(cached, &st) == 0 && st.st_size > 0) {
        /* 缓存命中也要刷新 Python 框架标记：旧版本曾无条件写 CLT 3.9，
         * 不刷新则脏标记永久存活（同二进制哈希的缓存长期复用） */
        update_python_home_marker(full_dir, path);
        return cached;
    }
    int src = open(path, O_RDONLY | O_CLOEXEC);
    if (src < 0) {
        free(cached);
        return NULL;
    }
    char tmp_path[PATH_MAX];
    /* 同进程多线程并发重签同一文件：tmp 名必须含线程区分度，否则互踩。
     * tmp 放在最终目标目录内，保证 rename 同文件系统原子。 */
    static _Atomic uint32_t tmp_seq = 0;
    uint32_t seq = atomic_fetch_add(&tmp_seq, 1);
    snprintf(tmp_path, sizeof(tmp_path), "%s/.tmp.%d.%u", full_dir, (int)getpid(), seq);
    int dst = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0755);
    if (dst < 0) {
        close(src);
        free(cached);
        return NULL;
    }
    char buf[65536];
    ssize_t n;
    bool copy_ok = true;
    while ((n = read(src, buf, sizeof(buf))) > 0) {
        if (write(dst, buf, (size_t)n) != n) {
            copy_ok = false;
            break;
        }
    }
    close(src);
    close(dst);
    if (!copy_ok || n < 0) {
        unlink(tmp_path);
        free(cached);
        return NULL;
    }
    /* adhoc 重签：--force 覆盖旧签名；--preserve-metadata=flags 保留原
     * runtime/hardened 标志没有意义（重签目的恰是剥离），只保留 entitlements。
     * 成功后原子 rename 到 <hash>/<basename>（并发线程重复完成时 rename 覆盖无害）。
     * codesign 输出重定向 /dev/null 防污染命令 stdout。 */
    for (int attempt = 0; attempt < 2; attempt++) {
        pid_t pid = -1;
        char *argv[] = { "codesign", "--force", "--sign", "-", tmp_path, NULL };
        posix_spawn_file_actions_t actions;
        bool have_actions = posix_spawn_file_actions_init(&actions) == 0;
        if (have_actions) {
            posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
            posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
        }
        extern char **environ;
        int spawn_rc = posix_spawn(&pid, "/usr/bin/codesign", have_actions ? &actions : NULL, NULL, argv, environ);
        if (have_actions) posix_spawn_file_actions_destroy(&actions);
        if (spawn_rc == 0) {
            int status = 0;
            while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
            if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
                if (rename(tmp_path, cached) == 0) {
                    /* 先于返回：副本的 @executable_path 相对依赖桥回原位置 */
                    bridge_executable_path_deps(path, cached);
                    /* Python framework 二进制（CLT python3）需要 PYTHONHOME 指向
                     * 副本框架根才能正确定位 stdlib 与 app stub——写标记供
                     * exec 时注入 env（见 prepare_exec 的 PYTHONHOME 注入） */
                    /* 标记内容 = 原始 Python prefix（stdlib 仍在原 CLT 框架树，
                     * 副本只替换二进制；PYTHONHOME 指向原 prefix 使 stdlib 可达） */
                    /* Python framework 二进制（CLT/Homebrew python3）需要 PYTHONHOME 指向
                     * 框架 Versions/<ver> 才能正确定位 stdlib 与 app stub——写标记供
                     * exec 时注入 env（见 prepare_exec 的 PYTHONHOME 注入）。
                     * 标记内容 = 框架 prefix（stdlib 仍在原框架树，副本只替换二进制）；
                     * 非 Python 框架二进制清除历史标记，exec 时不注入 PYTHONHOME */
                    update_python_home_marker(full_dir, path);
                    return cached;
                }
                break;
            }
        }
        /* 并发线程可能已完成同一哈希的副本：复用 */
        struct stat st;
        if (stat(cached, &st) == 0 && st.st_size > 0) {
            unlink(tmp_path);
            update_python_home_marker(full_dir, path);
            return cached;
        }
        usleep(20000);
    }
    unlink(tmp_path);
    free(cached);
    return NULL;
}

/*
 * 判定二进制是否需要重签后才能注入：
 * - 读不到签名（脚本等）：false（脚本由解释器执行，走 shebang 改写路径）；
 * - 平台二进制 / hardened runtime：true；
 * - linker-signed（未签名构建产物，adhoc 语义）：false，直接注入。
 */
static bool needs_resign(const char *path)
{
    uint32_t flags = 0;
    if (!read_code_flags(path, &flags)) return false;
    if (flags & CS_LINKER_SIGNED) return false;
    /* CS_ADHOC 缺失 = 正式身份签名；CS_RUNTIME = hardened runtime */
    if (!(flags & CS_ADHOC) || (flags & CS_RUNTIME)) return true;
    return false;
}

/* ── 回收站（macOS 废纸篓） ─────────────────────────────────────────────── */

/*
 * 与 Linux XDG Trash 语义对齐（sandboxDeleteToTrash）：
 * - 任务开始前已存在的文件 → 移入废纸篓（保留原始内容，可恢复）；
 * - 本沙箱实例运行期间新建的文件 → 直接清除（回收站无意义且避免占满磁盘）。
 * 新建判定：st_birthtimespec >= 沙箱进程启动时间（与 Linux dynobox 的 TTL 语义一致）。
 */
static struct timespec g_sandbox_start = { 0, 0 };

static bool birth_after_start(const struct stat *st)
{
    time_t birth = ST_BIRTHTIM_SEC(st);
    if (birth > g_sandbox_start.tv_sec) return true;
    if (birth < g_sandbox_start.tv_sec) return false;
    /* 同秒：出生纳秒 >= 启动纳秒即判定为本实例新建（宁可送回收站不误删，
     * 因此边界取小于：相等也算预存在） */
    return (long long)ST_BIRTHTIM_NSEC(st) > (long long)g_sandbox_start.tv_nsec;
}

/* ── OpenDesk 统一回收站（<opendesk>/trash/<taskId>：<uuid>.back + summary.json）─
 * 与 Windows/Linux/OpenHarmony 原生层及宿主侧 TrashEntry 格式一致：随机 UUID
 * 命名避免 stat-then-rename 的 TOCTOU（两个实例同时删除也不会互相覆盖），
 * summary.json 供宿主 GUI 搜索与找回。 */

/* flock 阻塞等待可能被信号打断（EINTR）：shell 进程信号频繁，必须重试，
 * 否则会在未持锁状态下读-改-写 summary.json，与其他并发写者互相覆盖 */
static void trash_flock(int fd, int operation)
{
    while (flock(fd, operation) != 0 && errno == EINTR) {
    }
}

/* 生成随机 UUID v4（/dev/urandom → RFC 4122 小写连字符格式）。 */
static void trash_uuid(char out[37])
{
    unsigned char b[16];
    bool ok = false;
    int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd >= 0) {
        ok = read(fd, b, sizeof b) == (ssize_t)sizeof b;
        close(fd);
    }
    if (!ok) {
        struct timeval tv;
        gettimeofday(&tv, NULL);
        unsigned long long n = (unsigned long long)tv.tv_usec ^ ((unsigned long long)getpid() << 47);
        memcpy(b, &n, sizeof n);
        memcpy(b + 8, &tv.tv_sec, 8);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    snprintf(out, 37,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
             b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
}

/* 当前 UTC 时间的 ISO 8601 毫秒精度时间戳（与宿主侧 deleted_at 一致）。 */
static void trash_iso_utc(char *out, size_t outsz)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    struct tm tm;
    gmtime_r(&tv.tv_sec, &tm);
    snprintf(out, outsz, "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec, (long)(tv.tv_usec / 1000));
}

/* JSON 字符串转义（仅 \" \\ 与控制字符；非 ASCII 按 UTF-8 原样输出，合法 JSON）。 */
static void trash_json_escape(const char *s, char *out, size_t outsz)
{
    size_t n = 0;
    if (outsz == 0) return;
    out[n++] = '"';
    for (const unsigned char *p = (const unsigned char *)s; *p && n + 8 < outsz; p++) {
        unsigned char ch = *p;
        if (ch == '"' || ch == '\\') { out[n++] = '\\'; out[n++] = (char)ch; }
        else if (ch == '\b') { out[n++] = '\\'; out[n++] = 'b'; }
        else if (ch == '\f') { out[n++] = '\\'; out[n++] = 'f'; }
        else if (ch == '\n') { out[n++] = '\\'; out[n++] = 'n'; }
        else if (ch == '\r') { out[n++] = '\\'; out[n++] = 'r'; }
        else if (ch == '\t') { out[n++] = '\\'; out[n++] = 't'; }
        else if (ch < 0x20) { snprintf(out + n, 8, "\\u%04x", ch); n += 6; }
        else out[n++] = (char)ch;
    }
    out[n++] = '"';
    out[n] = 0;
}

/* 追加一条删除记录到 <trash>/summary.json（顶层 JSON 数组，字段顺序与宿主
 * TrashEntry 一致）。flock 独占锁下读-改-写：新条目定位数组尾部 ']' 追加，
 * 避免整表解析；损坏文件留存为 summary.json.corrupt-<秒> 后重建。
 * 成功返回 0。 */
static int trash_append_summary(const char *trash_dir, const char *uuid,
                                const char *original_path,
                                long long size, const char *deleted_at)
{
    char path[PATH_MAX];
    snprintf(path, sizeof path, "%s/summary.json", trash_dir);

    int fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    trash_flock(fd, LOCK_EX);

    int result = -1;
    char *content = NULL;
    char *out = NULL;
    do {
        struct stat st;
        if (fstat(fd, &st) != 0 || st.st_size > 256 * 1024 * 1024) break;
        size_t len = (size_t)st.st_size;
        content = malloc(len + 1);
        if (!content) break;
        if (len > 0) {
            if (lseek(fd, 0, SEEK_SET) != 0 ||
                read(fd, content, len) != (ssize_t)len) break;
        }
        content[len] = 0;

        /* 结构校验：首个 '[' 与最后一个 ']'；缺失或顺序颠倒视为损坏（留存重建） */
        const char *o = strchr(content, '[');
        const char *c = len ? strrchr(content, ']') : NULL;
        bool corrupt = (!o || !c || o > c);
        if (corrupt && len > 0) {
            char backup[PATH_MAX];
            snprintf(backup, sizeof backup, "%s/summary.json.corrupt-%ld",
                     trash_dir, (long)time(NULL));
            trash_flock(fd, LOCK_UN);
            close(fd);
            if (rename(path, backup) != 0) break;
            slog("summary.json 损坏，旧内容留存 %s", backup);
            fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
            if (fd < 0) break;
            trash_flock(fd, LOCK_EX);
            len = 0;
            content[0] = 0;
            o = NULL;
            c = NULL;
        }

        /* 条目 JSON */
        char *esc = malloc(strlen(original_path) * 6 + 16);
        char *entry = malloc(strlen(original_path) * 6 + 160);
        if (!esc || !entry) { free(esc); free(entry); break; }
        trash_json_escape(original_path, esc, strlen(original_path) * 6 + 16);
        snprintf(entry, strlen(original_path) * 6 + 160,
                 "{\"uuid\":\"%s\",\"original_path\":%s,\"size\":%lld,\"deleted_at\":\"%s\"}",
                 uuid, esc, size, deleted_at);
        free(esc);

        /* 空文件/损坏重建 → 单条目数组；否则定位数组边界追加 */
        size_t outcap = len + strlen(entry) + 64;
        out = malloc(outcap);
        if (!out) { free(entry); break; }
        if (!o || !c) {
            snprintf(out, outcap, "[\n  %s\n]", entry);
        } else {
            bool empty_array = true;
            for (const char *p = o + 1; p < c; p++) {
                if (*p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') {
                    empty_array = false;
                    break;
                }
            }
            if (empty_array) {
                snprintf(out, outcap, "%.*s\n  %s\n]%s",
                         (int)(o - content) + 1, content, entry, c + 1);
            } else {
                size_t headlen = (size_t)(c - content);
                while (headlen > 0 && (content[headlen - 1] == ' ' ||
                                       content[headlen - 1] == '\n' ||
                                       content[headlen - 1] == '\r' ||
                                       content[headlen - 1] == '\t'))
                    headlen--;
                snprintf(out, outcap, "%.*s,\n  %s\n]%s",
                         (int)headlen, content, entry, c + 1);
            }
        }
        free(entry);

        size_t outlen = strlen(out);
        /* 先写后截断：写失败（如被信号打断）时旧内容完整保留，避免清空索引 */
        if (lseek(fd, 0, SEEK_SET) != 0 ||
            write(fd, out, outlen) != (ssize_t)outlen ||
            ftruncate(fd, (off_t)outlen) != 0) break;
        result = 0;
    } while (0);

    trash_flock(fd, LOCK_UN);
    close(fd);
    free(content);
    free(out);
    return result;
}

/* 删除分流：送废纸篓或直接清除。返回 0 成功，-1 失败（errno 保持语义） */
static int trash_or_remove_internal(const char *path, const struct stat *st, bool is_dir);

static int trash_or_remove(const char *path, const struct stat *st, bool is_dir)
{
    /* rename 到废纸篓等内部 IO 豁免策略检查防递归 */
    internal_begin();
    int result = trash_or_remove_internal(path, st, is_dir);
    internal_end();
    return result;
}

static int trash_or_remove_internal(const char *path, const struct stat *st, bool is_dir)
{
    if (getenv(ENV_TRASH) == NULL) {
        /* 未启用回收站：普通删除 */
        int rc = is_dir ? rmdir(path) : unlink(path);
        return rc;
    }
    if (birth_after_start(st)) {
        /* 沙箱实例内新建：直接清除 */
        int rc = is_dir ? rmdir(path) : unlink(path);
        return rc;
    }
    /* 命中排除清单（--trash-exclude / 内建临时目录，如 $TMPDIR 下构建工具
     * 的零时产物）：与空目录/0B 文件同为"无保留价值"，直接清除不入回收站 */
    if (trash_excluded(path)) {
        slog("trash excluded (matches --trash-exclude), removing: %s", path);
        return is_dir ? rmdir(path) : unlink(path);
    }
    /* 无恢复价值的目标不入回收站：空目录（rmdir/AT_REMOVEDIR 语义只删空目录，
     * rm -rf 的收尾 rmdir 是空壳条目主要来源）与 0 字节普通文件（构建零时文件
     * 噪音），找回空壳没有意义——直接清除，与 Linux/Windows 原生层语义一致 */
    if (is_dir || (S_ISREG(st->st_mode) && st->st_size == 0)) {
        return is_dir ? rmdir(path) : unlink(path);
    }
    const char *trash_dir = getenv(ENV_TRASH_DIR);
    char resolved_trash[PATH_MAX];
    if (!trash_dir || !*trash_dir) {
        const char *home = getenv("HOME");
        if (!home || !*home) return is_dir ? rmdir(path) : unlink(path);
        snprintf(resolved_trash, sizeof(resolved_trash), "%s/.Trash", home);
        trash_dir = resolved_trash;
    }
    /* trash 目录可能多级（<opendesk>/trash/<taskId>/）：逐级创建 */
    {
        char tmp_dir[PATH_MAX];
        snprintf(tmp_dir, sizeof(tmp_dir), "%s", trash_dir);
        size_t len = strlen(tmp_dir);
        while (len > 1 && tmp_dir[len - 1] == '/') tmp_dir[--len] = '\0';
        for (char *p = tmp_dir + 1; *p; p++) {
            if (*p == '/') {
                *p = '\0';
                mkdir(tmp_dir, 0700); /* 忽略 EEXIST */
                *p = '/';
            }
        }
    }
    if (mkdir(trash_dir, 0700) != 0 && errno != EEXIST) {
        slog("trash mkdir failed: %s errno=%d", trash_dir, errno);
        /* 废纸篓不可用：回退直接删除（与 XDG trash 失败语义一致） */
        return is_dir ? rmdir(path) : unlink(path);
    }
    /* 大小必须在 rename 前取（目录记 0；lstat 取 symlink 本身） */
    long long size_bytes = 0;
    {
        struct stat lst;
        if (lstat(path, &lst) == 0 && !S_ISDIR(lst.st_mode)) size_bytes = (long long)lst.st_size;
    }
    char uuid[37];
    trash_uuid(uuid);
    char target[PATH_MAX];
    snprintf(target, sizeof(target), "%s/%s.back", trash_dir, uuid);
    if (rename(path, target) == 0) {
        /* 记录失败不回滚移动（文件已在回收站，仅缺索引），留下诊断日志 */
        char iso[40];
        trash_iso_utc(iso, sizeof iso);
        if (trash_append_summary(trash_dir, uuid, path, size_bytes, iso) != 0)
            slog("trash summary record failed: %s", path);
        slog("trashed: %s -> %s", path, target);
        return 0;
    }
    int rename_errno = errno;
    slog("trash rename failed: %s -> %s errno=%d", path, target, rename_errno);
    /* EXDEV/跨卷等失败回退为直接删除（与 XDG trash 失败语义一致） */
    if (rename_errno == EXDEV || rename_errno == ENOTEMPTY || rename_errno == EEXIST) {
        return is_dir ? rmdir(path) : unlink(path);
    }
    errno = rename_errno;
    return -1;
}

/* ── interposing 声明 ───────────────────────────────────────────────────── */

/*
 * macOS interposing 约定：
 *   #define DYLD_INTERPOSE(_replacement, _replacee) …
 * 替代函数与被替代函数同名+static 声明，链接器把替换表写入 __DATA,__interpose。
 */
#define DYLD_INTERPOSE(_replacement, _replacee)                                                                    \
    __attribute__((used)) static struct {                                                                          \
        const void *replacement;                                                                                   \
        const void *replacee;                                                                                      \
    } _interpose_##_replacee __attribute__((section("__DATA,__interpose"))) = {                                    \
        (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee                        \
    };

/* 真实符号经 dlsym(RTLD_NEXT) 解析（interpose 表不影响 RTLD_NEXT 查找）。 */

/* ── 路径归一化：处理 .. 与多斜杠（不解析 symlink，前缀匹配语义保持一致） ── */
/* 归一化结果：0=成功 -1=段数超限（调用方应拒绝而非使用截断结果） */
static int normalize_path(const char *in, char *out, size_t cap)
{
    if (!in || in[0] != '/') {
        snprintf(out, cap, "%s", in ? in : "");
        return in && in[0] ? -1 : 0; /* 相对路径交由 resolve_relative 预处理；到达此处即异常 */
    }
    /* 拆段重组；strtok 非线程安全，沙箱内多线程并发检查必须用 strtok_r */
    const char *segs[256];
    size_t seg_count = 0;
    char copy[PATH_MAX];
    snprintf(copy, sizeof(copy), "%s", in);
    char *save = NULL;
    for (char *p = strtok_r(copy, "/", &save); p; p = strtok_r(NULL, "/", &save)) {
        if (strcmp(p, ".") == 0) continue;
        if (strcmp(p, "..") == 0) {
            if (seg_count > 0) seg_count--;
            continue;
        }
        if (seg_count >= 256) {
            /* 段溢出时静默截断会改变路径语义（截断前缀可能误命中规则）：
             * 返回失败让调用方拒绝。内核 PATH_MAX 使该场景在绝对路径上
             * 不可达（>512 段必超 1024 字节），此为纵深防御。 */
            return -1;
        }
        segs[seg_count++] = p;
    }
    size_t o = 0;
    out[o++] = '/';
    for (size_t i = 0; i < seg_count; i++) {
        size_t n = strlen(segs[i]);
        if (o + n + 2 > cap) break;
        memcpy(out + o, segs[i], n);
        o += n;
        if (i + 1 < seg_count) out[o++] = '/';
    }
    out[o] = '\0';
    /* 根路径特殊处理：避免结尾多余斜杠 */
    if (o > 1 && out[o - 1] == '/') out[o - 1] = '\0';
    return 0;
}

/*
 * 复制副本的 @executable_path 依赖桥接：
 * 原二进制（如 CLT 的 python3）依赖 @executable_path/../Python3（相对自身的
 * 框架）。副本换了目录后相对路径断链。为副本目录按依赖的相对段创建符号链接
 * 指回原位置：原 python3 在 .../Versions/3.9/bin/，依赖 ../Python3 → 原 target
 * .../Versions/3.9/Python3；副本 /cache/<hash>/python3 的 ../Python3 解析到
 * /cache/Python3 → symlink /cache/Python3 → 原 target。
 */
/*
 * 扫描 @executable_path 依赖的最大上跳级数（../ 数）。副本目录必须镜像
 * 原文件相同深度的目录层级，否则相对依赖解析越出缓存根（symlink 建到
 * 系统路径上）或断链。
 */
static int scan_executable_path_max_ups(const char *original)
{
    int max_ups = 0;
    int fd = open(original, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    uint32_t header[8];
    if (read(fd, header, sizeof(header)) < (ssize_t)sizeof(uint32_t) * 5) {
        close(fd);
        return 0;
    }
    uint32_t magic = header[0];
    off_t arch_offset = 0;
    cpu_type_t want_cputype = 0;
#if defined(__arm64__) || defined(__aarch64__)
    want_cputype = CPU_TYPE_ARM64;
#elif defined(__x86_64__)
    want_cputype = CPU_TYPE_X86_64;
#endif
    if (magic == FAT_MAGIC || magic == FAT_CIGAM) {
        bool swap = magic == FAT_CIGAM;
        if (lseek(fd, 0, SEEK_SET) < 0 || read(fd, header, sizeof(uint32_t) * 2) < (ssize_t)sizeof(uint32_t) * 2) {
            close(fd);
            return 0;
        }
        uint32_t nfat = swap ? __builtin_bswap32(header[1]) : header[1];
        if (nfat > 16) {
            close(fd);
            return 0;
        }
        bool found = false;
        for (uint32_t i = 0; i < nfat && !found; i++) {
            struct fat_arch e;
            if (read(fd, &e, sizeof(e)) != (ssize_t)sizeof(e)) break;
            uint32_t cputype = swap ? __builtin_bswap32(e.cputype) : e.cputype;
            if ((int)cputype == want_cputype) {
                arch_offset = (off_t)(swap ? __builtin_bswap32(e.offset) : e.offset);
                found = true;
            }
        }
        if (!found) {
            close(fd);
            return 0;
        }
        if (lseek(fd, arch_offset, SEEK_SET) < 0 ||
            read(fd, header, sizeof(uint32_t) * 5) < (ssize_t)sizeof(uint32_t) * 5) {
            close(fd);
            return 0;
        }
        magic = header[0];
    }
    if (magic != MH_MAGIC_64 && magic != MH_CIGAM_64 && magic != MH_MAGIC && magic != MH_CIGAM) {
        close(fd);
        return 0;
    }
    bool mswap = magic == MH_CIGAM_64 || magic == MH_CIGAM;
    uint32_t ncmds = mswap ? __builtin_bswap32(header[4]) : header[4];
    if (ncmds > 4096) {
        close(fd);
        return 0;
    }
    off_t pos = arch_offset + (magic == MH_MAGIC_64 || magic == MH_CIGAM_64 ? sizeof(struct mach_header_64)
                                                                            : sizeof(struct mach_header));
    for (uint32_t i = 0; i < ncmds; i++) {
        struct load_command lc;
        if (pread(fd, &lc, sizeof(lc), pos) != (ssize_t)sizeof(lc)) break;
        uint32_t cmd = mswap ? __builtin_bswap32(lc.cmd) : lc.cmd;
        uint32_t cmdsize = mswap ? __builtin_bswap32(lc.cmdsize) : lc.cmdsize;
        if (cmdsize < sizeof(lc) || cmdsize > 0x1000000u) break;
        if (cmd == LC_LOAD_DYLIB || cmd == LC_LOAD_WEAK_DYLIB) {
            uint32_t name_off_field;
            if (cmdsize >= sizeof(lc) + 16 + 2 &&
                pread(fd, &name_off_field, sizeof(name_off_field), pos + sizeof(lc)) == sizeof(name_off_field)) {
                if (mswap) name_off_field = __builtin_bswap32(name_off_field);
                if (name_off_field < cmdsize) {
                    char name[PATH_MAX];
                    uint32_t max_read = cmdsize - name_off_field;
                    if (max_read >= sizeof(name)) max_read = sizeof(name) - 1;
                    if (pread(fd, name, max_read, pos + name_off_field) == (ssize_t)max_read) {
                        name[max_read] = '\0';
                        if (strncmp(name, "@executable_path/", 17) == 0) {
                            int ups = 0;
                            for (const char *p = name + 17;; p += 3) {
                                if (p[0] == '.' && p[1] == '.' && (p[2] == '/' || p[2] == '\0')) {
                                    ups++;
                                    if (p[2] == '\0') break;
                                } else break;
                            }
                            if (ups > max_ups) max_ups = ups;
                        }
                    }
                }
            }
        }
        pos += cmdsize;
    }
    close(fd);
    return max_ups;
}

/* 收集 LC_RPATH 列表（最多 32 条，含 @loader_path/@executable_path 展开） */
#define MAX_RPATHS 32
struct RpathList {
    char paths[MAX_RPATHS][PATH_MAX];
    int count;
};

static void collect_rpaths(const char *original, const char *resolved_orig, struct RpathList *out)
{
    memset(out, 0, sizeof(*out));
    int fd = open(original, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    uint32_t header[8];
    if (read(fd, header, sizeof(header)) < (ssize_t)sizeof(uint32_t) * 5) {
        close(fd);
        return;
    }
    uint32_t magic = header[0];
    off_t arch_offset = 0;
    cpu_type_t want_cputype = 0;
#if defined(__arm64__) || defined(__aarch64__)
    want_cputype = CPU_TYPE_ARM64;
#elif defined(__x86_64__)
    want_cputype = CPU_TYPE_X86_64;
#endif
    if (magic == FAT_MAGIC || magic == FAT_CIGAM) {
        bool swap = magic == FAT_CIGAM;
        if (lseek(fd, 0, SEEK_SET) < 0 || read(fd, header, sizeof(uint32_t) * 2) < (ssize_t)sizeof(uint32_t) * 2) {
            close(fd);
            return;
        }
        uint32_t nfat = swap ? __builtin_bswap32(header[1]) : header[1];
        if (nfat > 16) {
            close(fd);
            return;
        }
        bool found = false;
        for (uint32_t i = 0; i < nfat && !found; i++) {
            struct fat_arch e;
            if (read(fd, &e, sizeof(e)) != (ssize_t)sizeof(e)) break;
            uint32_t cputype = swap ? __builtin_bswap32(e.cputype) : e.cputype;
            if ((int)cputype == want_cputype) {
                arch_offset = (off_t)(swap ? __builtin_bswap32(e.offset) : e.offset);
                found = true;
            }
        }
        if (!found) {
            close(fd);
            return;
        }
        if (lseek(fd, arch_offset, SEEK_SET) < 0 ||
            read(fd, header, sizeof(uint32_t) * 5) < (ssize_t)sizeof(uint32_t) * 5) {
            close(fd);
            return;
        }
        magic = header[0];
    }
    if (magic != MH_MAGIC_64 && magic != MH_CIGAM_64 && magic != MH_MAGIC && magic != MH_CIGAM) {
        close(fd);
        return;
    }
    bool mswap = magic == MH_CIGAM_64 || magic == MH_CIGAM;
    uint32_t ncmds = mswap ? __builtin_bswap32(header[4]) : header[4];
    if (ncmds > 4096) {
        close(fd);
        return;
    }
    off_t pos = arch_offset + (magic == MH_MAGIC_64 || magic == MH_CIGAM_64 ? sizeof(struct mach_header_64)
                                                                            : sizeof(struct mach_header));
    /* 原二进制目录（@loader_path 语义） */
    char orig_dir[PATH_MAX];
    snprintf(orig_dir, sizeof(orig_dir), "%s", resolved_orig);
    char *ls = strrchr(orig_dir, '/');
    if (ls) *ls = '\0';

    for (uint32_t i = 0; i < ncmds && out->count < MAX_RPATHS; i++) {
        struct load_command lc;
        if (pread(fd, &lc, sizeof(lc), pos) != (ssize_t)sizeof(lc)) break;
        uint32_t cmd = mswap ? __builtin_bswap32(lc.cmd) : lc.cmd;
        uint32_t cmdsize = mswap ? __builtin_bswap32(lc.cmdsize) : lc.cmdsize;
        if (cmdsize < sizeof(lc) || cmdsize > 0x1000000u) break;
        if (cmd == LC_RPATH) {
            uint32_t name_off_field;
            if (cmdsize >= sizeof(lc) + 16 + 2 &&
                pread(fd, &name_off_field, sizeof(name_off_field), pos + sizeof(lc)) == sizeof(name_off_field)) {
                if (mswap) name_off_field = __builtin_bswap32(name_off_field);
                if (name_off_field < cmdsize) {
                    char raw[PATH_MAX];
                    uint32_t max_read = cmdsize - name_off_field;
                    if (max_read >= sizeof(raw)) max_read = sizeof(raw) - 1;
                    if (pread(fd, raw, max_read, pos + name_off_field) == (ssize_t)max_read) {
                        raw[max_read] = '\0';
                        const char *val = raw;
                        char expanded[PATH_MAX];
                        if (strncmp(val, "@loader_path/", 13) == 0) {
                            snprintf(expanded, sizeof(expanded), "%s/%s", orig_dir, val + 13);
                        } else if (strcmp(val, "@loader_path") == 0) {
                            snprintf(expanded, sizeof(expanded), "%s", orig_dir);
                        } else {
                            snprintf(expanded, sizeof(expanded), "%s", val);
                        }
                        char norm[PATH_MAX];
                        normalize_path(expanded, norm, sizeof(norm));
                        snprintf(out->paths[out->count], PATH_MAX, "%s", norm);
                        out->count++;
                    }
                }
            }
        }
        pos += cmdsize;
    }
    close(fd);
}

/* 解析 @rpath/lib → 在 rpath 列表中找第一个存在的原始路径；找不到返回 false */
static bool resolve_rpath_target(const struct RpathList *rpaths, const char *rel, const char *copy_dir,
                                 char *out, size_t cap)
{
    char norm_copy_dir[PATH_MAX];
    normalize_path(copy_dir, norm_copy_dir, sizeof(norm_copy_dir));
    for (int i = 0; i < rpaths->count; i++) {
        /* @rpath 展开值本身可能带 ../（相对）——rpath 已 normalize；
         * 副本侧对应路径 = 副本目录 + rpath 中原前缀之外的部分。
         * 简化：副本侧与原侧共用镜像层级，直接尝试原绝对路径存在性。 */
        char candidate[PATH_MAX];
        snprintf(candidate, sizeof(candidate), "%s/%s", rpaths->paths[i], rel);
        struct stat st;
        if (stat(candidate, &st) == 0) {
            snprintf(out, cap, "%s", candidate);
            return true;
        }
        (void)norm_copy_dir;
    }
    return false;
}

static void bridge_executable_path_deps(const char *original, const char *copy)
{
    int fd = open(original, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    uint32_t header[8];
    if (read(fd, header, sizeof(header)) < (ssize_t)sizeof(uint32_t) * 5) {
        close(fd);
        return;
    }
    uint32_t magic = header[0];
    off_t arch_offset = 0;
    cpu_type_t want_cputype = 0;
#if defined(__arm64__) || defined(__aarch64__)
    want_cputype = CPU_TYPE_ARM64;
#elif defined(__x86_64__)
    want_cputype = CPU_TYPE_X86_64;
#endif
    if (magic == FAT_MAGIC || magic == FAT_CIGAM) {
        bool swap = magic == FAT_CIGAM;
        if (lseek(fd, 0, SEEK_SET) < 0 || read(fd, header, sizeof(uint32_t) * 2) < (ssize_t)sizeof(uint32_t) * 2) {
            close(fd);
            return;
        }
        uint32_t nfat = swap ? __builtin_bswap32(header[1]) : header[1];
        if (nfat > 16) {
            close(fd);
            return;
        }
        bool found = false;
        for (uint32_t i = 0; i < nfat && !found; i++) {
            struct fat_arch e;
            if (read(fd, &e, sizeof(e)) != (ssize_t)sizeof(e)) break;
            uint32_t cputype = swap ? __builtin_bswap32(e.cputype) : e.cputype;
            if ((int)cputype == want_cputype) {
                arch_offset = (off_t)(swap ? __builtin_bswap32(e.offset) : e.offset);
                found = true;
            }
        }
        if (!found) {
            close(fd);
            return;
        }
        if (lseek(fd, arch_offset, SEEK_SET) < 0 ||
            read(fd, header, sizeof(uint32_t) * 5) < (ssize_t)sizeof(uint32_t) * 5) {
            close(fd);
            return;
        }
        magic = header[0];
    }
    if (magic != MH_MAGIC_64 && magic != MH_CIGAM_64 && magic != MH_MAGIC && magic != MH_CIGAM) {
        close(fd);
        return;
    }
    bool mswap = magic == MH_CIGAM_64 || magic == MH_CIGAM;
    uint32_t ncmds = mswap ? __builtin_bswap32(header[4]) : header[4];
    if (ncmds > 4096) {
        close(fd);
        return;
    }
    off_t pos = arch_offset + (magic == MH_MAGIC_64 || magic == MH_CIGAM_64 ? sizeof(struct mach_header_64)
                                                                            : sizeof(struct mach_header));
    /* 原二进制所在目录（依赖解析基准）：original 可能是 symlink（CLT 的
     * usr/bin/python3 → Frameworks/...），@executable_path 相对的是**真实
     * 文件**所在目录，必须 realpath 解析后再取目录 */
    char resolved_orig[PATH_MAX];
    if (realpath(original, resolved_orig) == NULL) return;
    char orig_dir[PATH_MAX];
    snprintf(orig_dir, sizeof(orig_dir), "%s", resolved_orig);
    char *last_slash = strrchr(orig_dir, '/');
    if (last_slash) *last_slash = '\0';
    /* 收集 LC_RPATH（@rpath 依赖解析用） */
    struct RpathList rpaths;
    collect_rpaths(original, resolved_orig, &rpaths);
    /* 副本所在目录；链接位置 = 副本目录上跳 max_ups 级（与原侧 ../解析对称） */
    char copy_dir[PATH_MAX];
    snprintf(copy_dir, sizeof(copy_dir), "%s", copy);
    last_slash = strrchr(copy_dir, '/');
    if (last_slash) *last_slash = '\0';

    for (uint32_t i = 0; i < ncmds; i++) {
        struct load_command lc;
        if (pread(fd, &lc, sizeof(lc), pos) != (ssize_t)sizeof(lc)) break;
        uint32_t cmd = mswap ? __builtin_bswap32(lc.cmd) : lc.cmd;
        uint32_t cmdsize = mswap ? __builtin_bswap32(lc.cmdsize) : lc.cmdsize;
        if (cmdsize < sizeof(lc) || cmdsize > 0x1000000u) break;
        if (cmd == LC_LOAD_DYLIB || cmd == LC_LOAD_WEAK_DYLIB) {
            /* LC_LOAD_DYLIB 布局：load_command(8) + dylib{name.offset(4),timestamp(4),
             * current(4),compat(4)}，name 字符串位于命令起点 + name.offset */
            uint32_t name_off_field;
            if (cmdsize < sizeof(lc) + 16 + 2) {
                pos += cmdsize;
                continue;
            }
            if (pread(fd, &name_off_field, sizeof(name_off_field), pos + sizeof(lc)) != sizeof(name_off_field)) {
                pos += cmdsize;
                continue;
            }
            if (mswap) name_off_field = __builtin_bswap32(name_off_field);
            if (name_off_field >= cmdsize) {
                pos += cmdsize;
                continue;
            }
            char name[PATH_MAX];
            uint32_t max_read = cmdsize - name_off_field;
            if (max_read >= sizeof(name)) max_read = sizeof(name) - 1;
            if (pread(fd, name, max_read, pos + name_off_field) != (ssize_t)max_read) {
                pos += cmdsize;
                continue;
            }
            name[max_read] = '\0';
            if (strncmp(name, "@executable_path/", 17) == 0) {
                const char *rel = name + 17;
                /* 原始 target：原目录 + 相对段 */
                char orig_target[PATH_MAX];
                snprintf(orig_target, sizeof(orig_target), "%s/%s", orig_dir, rel);
                char norm_orig[PATH_MAX];
                normalize_path(orig_target, norm_orig, sizeof(norm_orig));
                /* 副本侧：从副本目录按 rel 的 .. 数上跳（副本目录深度与原目录
                 * 一致，镜像层级已由 resign 建立），剩余相对段拼在链接位置下 */
                int ups = 0;
                const char *rest = rel;
                for (;;) {
                    if (rest[0] == '.' && rest[1] == '.' && (rest[2] == '/' || rest[2] == '\0')) {
                        ups++;
                        rest += rest[2] ? 3 : 2;
                    } else break;
                }
                char link_dir[PATH_MAX];
                snprintf(link_dir, sizeof(link_dir), "%s", copy_dir);
                for (int u = 0; u < ups; u++) {
                    char *ls = strrchr(link_dir, '/');
                    if (!ls || ls == link_dir) break;
                    *ls = '\0';
                }
                char norm_copy[PATH_MAX];
                snprintf(norm_copy, sizeof(norm_copy), "%s/%s", link_dir, rest);
                normalize_path(norm_copy, norm_copy, sizeof(norm_copy));
                struct stat st;
                if (lstat(norm_copy, &st) != 0 && stat(norm_orig, &st) == 0) {
                    if (symlink(norm_orig, norm_copy) != 0) {
                        slog("dep bridge failed: %s -> %s errno=%d", norm_copy, norm_orig, errno);
                    } else {
                        slog("dep bridged: %s -> %s", norm_copy, norm_orig);
                    }
                }
            } else if (strncmp(name, "@rpath/", 7) == 0) {
                /* @rpath 依赖（如 ld 的 @rpath/libtapi.dylib）：按 LC_RPATH 列表
                 * 解析原始位置，在副本目录放 symlink 指向原绝对路径 */
                const char *rel = name + 7;
                char orig_target[PATH_MAX];
                if (resolve_rpath_target(&rpaths, rel, copy_dir, orig_target, sizeof(orig_target))) {
                    char copy_side[PATH_MAX];
                    snprintf(copy_side, sizeof(copy_side), "%s/%s", copy_dir, rel);
                    char norm_copy[PATH_MAX];
                    normalize_path(copy_side, norm_copy, sizeof(norm_copy));
                    struct stat st;
                    if (lstat(norm_copy, &st) != 0 && stat(orig_target, &st) == 0) {
                        if (symlink(orig_target, norm_copy) != 0) {
                            slog("rpath bridge failed: %s -> %s errno=%d", norm_copy, orig_target, errno);
                        } else {
                            slog("rpath bridged: %s -> %s", norm_copy, orig_target);
                        }
                    }
                }
            }
        }
        pos += cmdsize;
    }
    close(fd);
}
/* 相对路径 → cwd 绝对路径（与内核 openat(AT_FDCWD) 语义一致） */
static void resolve_relative(const char *in, char *out, size_t cap)
{
    if (in && in[0] == '/') {
        snprintf(out, cap, "%s", in);
        return;
    }
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) {
        snprintf(out, cap, "%s", in ? in : "");
        return;
    }
    snprintf(out, cap, "%s/%s", cwd, in ? in : "");
}

/* 插桩开启判定：策略加载成功才管控（缺省 passthrough，供弱链接环境） */
static volatile bool g_active = false;

/* ── watchdog：宿主（launcher）死亡 → 整树陪葬（对齐 Linux/OH 管道方案）────
 * macOS 无 Linux 的 fork 管道传递（TS 层 spawn 不经 wrapper），用 kqueue
 * EVFILT_PROC/NOTE_EXIT 监听父进程：宿主退出 → 事件触发 → kill 本进程组。
 * kqueue 的 proc 事件绑定注册时的进程对象，pid 复用不误判（事件先于复用）。
 * 防宿主崩溃后沙箱 shell 树残留。 */

static int g_watch_kq = -1;
static pid_t g_watch_parent = -1;
static pthread_mutex_t g_watch_mu = PTHREAD_MUTEX_INITIALIZER;

static void *watch_thread(void *arg)
{
    (void)arg;
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)g_watch_parent, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, NULL);
    if (kevent(g_watch_kq, &ev, 1, NULL, 0, NULL) != 0) {
        slog("watchdog: kevent register failed errno=%d", errno);
        return NULL;
    }
    struct kevent out;
    int n;
    for (;;) {
        n = kevent(g_watch_kq, NULL, 0, &out, 1, NULL);   /* 阻塞等父进程退出 */
        if (n > 0) break;
        if (n < 0 && errno != EINTR) break;
        /* n < 0 && EINTR：继续等 */
    }
    slog("watchdog: launcher (pid %d) gone, killing sandboxed process tree", (int)g_watch_parent);
    pid_t pg = getpgid(0);
    if (pg > 0) kill(-pg, SIGKILL);
    kill(getpid(), SIGKILL);
    _exit(129);
    return NULL;
}

static void start_watch(void)
{
    /* 只有策略生效的沙箱进程需要 watchdog（passthrough 进程非沙箱树成员）。
     * 父进程是 TS 宿主（OpenDesk 主进程或调试实例）；宿主退出 → 沙箱树陪葬。 */
    if (!g_active) return;
    pid_t parent = getppid();
    if (parent <= 1) return;
    int kq = kqueue();
    if (kq < 0) {
        slog("watchdog: kqueue failed errno=%d, not armed", errno);
        return;
    }
    pthread_mutex_lock(&g_watch_mu);
    g_watch_kq = kq;
    g_watch_parent = parent;
    pthread_mutex_unlock(&g_watch_mu);
    pthread_t t;
    pthread_attr_t a;
    pthread_attr_init(&a);
    pthread_attr_setdetachstate(&a, PTHREAD_CREATE_DETACHED);
    pthread_attr_setstacksize(&a, 256 * 1024);
    if (pthread_create(&t, &a, watch_thread, NULL) != 0) {
        slog("watchdog thread create failed: watchdog not armed");
        return;
    }
    slog("watchdog armed: parent pid %d", (int)parent);
}

/* fd 写判定缓存（open/openat 打开成功时填充、close 清除；定义在文件写段之前供 open 用） */
#define FD_CACHE_SLOTS 1024
static volatile int g_fd_cache[FD_CACHE_SLOTS]; /* 0=未缓存 1=可写 -1=拒绝 */

static bool is_sandboxed(void)
{
    return g_active;
}

/* write 相关：open(O_TRUNC/O_CREAT/O_APPEND)、creat、unlink 等需要管控的入口 */
static bool open_has_write_semantics(int flags)
{
    int acc = flags & O_ACCMODE;
    /* O_RDWR 仅探测、不带截断/创建/追加标志：按 read 判定。工具链（node-gyp
     * 对 python 二进制等）常以 O_RDWR 打开检查可写性却从不写入；按写判定会让
     * standard 下每次探测都弹 write ask。真正的写入仍由 wrap_write/wrap_pwrite
     * 的 fd_write_verdict 按路径 ACC_WRITE 兜底拦截——open 放行不授予写权限。 */
    if (acc == O_RDWR && (flags & (O_TRUNC | O_CREAT | O_APPEND)) == 0) return false;
    if (acc == O_WRONLY || acc == O_RDWR) return true;
    if (flags & (O_TRUNC | O_CREAT | O_APPEND)) return true;
    return false;
}

/* stat 需放行（布局一致性）；写类操作统一走 policy_check */
static int check_write_path(const char *pathname, const char *fn)
{
    if (!is_sandboxed()) return 0;
    char raw[PATH_MAX];
    resolve_relative(pathname, raw, sizeof(raw));
    char norm[PATH_MAX];
    if (normalize_path(raw, norm, sizeof(norm)) != 0) {
        slog("%s denied (path too deep): %s", fn, raw);
        errno = EACCES;
        return -1;
    }
    /*
     * 写类操作父目录链缺失 → 该写注定失败（内核返回 ENOENT）：透传不触发 ask。
     * 与 Windows sandboxCheckWriteParentMissing / Linux write_parent_missing 同构
     * 实现——dbghelp/SymSrv 按模块内嵌 CodeView 路径（node.exe 的
     * c:\ws\out\Release\node.pdb 等）探测并写入符号缓存，这类路径在多数机器上
     * 根本不存在，此前每次探测都弹写审批框。deny 规则仍优先拦截。
     */
    {
        char parent[PATH_MAX];
        const char *slash = strrchr(norm, '/');
        if (slash && slash != norm && (size_t)(slash - norm) < sizeof(parent)) {
            memcpy(parent, norm, (size_t)(slash - norm));
            parent[slash - norm] = '\0';
            struct stat pst;
            if (stat(parent, &pst) != 0 && errno == ENOENT) {
                /* deny 规则仍优先拦截（防 deny 区存在性探测泄露），alias 变体
                 * 同理参与"最具体"竞争；命中 allow/ask/未命中一律透传：父链缺失
                 * 的写注定 ENOENT，弹审批是纯噪音。 */
                struct PolicyHit hit = policy_lookup_detailed(norm, ACC_WRITE);
                char alias[PATH_MAX];
                if (path_alias_variant(norm, alias, sizeof(alias))) {
                    struct PolicyHit ah = policy_lookup_detailed(alias, ACC_WRITE);
                    if (ah.perm >= 0 &&
                        (hit.perm < 0 || ah.base_len > hit.base_len ||
                         (ah.base_len == hit.base_len && ah.perm < hit.perm)))
                        hit = ah;
                }
                if (hit.perm == PERM_DENY_box) {
                    slog("%s denied (missing parent, deny rule): %s", fn, norm);
                    errno = EACCES;
                    return EACCES;
                }
                slog("%s pass-through (parent missing -> ENOENT): %s", fn, norm);
                return 0;   /* 放行：内核对缺失父链的写返回 ENOENT */
            }
        }
    }
    int rc = policy_check(norm, ACC_WRITE);
    if (rc != 0) {
        slog("%s denied: %s", fn, norm);
        errno = EACCES;
    }
    return rc;
}

static int check_read_path(const char *pathname, const char *fn)
{
    if (!is_sandboxed()) return 0;
    char raw[PATH_MAX];
    resolve_relative(pathname, raw, sizeof(raw));
    char norm[PATH_MAX];
    if (normalize_path(raw, norm, sizeof(norm)) != 0) {
        slog("%s denied (path too deep): %s", fn, raw);
        errno = EACCES;
        return -1;
    }
    /*
     * 读探测的目标不存在 → 透传（真实 open 返回 ENOENT），不判定不 ask：
     * 读不到任何内容，只是把"不存在"结果透传给探测/容错逻辑。与 Linux
     * preload.c 的 open 读 ENOENT 透传、Windows sandboxCheckNotExistRead 同一
     * 哲学。实测：standard 沙箱里 git status 每次对 attributes 查找链上不存在
     * 的 ~/.config/git/attributes、<Git 安装前缀>/share/git-core/gitattributes
     * 做存在性探测，cache_ttl=0 不缓存，逐次弹 ask 纯属噪音。
     * deny 规则仍优先拦截（防 deny 区存在性探测泄露），与 check_write_path
     * 的"父链缺失透传"同构：命中 deny 按拒绝处理，命中 ask/allow/未命中一律
     * 放行交给内核返回真实错误码。
     */
    {
        struct stat st;
        if (stat(norm, &st) != 0 && errno == ENOENT) {
            struct PolicyHit hit = policy_lookup_detailed(norm, ACC_READ);
            char alias[PATH_MAX];
            if (path_alias_variant(norm, alias, sizeof(alias))) {
                struct PolicyHit ah = policy_lookup_detailed(alias, ACC_READ);
                if (ah.perm >= 0 &&
                    (hit.perm < 0 || ah.base_len > hit.base_len ||
                     (ah.base_len == hit.base_len && ah.perm < hit.perm)))
                    hit = ah;
            }
            if (hit.perm == PERM_DENY_box) {
                slog("%s denied (missing target, deny rule): %s", fn, norm);
                errno = EACCES;
                return EACCES;
            }
            slog("%s pass-through (target missing -> ENOENT): %s", fn, norm);
            return 0;   /* 放行：真实 open 对不存在的目标返回 ENOENT */
        }
    }
    int rc = policy_check(norm, ACC_READ);
    if (rc != 0) {
        slog("%s denied: %s", fn, norm);
        errno = EACCES;
    }
    return rc;
}

/* ── 内部操作豁免 ───────────────────────────────────────────────────────── */

/*
 * 沙箱自身的行为（日志写、签名缓存复制、ask 的 curl、codesign）不得再经策略
 * 检查：一来递归死锁，二来日志/缓存写不该弹审批。线程局部深度计数覆盖当前
 * 线程；ask/codesign 子进程通过剥离策略环境变量退出沙箱。
 */
static bool is_internal(void)
{
    return g_internal_depth > 0;
}

static void internal_begin(void)
{
    g_internal_depth++;
}

static void internal_end(void)
{
    g_internal_depth--;
}

/* ── execve 家族 ────────────────────────────────────────────────────────── */

/* shebang 解析：读文件首行 "#!interp [arg]"。is_script 返回是否脚本 */
static bool read_shebang(const char *path, char *interp, size_t icap, char *iarg, size_t acap, bool *is_script)
{
    *is_script = false;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    char head[560];
    ssize_t n = read(fd, head, sizeof(head) - 1);
    close(fd);
    if (n <= 0) return false;
    head[n] = '\0';
    if (n < 2 || head[0] != '#' || head[1] != '!') return false;
    *is_script = true;
    /* 解释器行：到第一个换行为止；按空白拆出 interp 与可选单参数 */
    char *line_end = strchr(head, '\n');
    if (line_end) *line_end = '\0';
    char *p = head + 2;
    while (*p == ' ' || *p == '\t') p++;
    char *sp = p;
    while (*sp && *sp != ' ' && *sp != '\t') sp++;
    size_t ilen = (size_t)(sp - p);
    if (ilen == 0 || ilen >= icap) return false;
    memcpy(interp, p, ilen);
    interp[ilen] = '\0';
    iarg[0] = '\0';
    while (*sp == ' ' || *sp == '\t') sp++;
    if (*sp) {
        char *arg_end = sp;
        while (*arg_end && *arg_end != ' ' && *arg_end != '\t') arg_end++;
        size_t alen = (size_t)(arg_end - sp);
        if (alen < acap) {
            memcpy(iarg, sp, alen);
            iarg[alen] = '\0';
        }
    }
    return true;
}

/*
 * CLT 工具链 basename 匹配：精确命中或 <基名>-<纯数字> 版本后缀命中
 * （clang-14、gcc-12 等带版本号的别名二进制随 CLT 版本演进出现，逐个
 * 枚举过时即失效；纯数字约束防止 clang-format/clang++ 这类连字符名
 * 误命中）。数据类工具（git 等）刻意不在表内：它们的写必须管控。
 */
static bool clt_toolchain_basename(const char *name)
{
    static const char *const allow[] = { "cc",      "clang",   "clang++", "gcc",      "g++",
                                         "ld",      "swift",   "swiftc",  "ar",       "ranlib",
                                         "nm",      "strip",   "libtool", "install_name_tool",
                                         "otool",   "codesign", "lipo",   NULL };
    for (int i = 0; allow[i]; i++) {
        size_t bl = strlen(allow[i]);
        if (strncmp(name, allow[i], bl) != 0) continue;
        if (name[bl] == '\0') return true;
        if (name[bl] != '-') continue;
        const char *v = name + bl + 1;
        if (*v == '\0') continue; /* 悬空连字符（"clang-"）不视为版本后缀 */
        bool all_digits = true;
        for (const char *d = v; *d; d++) {
            if (*d < '0' || *d > '9') {
                all_digits = false;
                break;
            }
        }
        if (all_digits) return true;
    }
    return false;
}

/*
 * exec 前置处理：权限检查 + 平台二进制重签 + shebang 改写。
 * 返回 0 且 out_path/out_argv 就绪（调用方 exec）；非 0 表示拒绝（errno 已置）。
 * out_argv 是 malloc 的 argv 副本，调用方负责 free（exec 失败路径）。
 */
static int prepare_exec(const char *path, char *const argv[], char **resolved_path, char ***out_argv, char **framework_home, bool *strip_dyld_env)
{
    char raw[PATH_MAX];
    resolve_relative(path, raw, sizeof(raw));
    char norm[PATH_MAX];
    if (normalize_path(raw, norm, sizeof(norm)) != 0) {
        slog("exec denied (path too deep): %s", raw);
        errno = EACCES;
        return -1;
    }
    int rc = policy_check(norm, ACC_EXEC);
    if (rc != 0) {
        slog("exec denied: %s", norm);
        errno = EACCES;
        return -1;
    }
    struct stat st;
    bool is_dir = stat(path, &st) == 0 && S_ISDIR(st.st_mode);
    if (is_dir) return 0; /* 目录 exec：保持内核 EACCES 语义 */

    /* shebang：解释器是平台二进制时内核会绕过注入，改写为直接 exec 解释器 */
    char interp[PATH_MAX], iarg[256];
    bool is_script = false;
    if (read_shebang(path, interp, sizeof(interp), iarg, sizeof(iarg), &is_script) && is_script) {
        char cached[PATH_MAX];
        char use_interp[PATH_MAX];
        snprintf(use_interp, sizeof(use_interp), "%s", interp);
        if (needs_resign(use_interp)) {
            char *cached_interp = resign_copy_for_exec(use_interp);
            if (cached_interp) {
                snprintf(cached, sizeof(cached), "%s", cached_interp);
                free(cached_interp);
                snprintf(use_interp, sizeof(use_interp), "%s", cached);
            } else {
                /*
                 * 解释器重签失败：拒绝 exec。保持原解释器会让平台解释器
                 * 忽略注入——脚本（及其所有子命令）在无沙箱下运行。
                 */
                slog("exec resign failed (interpreter), deny: %s", use_interp);
                errno = EACCES;
                return -1;
            }
        }
        /* 新 argv = [interp, iarg?, script, argv[1..]] */
        size_t argc = 0;
        while (argv[argc]) argc++;
        bool has_iarg = iarg[0] != '\0';
        size_t new_argc = 1 + (has_iarg ? 1 : 0) + 1 + (argc > 1 ? argc - 1 : 0);
        char **new_argv = malloc((new_argc + 1) * sizeof(char *));
        if (!new_argv) {
            errno = ENOMEM;
            return -1;
        }
        size_t o = 0;
        new_argv[o++] = xstrdup(use_interp);
        if (has_iarg) new_argv[o++] = xstrdup(iarg);
        new_argv[o++] = xstrdup(path);
        for (size_t i = 1; i < argc; i++) new_argv[o++] = xstrdup(argv[i]);
        new_argv[o] = NULL;
        *resolved_path = xstrdup(use_interp);
        *out_argv = new_argv;
        /* Python framework 解释器副本（CLT/Homebrew）：按标记注入 PYTHONHOME，
         * 否则副本定位不到 stdlib 启动即崩（No module named 'encodings'）。
         * 非 Python 框架解释器无标记，不注入 */
        if (framework_home) {
            char cached_dir[PATH_MAX];
            snprintf(cached_dir, sizeof(cached_dir), "%s", use_interp);
            char *slash = strrchr(cached_dir, '/');
            if (slash) *slash = '\0';
            *framework_home = read_python_home_marker(cached_dir);
        }
        return 0;
    }

    /*
     * CLT 编译/链接驱动精确放行（cc/clang/ld/swift 等 basename 白名单）：
     * 这类二进制依赖树庞大（@rpath/framework 链），重签副本在链接/编译子进程
     * 链上不稳定（实测 hang），且其写操作（构建产物）几乎总落在工作区/工具链
     * 缓存目录（policy 已放行）。**git 等数据类工具不放行**——它们的写必须管控
     * （git 的 @rpath 依赖已可桥接）。
     */
    {
        const char *cb = strrchr(path, '/');
        cb = cb ? cb + 1 : path;
        if (clt_toolchain_basename(cb) &&
            strncmp(path, "/Library/Developer/CommandLineTools/", 36) == 0) {
            /* lipo 只对只读信息子命令（-archs/-info/-detailed_info）豁免：
             * 变更型子命令（-create/-thin/-replace/-remove -output）可把
             * Mach-O 写到任意路径，豁免会静默绕过写策略与 ask 门控。
             * 未豁免的 lipo 走重签副本路径，副本缺 @rpath/libLTO.dylib
             * 启动即失败——沙箱内变更型 lipo 事实不可用（fail-closed，
             * 与白名单引入前的行为一致），不会静默脱离管控执行。 */
            if (strcmp(cb, "lipo") == 0) {
                static const char *const readonly_verbs[] = { "-archs", "-info", "-detailed_info", NULL };
                bool readonly_verb = false;
                for (int v = 0; readonly_verbs[v]; v++) {
                    if (argv[1] && strcmp(argv[1], readonly_verbs[v]) == 0) {
                        readonly_verb = true;
                        break;
                    }
                }
                if (!readonly_verb) {
                    slog("lipo mutating command denied in sandbox: %s", argv[1] ? argv[1] : "");
                    errno = EACCES;
                    return -1;
                }
            }
            if (strip_dyld_env) *strip_dyld_env = true;
            return 0;
        }
    }
    /* 直接二进制：需要重签的换缓存路径 */
    if (needs_resign(path)) {
        char *cached = resign_copy_for_exec(path);
        if (cached) {
            *resolved_path = cached;
            /* argv 原样透传（argv[0] 保留原程序名，程序自身无感知） */
            *out_argv = NULL;
            /* Python framework 副本：返回框架根供调用方注入 PYTHONHOME */
            if (framework_home) {
                char cached_dir[PATH_MAX];
                snprintf(cached_dir, sizeof(cached_dir), "%s", cached);
                char *slash = strrchr(cached_dir, '/');
                if (slash) *slash = '\0';
                /* 标记与副本同目录（update_python_home_marker 保证），内容 =
                 * 原始框架 prefix（stdlib 位置）；无标记（非 Python 框架）不注入 */
                *framework_home = read_python_home_marker(cached_dir);
            }
            return 0;
        }
        /*
         * 重签失败：拒绝 exec（EACCES）。若回退原路径 exec，平台二进制会
         * 静默忽略注入——命令在无沙箱下运行，等于沙箱失效。拒绝更符合
         * fail-closed（重签失败概率极低：OOM 或 codesign 异常）。
         */
        slog("exec resign failed, deny: %s", path);
        errno = EACCES;
        return -1;
    }
    *resolved_path = NULL;
    *out_argv = NULL;
    return 0;
}

static void free_exec_prep(char *resolved_path, char **out_argv)
{
    if (resolved_path) free(resolved_path);
    if (out_argv) {
        for (size_t i = 0; out_argv[i]; i++) free(out_argv[i]);
        free(out_argv);
    }
}

/* execve 的真实实现：裸 syscall（interpose 环境下 RTLD_NEXT 会拿回 wrap 自身） */
static int real_execve(const char *path, char *const argv[], char *const envp[])
{
    return __execve(path, argv, envp);
}

static int wrap_execve(const char *path, char *const argv[], char *const envp[])
{
    if (is_internal() || !is_sandboxed()) return real_execve(path, argv, envp);
    char *resolved = NULL;
    char **new_argv = NULL;
    char *framework_home = NULL;
    bool strip_dyld_env = false;
    if (prepare_exec(path, argv, &resolved, &new_argv, &framework_home, &strip_dyld_env) != 0) return -1;
    const char *use = resolved ? resolved : path;
    char *const *use_argv = new_argv ? new_argv : argv;
    /* 注入强制重注入（M4）：非 strip 目标的子进程恒携带本 dylib（对齐
     * Linux/OH 的 build_envp），沙箱内清 DYLD_INSERT_LIBRARIES 无法脱管 */
    char **reinjected = strip_dyld_env ? NULL : build_reinjected_env(envp);
    char **stripped = strip_dyld_env ? build_stripped_env((char *const *)envp) : NULL;
    char *const *base_env = reinjected ? (char *const *)reinjected
                            : stripped ? (char *const *)stripped : envp;
    char **py_env = framework_home ? envp_with_python_home(base_env, framework_home) : NULL;
    int rc = real_execve(use, use_argv, py_env ? (char *const *)py_env : base_env);
    int saved = errno;
    free_python_home_envp(py_env);
    free(framework_home);
    free(reinjected);
    free(stripped);
    free_exec_prep(resolved, new_argv);
    errno = saved;
    return rc;
}

/* PATH 搜索 + exec。返回 -1 且 errno=ENOENT 表示全部候选不可执行 */

static int wrap_execvp(const char *file, char *const argv[])
{
    extern char **environ;
    if (is_internal() || !is_sandboxed()) {
        /* passthrough：RTLD_NEXT 在 interpose 环境会解析回 wrap 自身（实测递归），
         * 直接内联 PATH 展开 + __execve；ENOEXEC 时继续尝试下一候选（内核语义） */
        if (strchr(file, '/')) return __execve(file, argv, environ);
        const char *search = getenv("PATH");
        const char *p = search && *search ? search : "/usr/bin:/bin:/usr/sbin:/sbin";
        char candidate[PATH_MAX];
        int last_errno = ENOENT;
        while (*p) {
            const char *colon = strchr(p, ':');
            size_t len = colon ? (size_t)(colon - p) : strlen(p);
            if (len == 0) snprintf(candidate, sizeof(candidate), "./%s", file);
            else snprintf(candidate, sizeof(candidate), "%.*s/%s", (int)len, p, file);
            if (access(candidate, X_OK) == 0) {
                int rc = __execve(candidate, argv, environ);
                if (rc == 0) return 0;
                if (errno != ENOEXEC) return -1;
                last_errno = errno;
            }
            if (!colon) break;
            p = colon + 1;
        }
        errno = last_errno;
        return -1;
    }
    char *resolved = NULL;
    char **new_argv = NULL;
    /* 先对解析后的完整路径做检查：逐候选尝试 */
    if (strchr(file, '/')) {
        char *framework_home = NULL;
        bool strip_dyld_env = false;
        if (prepare_exec(file, argv, &resolved, &new_argv, &framework_home, &strip_dyld_env) != 0) return -1;
        const char *use = resolved ? resolved : file;
        char *const *use_argv = new_argv ? new_argv : argv;
        /* 注入强制重注入（M4）：非 strip 目标的子进程恒携带本 dylib，
         * 沙箱内清 DYLD_INSERT_LIBRARIES 无法让子进程脱管 */
        char **reinjected = strip_dyld_env ? NULL : build_reinjected_env(environ);
        char **stripped = strip_dyld_env ? build_stripped_env(environ) : NULL;
        char *const *base_env = reinjected ? (char *const *)reinjected
                                : stripped ? (char *const *)stripped : (char *const *)environ;
        char **py_env = framework_home ? envp_with_python_home(base_env, framework_home) : NULL;
        int rc = real_execve(use, use_argv, py_env ? (char *const *)py_env : base_env);
        free_python_home_envp(py_env);
        free(framework_home);
        free(reinjected);
        int saved = errno;
        free_exec_prep(resolved, new_argv);
        errno = saved;
        return rc;
    }
    const char *search = getenv("PATH");
    const char *p = search && *search ? search : "/usr/bin:/bin:/usr/sbin:/sbin";
    char candidate[PATH_MAX];
    int last_errno = ENOENT;
    while (*p) {
        const char *colon = strchr(p, ':');
        size_t len = colon ? (size_t)(colon - p) : strlen(p);
        /* 空 PATH 段按 POSIX 语义表示当前目录 */
        if (len == 0) snprintf(candidate, sizeof(candidate), "./%s", file);
        else snprintf(candidate, sizeof(candidate), "%.*s/%s", (int)len, p, file);
        if (access(candidate, X_OK) == 0) {
            resolved = NULL;
            new_argv = NULL;
            char *framework_home = NULL;
            bool strip_dyld_env = false;
            if (prepare_exec(candidate, argv, &resolved, &new_argv, &framework_home, &strip_dyld_env) == 0) {
                const char *use = resolved ? resolved : candidate;
                char *const *use_argv = new_argv ? new_argv : argv;
                char **reinjected = strip_dyld_env ? NULL : build_reinjected_env(environ);
                char **stripped = strip_dyld_env ? build_stripped_env(environ) : NULL;
                char *const *base_env = reinjected ? (char *const *)reinjected
                                        : stripped ? (char *const *)stripped : (char *const *)environ;
                char **py_env = framework_home ? envp_with_python_home(base_env, framework_home) : NULL;
                int rc = real_execve(use, use_argv, py_env ? (char *const *)py_env : base_env);
                free_python_home_envp(py_env);
                free(framework_home);
                free(reinjected);
                free(stripped);
                int saved = errno;
                free_exec_prep(resolved, new_argv);
                if (rc == 0) return 0;
                if (saved != ENOEXEC) {
                    errno = saved;
                    return -1;
                }
                last_errno = saved;
            } else {
                return -1;
            }
        }
        if (!colon) break;
        p = colon + 1;
    }
    errno = last_errno;
    return -1;
}

static int wrap_execvP(const char *file, const char *searchpath, char *const argv[])
{
    extern char **environ;
    /* execvP 与 execvp 语义一致，仅 PATH 来源不同：直接内联 PATH 展开 +
     * prepare_exec，不能用 setenv 临时切 PATH（多线程下其他线程会看到脏值） */
    char full[PATH_MAX];
    if (strchr(file, '/')) {
        snprintf(full, sizeof(full), "%s", file);
    } else {
        const char *search = searchpath && *searchpath ? searchpath : "/usr/bin:/bin:/usr/sbin:/sbin";
        bool found = false;
        const char *p = search;
        char candidate[PATH_MAX];
        while (*p && !found) {
            const char *colon = strchr(p, ':');
            size_t len = colon ? (size_t)(colon - p) : strlen(p);
            if (len == 0) snprintf(candidate, sizeof(candidate), "./%s", file);
            else snprintf(candidate, sizeof(candidate), "%.*s/%s", (int)len, p, file);
            if (access(candidate, X_OK) == 0) {
                snprintf(full, sizeof(full), "%s", candidate);
                found = true;
            }
            if (!colon) break;
            p = colon + 1;
        }
        if (!found) {
            errno = ENOENT;
            return -1;
        }
    }
    char *resolved = NULL;
    char **new_argv = NULL;
    char *framework_home = NULL;
    bool strip_dyld_env = false;
    if (prepare_exec(full, argv, &resolved, &new_argv, &framework_home, &strip_dyld_env) != 0) return -1;
    const char *use = resolved ? resolved : full;
    char *const *use_argv = new_argv ? new_argv : argv;
    char **stripped = strip_dyld_env ? build_stripped_env(environ) : NULL;
    char **py_env = framework_home ? envp_with_python_home(stripped ? (char *const *)stripped : environ, framework_home) : NULL;
    int rc = real_execve(use, use_argv, py_env ? (char *const *)py_env : (stripped ? (char *const *)stripped : environ));
    free_python_home_envp(py_env);
    free(framework_home);
    free(stripped);
    int saved = errno;
    free_exec_prep(resolved, new_argv);
    errno = saved;
    return rc;
}

/* ── posix_spawn 家族（Node/macOS 的 fork+exec 走这条路径居多） ──────────── */

/*
 * 相对路径解析（posix_spawnp 语义）：返回完整路径。找不到返回 false。
 * 简化：不支持 POSIX_SPAWN_RESETIDS 等属性对 PATH 语义的影响（实践无影响）。
 */
static bool resolve_for_spawnp(const char *file, char *resolved, size_t cap)
{
    if (strchr(file, '/')) {
        snprintf(resolved, cap, "%s", file);
        return true;
    }
    const char *search = getenv("PATH");
    const char *p = search && *search ? search : "/usr/bin:/bin:/usr/sbin:/sbin";
    char candidate[PATH_MAX];
    while (*p) {
        const char *colon = strchr(p, ':');
        size_t len = colon ? (size_t)(colon - p) : strlen(p);
        if (len == 0) snprintf(candidate, sizeof(candidate), "./%s", file);
        else snprintf(candidate, sizeof(candidate), "%.*s/%s", (int)len, p, file);
        if (access(candidate, X_OK) == 0) {
            snprintf(resolved, cap, "%s", candidate);
            return true;
        }
        if (!colon) break;
        p = colon + 1;
    }
    return false;
}

/*
 * fork+execve 模拟 posix_spawn：仅用于 attr 含 POSIX_SPAWN_CLOEXEC_DEFAULT 的
 * 场景——该 flag 的 fd 表快照由 libsystem_c 用户态实现，内核直呼 __posix_spawn
 * 返回 -1/EFAULT（实测）。fork 后子进程走 wrap_execve（管控完整），父进程
 * waitpid 直到 exec 成功或子进程退出后返回；exec 成功时子进程地址空间被替换，
 * waitpid 返回前父进程不归还——与 posix_spawn 的同步语义一致。
 * 局限：POSIX_SPAWN_SETEXEC/SETPGROUP 等其余 attr 与 file_actions 的 addchdir_np
 * 等在此路径未实现（调用方为 python3 等，只组合 CLOEXEC_DEFAULT + inherit）。
 */

static int wrap_posix_spawn_common(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                                   const posix_spawnattr_t *attr, char *const argv[], char *const envp[],
                                   bool use_path_search)
{
    if (!use_path_search && (is_internal() || !is_sandboxed() || g_in_libc_spawn)) {
        return __posix_spawn(pid, path, actions, attr, argv, envp);
    }
    char full[PATH_MAX];
    if (use_path_search) {
        /* spawnp：内核层无 __posix_spawnp，自行展开 PATH 后统一走 __posix_spawn */
        if (!resolve_for_spawnp(path, full, sizeof(full))) {
            errno = ENOENT;
            return ENOENT;
        }
    } else {
        snprintf(full, sizeof(full), "%s", path);
    }
    if (is_internal() || !is_sandboxed() || g_in_libc_spawn) {
        return __posix_spawn(pid, full, actions, attr, argv, envp);
    }
    char *resolved = NULL;
    char **new_argv = NULL;
    char *framework_home = NULL;
    bool strip_dyld_env = false;
    if (prepare_exec(full, argv, &resolved, &new_argv, &framework_home, &strip_dyld_env) != 0) return errno;
    const char *use = resolved ? resolved : full;
    char *const *use_argv = new_argv ? new_argv : argv;
    /* 注入强制重注入（M4，与 wrap_execve 对齐） */
    char **reinjected = strip_dyld_env ? NULL : build_reinjected_env(envp);
    char **stripped = strip_dyld_env ? build_stripped_env(envp) : NULL;
    char **base_env = reinjected ? reinjected : (stripped ? stripped : (char **)envp);
    char **py_env = framework_home ? envp_with_python_home(base_env, framework_home) : NULL;
    if (py_env) envp = py_env; else if (base_env != (char **)envp) envp = base_env;
    /*
     * attr 含 POSIX_SPAWN_CLOEXEC_DEFAULT 时 __posix_spawn 直呼返回 -1/EFAULT
     * （该 flag 的 fd 快照在 libsystem_c 用户态实现）——降级 fork+execve 模拟。
     */
    /*
     * libc 用户态扩展（POSIX_SPAWN_CLOEXEC_DEFAULT 的 fd 快照、
     * posix_spawn_file_actions_addinherit_np）内核直呼不支持：实测
     * __posix_spawn 返回 -1/EFAULT 或 -1/EINVAL。处理：先试内核直呼，
     * 失败（rc==-1）则经 libc posix_spawn 重入完整语义——重入调用置
     * g_in_libc_spawn 标志让 wrap 直接透传内核（libc 内部 exec 由内核
     * 完成，不经用户态 execve；路径改写已在参数层完成，子进程照常注入）。
     */
    int rc = __posix_spawn(pid, use, actions, attr, use_argv, envp);
    if (rc == -1) {
        extern int posix_spawn(pid_t *, const char *, const posix_spawn_file_actions_t *,
                               const posix_spawnattr_t *, char *const[], char *const[]);
        g_in_libc_spawn++;
        errno = 0;
        rc = posix_spawn(pid, use, actions, attr, use_argv, envp);
        g_in_libc_spawn--;
        if (rc != 0) slog("libc spawn fallback failed: %s rc=%d errno=%d", use, rc, errno);
    } else if (rc != 0) {
        slog("__posix_spawn failed: %s rc=%d errno=%d", use, rc, errno);
    }
    free_python_home_envp(py_env);
    free(framework_home);
    free(reinjected);
    free(stripped);
    free_exec_prep(resolved, new_argv);
    return rc;
}

static int wrap_posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                            const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
    return wrap_posix_spawn_common(pid, path, actions, attr, argv, envp, false);
}

static int wrap_posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                             const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
    return wrap_posix_spawn_common(pid, file, actions, attr, argv, envp, true);
}

/* ── 文件写/删除/改名类 ─────────────────────────────────────────────────── */

static int wrap_open(const char *path, int flags, ...)
{
    mode_t mode = 0;
    bool has_mode = (flags & O_CREAT) != 0;
    if (has_mode) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    if (is_internal() || !is_sandboxed()) {
        int fd;
        if (has_mode) fd = open(path, flags, mode);
        else fd = open(path, flags);
        return fd;
    }
    /* /dev/tty、/dev/null 等设备文件不属于文件系统管控范围 */
    if (path && strncmp(path, "/dev/", 5) == 0) return has_mode ? open(path, flags, mode) : open(path, flags);
    bool writing = open_has_write_semantics(flags);
    int check_rc = 0;
    if (writing) check_rc = check_write_path(path, "open");
    else if ((flags & O_DIRECTORY) == 0) check_rc = check_read_path(path, "open");
    if (check_rc != 0) return -1; /* 拒绝：不得执行真实 open */
    int fd;
    if (has_mode) fd = open(path, flags, mode);
    else fd = open(path, flags);
    /* 写打开成功且 fd 在缓存槽内：缓存放行判定（读 fd 内核层拒写，无需缓存） */
    if (writing && fd >= 0 && fd < FD_CACHE_SLOTS) {
        g_fd_cache[fd] = 1;
    }
    return fd;
}

/* macOS 内部大量经 openat 打开文件：不 interpose 则写操作全部绕过管控 */
static int wrap_openat(int dirfd, const char *path, int flags, ...)
{
    mode_t mode = 0;
    bool has_mode = (flags & O_CREAT) != 0;
    if (has_mode) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    if (is_internal() || !is_sandboxed()) {
        int fd;
        if (has_mode) fd = openat(dirfd, path, flags, mode);
        else fd = openat(dirfd, path, flags);
        return fd;
    }
    /* AT_FDCWD + 绝对路径最常见；dirfd 相对路径的目录fd 拼接按 /dev/fd 回查 */
    char full[PATH_MAX];
    if (path && path[0] == '/') {
        snprintf(full, sizeof(full), "%s", path);
    } else if (dirfd == AT_FDCWD) {
        snprintf(full, sizeof(full), "%s", path ? path : "");
    } else {
        char dirpath[PATH_MAX];
        char proc[64];
        snprintf(proc, sizeof(proc), "/dev/fd/%d", dirfd);
        ssize_t n = readlink(proc, dirpath, sizeof(dirpath) - 1);
        if (n <= 0) return has_mode ? openat(dirfd, path, flags, mode) : openat(dirfd, path, flags);
        dirpath[n] = '\0';
        snprintf(full, sizeof(full), "%s/%s", dirpath, path ? path : "");
    }
    if (strncmp(full, "/dev/", 5) == 0) return has_mode ? openat(dirfd, path, flags, mode) : openat(dirfd, path, flags);
    bool writing = open_has_write_semantics(flags);
    int check_rc = 0;
    if (writing) check_rc = check_write_path(full, "openat");
    else if ((flags & O_DIRECTORY) == 0) check_rc = check_read_path(full, "openat");
    if (check_rc != 0) return -1; /* 拒绝：不得执行真实 openat */
    int fd;
    if (has_mode) fd = openat(dirfd, path, flags, mode);
    else fd = openat(dirfd, path, flags);
    /* 写打开成功才缓存放行判定（与 wrap_open 同语义） */
    if (writing && fd >= 0 && fd < FD_CACHE_SLOTS) {
        g_fd_cache[fd] = 1;
    }
    return fd;
}

static FILE *wrap_fopen(const char *path, const char *mode)
{
    if (is_internal() || !is_sandboxed()) return fopen(path, mode);
    if (strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+')) {
        if (check_write_path(path, "fopen") != 0) return NULL;
    } else if (check_read_path(path, "fopen") != 0) {
        return NULL;
    }
    return fopen(path, mode);
}

static int wrap_creat(const char *path, mode_t mode)
{
    if (is_internal() || !is_sandboxed()) return creat(path, mode);
    if (check_write_path(path, "creat") != 0) return -1;
    return creat(path, mode);
}

static int wrap_unlink(const char *path)
{
    if (is_internal() || !is_sandboxed()) return unlink(path);
    char raw[PATH_MAX];
    resolve_relative(path, raw, sizeof(raw));
    char norm[PATH_MAX];
    if (normalize_path(raw, norm, sizeof(norm)) != 0) {
        slog("unlink denied (path too deep): %s", raw);
        errno = EACCES;
        return -1;
    }
    struct stat st;
    if (stat(norm, &st) != 0) return unlink(path);
    int check_rc = policy_check(norm, ACC_WRITE);
    slog("unlink check: %s rc=%d", norm, check_rc);
    if (check_rc != 0) {
        errno = EACCES;
        return -1;
    }
    return trash_or_remove(norm, &st, false);
}

static int wrap_rmdir(const char *path)
{
    if (is_internal() || !is_sandboxed()) return rmdir(path);
    char raw[PATH_MAX];
    resolve_relative(path, raw, sizeof(raw));
    char norm[PATH_MAX];
    if (normalize_path(raw, norm, sizeof(norm)) != 0) {
        slog("rmdir denied (path too deep): %s", raw);
        errno = EACCES;
        return -1;
    }
    struct stat st;
    if (stat(norm, &st) != 0) return rmdir(path);
    if (policy_check(norm, ACC_WRITE) != 0) {
        slog("rmdir denied: %s", norm);
        errno = EACCES;
        return -1;
    }
    return trash_or_remove(norm, &st, true);
}

static int wrap_rename(const char *from, const char *to)
{
    if (is_internal() || !is_sandboxed()) return rename(from, to);
    /* check_write_path 内部已做相对路径解析 */
    if (check_write_path(from, "rename") != 0) return -1;
    if (check_write_path(to, "rename") != 0) return -1;
    return rename(from, to);
}

static int wrap_mkdir(const char *path, mode_t mode)
{
    if (is_internal() || !is_sandboxed()) return mkdir(path, mode);
    /* mkdir -p 工具会对已存在的中间路径调 mkdir：对已存在路径放行到真实
     * syscall（返回 EEXIST），避免策略误拒合法的 -p 行为 */
    struct stat st;
    if (stat(path, &st) == 0) return mkdir(path, mode);
    if (check_write_path(path, "mkdir") != 0) return -1;
    return mkdir(path, mode);
}

/* 解析 dirfd + 相对路径为绝对路径（openat/unlinkat/renameat/linkat/mkdirat 共用）。
 * 返回 0 成功（out 被填充）；-1 时无法解析（调用方按原始路径透传给内核处理）。 */
static int resolve_dirfd_path(int dirfd, const char *path, char *out, size_t cap)
{
    if (path && path[0] == '/') {
        snprintf(out, cap, "%s", path);
        return 0;
    }
    if (dirfd == AT_FDCWD) {
        char cwd[PATH_MAX];
        if (!getcwd(cwd, sizeof(cwd))) return -1;
        snprintf(out, cap, "%s/%s", cwd, path ? path : "");
        return 0;
    }
    char dirpath[PATH_MAX];
    char proc[64];
    snprintf(proc, sizeof(proc), "/dev/fd/%d", dirfd);
    ssize_t n = readlink(proc, dirpath, sizeof(dirpath) - 1);
    if (n <= 0) return -1;
    dirpath[n] = '\0';
    snprintf(out, cap, "%s/%s", dirpath, path ? path : "");
    return 0;
}

/* mkdirat：与 openat 同理，不 interpose 则目录创建绕过管控 */
static int wrap_mkdirat(int dirfd, const char *path, mode_t mode)
{
    if (is_internal() || !is_sandboxed()) return mkdirat(dirfd, path, mode);
    char full[PATH_MAX];
    if (resolve_dirfd_path(dirfd, path, full, sizeof(full)) != 0) return mkdirat(dirfd, path, mode);
    struct stat st;
    if (stat(full, &st) == 0) return mkdirat(dirfd, path, mode);
    if (check_write_path(full, "mkdirat") != 0) return -1;
    return mkdirat(dirfd, path, mode);
}

static int wrap_chmod(const char *path, mode_t mode)
{
    if (is_internal() || !is_sandboxed()) return chmod(path, mode);
    if (check_write_path(path, "chmod") != 0) return -1;
    return chmod(path, mode);
}

static int wrap_chown(const char *path, uid_t owner, gid_t group)
{
    if (is_internal() || !is_sandboxed()) return chown(path, owner, group);
    if (check_write_path(path, "chown") != 0) return -1;
    return chown(path, owner, group);
}

static int wrap_truncate(const char *path, off_t length)
{
    if (is_internal() || !is_sandboxed()) return truncate(path, length);
    if (check_write_path(path, "truncate") != 0) return -1;
    return truncate(path, length);
}

static int wrap_symlink(const char *target, const char *linkpath)
{
    if (is_internal() || !is_sandboxed()) return symlink(target, linkpath);
    if (check_write_path(linkpath, "symlink") != 0) return -1;
    /*
     * symlink 逃逸防线：linkpath 在放行区但 target 指向受限路径时，后续写
     * linkpath 即写受限文件（写检查按 linkpath 前缀放行）。解析真实目标：
     * 绝对 target 直接检查；相对 target 按 linkpath 所在目录折叠后检查，
     * 解析失败（悬空链接）放行——悬空链接不构成逃逸。
     */
    if (target && target[0] == '/') {
        if (policy_check(target, ACC_WRITE) != 0) {
            slog("symlink denied (target outside): %s -> %s", linkpath, target);
            errno = EACCES;
            return -1;
        }
    } else if (target) {
        char base[PATH_MAX], resolved[PATH_MAX * 2];
        char link_full[PATH_MAX];
        resolve_relative(linkpath, link_full, sizeof(link_full));
        char norm_link[PATH_MAX];
        normalize_path(link_full, norm_link, sizeof(norm_link));
        char *slash = strrchr(norm_link, '/');
        if (slash) {
            size_t dir_len = (size_t)(slash - norm_link);
            snprintf(base, dir_len + 2, "%s", norm_link); /* 保留 dir 部分 + NUL */
            snprintf(resolved, sizeof(resolved), "%s/%s", base, target);
            char norm_target[PATH_MAX];
            if (normalize_path(resolved, norm_target, sizeof(norm_target)) == 0 &&
                policy_check(norm_target, ACC_WRITE) != 0) {
                slog("symlink denied (target outside): %s -> %s", linkpath, target);
                errno = EACCES;
                return -1;
            }
        }
    }
    return symlink(target, linkpath);
}

/* hardlink 检查：newpath（创建位置）与 oldpath（目标）都须可写——
 * workspace 内创建指向外部文件的 hardlink 后，写 link 即写外部文件 */
static int check_link_paths(const char *oldpath, const char *newpath)
{
    if (check_write_path(newpath, "link") != 0) return -1;
    if (check_write_path(oldpath, "link") != 0) return -1;
    return 0;
}

static int wrap_link(const char *oldpath, const char *newpath)
{
    if (is_internal() || !is_sandboxed()) return link(oldpath, newpath);
    if (check_link_paths(oldpath, newpath) != 0) return -1;
    return link(oldpath, newpath);
}

static int wrap_linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags)
{
    if (is_internal() || !is_sandboxed()) return linkat(olddirfd, oldpath, newdirfd, newpath, flags);
    char old_full[PATH_MAX], new_full[PATH_MAX];
    if (resolve_dirfd_path(olddirfd, oldpath, old_full, sizeof(old_full)) != 0)
        return linkat(olddirfd, oldpath, newdirfd, newpath, flags);
    if (resolve_dirfd_path(newdirfd, newpath, new_full, sizeof(new_full)) != 0)
        return linkat(olddirfd, oldpath, newdirfd, newpath, flags);
    if (check_link_paths(old_full, new_full) != 0) return -1;
    return linkat(olddirfd, oldpath, newdirfd, newpath, flags);
}

static int wrap_mknod(const char *path, mode_t mode, dev_t dev)
{
    if (is_internal() || !is_sandboxed()) return mknod(path, mode, dev);
    if (check_write_path(path, "mknod") != 0) return -1;
    return mknod(path, mode, dev);
}

/* ACL/扩展属性：写语义同样管控 */
static int wrap_setxattr(const char *path, const char *name, void *value, size_t size, u_int32_t position, int options)
{
    if (is_internal() || !is_sandboxed()) return setxattr(path, name, value, size, position, options);
    if (options & XATTR_NOFOLLOW) return setxattr(path, name, value, size, position, options);
    if (check_write_path(path, "setxattr") != 0) return -1;
    return setxattr(path, name, value, size, position, options);
}

static int wrap_removexattr(const char *path, const char *name, int options)
{
    if (is_internal() || !is_sandboxed()) return removexattr(path, name, options);
    if (options & XATTR_NOFOLLOW) return removexattr(path, name, options);
    if (check_write_path(path, "removexattr") != 0) return -1;
    return removexattr(path, name, options);
}

/* ── fd 写入（open 之后经由 fd 的写也要拦） ─────────────────────────────── */

/*
 * fd → 路径回查有 TOCTOU，但与 Linux dynobox 的镜像层检查同粒度（调用时路径）。
 * 内部 fd（日志等）不经过这里：内部操作在 g_internal_depth 保护下调用真实符号。
 *
 * 逐块写大文件（tar/cp）每次 write 都回查路径 + 策略检查：ask 场景会反复弹窗、
 * 无 ask 场景也是海量 readlink。fd 的写权限在 open/openat 时已检查并缓存，
 * write/pwrite/ftruncate 只查缓存；槽位复用安全——新 fd 的 open 必经
 * check_write_path 刷新缓存，不存在把拒绝路径放行的口子。
 */
static bool fd_path_lookup(int fd, char *target, size_t cap)
{
    char proc[64];
    snprintf(proc, sizeof(proc), "/dev/fd/%d", fd);
    ssize_t n = readlink(proc, target, cap - 1);
    if (n <= 0) return false;
    target[n] = '\0';
    return true;
}

/* fd 写判定：1=放行 -1=拒绝 0=非文件系统 fd（交由真实 write 兜底） */
static int fd_write_verdict(int fd)
{
    if (fd < 0 || fd >= FD_CACHE_SLOTS) {
        char target[PATH_MAX];
        if (!fd_path_lookup(fd, target, sizeof(target))) return 0;
        if (strncmp(target, "/dev/", 5) == 0 || strncmp(target, "pipe:", 5) == 0) return 0;
        return policy_check(target, ACC_WRITE) == 0 ? 1 : -1;
    }
    int cached = g_fd_cache[fd];
    if (cached != 0) return cached;
    char target[PATH_MAX];
    if (!fd_path_lookup(fd, target, sizeof(target))) return 0;
    if (strncmp(target, "/dev/", 5) == 0 || strncmp(target, "pipe:", 5) == 0) return 0;
    int verdict = policy_check(target, ACC_WRITE) == 0 ? 1 : -1;
    /* 只缓存放行：拒绝不缓存——用户在审批弹窗批准该路径后，同 fd 的后续写
     * 应当生效（与宿主 decide 端点 cache_ttl_seconds=0 的不缓存决策语义一致）；
     * 拒绝每次重新走策略（allow 规则命中即放行，不会重复弹窗）。 */
    if (verdict > 0) g_fd_cache[fd] = (sig_atomic_t)verdict;
    return verdict;
}

/*
 * close 时清缓存：fd 编号会被 close+open/dup2 复用，残留判定会让新指向的
 * 文件沿用旧判定（如 dup2 把工作区内文件的 fd 编号让给拒绝路径的文件）。
 */
static int wrap_close(int fd)
{
    if (fd >= 0 && fd < FD_CACHE_SLOTS) g_fd_cache[fd] = 0;
    return close(fd);
}

static int wrap_close_nocancel(int fd)
{
    if (fd >= 0 && fd < FD_CACHE_SLOTS) g_fd_cache[fd] = 0;
    extern int close$NOCANCEL(int);
    return close$NOCANCEL(fd);
}

static ssize_t wrap_write(int fd, const void *buf, size_t count)
{
    if (is_internal() || !is_sandboxed() || fd < 0) return write(fd, buf, count);
    int verdict = fd_write_verdict(fd);
    if (verdict < 0) {
        errno = EACCES;
        return -1;
    }
    return write(fd, buf, count);
}

static ssize_t wrap_pwrite(int fd, const void *buf, size_t count, off_t offset)
{
    if (is_internal() || !is_sandboxed() || fd < 0) return pwrite(fd, buf, count, offset);
    int verdict = fd_write_verdict(fd);
    if (verdict < 0) {
        errno = EACCES;
        return -1;
    }
    return pwrite(fd, buf, count, offset);
}

static int wrap_ftruncate(int fd, off_t length)
{
    if (is_internal() || !is_sandboxed() || fd < 0) return ftruncate(fd, length);
    int verdict = fd_write_verdict(fd);
    if (verdict < 0) {
        errno = EACCES;
        return -1;
    }
    return ftruncate(fd, length);
}

static int wrap_unlinkat(int dirfd, const char *path, int flags)
{
    if (is_internal() || !is_sandboxed()) return unlinkat(dirfd, path, flags);
    /* 沙箱内主要是绝对路径调用；AT_FDCWD + 相对路径按 cwd 拼接 */
    char full[PATH_MAX];
    if (resolve_dirfd_path(dirfd, path, full, sizeof(full)) != 0) return unlinkat(dirfd, path, flags);
    struct stat st;
    if (stat(full, &st) != 0) return unlinkat(dirfd, path, flags);
    if (policy_check(full, ACC_WRITE) != 0) {
        slog("unlinkat denied: %s", full);
        errno = EACCES;
        return -1;
    }
    bool is_dir = (flags & AT_REMOVEDIR) != 0;
    return trash_or_remove(full, &st, is_dir);
}

static int wrap_renameat(int fromfd, const char *from, int tofd, const char *to)
{
    if (is_internal() || !is_sandboxed()) return renameat(fromfd, from, tofd, to);
    char from_full[PATH_MAX], to_full[PATH_MAX];
    if (resolve_dirfd_path(fromfd, from, from_full, sizeof(from_full)) != 0)
        return renameat(fromfd, from, tofd, to);
    if (resolve_dirfd_path(tofd, to, to_full, sizeof(to_full)) != 0)
        return renameat(fromfd, from, tofd, to);
    if (check_write_path(from_full, "renameat") != 0) return -1;
    if (check_write_path(to_full, "renameat") != 0) return -1;
    return renameat(fromfd, from, tofd, to);
}

/* ── 装载：读环境变量、解析策略 ─────────────────────────────────────────── */

static void boxdylib_init(void) __attribute__((constructor));

static void boxdylib_init(void)
{
    const char *policy_path = getenv(ENV_POLICY);
    const char *log_path = getenv(ENV_LOG);
    if (log_path && *log_path) snprintf(g_log_path, sizeof(g_log_path), "%s", log_path);
    if (!policy_path || !*policy_path) return; /* 宿主未启用沙箱：passthrough */
    struct timeval tv;
    gettimeofday(&tv, NULL);
    g_sandbox_start.tv_sec = tv.tv_sec;
    g_sandbox_start.tv_nsec = (long)tv.tv_usec * 1000;
    /*
     * 策略存在即激活沙箱（g_active=true）。策略文件不可读/解析失败时保持
     * 激活但规则为空：读放行、写全部走 ask——endpoint 不可达时 deny，
     * 等效只读沙箱（fail closed）。绝不能回退 passthrough（fail open 等于
     * 策略一坏沙箱就失效）。
     */
    g_active = true;
    int fd = open(policy_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        slog("policy unreadable (%s): fail closed read-only", policy_path);
        return;
    }
    char buf[65536];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) {
        slog("policy empty (%s): fail closed read-only", policy_path);
        return;
    }
    buf[n] = '\0';
    if (policy_parse(&g_policy, buf) != 0) {
        slog("policy parse failed (%s): fail closed read-only", g_policy_error);
        return;
    }
    record_self_dylib();
    start_watch();
    slog("sandbox active: rules=%zu trash=%s", g_policy.rule_count, getenv(ENV_TRASH) ? "yes" : "no");
}

/* ── interpose 表 ───────────────────────────────────────────────────────── */

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-function"

int open(const char *path, int flags, ...);
int openat(int dirfd, const char *path, int flags, ...);
int close(int fd);
int close$NOCANCEL(int fd);
int linkat(int, const char *, int, const char *, int);
int mkdirat(int, const char *, mode_t);
int execve(const char *path, char *const argv[], char *const envp[]);
int execvp(const char *file, char *const argv[]);
/* macOS 的 execvP 签名是 (file, searchpath, argv) —— 与 Linux 相反 */
int execvP(const char *file, const char *searchpath, char *const argv[]);
int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]);
int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]);

#pragma clang diagnostic pop

DYLD_INTERPOSE(wrap_execve, execve)
DYLD_INTERPOSE(wrap_execvp, execvp)
DYLD_INTERPOSE(wrap_execvP, execvP)
DYLD_INTERPOSE(wrap_posix_spawn, posix_spawn)
DYLD_INTERPOSE(wrap_posix_spawnp, posix_spawnp)
DYLD_INTERPOSE(wrap_open, open)
DYLD_INTERPOSE(wrap_openat, openat)
DYLD_INTERPOSE(wrap_close, close)
DYLD_INTERPOSE(wrap_close_nocancel, close$NOCANCEL)
DYLD_INTERPOSE(wrap_fopen, fopen)
DYLD_INTERPOSE(wrap_creat, creat)
DYLD_INTERPOSE(wrap_unlink, unlink)
DYLD_INTERPOSE(wrap_rmdir, rmdir)
DYLD_INTERPOSE(wrap_rename, rename)
DYLD_INTERPOSE(wrap_mkdir, mkdir)
DYLD_INTERPOSE(wrap_mkdirat, mkdirat)
DYLD_INTERPOSE(wrap_chmod, chmod)
DYLD_INTERPOSE(wrap_chown, chown)
DYLD_INTERPOSE(wrap_truncate, truncate)
DYLD_INTERPOSE(wrap_symlink, symlink)
DYLD_INTERPOSE(wrap_link, link)
DYLD_INTERPOSE(wrap_linkat, linkat)
DYLD_INTERPOSE(wrap_mknod, mknod)
DYLD_INTERPOSE(wrap_setxattr, setxattr)
DYLD_INTERPOSE(wrap_removexattr, removexattr)
DYLD_INTERPOSE(wrap_write, write)
DYLD_INTERPOSE(wrap_pwrite, pwrite)
DYLD_INTERPOSE(wrap_ftruncate, ftruncate)
DYLD_INTERPOSE(wrap_unlinkat, unlinkat)
DYLD_INTERPOSE(wrap_renameat, renameat)
