/* policy.c — dynobox policy engine.
 *
 * Evaluation order mirrors the Windows dynobox:
 *   1. static rules in declaration order, first match wins
 *      (deny → deny, allow → allow, ask → continue below)
 *   2. for ask: endpoint-issued subtree grants (within TTL)
 *   3. for ask: decision cache (positive decisions only)
 *   4. ask upstream endpoint — timeout/error/bad response => deny (fail-closed)
 *   5. no rule matched => default (allow|deny, default deny)
 * Grants can only refine an ask result; they never override static
 * deny/allow/default.
 */
#define _GNU_SOURCE
#include "dynobox.h"
#include "policy.h"
#include "util.h"
#include "mini_toml.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <pthread.h>

const char *dbox_perm_name(dperm_t p)
{
    switch (p) {
    case PERM_ALLOW: return "allow";
    case PERM_ASK:   return "ask";
    case PERM_DENY:  return "deny";
    }
    return "?";
}

const char *dbox_access_name(int acc)
{
    switch (acc) {
    case ACC_READ:  return "read";
    case ACC_WRITE: return "write";
    case ACC_EXEC:  return "execute";
    case ACC_ALL:   return "all";
    }
    return "?";
}

int64_t dbox_now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* ------------------------------------------------------------------ */
/* glob                                                                */
/* ------------------------------------------------------------------ */

/* wildcard match within one path component */
static int match_comp(const char *p, const char *s)
{
    const char *star = NULL, *ss = NULL;
    while (*s) {
        if (*p == '?') { p++; s++; }
        else if (*p == '*') { star = ++p; ss = s; }
        else if (*p == *s) { p++; s++; }
        else if (star) { p = star; s = ++ss; }
        else return 0;
    }
    while (*p == '*') p++;
    return *p == '\0';
}

typedef struct { char **c; int n; } comps_t;

static void comps_free(comps_t *cs)
{
    for (int i = 0; i < cs->n; i++) dbox_free(cs->c[i]);
    if (cs->c) dbox_free(cs->c);
    cs->c = NULL; cs->n = 0;
}

static void comps_split(const char *path, comps_t *cs)
{
    memset(cs, 0, sizeof(*cs));
    int cap = 8;
    cs->c = dbox_malloc(sizeof(char *) * cap);
    const char *p = path;
    while (*p) {
        while (*p == '/') p++;
        if (!*p) break;
        const char *st = p;
        while (*p && *p != '/') p++;
        if (cs->n == cap) { cap *= 2; cs->c = dbox_realloc(cs->c, sizeof(char *) * cap); }
        cs->c[cs->n++] = dbox_strndup(st, (size_t)(p - st));
    }
}

static int match_list(char **pat, int np, char **pth, int nt)
{
    if (np == 0) return nt == 0;
    if (strcmp(pat[0], "**") == 0) {
        if (np == 1) return 1;   /* trailing ** matches the rest incl. empty */
        for (int i = 0; i <= nt; i++)
            if (match_list(pat + 1, np - 1, pth + i, nt - i)) return 1;
        return 0;
    }
    if (nt == 0) return 0;
    if (!match_comp(pat[0], pth[0])) return 0;
    return match_list(pat + 1, np - 1, pth + 1, nt - 1);
}

int dbox_glob_match(const char *pat, const char *path)
{
    if (!pat || !path) return 0;
    /* normalize both to component lists */
    char *pn = dbox_normpath(pat);
    char *un = dbox_normpath(path);
    /* pattern "/" matches path "/" only (empty component lists) */
    comps_t cp, cu;
    comps_split(pn, &cp);
    comps_split(un, &cu);
    int r = match_list(cp.c, cp.n, cu.c, cu.n);
    comps_free(&cp);
    comps_free(&cu);
    dbox_free(pn);
    dbox_free(un);
    return r;
}

/* ------------------------------------------------------------------ */
/* policy lifecycle                                                    */
/* ------------------------------------------------------------------ */

