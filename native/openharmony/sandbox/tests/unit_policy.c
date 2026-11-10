/* unit_policy.c — unit tests for the dynobox policy engine, path
 * attribution and config serialization. Run directly (no sandbox):
 * tests/unit_policy */
#define _GNU_SOURCE
#include "dynobox.h"
#include "policy.h"
#include "pathmap.h"
#include "cfgio.h"
#include "ask.h"
#include "util.h"
#include "mini_toml.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <fcntl.h>

static int g_failed, g_total;
#define CHECK(cond, name) do { \
    g_total++; \
    if (cond) { printf("ok   %s\n", name); } \
    else { g_failed++; printf("FAIL %s\n", name); } \
} while (0)

static void test_normpath(void)
{
    char *a;
    a = dbox_normpath("a/b/../c");       CHECK(strcmp(a, "a/c") == 0, "normpath .. mid"); dbox_free(a);
    a = dbox_normpath("/a//b/./c/");     CHECK(strcmp(a, "/a/b/c") == 0, "normpath slashes+dot"); dbox_free(a);
    a = dbox_normpath("/..");            CHECK(strcmp(a, "/") == 0, "normpath .. above root clamps"); dbox_free(a);
    a = dbox_normpath("../x");           CHECK(strcmp(a, "../x") == 0, "normpath leading .. kept"); dbox_free(a);
    a = dbox_normpath("/");              CHECK(strcmp(a, "/") == 0, "normpath root"); dbox_free(a);
    a = dbox_normpath("");               CHECK(strcmp(a, ".") == 0, "normpath empty"); dbox_free(a);
    a = dbox_normpath("/a/../..");       CHECK(strcmp(a, "/") == 0, "normpath double .. clamps"); dbox_free(a);
    a = dbox_normpath("/../../etc");     CHECK(strcmp(a, "/etc") == 0, "normpath escape collapses"); dbox_free(a);
}

static void test_path_under(void)
{
    CHECK(dbox_path_under("/a/b", "/a") == 1, "under prefix");
    CHECK(dbox_path_under("/a/bc", "/a/b") == 0, "prefix not at boundary");
    CHECK(dbox_path_under("/a", "/a") == 1, "under equal");
    CHECK(dbox_path_under("/", "/") == 1, "under root");
    CHECK(dbox_path_under("/anything", "/") == 1, "under slash matches all");
    CHECK(dbox_path_under("ab", "a") == 0, "under relative boundary");
    CHECK(dbox_path_under("/x", "") == 0, "under empty prefix never");
    CHECK(dbox_path_under("/a/b/", "/a") == 1, "under trailing slash");
}

static void test_path_rel(void)
{
    char *r = dbox_path_rel("/a/b", "/a");
    CHECK(r && strcmp(r, "b") == 0, "rel simple"); dbox_free(r);
    r = dbox_path_rel("/a", "/a");
    CHECK(r && strcmp(r, "") == 0, "rel equal"); dbox_free(r);
    r = dbox_path_rel("/ab", "/a");
    CHECK(r == NULL, "rel non-boundary");
}

static void test_glob(void)
{
    CHECK(dbox_glob_match("/", "/") == 1, "glob root-root");
    CHECK(dbox_glob_match("/", "/x") == 0, "glob root not subdir");
    /* 尾部 ** 只覆盖子树，不匹配目录自身（四平台统一语义）。要让目录自身
     * 命中须显式写 path="/docs"；策略生成侧对 allow 的 `X/**` 会自动补一条 X。 */
    CHECK(dbox_glob_match("/**", "/") == 0, "glob ** does not match root itself");
    CHECK(dbox_glob_match("/**", "/a/b/c") == 1, "glob ** deep");
    CHECK(dbox_glob_match("/docs/**", "/docs") == 0, "glob dir/** does not match dir itself");
    CHECK(dbox_glob_match("/docs/**", "/docs/") == 0, "glob dir/** not dir itself (trailing slash)");
    CHECK(dbox_glob_match("/docs/**", "/docs/a") == 1, "glob dir/** child");
    CHECK(dbox_glob_match("/docs/**", "/docs/a/b") == 1, "glob dir/** grandchild");
    CHECK(dbox_glob_match("/docs/**", "/docsx") == 0, "glob dir/** boundary");
    CHECK(dbox_glob_match("/docs/*", "/docs/a") == 1, "glob dir/* child");
    CHECK(dbox_glob_match("/docs/*", "/docs/a/b") == 0, "glob dir/* not deep");
    CHECK(dbox_glob_match("/*.txt", "/a.txt") == 1, "glob *.txt");
    CHECK(dbox_glob_match("/*.txt", "/d/a.txt") == 0, "glob *.txt no cross");
    CHECK(dbox_glob_match("/a?c", "/abc") == 1, "glob ?");
    CHECK(dbox_glob_match("/a?c", "/ac") == 0, "glob ? needs one");
    CHECK(dbox_glob_match("/a?c", "/abbc") == 0, "glob ? not many");
    CHECK(dbox_glob_match("/a/**/b", "/a/x/y/b") == 1, "glob ** mid");
    CHECK(dbox_glob_match("/a/**/b", "/a/b") == 1, "glob ** mid zero");
    CHECK(dbox_glob_match("/notes/x.txt", "/notes/x.txt") == 1, "glob exact");
    CHECK(dbox_glob_match("/notes/**", "/notes/x.txt") == 1, "glob against file");
    CHECK(dbox_glob_match("/Docs/**", "/docs/a") == 0, "glob case-sensitive");
    CHECK(dbox_glob_match("/public/*", "/public/sub/f") == 0, "glob * single level");
}

/* 预编译会把 rules[] 按 specificity 降序重排（qsort 不稳定），因此必须锁定：
 *  1) 判定语义仍是"最具体优先、同长度取最严"，与声明顺序无关；
 *  2) 提前结束（spec 更小的规则不再检查）不改变结果。 */
