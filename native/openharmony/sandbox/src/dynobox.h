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
typedef struct {
    char   *path;    /* virtual glob (two-star/one-star/question-mark) */
    int     acc;     /* ACC_* bitmask */
    dperm_t perm;
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
} dbox_policy_t;

void  dbox_policy_init(dbox_policy_t *p);
void  dbox_policy_free(dbox_policy_t *p);

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

/* ---- monotonic milliseconds ---- */
int64_t dbox_now_ms(void);

#ifdef __cplusplus
}
#endif
#endif /* DYNOBOX_H */