void dbox_policy_init(dbox_policy_t *p)
{
    memset(p, 0, sizeof(*p));
    p->default_perm   = PERM_DENY;
    p->ask_timeout_ms = 2000;
    p->cache_ttl_s    = 60;
    p->grant_ttl_s    = 300;
    p->net_mode       = NET_ALLOW;
    p->system_read    = 1;
}

void dbox_policy_free(dbox_policy_t *p)
{
    for (int i = 0; i < p->nrules; i++) dbox_free(p->rules[i].path);
    dbox_free(p->rules);
    for (int i = 0; i < p->ngrants; i++) dbox_free(p->grants[i].path);
    dbox_free(p->grants);
    dbox_free(p->ask_endpoint);
    memset(p, 0, sizeof(*p));
}

static int parse_access(const char *s, int *acc)
{
    if (!s) return -1;
    if (dbox_str_ieq(s, "read"))         *acc = ACC_READ;
    else if (dbox_str_ieq(s, "write"))   *acc = ACC_WRITE;
    else if (dbox_str_ieq(s, "execute")) *acc = ACC_EXEC;
    else if (dbox_str_ieq(s, "all"))     *acc = ACC_ALL;
    else return -1;
    return 0;
}

static int parse_perm(const char *s, dperm_t *perm)
{
    if (!s) return -1;
    if (dbox_str_ieq(s, "allow"))      *perm = PERM_ALLOW;
    else if (dbox_str_ieq(s, "ask"))   *perm = PERM_ASK;
    else if (dbox_str_ieq(s, "deny"))  *perm = PERM_DENY;
    else return -1;
    return 0;
}