static void test_eval_specificity_order(void)
{
    /* 故意把最具体的规则写在最后，验证与声明顺序无关 */
    static const char *toml =
        "version = 1\n"
        "default = \"deny\"\n"
        "[[rules]]\npath = \"/a/**\"\naccess = \"all\"\nperm = \"allow\"\n"
        "[[rules]]\npath = \"/a/b/**\"\naccess = \"all\"\nperm = \"ask\"\n"
        "[[rules]]\npath = \"/a/b/c\"\naccess = \"all\"\nperm = \"deny\"\n";
    dbox_policy_t p;
    dbox_policy_init(&p);
    char err[256];
    CHECK(dbox_policy_load_toml(toml, &p, err, sizeof err) == 0, "order: load ok");
    CHECK(p.rules_compiled == 1, "order: rules compiled at load");
    CHECK(p.nrules == 3 && p.rules[0].spec >= p.rules[1].spec &&
          p.rules[1].spec >= p.rules[2].spec, "order: rules sorted by specificity desc");
    CHECK(dbox_policy_eval_static(&p, "/a/b/c", ACC_ALL) == PERM_DENY,
          "order: most specific rule wins regardless of declaration order");
    CHECK(dbox_policy_eval_static(&p, "/a/b/x", ACC_ALL) == PERM_ASK,
          "order: /a/b/** beats /a/**");
    CHECK(dbox_policy_eval_static(&p, "/a/x", ACC_ALL) == PERM_ALLOW,
          "order: falls back to /a/**");
    dbox_policy_free(&p);

    /* 同长度规则：deny > ask > allow，且与谁先声明无关（qsort 不稳定） */
    static const char *same_allow_first =
        "version = 1\n"
        "default = \"deny\"\n"
        "[[rules]]\npath = \"/same\"\naccess = \"all\"\nperm = \"allow\"\n"
        "[[rules]]\npath = \"/same\"\naccess = \"all\"\nperm = \"deny\"\n";
    dbox_policy_init(&p);
    CHECK(dbox_policy_load_toml(same_allow_first, &p, err, sizeof err) == 0,
          "order: same-length load ok");
    CHECK(dbox_policy_eval_static(&p, "/same", ACC_ALL) == PERM_DENY,
          "order: same specificity -> deny wins");
    /* 排序的比较器必须带 perm 次级键：排序结果不只是 Debug 输出的顺序，还决定
     * Windows 侧 rule#N 的归因下标（Policy 按 p.rules[] 顺序 import 规则表）。
     * qsort 对相等元素不稳定，没有次级键时同 spec 的 deny/allow 前后会漂移，
     * 日志归因无法复现（判定本身不受影响：同 spec 取 perm 更严者）。 */
    CHECK(p.nrules == 2 && p.rules[0].perm == PERM_DENY && p.rules[1].perm == PERM_ALLOW,
          "order: same specificity sorts deny first (deterministic order for callers)");
    dbox_policy_free(&p);

    /* 反序声明得到同一顺序：排序结果只取决于 spec + perm，不取决于书写顺序 */
    static const char *same_deny_first =
        "version = 1\n"
        "default = \"deny\"\n"
        "[[rules]]\npath = \"/same\"\naccess = \"all\"\nperm = \"deny\"\n"
        "[[rules]]\npath = \"/same\"\naccess = \"all\"\nperm = \"allow\"\n";
    dbox_policy_init(&p);
    CHECK(dbox_policy_load_toml(same_deny_first, &p, err, sizeof err) == 0,
          "order: reversed declaration load ok");
    CHECK(p.nrules == 2 && p.rules[0].perm == PERM_DENY && p.rules[1].perm == PERM_ALLOW,
          "order: declaration order does not affect the sorted order");
    dbox_policy_free(&p);

    /* ask 也参与次级键：同 spec 时 ask 排在 allow 前（deny > ask > allow） */
    dbox_policy_init(&p);
    CHECK(dbox_policy_load_toml(
              "version = 1\n"
              "default = \"deny\"\n"
              "[[rules]]\npath = \"/same\"\naccess = \"all\"\nperm = \"allow\"\n"
              "[[rules]]\npath = \"/same\"\naccess = \"all\"\nperm = \"ask\"\n",
              &p, err, sizeof err) == 0,
          "order: allow+ask load ok");
    CHECK(p.nrules == 2 && p.rules[0].perm == PERM_ASK && p.rules[1].perm == PERM_ALLOW,
          "order: same specificity sorts ask before allow");
    dbox_policy_free(&p);

    /* 未编译（rules_compiled=0）时走旧路径，结果必须一致 */
    dbox_policy_init(&p);
    CHECK(dbox_policy_load_toml(toml, &p, err, sizeof err) == 0, "order: reload ok");
    p.rules_compiled = 0;   /* 强制旧路径 */
    CHECK(dbox_policy_eval_static(&p, "/a/b/c", ACC_ALL) == PERM_DENY,
          "order: legacy path agrees (deny)");
    CHECK(dbox_policy_eval_static(&p, "/a/x", ACC_ALL) == PERM_ALLOW,
          "order: legacy path agrees (allow)");
    dbox_policy_free(&p);

    /* 目录自身不被 /dir/** 覆盖：`/**` read allow + `/docs/**` read deny 时，
     * /docs 本身仍 allow（只拒内部），/docs/a.txt 被拒。deny 侧不自动补 X——
     * 敏感目录清单要能继续列目录（只拦内容），这是预期特性。 */
    dbox_policy_init(&p);
    CHECK(dbox_policy_load_toml(
              "version = 1\n"
              "default = \"deny\"\n"
              "[[rules]]\npath = \"/**\"\naccess = \"read\"\nperm = \"allow\"\n"
              "[[rules]]\npath = \"/docs/**\"\naccess = \"read\"\nperm = \"deny\"\n",
              &p, err, sizeof err) == 0,
          "dirself: load ok");
    CHECK(dbox_policy_eval_static(&p, "/docs", ACC_READ) == PERM_ALLOW,
          "dirself: /docs/** deny does not cover /docs itself");
    CHECK(dbox_policy_eval_static(&p, "/docs/a.txt", ACC_READ) == PERM_DENY,
          "dirself: /docs/** deny covers children");
    dbox_policy_free(&p);
}

/* 预编译 glob（三平台共用 API）必须与逐次解析版逐条一致 */
static const char *k_glob_pats[] = {
    "/", "/**", "/docs/**", "/docs/*", "/*.txt", "/a?c", "/a/**/b",
    "/notes/x.txt", "/public/*", "/a/b/c", "/**/x/**", "/storage/Users/**",
    NULL
};

static const char *k_glob_paths[] = {
    "/", "/x", "/a", "/a/b", "/a/b/c", "/docs", "/docs/a", "/docs/a/b",
    "/docsx", "/a.txt", "/d/a.txt", "/abc", "/ac", "/abbc", "/a/x/y/b",
    "/notes/x.txt", "/public/sub/f", "/x/y/z", "/storage/Users/currentUser/p",
    NULL
};

