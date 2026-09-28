/* policy.h — policy engine (evaluation, grants, ask cache, TOML loading) */
#ifndef DYNOBOX_POLICY_H
#define DYNOBOX_POLICY_H

#include "dynobox.h"
#include <pthread.h>
#include <stddef.h>

/* Parse policy TOML text into p. Returns 0 or -1 with `err` filled. */
int  dbox_policy_load_toml(const char *text, dbox_policy_t *p,
                           char *err, size_t errsz);

/* Translate a comma-separated list of host directories into leading
 * write-deny rules (dir + 双星号递归后缀): the identity namespace has no mount
 * concept, so "read-only directories" are enforced as policy-level write
 * bans, mirroring --ro-dirs of the FUSE dynobox-linux. The rules are
 * PREPENDED before the user rules so they take precedence (parity with a
 * kernel read-only bind mount which cannot be overridden). Returns 0 on
 * success (including empty spec), -1 on allocation failure. */
int  dbox_policy_prepend_ro_dirs(dbox_policy_t *p, const char *spec);

/* Evaluation with optional built-in system allowlist. `allow_system = 0`
 * (rules + default only) is used for hardlink SOURCES: a system path made
 * readable for runtime needs must not be hardlinkable into a writable area
 * (that would exfiltrate its content). */
dperm_t dbox_policy_eval_static_ex(const dbox_policy_t *p, const char *vpath,
                                   int acc, int allow_system);
dperm_t dbox_policy_check_ex(dbox_policy_t *p, const char *vpath, int acc,
                             dbox_ask_fn ask, int64_t now_ms, int allow_system);

/* ------------------------------------------------------------------ *
 * Shared ask state (parity with the Windows manager: decisions and
 * endpoint grants live in the LAUNCHER process and are shared by the
 * whole sandbox tree through a POSIX shared-memory region).
 * ------------------------------------------------------------------ */

#define DBOX_SHM_MAGIC   0x44425853u      /* "DBXS" */
#define DBOX_SHM_GRANTS  64
#define DBOX_SHM_CACHE   512
#define DBOX_SHM_NEWFILES 128
#define DBOX_SHM_PATH    240

typedef struct {
    char    path[DBOX_SHM_PATH];
    int     acc;
    int64_t expires_ms;
} dbox_shm_ent_t;

typedef struct {
    uint32_t        magic;
    pthread_mutex_t mu;               /* PTHREAD_PROCESS_SHARED */
    int             ngrants;
    dbox_shm_ent_t  grants[DBOX_SHM_GRANTS];
    int64_t         cache_stamp;      /* round-robin overwrite counter */
    dbox_shm_ent_t  cache[DBOX_SHM_CACHE];
    int64_t         newfile_stamp;    /* round-robin overwrite counter */
    int             nnewfiles;
    dbox_shm_ent_t  newfiles[DBOX_SHM_NEWFILES]; /* 本次实例创建的文件（删除直接清除） */
} dbox_shm_t;

/* Launcher side: create + initialize the region, return the fd (the
 * name is unlinked immediately; children inherit the fd through fork). */
int  dbox_shared_create(void);
/* Sandbox side: map the inherited fd and install it as the global region. */
int  dbox_shared_attach(int fd);
/* Global region pointer (NULL = in-process fallback, used by unit tests). */
dbox_shm_t *dbox_shared_region(void);

/* Grants management (route through the shared region when attached,
 * otherwise operate on the per-process policy). */
int  dbox_grant_add(dbox_policy_t *p, const char *path_glob, int acc,
                    int64_t ttl_s, int64_t now_ms);
int  dbox_grant_match(const dbox_policy_t *p, const char *vpath, int acc,
                      int64_t now_ms);
void dbox_grant_purge_expired(dbox_policy_t *p, int64_t now_ms);

/* Ask decision cache: only positive decisions are cached (fail-closed).
 * acc = single category. */
void dbox_cache_put(const char *vpath, int acc, int64_t expires_ms);
int  dbox_cache_hit(const char *vpath, int acc, int64_t now_ms); /* 1 = cached allow */
void dbox_cache_clear(void);

/* Newly-created files of the CURRENT sandbox instance (shared across the
 * whole tree): deletion of such files must not go to the recycle bin
 * (temp-file semantics, parity with the Windows dynobox). */
void dbox_shm_newfile_add(const char *realpath); /* called on successful create */
int  dbox_shm_newfile_has(const char *realpath); /* 1 = created inside this run */

#endif