int dbox_policy_load_toml(const char *text, dbox_policy_t *p,
                          char *err, size_t errsz)
{

    dbox_policy_init(p);
    tdoc_t doc;
    if (mini_toml_parse(text, &doc, err, errsz) != 0) return -1;

    /* Linux 版不做路径映射：[[roots]] 不再支持，策略直接作用于真实路径 */
    for (int i = 0; i < doc.n; i++) {
        if (strcmp(doc.e[i].section, "roots") == 0) {
            snprintf(err, errsz,
                     "[[roots]] 已不支持：Linux 版路径与真实路径相同，"
                     "规则直接使用真实路径");
            goto bad;
        }
    }

    /* rules in document order */
    int n_rules = 0;
    for (int i = 0; i < doc.n; i++) {
        if (strcmp(doc.e[i].section, "rules") == 0 && doc.e[i].aot_index + 1 > n_rules)
            n_rules = doc.e[i].aot_index + 1;
    }
    if (n_rules) p->rules = dbox_malloc(sizeof(dbox_rule_t) * n_rules);

    for (int i = 0; i < doc.n; i++) {
        const tentry_t *e = &doc.e[i];
        if (e->aot_index >= 0) {
            if (strcmp(e->section, "rules") != 0 || e->aot_index != p->nrules)
                continue;
            dbox_rule_t *r = &p->rules[p->nrules];
            memset(r, 0, sizeof(*r));
            const tentry_t *pa = mini_toml_find(&doc, "rules", e->aot_index, "path");
            const tentry_t *ac = mini_toml_find(&doc, "rules", e->aot_index, "access");
            const tentry_t *pe = mini_toml_find(&doc, "rules", e->aot_index, "perm");
            if (!pa || pa->type != TV_STR || !ac || ac->type != TV_STR || !pe || pe->type != TV_STR) {
                snprintf(err, errsz, "[[rules]] #%d needs path=, access=, perm= strings",
                         e->aot_index + 1);
                goto bad;
            }
            if (parse_access(ac->s, &r->acc) != 0) {
                snprintf(err, errsz, "invalid access `%s`", ac->s);
                goto bad;
            }
            if (parse_perm(pe->s, &r->perm) != 0) {
                snprintf(err, errsz, "invalid perm `%s`", pe->s);
                goto bad;
            }
            r->path = dbox_normpath(pa->s);
            p->nrules++;
            continue;
        }
        if (e->section[0] == '\0') {
            if (strcmp(e->key, "default") == 0) {
                if (e->type != TV_STR || parse_perm(e->s, &p->default_perm) != 0) {
                    snprintf(err, errsz, "invalid `default` value"); goto bad;
                }
                if (p->default_perm == PERM_ASK) {
                    snprintf(err, errsz, "`default` must be allow or deny"); goto bad;
                }
            } else if (strcmp(e->key, "version") == 0) {
                /* accepted, currently unused */
            } else if (strcmp(e->key, "system_read") == 0) {
                if (e->type != TV_BOOL) {
                    snprintf(err, errsz, "system_read must be boolean"); goto bad;
                }
                p->system_read = e->b;
            } else {
                snprintf(err, errsz, "unknown key `%s` at top level", e->key);
                goto bad;
            }
        } else if (strcmp(e->section, "ask") == 0) {
            if (strcmp(e->key, "endpoint") == 0) {
                dbox_free(p->ask_endpoint);
                p->ask_endpoint = dbox_strdup(e->s);
            } else if (strcmp(e->key, "timeout_ms") == 0) {
                p->ask_timeout_ms = (int)e->i;
            } else if (strcmp(e->key, "cache_ttl_seconds") == 0) {
                p->cache_ttl_s = (int)e->i;
            } else if (strcmp(e->key, "grant_ttl_seconds") == 0) {
                p->grant_ttl_s = (int)e->i;
            } else {
                snprintf(err, errsz, "unknown key `%s` in [ask]", e->key);
                goto bad;
            }
        } else if (strcmp(e->section, "network") == 0) {
            if (strcmp(e->key, "default") == 0) {
                if (dbox_str_ieq(e->s, "allow"))         p->net_mode = NET_ALLOW;
                else if (dbox_str_ieq(e->s, "deny"))     p->net_mode = NET_DENY;
                else if (dbox_str_ieq(e->s, "loopback")) p->net_mode = NET_LOOPBACK;
                else { snprintf(err, errsz, "invalid [network] default"); goto bad; }
            } else {
                snprintf(err, errsz, "unknown key `%s` in [network]", e->key);
                goto bad;
            }
        }
    }

    mini_toml_free(&doc);
    return 0;
bad:
    mini_toml_free(&doc);
    dbox_policy_free(p);
    return -1;
}

/* ------------------------------------------------------------------ */
/* evaluation                                                          */
/* ------------------------------------------------------------------ */

int dbox_system_allow(const char *path, int acc)
{
    /* Runtime/toolchain prefixes: read always, exec also allowed
     * (parity with Windows: sandboxed processes keep system runtime
     * read access; see README "known boundaries"). */
    static const char *const sys_read[] = {
        "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/opt",
        "/etc/ld.so.cache", "/etc/ld.so.preload", "/etc/nsswitch.conf",
        "/etc/localtime", "/etc/timezone", "/etc/hosts", "/etc/hostname",
        "/etc/resolv.conf", "/etc/gai.conf", "/etc/passwd", "/etc/group",
        "/etc/mime.types", "/etc/protocols", "/etc/services", "/etc/shells",
        "/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom",
        "/dev/tty",
        NULL
    };
    static const char *const sys_exec_prefix[] = {
        "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/opt", NULL
    };
    static const char *const tty_dev[] = {
        "/dev/tty", "/dev/console", "/dev/ptmx", "/dev/pts", NULL
    };
    /* terminal devices need read+write for interactive tools */
    for (int i = 0; tty_dev[i]; i++)
        if (dbox_path_under(path, tty_dev[i]))
            return (acc & (ACC_READ | ACC_WRITE)) ? 1 : 0;
    /* /dev/null accepts writes by design (redirects must not fail) */
    if (dbox_path_under(path, "/dev/null"))
        return (acc & (ACC_READ | ACC_WRITE)) ? 1 : 0;
    for (int i = 0; sys_read[i]; i++)
        if (dbox_path_under(path, sys_read[i])) {
            if (acc == ACC_READ) return 1;
            if (acc & ACC_EXEC)
                for (int k = 0; sys_exec_prefix[k]; k++)
                    if (dbox_path_under(path, sys_exec_prefix[k])) return 1;
            return 0;   /* under a read-prefix but requesting write */
        }
    return 0;
}