static void test_glob_compiled(void)
{
    int mismatches = 0, pairs = 0;
    for (int i = 0; k_glob_pats[i]; i++) {
        dbox_glob_t *g = dbox_glob_compile(k_glob_pats[i]);
        CHECK(g != NULL, "glob compile returns handle");
        if (!g) continue;
        for (int j = 0; k_glob_paths[j]; j++) {
            int plain = dbox_glob_match(k_glob_pats[i], k_glob_paths[j]);
            int comp = dbox_glob_match_compiled(g, k_glob_paths[j]);
            pairs++;
            if (plain != comp) {
                mismatches++;
                printf("     mismatch: pat=%s path=%s plain=%d compiled=%d\n",
                       k_glob_pats[i], k_glob_paths[j], plain, comp);
            }
        }
        dbox_glob_free(g);
    }
    CHECK(pairs > 0 && mismatches == 0, "glob compiled == plain (every pair)");
    /* specificity：尾部 "/**" 被剥离后取前缀长度（排序/提前结束依赖它） */
    dbox_glob_t *g1 = dbox_glob_compile("/docs/**");
    dbox_glob_t *g2 = dbox_glob_compile("/*.txt");
    dbox_glob_t *g3 = dbox_glob_compile("/a/b/c");
    CHECK(g1 && dbox_glob_specificity(g1) == 5, "glob specificity dir/** strips suffix");
    CHECK(g2 && dbox_glob_specificity(g2) == 6, "glob specificity plain length");
    CHECK(g3 && dbox_glob_specificity(g3) == 6, "glob specificity exact path");
    dbox_glob_free(g1); dbox_glob_free(g2); dbox_glob_free(g3);
    /* 非规范写法必须与直接匹配同一模式等价（compile 内部先 normpath） */
    dbox_glob_t *g4 = dbox_glob_compile("/docs//a/../b/**");
    CHECK(g4 && dbox_glob_match_compiled(g4, "/docs/b/x") == 1,
          "glob compiled normalizes pattern");
    dbox_glob_free(g4);
    dbox_glob_free(NULL);   /* 空句柄安全 */
}

static const char *k_policy_toml =
    "version = 1\n"
    "default = \"deny\"\n"
    "\n"
    "[ask]\n"
    "endpoint = \"http://127.0.0.1:18080/decide\"\n"
    "timeout_ms = 1234\n"
    "cache_ttl_seconds = 45\n"
    "grant_ttl_seconds = 90\n"
    "\n"
    "[[rules]]\n"
    "path = \"/docs/secret.txt\"\n"
    "access = \"all\"\n"
    "perm = \"deny\"\n"
    "\n"
    "[[rules]]\n"
    "path = \"/docs/**\"\n"
    "access = \"read\"\n"
    "perm = \"allow\"\n"
    "\n"
    "[[rules]]\n"
    "path = \"/notes/**\"\n"
    "access = \"read\"\n"
    "perm = \"ask\"\n"
    "\n"
    "[[rules]]\n"
    "path = \"/**\"\n"
    "access = \"all\"\n"
    "perm = \"allow\"\n";

static void test_toml_and_eval(void)
{
    char err[256];
    dbox_policy_t p;
    int rc = dbox_policy_load_toml(k_policy_toml, &p, err, sizeof err);
    CHECK(rc == 0, "toml parse ok");
    if (rc != 0) { fprintf(stderr, "  err: %s\n", err); return; }

    CHECK(p.default_perm == PERM_DENY, "default deny");
    CHECK(p.nrules == 4, "four rules");
    CHECK(p.ask_timeout_ms == 1234, "ask timeout parsed");
    CHECK(p.cache_ttl_s == 45, "cache ttl parsed");
    CHECK(p.grant_ttl_s == 90, "grant ttl parsed");
    CHECK(p.ask_endpoint && strcmp(p.ask_endpoint, "http://127.0.0.1:18080/decide") == 0,
          "endpoint parsed");

    /* static evaluation order: specific deny beats general allow */
    CHECK(dbox_policy_eval_static(&p, "/docs/secret.txt", ACC_READ) == PERM_DENY,
          "specific deny first");
    CHECK(dbox_policy_eval_static(&p, "/docs/a.txt", ACC_READ) == PERM_ALLOW,
          "general allow second");
    CHECK(dbox_policy_eval_static(&p, "/docs/a.txt", ACC_WRITE) == PERM_ALLOW,
          "later all rule covers write");
    CHECK(dbox_policy_eval_static(&p, "/notes/a", ACC_READ) == PERM_ASK,
          "ask rule");
    CHECK(dbox_policy_eval_static(&p, "/notes/a", ACC_WRITE) == PERM_ALLOW,
          "ask rule acc mismatch falls through");
    CHECK(dbox_policy_eval_static(&p, "/nope", ACC_READ) == PERM_ALLOW,
          "catch-all allow");
    dbox_policy_free(&p);

    /* default allow */
    dbox_policy_t q;
    rc = dbox_policy_load_toml("default = \"allow\"\n", &q, err, sizeof err);
    CHECK(rc == 0 && dbox_policy_eval_static(&q, "/whatever", ACC_WRITE) == PERM_ALLOW,
          "default allow");
    dbox_policy_free(&q);

    /* malformed */
    rc = dbox_policy_load_toml("default = \"sometimes\"\n", &q, err, sizeof err);
    CHECK(rc != 0, "bad perm rejected");
    rc = dbox_policy_load_toml("[[rules]]\npath = \"/a\"\n", &q, err, sizeof err);
    CHECK(rc != 0, "incomplete rule rejected");
    rc = dbox_policy_load_toml("default = \"ask\"\n", &q, err, sizeof err);
    CHECK(rc != 0, "default ask rejected");
    /* identity namespace: [[roots]] mapping is no longer supported */
    rc = dbox_policy_load_toml("[[roots]]\nvirtual = \"/C\"\nreal = \"/host\"\n", &q, err, sizeof err);
    CHECK(rc != 0, "roots rejected in identity namespace");
}

/* 回归：catch-all 兜底规则不得遮蔽内建设备白名单。
 * OpenDesk 标准/受限模式以 `/** write = ask` 兜底，而 node / devecocli 启动即
 * open("/dev/tty", O_WRONLY)；若 /dev/tty 走到 ask，上游无人应答时命令会卡满
 * timeout_ms（330s），外部表现就是"devecocli 卡死且没有任何输出"。 */
static void test_device_whitelist_vs_catchall(void)
{
    char err[256];
    dbox_policy_t p;
    int rc = dbox_policy_load_toml(
        "version = 1\n"
        "default = \"deny\"\n"
        "[[rules]]\npath = \"/**\"\naccess = \"write\"\nperm = \"ask\"\n",
        &p, err, sizeof err);
    CHECK(rc == 0, "device-wl: catch-all policy parse ok");
    if (rc != 0) { fprintf(stderr, "  err: %s\n", err); return; }

    CHECK(dbox_policy_eval_static(&p, "/dev/tty", ACC_WRITE) == PERM_ALLOW,
          "device-wl: /dev/tty write not shadowed by catch-all ask");
    CHECK(dbox_policy_eval_static(&p, "/dev/tty", ACC_READ) == PERM_ALLOW,
          "device-wl: /dev/tty read not shadowed by catch-all ask");
    CHECK(dbox_policy_eval_static(&p, "/dev/pts/3", ACC_WRITE) == PERM_ALLOW,
          "device-wl: /dev/pts write allowed");
    CHECK(dbox_policy_eval_static(&p, "/dev/null", ACC_WRITE) == PERM_ALLOW,
          "device-wl: /dev/null write allowed");
    CHECK(dbox_policy_eval_static(&p, "/var/tmp/x", ACC_WRITE) == PERM_ASK,
          "device-wl: ordinary path still asks");
    dbox_policy_free(&p);

    /* 显式规则（specificity > 0）仍然可以收紧设备访问 */
    rc = dbox_policy_load_toml(
        "version = 1\n"
        "default = \"deny\"\n"
        "[[rules]]\npath = \"/dev/tty\"\naccess = \"write\"\nperm = \"deny\"\n",
        &p, err, sizeof err);
    CHECK(rc == 0 && dbox_policy_eval_static(&p, "/dev/tty", ACC_WRITE) == PERM_DENY,
          "device-wl: explicit rule still wins over device baseline");
    dbox_policy_free(&p);
}

