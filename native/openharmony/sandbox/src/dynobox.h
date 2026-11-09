/*
 * dynobox.h — common types shared by the CLI launcher, the LD_PRELOAD
 * sandbox library and the reference decision endpoint.
 *
 * dynobox-linux: LD_PRELOAD based file-access-control sandbox, the Linux
 * counterpart of the OpenDesk dynobox (Windows sandbox) component.
 */
#ifndef DYNOBOX_H
#define DYNOBOX_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- permissions ---- */
typedef enum {
    PERM_ALLOW = 0,
    PERM_ASK   = 1,
    PERM_DENY  = 2
} dperm_t;

/* ---- access categories ---- */
enum {
    ACC_READ  = 1,
    ACC_WRITE = 2,
    ACC_EXEC  = 4,
    ACC_ALL   = 7
};

const char *dbox_perm_name(dperm_t p);
const char *dbox_access_name(int acc);   /* returns "read"/"write"/"execute"/"all" */

/* ---- policy ---- */
/* 预编译的路径 glob：dbox_rule_t 持有它，实现见下方 glob 段 */
typedef struct dbox_glob dbox_glob_t;

typedef struct {
    char   *path;    /* virtual glob (two-star/one-star/question-mark) */
    int     acc;     /* ACC_* bitmask */
    dperm_t perm;
    /* 预编译匹配数据（dbox_policy_compile 填充）。没有它时评估退化为
     * 每次重新解析模式（旧行为），保证手工构造规则的调用方不受影响。 */
    dbox_glob_t *glob;
    size_t  spec;    /* 规范化后模式的 specificity（排序/提前结束用） */
} dbox_rule_t;

typedef struct {
    char   *path;    /* path glob granted by the endpoint */
    int     acc;     /* ACC_* bitmask */
    int64_t expires_ms;  /* monotonic milliseconds; 0 = already expired */
} dbox_grant_t;

enum { NET_ALLOW = 0, NET_DENY = 1, NET_LOOPBACK = 2 };

typedef struct {
    dbox_rule_t *rules;  int nrules;
    dbox_grant_t *grants; int ngrants; int cap_grants;

    /* [ask] */
    char  *ask_endpoint;      /* "http://127.0.0.1:8080/decide" or "unix:///path" */
    char  *ask_token;         /* optional bearer token sent to the endpoint */
    int    ask_timeout_ms;    /* default 2000 */
    int    cache_ttl_s;       /* ask decision cache, 0 = disabled */
    int    grant_ttl_s;       /* default TTL for endpoint grants, default 300 */

    dperm_t default_perm;     /* PERM_ALLOW or PERM_DENY (default: DENY) */

    /* [network] */
    int     net_mode;         /* NET_* (default: NET_ALLOW, parity with Windows) */

    /* built-in system runtime read/exec allowance (parity: Windows keeps
     * system directories readable for the sandboxed processes) */
    int     system_read;      /* default 1 */

    /* rules[] 已预编译并按 specificity 降序排列（dbox_policy_compile 置位）。
     * 置位后评估走"预编译 + 提前结束"的快路径，否则回退旧逻辑。 */
    int     rules_compiled;
} dbox_policy_t;

void  dbox_policy_init(dbox_policy_t *p);
void  dbox_policy_free(dbox_policy_t *p);

/* 为 rules[] 预编译 glob 组件并按 specificity 降序排序（幂等）。
 * 只做纯实现优化，不改变判定语义。 */
void  dbox_policy_compile(dbox_policy_t *p);

/* Evaluate a path for the given access mask (single category).
 * Returns PERM_ALLOW / PERM_DENY. `ask_cb`-free core used by tests. */
dperm_t dbox_policy_eval_static(const dbox_policy_t *p, const char *path, int acc);

/* Full evaluation incl. grants + ask transport. `now_ms` = monotonic ms. */
typedef int (*dbox_ask_fn)(const dbox_policy_t *p, const char *path, int acc,
                           char *err, size_t errsz);
dperm_t dbox_policy_check(dbox_policy_t *p, const char *path, int acc,
                          dbox_ask_fn ask, int64_t now_ms);

/* built-in system runtime prefixes allowed for read+exec when system_read */
int dbox_system_allow(const char *path, int acc);

/* ---- glob (path pattern) ----
 * a two-star segment crosses directory levels, one-star stays within one
 * level, question-mark matches a single character. A trailing two-star
 * pattern also matches the directory itself; a lone two-star pattern
 * matches the whole volume. */
int dbox_glob_match(const char *pat, const char *path);

/* ---- pre-compiled glob ----
 * 策略生命周期内模式不变、被判定路径不断变化，因此把"模式解析"（normpath +
 * 按组件切分）从每次判定里拿出来做一次。判定时只切分路径，语义与
 * dbox_glob_match 完全一致。
 *
 * 供三平台共用（Linux/OpenHarmony 的规则快路径直接用它，macOS 的
 * boxdylib 与 Windows 的 Policy 在各自的规则结构里持有该句柄）。 */
dbox_glob_t *dbox_glob_compile(const char *pattern);   /* NULL = 失败 */
int   dbox_glob_match_compiled(const dbox_glob_t *g, const char *path);
size_t dbox_glob_specificity(const dbox_glob_t *g);    /* 排序/提前结束用 */
void  dbox_glob_free(dbox_glob_t *g);

/* ---- monotonic milliseconds ---- */
int64_t dbox_now_ms(void);

#ifdef __cplusplus
}
#endif
#endif /* DYNOBOX_H */