dperm_t dbox_policy_eval_static_ex(const dbox_policy_t *p, const char *vpath,
                                   int acc, int allow_system)
{
    for (int i = 0; i < p->nrules; i++) {
        const dbox_rule_t *r = &p->rules[i];
        if (!(r->acc & acc)) continue;
        if (dbox_glob_match(r->path, vpath)) return r->perm;
    }
    if (allow_system && p->system_read && dbox_system_allow(vpath, acc))
        return PERM_ALLOW;
    return p->default_perm;
}

dperm_t dbox_policy_eval_static(const dbox_policy_t *p, const char *vpath, int acc)
{
    return dbox_policy_eval_static_ex(p, vpath, acc, 1);
}

/* ------------------------------------------------------------------ */
/* shared region (launcher-created, whole tree shares decisions)       */
/* ------------------------------------------------------------------ */

#include <pthread.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>

static dbox_shm_t *g_shm;

dbox_shm_t *dbox_shared_region(void) { return g_shm; }

int dbox_shared_create(void)
{
    char name[64];
    snprintf(name, sizeof name, "/dynobox-%ld", (long)getpid());
    int fd = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0600);
    if (fd < 0) return -1;
    shm_unlink(name);   /* anonymous from here on; children hold the fd */
    if (ftruncate(fd, (off_t)sizeof(dbox_shm_t)) != 0) { close(fd); return -1; }
    dbox_shm_t *s = mmap(NULL, sizeof(dbox_shm_t), PROT_READ | PROT_WRITE,
                         MAP_SHARED, fd, 0);
    if (s == MAP_FAILED) { close(fd); return -1; }
    memset(s, 0, sizeof *s);
    s->magic = DBOX_SHM_MAGIC;
    pthread_mutexattr_t ma;
    pthread_mutexattr_init(&ma);
    pthread_mutexattr_setpshared(&ma, PTHREAD_PROCESS_SHARED);
    pthread_mutexattr_settype(&ma, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&s->mu, &ma);
    pthread_mutexattr_destroy(&ma);
    /* keep the mapping (harmless) so the region stays referenced */
    g_shm = s;
    return fd;
}

int dbox_shared_attach(int fd)
{
    if (fd < 0 || g_shm) return -1;
    dbox_shm_t *s = mmap(NULL, sizeof(dbox_shm_t), PROT_READ | PROT_WRITE,
                         MAP_SHARED, fd, 0);
    if (s == MAP_FAILED) return -1;
    if (s->magic != DBOX_SHM_MAGIC) { munmap(s, sizeof *s); return -1; }
    g_shm = s;
    return 0;
}

/* ------------------------------------------------------------------ */
/* grants                                                              */
/* ------------------------------------------------------------------ */