static int fake_ask_allow;
static int fake_ask_calls;
static const char *fake_ask_grant;
static int fake_ask(const dbox_policy_t *p, const char *path, int acc,
                    char *err, size_t errsz)
{
    (void)p; (void)acc; (void)err; (void)errsz;
    fake_ask_calls++;
    if (fake_ask_allow && fake_ask_grant) {
        dbox_grant_add((dbox_policy_t *)p, fake_ask_grant, ACC_ALL, 300,
                       dbox_now_ms());
    }
    return fake_ask_allow;
}

static void test_grants_ask_cache(void)
{
    char err[256];
    dbox_policy_t p;
    int rc = dbox_policy_load_toml(k_policy_toml, &p, err, sizeof err);
    if (rc != 0) { CHECK(0, "policy load for ask tests"); return; }

    int64_t t0 = dbox_now_ms();
    fake_ask_calls = 0;

    /* ask denied -> deny, not cached */
    fake_ask_allow = 0;
    CHECK(dbox_policy_check(&p, "/notes/a", ACC_READ, fake_ask, t0) == PERM_DENY,
          "ask denied => deny");
    CHECK(fake_ask_calls == 1, "ask called once");
    fake_ask_calls = 0;
    CHECK(dbox_policy_check(&p, "/notes/a", ACC_READ, fake_ask, t0) == PERM_DENY,
          "denial not cached");
    CHECK(fake_ask_calls == 1, "ask called again after denial");

    /* ask allowed with grant -> allow; grant covers siblings */
    fake_ask_allow = 1;
    fake_ask_grant = "/notes/**";
    fake_ask_calls = 0;
    CHECK(dbox_policy_check(&p, "/notes/b", ACC_READ, fake_ask, t0) == PERM_ALLOW,
          "ask allow");
    CHECK(fake_ask_calls == 1, "ask once");
    CHECK(dbox_policy_check(&p, "/notes/c", ACC_READ, fake_ask, t0) == PERM_ALLOW,
          "grant covers sibling");
    CHECK(fake_ask_calls == 1, "grant avoids second ask");
    CHECK(dbox_policy_check(&p, "/notes/d", ACC_WRITE, fake_ask, t0) == PERM_ALLOW,
          "catch-all rule covers write without ask");
    CHECK(fake_ask_calls == 1, "no ask for write");

    /* grants never override static deny */
    CHECK(dbox_policy_check(&p, "/docs/secret.txt", ACC_READ, fake_ask, t0) == PERM_DENY,
          "static deny beats grants");
    CHECK(fake_ask_calls == 1, "static deny asks nothing");
    dbox_policy_free(&p);

    /* cache-only tests: no grants involved, dedicated policy so the
     * /ask ask rule is the only matcher */
    dbox_policy_t c;
    rc = dbox_policy_load_toml(
        "default = \"deny\"\n"
        "[ask]\n"
        "endpoint = \"http://127.0.0.1:1/decide\"\n"
        "cache_ttl_seconds = 45\n"
        "[[rules]]\n"
        "path = \"/ask/**\"\n"
        "access = \"read\"\n"
        "perm = \"ask\"\n", &c, err, sizeof err);
    if (rc != 0) { CHECK(0, "cache policy load"); return; }
    fake_ask_grant = NULL;
    fake_ask_calls = 0;
    CHECK(dbox_policy_check(&c, "/ask/e", ACC_READ, fake_ask, t0) == PERM_ALLOW,
          "ask allow no grant");
    CHECK(fake_ask_calls == 1, "exactly one ask");
    CHECK(dbox_policy_check(&c, "/ask/e", ACC_READ, fake_ask, t0) == PERM_ALLOW,
          "cached allow");
    CHECK(fake_ask_calls == 1, "cache avoided second ask");
    CHECK(dbox_policy_check(&c, "/ask/f", ACC_READ, fake_ask, t0) == PERM_ALLOW,
          "different path asks");
    CHECK(fake_ask_calls == 2, "new path asks again");
    CHECK(dbox_policy_check(&c, "/ask/e", ACC_READ, fake_ask, t0 + 46000) == PERM_ALLOW,
          "cache expired -> ask again");
    CHECK(fake_ask_calls == 3, "expired cache asks again");
    CHECK(dbox_policy_check(&c, "/ask/e", ACC_READ, fake_ask, t0 + 47000) == PERM_ALLOW,
          "read cache still valid");
    CHECK(fake_ask_calls == 3, "no ask while cached");

    dbox_policy_free(&c);
}

static void test_system_allow(void)
{
    CHECK(dbox_system_allow("/usr/bin/ls", ACC_READ) == 1, "system read /usr/bin/ls");
    CHECK(dbox_system_allow("/usr/bin/ls", ACC_EXEC) == 1, "system exec /usr/bin/ls");
    CHECK(dbox_system_allow("/lib/x86_64-linux-gnu/libc.so.6", ACC_READ) == 1,
          "system read lib");
    CHECK(dbox_system_allow("/etc/resolv.conf", ACC_READ) == 1, "system read resolv");
    CHECK(dbox_system_allow("/etc/shadow", ACC_READ) == 0, "no read /etc/shadow");
    CHECK(dbox_system_allow("/dev/null", ACC_READ) == 1, "read /dev/null");
    CHECK(dbox_system_allow("/dev/null", ACC_WRITE) == 1, "write /dev/null allowed (redirects)");
    CHECK(dbox_system_allow("/proc/self/mem", ACC_READ) == 1, "read /proc via system_read");
    CHECK(dbox_system_allow("/proc/self/mem", ACC_WRITE) == 0, "no write /proc");
    CHECK(dbox_system_allow("/run/user/1000/bus", ACC_READ) == 1, "read /run (runtime probes)");
    CHECK(dbox_system_allow("/run", ACC_WRITE) == 0, "no write /run");
    CHECK(dbox_system_allow("/usr", ACC_WRITE) == 0, "no write /usr");
}

