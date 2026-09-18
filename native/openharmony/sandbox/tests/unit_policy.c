/* unit_policy.c — unit tests for the dynobox policy engine, path
 * attribution and config serialization. Run directly (no sandbox):
 * tests/unit_policy */
#define _GNU_SOURCE
#include "dynobox.h"
#include "policy.h"
#include "pathmap.h"
#include "cfgio.h"
#include "util.h"
#include "mini_toml.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

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
    CHECK(dbox_glob_match("/**", "/") == 1, "glob ** root");
    CHECK(dbox_glob_match("/**", "/a/b/c") == 1, "glob ** deep");
    CHECK(dbox_glob_match("/docs/**", "/docs") == 1, "glob dir/** matches dir");
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
    CHECK(dbox_system_allow("/proc/self/mem", ACC_READ) == 0, "no read /proc by default");
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

    /* traversal collapses but never escapes */
    rc = dbox_plan_path(&ctx, "/tmp/../etc/passwd", DBOX_FOLLOW_ALL,
                        &vp, &real, &partial);
    CHECK(rc == 0 && vp && strcmp(vp, "/etc/passwd") == 0, "plan .. collapse");
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

int main(void)
{
    test_normpath();
    test_path_under();
    test_path_rel();
    test_glob();
    test_toml_and_eval();
    test_grants_ask_cache();
    test_system_allow();
    test_cfg_roundtrip();
    test_pathmap_identity();
    test_bom_crlf_and_literals();
    test_default_allow_cache_overwrite();
    test_duplicate_keys_and_multi_grants();
    printf("\n%d checks, %d failed\n", g_total, g_failed);
    return g_failed ? 1 : 0;
}