int dbox_grant_add(dbox_policy_t *p, const char *path_glob, int acc,
                   int64_t ttl_s, int64_t now_ms)
{
    if (!path_glob || !path_glob[0] || !(acc & ACC_ALL)) return -1;
    if (ttl_s <= 0) ttl_s = p->grant_ttl_s > 0 ? p->grant_ttl_s : 300;
    if (ttl_s > 3600) ttl_s = 3600;   /* hard cap, parity with Windows v2 */
    int64_t expires = now_ms + ttl_s * 1000;

    if (g_shm) {
        char norm[DBOX_SHM_PATH];
        {
            char *n = dbox_normpath(path_glob);
            snprintf(norm, sizeof norm, "%s", n);
            dbox_free(n);
        }
        pthread_mutex_lock(&g_shm->mu);
        if (g_shm->ngrants < DBOX_SHM_GRANTS) {
            dbox_shm_ent_t *e = &g_shm->grants[g_shm->ngrants++];
            snprintf(e->path, sizeof e->path, "%s", norm);
            e->acc = acc & ACC_ALL;
            e->expires_ms = expires;
        } else {
            /* overwrite the expired head (best effort under pressure) */
            int64_t now = now_ms;
            int victim = 0;
            for (int i = 0; i < DBOX_SHM_GRANTS; i++)
                if (g_shm->grants[i].expires_ms <= now) { victim = i; break; }
            dbox_shm_ent_t *e = &g_shm->grants[victim];
            snprintf(e->path, sizeof e->path, "%s", norm);
            e->acc = acc & ACC_ALL;
            e->expires_ms = expires;
        }
        pthread_mutex_unlock(&g_shm->mu);
        return 0;
    }

    if (p->ngrants == p->cap_grants) {
        p->cap_grants = p->cap_grants ? p->cap_grants * 2 : 8;
        p->grants = dbox_realloc(p->grants, sizeof(dbox_grant_t) * p->cap_grants);
    }
    dbox_grant_t *g = &p->grants[p->ngrants++];
    g->path = dbox_normpath(path_glob);
    g->acc = acc & ACC_ALL;
    g->expires_ms = expires;
    return 0;
}

void dbox_grant_purge_expired(dbox_policy_t *p, int64_t now_ms)
{
    if (g_shm) return;   /* shm entries are filtered at match time */
    int w = 0;
    for (int i = 0; i < p->ngrants; i++) {
        if (p->grants[i].expires_ms > now_ms) p->grants[w++] = p->grants[i];
        else dbox_free(p->grants[i].path);
    }
    p->ngrants = w;
}