static void test_cfg_roundtrip(void)
{
    char err[256];
    dbox_policy_t p;
    if (dbox_policy_load_toml(k_policy_toml, &p, err, sizeof err) != 0) {
        CHECK(0, "cfg roundtrip load");
        return;
    }

    char *enc = dbox_cfg_encode(&p);
    CHECK(enc && strlen(enc) > 16, "cfg encode");

    dbox_policy_t q;
    dbox_policy_init(&q);
    CHECK(dbox_cfg_decode(enc, &q) == 0, "cfg decode");
    CHECK(q.default_perm == p.default_perm, "roundtrip default");
    CHECK(q.net_mode == p.net_mode, "roundtrip net");
    CHECK(q.system_read == p.system_read, "roundtrip system_read");
    CHECK(q.ask_timeout_ms == p.ask_timeout_ms, "roundtrip timeout");
    CHECK(q.cache_ttl_s == p.cache_ttl_s, "roundtrip cache");
    CHECK(q.grant_ttl_s == p.grant_ttl_s, "roundtrip grant_ttl");
    CHECK(q.ask_endpoint && strcmp(q.ask_endpoint, p.ask_endpoint) == 0,
          "roundtrip endpoint");
    CHECK(q.nrules == p.nrules, "roundtrip rules count");
    CHECK(q.nrules == 4 && strcmp(q.rules[0].path, "/docs/secret.txt") == 0 &&
          q.rules[0].acc == ACC_ALL && q.rules[0].perm == PERM_DENY,
          "roundtrip rule0");

    /* cfg 往返末尾会重新 dbox_policy_compile（decode 内），判定结果必须与原始
     * 策略一致：排序（spec 降序 + 同 spec 的 perm 次级键）只影响顺序，不影响
     * 语义。这条同时锁住 Linux/OpenHarmony 生产路径（launcher encode → preload
     * decode → 快路径）与直接 load 的等价性。 */
    CHECK(dbox_policy_eval_static(&q, "/docs/secret.txt", ACC_READ) == PERM_DENY,
          "roundtrip eval keeps specific deny");
    CHECK(dbox_policy_eval_static(&q, "/docs/a.txt", ACC_READ) == PERM_ALLOW,
          "roundtrip eval keeps general allow");
    CHECK(dbox_policy_eval_static(&q, "/notes/a", ACC_READ) == PERM_ASK,
          "roundtrip eval keeps ask");
    CHECK(q.rules_compiled == 1, "roundtrip recompiles rules (fast path armed)");

    /* ask token 解析 + 序列化往返 + 请求构造（vs Windows/Linux 的 Bearer 认证） */
    dbox_policy_t pt, qt;
    dbox_policy_init(&pt);
    dbox_policy_init(&qt);
    CHECK(dbox_policy_load_toml(
              "default = \"deny\"\n"
              "[ask]\n"
              "endpoint = \"http://127.0.0.1:1/decide\"\n"
              "token = \"secret-token\"\n", &pt, err, sizeof err) == 0,
          "token toml parse");
    CHECK(pt.ask_token && strcmp(pt.ask_token, "secret-token") == 0, "token parsed");
    char *enc2 = dbox_cfg_encode(&pt);
    CHECK(enc2 && dbox_cfg_decode(enc2, &qt) == 0, "token cfg roundtrip");
    CHECK(qt.ask_token && strcmp(qt.ask_token, "secret-token") == 0, "token decode");
    char req[512];
    CHECK(dbox_ask_build_request(req, sizeof req, "/x", ACC_READ, "tok") == 0 &&
          strstr(req, "\"token\":\"tok\"") != NULL, "ask request carries token");
    CHECK(dbox_ask_build_request(req, sizeof req, "/x", ACC_READ, NULL) == 0 &&
          strstr(req, "token") == NULL,
          "ask request without token omits field");
    dbox_free(enc2);
    dbox_policy_free(&pt);
    dbox_policy_free(&qt);

    dbox_policy_free(&p);
    dbox_policy_free(&q);
    dbox_free(enc);
}

static void test_pathmap_identity(void)
{
    dbox_ctx_t ctx;
    memset(&ctx, 0, sizeof ctx);
    dbox_policy_init(&ctx.pol);
    strcpy(ctx.rpwd, "/tmp");

    char *vp = NULL, *real = NULL;
    int partial = 0;

    /* absolute path: policy path == real path */
    int rc = dbox_plan_path(&ctx, "/tmp/dynobox-unit/a", DBOX_FOLLOW_ALL,
                            &vp, &real, &partial);
    CHECK(rc == 0, "plan absolute ok");
    CHECK(vp && strcmp(vp, "/tmp/dynobox-unit/a") == 0, "plan absolute vpath==real");
    CHECK(real && strcmp(real, "/tmp/dynobox-unit/a") == 0, "plan absolute real");
    dbox_free(vp); dbox_free(real);

    /* relative input resolves against rpwd */
    rc = dbox_plan_path(&ctx, "docs/x", DBOX_FOLLOW_ALL, &vp, &real, &partial);
    CHECK(rc == 0 && vp && strcmp(vp, "/tmp/docs/x") == 0, "plan relative attr");
    dbox_free(vp); dbox_free(real);

    /* traversal collapses but never escapes; the target is /tmp itself
     * because HarmonyOS exposes /etc, /bin and /lib as symlinks into
     * /system, and the resolver here follows components, so such a path
     * would come back as the symlink target rather than the literal path
     * Linux hosts see. */
    rc = dbox_plan_path(&ctx, "/tmp/../tmp/x", DBOX_FOLLOW_ALL,
                        &vp, &real, &partial);
    CHECK(rc == 0 && vp && strcmp(vp, "/tmp/x") == 0, "plan .. collapse");
    dbox_free(vp); dbox_free(real);
}

static void test_bom_crlf_and_literals(void)
{
    char err[256];
    dbox_policy_t p;

    /* UTF-8 BOM + CRLF line endings (Windows-authored files) */
    const char *bom = "\xEF\xBB\xBFversion = 1\r\ndefault = \"deny\"\r\n"
                      "[[rules]]\r\npath = \"/a\"    # comment\r\naccess = \"read\"\r\nperm = \"allow\"\r\n";
    int rc = dbox_policy_load_toml(bom, &p, err, sizeof err);
    CHECK(rc == 0, "parse BOM+CRLF policy");
    if (rc == 0) {
        CHECK(p.default_perm == PERM_DENY && p.nrules == 1 &&
              strcmp(p.rules[0].path, "/a") == 0, "BOM+CRLF content intact");
        CHECK(dbox_policy_eval_static(&p, "/a", ACC_READ) == PERM_ALLOW,
              "BOM+CRLF rule evaluates");
        dbox_policy_free(&p);
    }

    /* glob characters inside literal filenames: '*' and '?' in a FILENAME
     * are matched by the corresponding wildcards (documented behaviour) */
    CHECK(dbox_glob_match("/a?b", "/a?b") == 1, "glob ? matches literal ?");
    CHECK(dbox_glob_match("/a*b", "/a*b") == 1, "glob * matches literal *");
    CHECK(dbox_glob_match("/a?b", "/aXb") == 1, "glob ? also matches X");

    /* b64 decode rejects malformed input */
    size_t n = 0;
    CHECK(dbox_b64decode("A", &n) == NULL, "b64 length%4 rejected");
    CHECK(dbox_b64decode("!!!!", &n) == NULL, "b64 bad chars rejected");
    CHECK(dbox_b64decode("aGVsbG8=", &n) != NULL && n == 5, "b64 hello ok");
}

static void test_default_allow_cache_overwrite(void)
{
    char err[256];
    dbox_policy_t p;
    int rc = dbox_policy_load_toml(
        "default = \"allow\"\n"
        "[[rules]]\n"
        "path = \"/secret/**\"\n"
        "access = \"all\"\n"
        "perm = \"deny\"\n", &p, err, sizeof err);
    CHECK(rc == 0, "default-allow + deny rule parse");
    if (rc == 0) {
        CHECK(dbox_policy_eval_static(&p, "/secret/f", ACC_READ) == PERM_DENY,
              "deny rule wins under default allow");
        CHECK(dbox_policy_eval_static(&p, "/other", ACC_READ) == PERM_ALLOW,
              "default allow covers others");
        dbox_policy_free(&p);
    }

    /* cache overwrite: latest put wins */
    int64_t now = dbox_now_ms();
    dbox_cache_put("/z", ACC_READ, now + 60000);
    CHECK(dbox_cache_hit("/z", ACC_READ, now) == 1, "cache hit before overwrite");
    dbox_cache_put("/z", ACC_READ, now - 1);
    CHECK(dbox_cache_hit("/z", ACC_READ, now) == 0, "cache overwrite latest wins");
    dbox_cache_clear();
}

static void test_duplicate_keys_and_multi_grants(void)
{
    char err[256];
    dbox_policy_t p;
    /* duplicate keys: last occurrence wins (override semantics, documented) */
    int rc = dbox_policy_load_toml(
        "default = \"deny\"\n"
        "default = \"allow\"\n"
        "[[rules]]\n"
        "path = \"/a\"\n"
        "access = \"read\"\n"
        "perm = \"allow\"\n", &p, err, sizeof err);
    CHECK(rc == 0, "duplicate keys parse");
    CHECK(p.default_perm == PERM_ALLOW, "duplicate key last-wins");
    dbox_policy_free(&p);

    /* multiple grants coexist and both match */
    rc = dbox_policy_load_toml(
        "default = \"deny\"\n"
        "[[rules]]\n"
        "path = \"/g/**\"\n"
        "access = \"all\"\n"
        "perm = \"ask\"\n", &p, err, sizeof err);
    if (rc != 0) { CHECK(0, "multi grant policy load"); return; }
    int64_t t0 = dbox_now_ms();
    dbox_grant_add(&p, "/g/reads/**", ACC_READ, 60, t0);
    dbox_grant_add(&p, "/g/writes/**", ACC_WRITE, 60, t0);
    CHECK(dbox_grant_match(&p, "/g/reads/f", ACC_READ, t0) == 1, "grant1 read");
    CHECK(dbox_grant_match(&p, "/g/writes/f", ACC_WRITE, t0) == 1, "grant2 write");
    CHECK(dbox_grant_match(&p, "/g/writes/f", ACC_READ, t0) == 0, "grant2 read no");
    CHECK(dbox_grant_match(&p, "/g/reads/f", ACC_WRITE, t0) == 0, "grant1 write no");

    /* ttl_s <= 0 falls back to the policy default (capped at 1h) */
    int64_t exp = 0;
    dbox_grant_add(&p, "/g/auto", ACC_READ, 0, t0);
    for (int i = 0; i < p.ngrants; i++)
        if (strcmp(p.grants[i].path, "/g/auto") == 0) exp = p.grants[i].expires_ms;
    CHECK(exp == t0 + p.grant_ttl_s * 1000, "grant default ttl applied");
    dbox_policy_free(&p);
}

static void test_pathmap_missing_tail(void)
{
    /* 尾段不存在（ENOENT）时也必须完成符号链接解析，并把解析结果用于策略
     * 归属。早期实现在该情况下退回词法路径，后果是：经符号链接访问系统
     * 路径被误判成越权（/etc/ssl/x.cnf 报 EACCES 而不是 ENOENT），反过来
     * 针对链接名的规则也会漏掉真实目标。
     * 用 /proc/self 作样本（各平台上都是符号链接）；若该平台不可用则跳过。 */
    struct stat st;
    if (lstat("/proc/self", &st) != 0 || !S_ISLNK(st.st_mode)) {
        printf("skip plan missing-tail (no /proc/self symlink here)\n");
        return;
    }

    dbox_ctx_t ctx;
    memset(&ctx, 0, sizeof ctx);
    dbox_policy_init(&ctx.pol);
    strcpy(ctx.rpwd, "/tmp");

    char *vp = NULL, *real = NULL;
    int partial = 0;
    int rc;

    rc = dbox_plan_path(&ctx, "/proc/self/no-such-file-xyz", DBOX_FOLLOW_ALL,
                        &vp, &real, &partial);
    CHECK(rc == 0 && vp && strncmp(vp, "/proc/self", 10) != 0,
          "plan missing tail still resolves symlink");
    CHECK(rc == 0 && vp && vp[0] == '/' && vp[1] != '/',
          "plan missing tail yields normalized path");
    dbox_free(vp); dbox_free(real);

    /* 反复回到根之后拼出的路径不得带 "//"：那会让策略前缀匹配失效 */
    rc = dbox_plan_path(&ctx, "/proc/self/../../etc/no-such-file-xyz",
                        DBOX_FOLLOW_ALL, &vp, &real, &partial);
    CHECK(rc == 0 && vp && vp[0] == '/' && vp[1] != '/',
          "plan root join does not emit //");
    dbox_free(vp); dbox_free(real);

    dbox_policy_free(&ctx.pol);
}