int dbox_grant_match(const dbox_policy_t *p, const char *vpath, int acc, int64_t now_ms)
{
    if (g_shm) {
        int hit = 0;
        pthread_mutex_lock(&g_shm->mu);
        for (int i = 0; i < g_shm->ngrants; i++) {
            const dbox_shm_ent_t *g = &g_shm->grants[i];
            if (g->expires_ms <= now_ms) continue;
            if (!(g->acc & acc)) continue;
            if (dbox_glob_match(g->path, vpath)) { hit = 1; break; }
        }
        pthread_mutex_unlock(&g_shm->mu);
        return hit;
    }
    for (int i = 0; i < p->ngrants; i++) {
        const dbox_grant_t *g = &p->grants[i];
        if (g->expires_ms <= now_ms) continue;
        if (!(g->acc & acc)) continue;
        if (dbox_glob_match(g->path, vpath)) return 1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* ask decision cache (positive decisions only, fail-closed)           */
/* ------------------------------------------------------------------ */

typedef struct cache_ent {
    struct cache_ent *next;
    char *path;
    int   acc;
    int64_t expires_ms;
} cache_ent_t;

static cache_ent_t *cache_buckets[256];
static pthread_mutex_t cache_mu = PTHREAD_MUTEX_INITIALIZER;

static unsigned cache_hash(const char *s, int acc)
{
    unsigned h = 2166136261u ^ (unsigned)acc;
    while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; }
    return h & 255;
}

void dbox_cache_put(const char *vpath, int acc, int64_t expires_ms)
{
    if (g_shm) {
        pthread_mutex_lock(&g_shm->mu);
        /* round-robin slot (simple, no chain) */
        int slot = (int)(g_shm->cache_stamp % DBOX_SHM_CACHE);
        g_shm->cache_stamp++;
        dbox_shm_ent_t *e = &g_shm->cache[slot];
        snprintf(e->path, sizeof e->path, "%s", vpath);
        e->acc = acc;
        e->expires_ms = expires_ms;
        pthread_mutex_unlock(&g_shm->mu);
        return;
    }
    unsigned b = cache_hash(vpath, acc);
    pthread_mutex_lock(&cache_mu);
    for (cache_ent_t *e = cache_buckets[b]; e; e = e->next) {
        if (e->acc == acc && strcmp(e->path, vpath) == 0) {
            e->expires_ms = expires_ms;
            pthread_mutex_unlock(&cache_mu);
            return;
        }
    }
    cache_ent_t *e = dbox_malloc(sizeof(*e));
    e->path = dbox_strdup(vpath);
    e->acc = acc;
    e->expires_ms = expires_ms;
    e->next = cache_buckets[b];
    cache_buckets[b] = e;
    pthread_mutex_unlock(&cache_mu);
}

int dbox_cache_hit(const char *vpath, int acc, int64_t now_ms)
{
    if (g_shm) {
        int found = 0;
        pthread_mutex_lock(&g_shm->mu);
        for (int i = 0; i < DBOX_SHM_CACHE; i++) {
            const dbox_shm_ent_t *e = &g_shm->cache[i];
            if (e->expires_ms <= now_ms) continue;
            if (e->acc != acc) continue;
            if (strcmp(e->path, vpath) == 0) { found = 1; break; }
        }
        pthread_mutex_unlock(&g_shm->mu);
        return found;
    }
    unsigned b = cache_hash(vpath, acc);
    int found = 0;
    pthread_mutex_lock(&cache_mu);
    for (cache_ent_t *e = cache_buckets[b]; e; e = e->next) {
        if (e->acc == acc && strcmp(e->path, vpath) == 0) {
            if (e->expires_ms > now_ms) found = 1;
            break;
        }
    }
    pthread_mutex_unlock(&cache_mu);
    return found;
}

void dbox_cache_clear(void)
{
    if (g_shm) {
        pthread_mutex_lock(&g_shm->mu);
        memset(g_shm->cache, 0, sizeof g_shm->cache);
        g_shm->ngrants = 0;
        pthread_mutex_unlock(&g_shm->mu);
        return;
    }
    pthread_mutex_lock(&cache_mu);
    for (int i = 0; i < 256; i++) {
        cache_ent_t *e = cache_buckets[i];
        while (e) { cache_ent_t *n = e->next; dbox_free(e->path); dbox_free(e); e = n; }
        cache_buckets[i] = NULL;
    }
    pthread_mutex_unlock(&cache_mu);
}

dperm_t dbox_policy_check_ex(dbox_policy_t *p, const char *vpath, int acc,
                             dbox_ask_fn ask, int64_t now_ms, int allow_system)
{
    dperm_t r = dbox_policy_eval_static_ex(p, vpath, acc, allow_system);
    if (r != PERM_ASK) return r;

    dbox_grant_purge_expired(p, now_ms);
    if (dbox_grant_match(p, vpath, acc, now_ms)) return PERM_ALLOW;

    if (p->cache_ttl_s > 0 && dbox_cache_hit(vpath, acc, now_ms))
        return PERM_ALLOW;

    if (!p->ask_endpoint || !ask) return PERM_DENY;   /* fail-closed */

    char aerr[128];
    int rc = ask(p, vpath, acc, aerr, sizeof aerr);
    if (rc == 1) {
        if (p->cache_ttl_s > 0)
            dbox_cache_put(vpath, acc, now_ms + (int64_t)p->cache_ttl_s * 1000);
        return PERM_ALLOW;
    }
    return PERM_DENY;   /* deny / timeout / error — never cached */
}

dperm_t dbox_policy_check(dbox_policy_t *p, const char *vpath, int acc,
                          dbox_ask_fn ask, int64_t now_ms)
{
    return dbox_policy_check_ex(p, vpath, acc, ask, now_ms, 1);
}