static void test_ro_dirs(void)
{
    char err[256];
    dbox_policy_t p;

    /* 整棵 /data 显式放行写，再把其中两部分标为只读：注入的 deny 必须
     * 前置（优先于 allow），且只约束写、不影响读。 */
    int rc = dbox_policy_load_toml(
        "default = \"deny\"\n"
        "[[rules]]\n"
        "path = \"/data/**\"\n"
        "access = \"write\"\n"
        "perm = \"allow\"\n"
        "[[rules]]\n"
        "path = \"/**\"\n"
        "access = \"read\"\n"
        "perm = \"allow\"\n", &p, err, sizeof err);
    if (rc != 0) { CHECK(0, "ro-dirs base policy load"); return; }
    CHECK(rc == 0 && p.nrules == 2, "ro-dirs base rule count");

    /* spec 含空白与尾斜杠；重复/空段需被容忍 */
    rc = dbox_policy_prepend_ro_dirs(&p, "/data/readonly, /data/ro2/ ,,  ");
    CHECK(rc == 0, "ro-dirs prepend ok");
    CHECK(p.nrules == 6, "ro-dirs prepend count (2 dirs x 2 rules + 2 base)");

    /* 每个只读目录注入两条：精确 `X`（目录自身）与 `X/**`（子树）。glob 语义下
     * `X/**` 不含 X 自身，只注入这一条会让只读目录本身的写落回兜底规则。
     * 同 spec 的两条相对次序由 qsort 决定（不稳定），故按存在性断言而非下标。 */
    int sawExact = 0, sawDeep = 0, sawRo2 = 0, sawRo2Deep = 0;
    for (int i = 0; i < p.nrules; i++) {
        const dbox_rule_t *r = &p.rules[i];
        if (r->acc != ACC_WRITE || r->perm != PERM_DENY) continue;
        if (strcmp(r->path, "/data/readonly") == 0) sawExact = 1;
        if (strcmp(r->path, "/data/readonly/**") == 0) sawDeep = 1;
        if (strcmp(r->path, "/data/ro2") == 0) sawRo2 = 1;
        if (strcmp(r->path, "/data/ro2/**") == 0) sawRo2Deep = 1;
    }
    CHECK(sawExact && sawDeep, "ro-dirs injects exact + subtree deny for /data/readonly");
    CHECK(sawRo2 && sawRo2Deep, "ro-dirs strips trailing slash for both rules");

    CHECK(dbox_policy_eval_static(&p, "/data/w.txt", ACC_WRITE) == PERM_ALLOW,
          "ro-dirs outside dir still writable");
    CHECK(dbox_policy_eval_static(&p, "/data/readonly/a.txt", ACC_WRITE) == PERM_DENY,
          "ro-dirs write denied inside");
    CHECK(dbox_policy_eval_static(&p, "/data/ro2", ACC_WRITE) == PERM_DENY,
          "ro-dirs dir itself write denied (exact X rule)");
    CHECK(dbox_policy_eval_static(&p, "/data/rox", ACC_WRITE) == PERM_ALLOW,
          "ro-dirs prefix boundary respected");
    CHECK(dbox_policy_eval_static(&p, "/data/readonly/a.txt", ACC_READ) == PERM_ALLOW,
          "ro-dirs read still allowed");
    dbox_policy_free(&p);

    /* 空 spec：不动已有规则 */
    rc = dbox_policy_load_toml(
        "default = \"deny\"\n"
        "[[rules]]\n"
        "path = \"/a/**\"\n"
        "access = \"write\"\n"
        "perm = \"allow\"\n", &p, err, sizeof err);
    CHECK(rc == 0 && p.nrules == 1, "ro-dirs empty base load");
    rc = dbox_policy_prepend_ro_dirs(&p, "");
    CHECK(rc == 0 && p.nrules == 1, "ro-dirs empty spec is no-op");
    dbox_policy_free(&p);
}

/* 回收站分流判定（--del-to-trash）：空目录与 0 字节普通文件无恢复价值，
 * 直接真删不入站——rm -rf 收尾 rmdir 与构建零时文件曾是回收站噪音主源 */
static void test_trash_worth_keeping(void)
{
    CHECK(dbox_trash_worth_keeping(S_IFREG | 0644, 123) == 1, "trash keep: regular non-empty");
    CHECK(dbox_trash_worth_keeping(S_IFREG | 0644, 1) == 1, "trash keep: single byte file");
    CHECK(dbox_trash_worth_keeping(S_IFREG | 0644, 0) == 0, "trash skip: zero-byte file");
    CHECK(dbox_trash_worth_keeping(S_IFDIR | 0755, 4096) == 0, "trash skip: directory (rmdir-only semantics)");
    CHECK(dbox_trash_worth_keeping(S_IFDIR | 0755, 0) == 0, "trash skip: directory size 0");
    CHECK(dbox_trash_worth_keeping(S_IFLNK | 0777, 11) == 1, "trash keep: symlink");
    CHECK(dbox_trash_worth_keeping(S_IFIFO | 0644, 0) == 1, "trash keep: fifo (conservative)");
    CHECK(dbox_trash_worth_keeping(S_IFSOCK | 0644, 0) == 1, "trash keep: socket (conservative)");
}

/* 回收站排除清单匹配（--trash-exclude / DYNOBOX_TRASH_EXCLUDE）：
 * 分隔符切段 + 组件边界前缀匹配，命中即真删不入站 */
static void test_trash_excluded(void)
{
    const char *list = "/tmp:/var/tmp:/dev/shm:/home/u/.cache/build";
    CHECK(dbox_trash_excluded("/tmp/esbuild-abc", list, ':') == 1, "trash-excl: tmp file");
    CHECK(dbox_trash_excluded("/tmp/a/b/c.bin", list, ':') == 1, "trash-excl: tmp subtree");
    CHECK(dbox_trash_excluded("/var/tmp/x", list, ':') == 1, "trash-excl: var/tmp");
    CHECK(dbox_trash_excluded("/dev/shm/seg", list, ':') == 1, "trash-excl: shm");
    CHECK(dbox_trash_excluded("/home/u/.cache/build/out.o", list, ':') == 1, "trash-excl: deep prefix");
    /* 组件边界：前缀相同但下一字符不是 '/' 的不得命中 */
    CHECK(dbox_trash_excluded("/tmp2/keep.txt", list, ':') == 0, "trash-excl: boundary /tmp2 not /tmp");
    CHECK(dbox_trash_excluded("/home/u/.cache/buildx/f", list, ':') == 0, "trash-excl: boundary buildx");
    /* 清单外路径 */
    CHECK(dbox_trash_excluded("/home/u/work/src/main.c", list, ':') == 0, "trash-excl: outside kept");
    CHECK(dbox_trash_excluded("/tmpx", list, ':') == 0, "trash-excl: prefix-only mismatch");
    /* 空清单/空路径：绝不排除（排除=真删，空输入必须保守返回 0） */
    CHECK(dbox_trash_excluded("/tmp/f", "", ':') == 0, "trash-excl: empty list");
    CHECK(dbox_trash_excluded(NULL, list, ':') == 0, "trash-excl: NULL path");
    /* 分隔符参数化（Windows 侧 hook 层用自己的实现，这里仅验证分隔符通用性；
     * 路径仍为 POSIX 形态——dbox_path_under 的组件边界按 '/' 判定） */
    CHECK(dbox_trash_excluded("/home/u/temp/x.tmp", "/home/u/temp;/home/u/cache", ';') == 1,
          "trash-excl: semicolon delimiter");
    /* 尾随分隔符产生的空段被跳过 */
    CHECK(dbox_trash_excluded("/tmp/f", "/tmp:/var/tmp:", ':') == 1, "trash-excl: trailing sep ok");
}

static void test_acc_from_open_flags(void)
{
#ifndef O_DIRECTORY
#define O_DIRECTORY 0200000
#endif
#ifndef O_TMPFILE
#define O_TMPFILE 020200000
#endif
    /* 回归（BUG find-ask-storm）：O_TMPFILE 定义含 O_DIRECTORY 位，按位
     * 检测曾把一切目录打开误判为写模式——standard 模式下 `find /` 逐目录
     * 触发幽灵 write ask。目录枚举（无写位 + O_DIRECTORY）必须是 0
     * （deny-only，与 opendir 同口径），O_TMPFILE 必须仍算写。 */
    CHECK(dbox_acc_from_open_flags(O_RDONLY) == ACC_READ, "acc: plain rd");
    CHECK(dbox_acc_from_open_flags(O_RDONLY | O_CLOEXEC) == ACC_READ, "acc: rd + cloexec");
    CHECK(dbox_acc_from_open_flags(O_RDONLY | O_DIRECTORY) == 0, "acc: dir enum is deny-only(0)");
    CHECK(dbox_acc_from_open_flags(O_RDONLY | O_DIRECTORY | O_NONBLOCK | O_CLOEXEC) == 0,
          "acc: fts-style dir open is deny-only(0)");
    CHECK(dbox_acc_from_open_flags(O_WRONLY) == (ACC_READ | ACC_WRITE), "acc: wr");
    CHECK(dbox_acc_from_open_flags(O_RDWR) == (ACC_READ | ACC_WRITE), "acc: rdwr");
    CHECK(dbox_acc_from_open_flags(O_WRONLY | O_CREAT | O_TRUNC) == (ACC_READ | ACC_WRITE), "acc: creat+trunc");
    CHECK(dbox_acc_from_open_flags(O_WRONLY | O_APPEND) == (ACC_READ | ACC_WRITE), "acc: append");
    CHECK(dbox_acc_from_open_flags(O_TMPFILE | O_WRONLY) == (ACC_READ | ACC_WRITE), "acc: O_TMPFILE is write");
    CHECK(dbox_acc_from_open_flags(O_TMPFILE) == (ACC_READ | ACC_WRITE), "acc: O_TMPFILE alone is write");
    /* O_DIRECTORY|O_CREAT：创建位在，仍走写判定（不是目录枚举） */
    CHECK(dbox_acc_from_open_flags(O_RDONLY | O_DIRECTORY | O_CREAT) == (ACC_READ | ACC_WRITE),
          "acc: dir+creat is write");
}

/* ------------------------------------------------------------------ */
/* BUG-021 bootstrap allocator guard                                   */

/* dbox_malloc/free 直连 __libc_malloc：验证分配/释放往返、NULL free
 * 安全性，以及跨 realloc 的内容保持。这些调用发生在测试进程（非沙箱
 * 注入环境），与 preload 内路径相同——返回的指针必须可用且与系统
 * malloc 语义一致。 */
static void test_bootstrap_allocator(void)
{
    void *p = dbox_malloc(128);
    CHECK(p != NULL, "bootstrap: dbox_malloc returns ptr");
    memset(p, 0xAB, 128);
    void *q = dbox_realloc(p, 256);
    CHECK(q != NULL, "bootstrap: dbox_realloc grows");
    unsigned char *b = q;
    int intact = 1;
    for (int i = 0; i < 128; i++) if (b[i] != 0xAB) { intact = 0; break; }
    CHECK(intact, "bootstrap: realloc preserves content");
    dbox_free(q);
    dbox_free(NULL);   /* free(NULL) must be a no-op */
    CHECK(1, "bootstrap: free(NULL) no-op");

    /* strdup/strndup/normpath 等上层 helper 全部经由 dbox_malloc，
     * 抽查一个确认分配器切换后仍正常。 */
    char *s = dbox_strdup("hello");
    CHECK(s && strcmp(s, "hello") == 0, "bootstrap: strdup via guard");
    dbox_free(s);
}

/* ------------------------------------------------------------------ */
/* log 时间戳的 civil-from-days 算法（log.c dbox_logf 内联实现）         */
/* BUG-021 修复把 localtime_r 换成纯算术 UTC 分解，这里对锚点日期复核    */
/* 算法正确性（算法实现与 log.c 保持逐字同步，改一处必须同步另一处）。   */
static void log_civil_from_days(long days, long *Y, long *M, long *D)
{
    long z = days + 719468;
    long era = (z >= 0 ? z : z - 146096) / 146097;
    long doe = z - era * 146097;
    long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long y = yoe + era * 400;
    long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    long mp = (5 * doy + 2) / 153;
    long d = doy - (153 * mp + 2) / 5 + 1;
    long m = mp < 10 ? mp + 3 : mp - 9;
    y += (m <= 2);
    *Y = y; *M = m; *D = d;
}

static void test_log_timestamp_civil(void)
{
    struct { long days; long y, m, d; const char *name; } cases[] = {
        { 0,      1970, 1,  1,  "epoch" },
        { 1,      1970, 1,  2,  "epoch+1" },
        { 31,     1970, 2,  1,  "feb" },
        { 365,    1971, 1,  1,  "year boundary" },
        { 11016,  2000, 2,  29, "leap day" },
        { 11017,  2000, 3,  1,  "leap day +1" },
        { 19723,  2024, 1,  1,  "recent year" },
        { -1,     1969, 12, 31, "pre-epoch" },
        { -719468, 0,  3,  1,  "z == 0 (0000-03-01, Hinnant epoch)" },
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        long Y, M, D;
        log_civil_from_days(cases[i].days, &Y, &M, &D);
        char name[64];
        snprintf(name, sizeof name, "log civil: %s", cases[i].name);
        CHECK(Y == cases[i].y && M == cases[i].m && D == cases[i].d, name);
    }
    /* 秒内分解：sod 拆 时:分:秒 */
    long sec = 23 * 3600 + 59 * 60 + 58;
    int sod = (int)(sec % 86400);
    CHECK(sod / 3600 == 23 && (sod / 60) % 60 == 59 && sod % 60 == 58,
          "log civil: time-of-day split");
}

int main(void)
{
    test_normpath();
    test_path_under();
    test_path_rel();
    test_glob();
    test_glob_compiled();
    test_eval_specificity_order();
    test_toml_and_eval();
    test_device_whitelist_vs_catchall();
    test_grants_ask_cache();
    test_system_allow();
    test_cfg_roundtrip();
    test_pathmap_identity();
    test_pathmap_missing_tail();
    test_bom_crlf_and_literals();
    test_default_allow_cache_overwrite();
    test_duplicate_keys_and_multi_grants();
    test_ro_dirs();
    test_trash_worth_keeping();
    test_trash_excluded();
    test_acc_from_open_flags();
    test_bootstrap_allocator();
    test_log_timestamp_civil();
    printf("\n%d checks, %d failed\n", g_total, g_failed);
    return g_failed ? 1 : 0;
}
