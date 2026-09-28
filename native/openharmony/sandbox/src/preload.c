/* preload.c — dynobox-linux LD_PRELOAD interposition layer (libdynobox.so).
 *
 * Every exported libc entry point that takes a path or spawns a process is
 * interposed: the path is resolved into the sandbox's virtual namespace,
 * evaluated against the policy (allow / ask / deny, fail-closed), and only
 * then handed to the real libc call — translated to its real location when
 * the program used a virtual path.
 *
 * Kernel contact inside this file (fd paths, watchdog, ask transport) uses
 * raw syscalls so it can never recurse into these wrappers.
 *
 * This is a POLICY layer over cooperative libc use, not a kernel boundary —
 * see README "安全边界" for what it can and cannot guarantee.
 */
#define _GNU_SOURCE
#include "dynobox.h"
#include "policy.h"
#include "pathmap.h"
#include "ask.h"
#include "cfgio.h"
#include "util.h"
#include "log.h"

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <utime.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <linux/close_range.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
/* struct statx is only reachable through <linux/stat.h> on musl (glibc
 * re-exports it from <sys/stat.h>). */
#include <linux/stat.h>
#include <sys/statvfs.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <spawn.h>

#ifndef O_TMPFILE
#define O_TMPFILE 020200000
#endif

/* ------------------------------------------------------------------ */
/* libc ABI differences                                                */
/* ------------------------------------------------------------------ */

/* musl turns the LFS64 names into macros aliasing the base functions
 * (open64 -> open, stat64 -> stat, struct stat64 -> struct stat, ...), so
 * those entry points do not exist as separate symbols and cannot be
 * interposed — interposing the base functions covers them. glibc keeps
 * real (if sometimes hidden) *64 symbols, which are hooked below.
 * <fcntl.h>/<sys/stat.h>/<sys/mman.h> are already included above, so the
 * alias macros are visible here. */
#if defined(open64) || defined(stat64) || defined(mmap64)
#define DBOX_LFS64_ARE_MACROS 1
#endif

/* Entry points glibc exports but musl does not provide at all. */
#if defined(__GLIBC__)
#define DBOX_EXTRA_HOOKS 1
#endif

#define MAX_FD 65536
#define AT_FDCWD_C (-100)

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

static dbox_ctx_t g_ctx;
static int g_ready = 0;
/* Recursive: a signal handler can interrupt this thread while it holds one of
 * these locks and then reach an interposed entry point again — HarmonyOS's DFX
 * signal handler calls access("/proc/self/unexpected_die_catch") from the
 * handler frame — which self-deadlocks on a non-recursive mutex. Initialised
 * by dbox_init_once(); a zeroed pthread_mutex_t is a plain mutex, so the tiny
 * window before that degrades to the old behaviour rather than breaking. */
static pthread_mutex_t g_ctx_mu;   /* cwd */
static pthread_mutex_t g_pol_mu;   /* grants */
static pthread_mutex_t g_fd_mu;    /* fd table */

static int g_watch_fd = -1;
/* Set while real_posix_spawn() runs. musl implements posix_spawn with
 * CLONE_VM|CLONE_VFORK, so the child shares our address space and reaches the
 * exec hooks below while the parent is suspended — allocating, locking or
 * touching the fd tables there would corrupt the parent's heap. During the
 * window those hooks pass straight through (the env we built for the spawn
 * already carries LD_PRELOAD/DYNOBOX_CFG, so the child stays sandboxed). */
static __thread int g_in_spawn;
static int g_shm_fd = -1;
static char g_self_so[DBOX_PATH_MAX];
static char g_cfg_b64[65536];
static char g_tmp_dir[DBOX_PATH_MAX];   /* --tmp 映射目录（/tmp 重定向目标） */
static char g_trash_dir[DBOX_PATH_MAX]; /* --del-to-trash 回收站目录 */
static char g_inject_ldpreload[DBOX_PATH_MAX * 2];

typedef struct {
    char *real;   /* resolved real path at open time */
    char *vpath;
    int   acc;
} fd_ent_t;

static fd_ent_t *g_fds;
static size_t g_fds_cap;

/* ------------------------------------------------------------------ */
/* real libc symbols                                                   */
/* ------------------------------------------------------------------ */

#define REAL(ret, name, sig) static ret (*real_##name) sig;
/* LFS64 entry points are macro aliases of the base functions on musl, so
 * they cannot be declared or interposed there (DBOX_LFS64_ARE_MACROS). */
#ifdef DBOX_LFS64_ARE_MACROS
#define REAL64(ret, name, sig)
#else
#define REAL64(ret, name, sig) static ret (*real_##name) sig;
#endif
REAL(int, open, (const char *, int, ...))
REAL64(int, open64, (const char *, int, ...))
REAL(int, openat, (int, const char *, int, ...))
REAL64(int, openat64, (int, const char *, int, ...))
REAL(int, creat, (const char *, mode_t))
REAL64(int, creat64, (const char *, mode_t))
REAL(FILE *, fopen, (const char *, const char *))
REAL64(FILE *, fopen64, (const char *, const char *))
REAL(FILE *, freopen, (const char *, const char *, FILE *))
REAL64(FILE *, freopen64, (const char *, const char *, FILE *))
REAL(FILE *, tmpfile, (void))
REAL64(FILE *, tmpfile64, (void))
REAL(int, stat, (const char *, struct stat *))
REAL64(int, stat64, (const char *, struct stat64 *))
REAL(int, lstat, (const char *, struct stat *))
REAL64(int, lstat64, (const char *, struct stat64 *))
REAL(int, fstatat, (int, const char *, struct stat *, int))
REAL64(int, fstatat64, (int, const char *, struct stat64 *, int))
REAL(int, statx, (int, const char *, int, unsigned int, struct statx *))
REAL(int, access, (const char *, int))
REAL(int, faccessat, (int, const char *, int, int))
#ifdef DBOX_EXTRA_HOOKS
REAL(int, faccessat2, (int, const char *, int, int))
#endif
REAL(ssize_t, readlink, (const char *, char *, size_t))
REAL(ssize_t, readlinkat, (int, const char *, char *, size_t))
REAL(char *, realpath, (const char *, char *))
REAL(int, statfs, (const char *, struct statfs *))
REAL64(int, statfs64, (const char *, struct statfs64 *))
REAL(int, statvfs, (const char *, struct statvfs *))
REAL64(int, statvfs64, (const char *, struct statvfs64 *))
REAL(DIR *, opendir, (const char *))
REAL(int, scandir, (const char *, struct dirent ***, int (*)(const struct dirent *), int (*)(const struct dirent **, const struct dirent **)))
REAL64(int, scandir64, (const char *, struct dirent64 ***, int (*)(const struct dirent64 *), int (*)(const struct dirent64 **, const struct dirent64 **)))
#ifdef DBOX_EXTRA_HOOKS
REAL(int, scandirat, (int, const char *, struct dirent ***, int (*)(const struct dirent *), int (*)(const struct dirent **, const struct dirent **)))
#endif
REAL(int, ftw, (const char *, int (*)(const char *, const struct stat *, int), int))
REAL(int, nftw, (const char *, int (*)(const char *, const struct stat *, int, struct FTW *), int, int))
REAL64(int, ftw64, (const char *, int (*)(const char *, const struct stat64 *, int), int))
REAL64(int, nftw64, (const char *, int (*)(const char *, const struct stat64 *, int, struct FTW *), int, int))
REAL(int, unlink, (const char *))
REAL(int, unlinkat, (int, const char *, int))
REAL(int, rename, (const char *, const char *))
REAL(int, renameat, (int, const char *, int, const char *))
REAL(int, renameat2, (int, const char *, int, const char *, unsigned int))
REAL(int, mkdir, (const char *, mode_t))
REAL(int, mkdirat, (int, const char *, mode_t))
REAL(int, rmdir, (const char *))
REAL(int, chmod, (const char *, mode_t))
REAL(int, fchmodat, (int, const char *, mode_t, int))
REAL(int, chown, (const char *, uid_t, gid_t))
REAL(int, lchown, (const char *, uid_t, gid_t))
REAL(int, fchownat, (int, const char *, uid_t, gid_t, int))
REAL(int, truncate, (const char *, off_t))
REAL64(int, truncate64, (const char *, off64_t))
REAL(int, link, (const char *, const char *))
REAL(int, linkat, (int, const char *, int, const char *, int))
REAL(int, symlink, (const char *, const char *))
REAL(int, symlinkat, (const char *, int, const char *))
REAL(int, mknod, (const char *, mode_t, dev_t))
REAL(int, mknodat, (int, const char *, mode_t, dev_t))
REAL(int, mkfifo, (const char *, mode_t))
REAL(int, mkfifoat, (int, const char *, mode_t))
REAL(int, utime, (const char *, const struct utimbuf *))
REAL(int, utimes, (const char *, const struct timeval *))
REAL(int, lutimes, (const char *, const struct timeval *))
REAL(int, futimesat, (int, const char *, const struct timeval *))
REAL(int, utimensat, (int, const char *, const struct timespec *, int))
REAL(int, execve, (const char *, char *const *, char *const *))
#ifdef DBOX_EXTRA_HOOKS
REAL(int, execveat, (int, const char *, char *const *, char *const *, int))
#endif
REAL(int, fexecve, (int, char *const *, char *const *))
REAL(int, execv, (const char *, char *const *))
REAL(int, execvp, (const char *, char *const *))
REAL(int, execvpe, (const char *, char *const *, char *const *))
REAL(int, system, (const char *))
REAL(FILE *, popen, (const char *, const char *))
REAL(int, posix_spawn, (pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *, char *const *, char *const *))
REAL(int, posix_spawnp, (pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *, char *const *, char *const *))
REAL(int, chdir, (const char *))
REAL(int, fchdir, (int))
REAL(char *, getcwd, (char *, size_t))
REAL(void *, dlopen, (const char *, int))
#ifdef DBOX_EXTRA_HOOKS
REAL(void *, dlmopen, (Lmid_t, const char *, int))
#endif
REAL(void *, mmap, (void *, size_t, int, int, int, off_t))
REAL64(void *, mmap64, (void *, size_t, int, int, int, off64_t))
REAL(int, close, (int))
#ifdef DBOX_EXTRA_HOOKS
REAL(int, close_range, (unsigned int, unsigned int, int))
#endif
REAL(int, dup, (int))
REAL(int, dup2, (int, int))
REAL(int, dup3, (int, int, int))
REAL(int, fcntl, (int, int, ...))
REAL(int, socket, (int, int, int))
REAL(int, connect, (int, const struct sockaddr *, socklen_t))
REAL(int, bind, (int, const struct sockaddr *, socklen_t))
#undef REAL
#undef REAL64

static void resolve_all(void)
{
#define RESOLVE(name) real_##name = (__typeof__(real_##name))dlsym(RTLD_NEXT, #name)
#ifdef DBOX_LFS64_ARE_MACROS
#define RESOLVE64(name)
#else
#define RESOLVE64(name) real_##name = (__typeof__(real_##name))dlsym(RTLD_NEXT, #name)
#endif
    RESOLVE(open); RESOLVE64(open64); RESOLVE(openat); RESOLVE64(openat64);
    RESOLVE(creat); RESOLVE64(creat64);
    RESOLVE(fopen); RESOLVE64(fopen64); RESOLVE(freopen); RESOLVE64(freopen64);
    RESOLVE(tmpfile); RESOLVE64(tmpfile64);
    RESOLVE(stat); RESOLVE64(stat64); RESOLVE(lstat); RESOLVE64(lstat64);
    RESOLVE(fstatat); RESOLVE64(fstatat64); RESOLVE(statx);
    RESOLVE(access); RESOLVE(faccessat);
#ifdef DBOX_EXTRA_HOOKS
    RESOLVE(faccessat2);
#endif
    RESOLVE(readlink); RESOLVE(readlinkat); RESOLVE(realpath);
    RESOLVE(statfs); RESOLVE64(statfs64); RESOLVE(statvfs); RESOLVE64(statvfs64);
    RESOLVE(opendir);
    RESOLVE(scandir); RESOLVE64(scandir64);
#ifdef DBOX_EXTRA_HOOKS
    RESOLVE(scandirat);
#endif
    RESOLVE(ftw); RESOLVE(nftw); RESOLVE64(ftw64); RESOLVE64(nftw64);
    RESOLVE(unlink); RESOLVE(unlinkat);
    RESOLVE(rename); RESOLVE(renameat); RESOLVE(renameat2);
    RESOLVE(mkdir); RESOLVE(mkdirat); RESOLVE(rmdir);
    RESOLVE(chmod); RESOLVE(fchmodat);
    RESOLVE(chown); RESOLVE(lchown); RESOLVE(fchownat);
    RESOLVE(truncate); RESOLVE64(truncate64);
    RESOLVE(link); RESOLVE(linkat); RESOLVE(symlink); RESOLVE(symlinkat);
    RESOLVE(mknod); RESOLVE(mknodat); RESOLVE(mkfifo); RESOLVE(mkfifoat);
    RESOLVE(utime); RESOLVE(utimes); RESOLVE(lutimes); RESOLVE(futimesat);
    RESOLVE(utimensat);
    RESOLVE(execve);
#ifdef DBOX_EXTRA_HOOKS
    RESOLVE(execveat);
#endif
    RESOLVE(fexecve);
    RESOLVE(execv); RESOLVE(execvp); RESOLVE(execvpe);
    RESOLVE(system); RESOLVE(popen);
    RESOLVE(posix_spawn); RESOLVE(posix_spawnp);
    RESOLVE(chdir); RESOLVE(fchdir); RESOLVE(getcwd);
    RESOLVE(dlopen);
#ifdef DBOX_EXTRA_HOOKS
    RESOLVE(dlmopen);
#endif
    RESOLVE(mmap); RESOLVE64(mmap64);
    RESOLVE(close);
#ifdef DBOX_EXTRA_HOOKS
    RESOLVE(close_range);
#endif
    RESOLVE(dup); RESOLVE(dup2); RESOLVE(dup3); RESOLVE(fcntl);
    RESOLVE(socket); RESOLVE(connect); RESOLVE(bind);
#undef RESOLVE

    /* glibc >= 2.34 hides some *64 compat symbols from dlsym; on x86_64 the
     * large-file variants share the ABI of their base functions, so fall
     * back to those pointers (struct stat/statfs/... layouts are identical
     * on 64-bit) */
#define FALLBACK(name, base) if (!real_##name) real_##name = (__typeof__(real_##name))real_##base
#ifdef DBOX_LFS64_ARE_MACROS
#define FALLBACK64(name, base)
#else
#define FALLBACK64(name, base) FALLBACK(name, base)
#endif
    FALLBACK64(open64, open);
    FALLBACK64(openat64, openat);
    FALLBACK64(creat64, creat);
    FALLBACK64(fopen64, fopen);
    FALLBACK64(freopen64, freopen);
    FALLBACK64(tmpfile64, tmpfile);
    FALLBACK64(stat64, stat);
    FALLBACK64(lstat64, lstat);
    FALLBACK64(fstatat64, fstatat);
    FALLBACK64(statfs64, statfs);
    FALLBACK64(statvfs64, statvfs);
    FALLBACK64(scandir64, scandir);
    FALLBACK64(ftw64, ftw);
    FALLBACK64(nftw64, nftw);
    FALLBACK64(truncate64, truncate);
    FALLBACK64(mmap64, mmap);
#undef FALLBACK
#undef FALLBACK64
}

/* ------------------------------------------------------------------ */
/* fd table                                                            */
/* ------------------------------------------------------------------ */

static void fd_record(int fd, const char *real, const char *vpath, int acc)
{
    if (fd < 0 || (size_t)fd >= MAX_FD) return;
    pthread_mutex_lock(&g_fd_mu);
    if ((size_t)fd >= g_fds_cap) {
        size_t ncap = g_fds_cap ? g_fds_cap : 1024;
        while (ncap <= (size_t)fd) ncap *= 2;
        g_fds = dbox_realloc(g_fds, sizeof(fd_ent_t) * ncap);
        memset(g_fds + g_fds_cap, 0, sizeof(fd_ent_t) * (ncap - g_fds_cap));
        g_fds_cap = ncap;
    }
    dbox_free(g_fds[fd].real);
    dbox_free(g_fds[fd].vpath);
    g_fds[fd].real = real ? dbox_strdup(real) : NULL;
    g_fds[fd].vpath = vpath ? dbox_strdup(vpath) : NULL;
    g_fds[fd].acc = acc;
    pthread_mutex_unlock(&g_fd_mu);
}

static void fd_clear(int fd)
{
    if (fd < 0 || !g_fds || (size_t)fd >= g_fds_cap) return;
    pthread_mutex_lock(&g_fd_mu);
    dbox_free(g_fds[fd].real);
    dbox_free(g_fds[fd].vpath);
    g_fds[fd].real = NULL;
    g_fds[fd].vpath = NULL;
    g_fds[fd].acc = 0;
    pthread_mutex_unlock(&g_fd_mu);
}

static void fd_copy(int from, int to)
{
    if (from < 0 || to < 0 || !g_fds || (size_t)from >= g_fds_cap) return;
    pthread_mutex_lock(&g_fd_mu);
    if ((size_t)to >= g_fds_cap) {
        size_t ncap = g_fds_cap;
        while (ncap <= (size_t)to) ncap *= 2;
        g_fds = dbox_realloc(g_fds, sizeof(fd_ent_t) * ncap);
        memset(g_fds + g_fds_cap, 0, sizeof(fd_ent_t) * (ncap - g_fds_cap));
        g_fds_cap = ncap;
    }
    dbox_free(g_fds[to].real);
    dbox_free(g_fds[to].vpath);
    g_fds[to].real = g_fds[from].real ? dbox_strdup(g_fds[from].real) : NULL;
    g_fds[to].vpath = g_fds[from].vpath ? dbox_strdup(g_fds[from].vpath) : NULL;
    g_fds[to].acc = g_fds[from].acc;
    pthread_mutex_unlock(&g_fd_mu);
}

/* malloc'd real path for fd (or NULL when unknown) */
static char *fd_path(int fd)
{
    if (fd == AT_FDCWD_C) {
        pthread_mutex_lock(&g_ctx_mu);
        char *r = dbox_strdup(g_ctx.rpwd);
        pthread_mutex_unlock(&g_ctx_mu);
        return r;
    }
    pthread_mutex_lock(&g_fd_mu);
    char *r = (g_fds && (size_t)fd < g_fds_cap && g_fds[fd].real)
        ? dbox_strdup(g_fds[fd].real) : NULL;
    pthread_mutex_unlock(&g_fd_mu);
    if (r) return r;
    char lp[64];
    snprintf(lp, sizeof lp, "/proc/self/fd/%d", fd);
    char buf[DBOX_PATH_MAX];
    ssize_t n = syscall(SYS_readlinkat, AT_FDCWD_C, lp, buf, sizeof buf - 1);
    if (n > 0) { buf[n] = '\0'; return dbox_strdup(buf); }
    return NULL;
}

/* ------------------------------------------------------------------ */
/* lazy initialization                                                 */
/* ------------------------------------------------------------------ */

static pthread_once_t g_once = PTHREAD_ONCE_INIT;
static volatile int g_once_started = 0;
static void dbox_preload_ctor_body(void);

static pthread_mutexattr_t g_mu_attr;

/* Must run before any hook takes a lock (see the mutex declarations). */
static void init_mutexes(void)
{
    pthread_mutexattr_init(&g_mu_attr);
    pthread_mutexattr_settype(&g_mu_attr, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&g_ctx_mu, &g_mu_attr);
    pthread_mutex_init(&g_pol_mu, &g_mu_attr);
    pthread_mutex_init(&g_fd_mu, &g_mu_attr);
}

static void dbox_init_once(void)
{
    g_once_started = 1;
    init_mutexes();
    dbox_preload_ctor_body();
}

/* Lazy init: other libraries' constructors (e.g. libselinux) may call
 * interposed symbols BEFORE our own constructor runs, so every hook goes
 * through here first. */
static inline void ensure_ready(void)
{
    if (__builtin_expect(!g_once_started, 0))
        pthread_once(&g_once, dbox_init_once);
}

/* ------------------------------------------------------------------ */
/* gating                                                              */
/* ------------------------------------------------------------------ */

typedef struct {
    char *vpath;   /* path the policy sees (== real path, identity namespace) */
    char *real;    /* resolved real path (fd attribution) */
    int   partial;
    int   tmp_area;   /* 1 = --tmp 映射区：总是可读可写，跳过策略 */
} gate_t;

static int gate_resolve(const char *input, int nofollow_last, gate_t *g)
{
    memset(g, 0, sizeof *g);
    if (!input || !input[0]) return -1;  /* nothing to attribute */
    const char *src = input;
    char mapped[DBOX_PATH_MAX];
    if (g_tmp_dir[0]) {
        /* /tmp 前缀重定向到 g_tmp_dir（应用视角不变，落点可写） */
        if (strcmp(input, "/tmp") == 0) {
            src = g_tmp_dir;
            g->tmp_area = 1;
        } else if (strncmp(input, "/tmp/", 5) == 0) {
            snprintf(mapped, sizeof mapped, "%s%s", g_tmp_dir, input + 4);
            src = mapped;
            g->tmp_area = 1;
        }
    }
    int flags = nofollow_last ? DBOX_NOFOLLOW_LAST : DBOX_FOLLOW_ALL;
    return dbox_plan_path(&g_ctx, src, flags, &g->vpath,
                          &g->real, &g->partial);
}

static int ask_gate(const dbox_policy_t *p, const char *vpath, int acc,
                    char *err, size_t errsz)
{
    return dbox_ask(p, vpath, acc, err, errsz);
}

/* 回收站保护：回收站内的**任何写操作**一律拒绝（只读保护）——包括
 * unlink/rmdir/rename/truncate，以及 open 写模式（O_WRONLY/O_RDWR/O_TRUNC，
 * 覆盖 open+ftruncate 类实现的"清空"路径）；读不受影响。 */
static int check_one(gate_t *g, int acc, const char *what, int allow_system)
{
    if (g->tmp_area) return 1;   /* tmp 映射区总是可读可写，无需策略规则 */
    if (g_trash_dir[0] && (acc & ACC_WRITE) &&
        dbox_path_under(g->vpath, g_trash_dir)) {
        dbox_logf("DENY  %-7s %s (trash-protected)", dbox_access_name(acc & ACC_ALL),
                  g->vpath);
        errno = EACCES;
        return 0;
    }
    pthread_mutex_lock(&g_pol_mu);
    dperm_t perm = dbox_policy_check_ex(&g_ctx.pol, g->vpath, acc, ask_gate,
                                        dbox_now_ms(), allow_system);
    pthread_mutex_unlock(&g_pol_mu);
    if (perm == PERM_ALLOW) {
        if (dbox_verbose_enabled)
            dbox_logf("allow %-7s %s", dbox_access_name(acc & ACC_ALL), g->vpath);
        return 1;
    }
    dbox_logf("DENY  %-7s %s (%s)", dbox_access_name(acc & ACC_ALL),
              g->vpath, what);
    errno = EACCES;
    return 0;
}

/* Evaluate each requested access category independently (Windows parity:
 * an open for read+write must pass read AND write rules); all must allow. */
static int gate_check(gate_t *g, int acc, const char *what, int allow_system)
{
    if (!g_ready) return 1;
    static const int cats[3] = { ACC_READ, ACC_WRITE, ACC_EXEC };
    for (int i = 0; i < 3; i++)
        if (acc & cats[i]) {
            if (!check_one(g, cats[i], what, allow_system)) return 0;
        }
    if (!(acc & ACC_ALL)) {   /* unknown bits: fail-closed */
        dbox_logf("DENY  ?%d %s (%s)", acc, g->vpath, what);
        errno = EACCES;
        return 0;
    }
    return 1;
}

static void gate_free(gate_t *g)
{
    dbox_free(g->vpath);
    dbox_free(g->real);
    memset(g, 0, sizeof *g);
}

/* gate one path; on allow returns 1 and `realp` receives the resolved real
 * path (used for fd attribution). The program's own path is always handed
 * to the kernel (identity namespace, no translation). */
static int gate1x(const char *input, int nofollow_last, int acc,
                  const char *what, int allow_system, char **realp)
{
    ensure_ready();
    *realp = NULL;
    /* A NULL or empty path cannot be attributed (open(""), access(NULL),
     * AT_EMPTY_PATH-style calls): hand it to the kernel, which produces the
     * authoritative error. Returning a gate with an empty vpath would feed a
     * NULL path into the policy matcher and fault inside the sandbox itself. */
    if (!g_ready || !input || !input[0]) return 1;
    gate_t g;
    if (gate_resolve(input, nofollow_last, &g) != 0) { errno = EACCES; return 0; }
    if (!gate_check(&g, acc, what, allow_system)) { gate_free(&g); return 0; }
    *realp = g.real;
    g.real = NULL;
    gate_free(&g);
    return 1;
}

static int gate1(const char *input, int nofollow_last, int acc,
                 const char *what, char **realp)
{
    return gate1x(input, nofollow_last, acc, what, 1, realp);
}

/* --tmp 映射激活时，实际执行目标改为 gate 解析后的映射路径（/tmp -> 映射目录）；
 * 非映射场景原样返回，行为与之前完全一致（零回归）。 */
static inline const char *xpath(const char *path, const char *real)
{
    if (g_tmp_dir[0] && real && real[0]) return real;
    return path;
}
/* 前缀替换（无 gate real 的场景，如 execve）：/tmp -> g_tmp_dir */
static inline const char *xtmp_prefix(const char *path, char *buf, size_t bufsz)
{
    if (!g_tmp_dir[0] || !path || path[0] != '/') return path;
    if (strcmp(path, "/tmp") == 0) return g_tmp_dir;
    if (strncmp(path, "/tmp/", 5) == 0) {
        snprintf(buf, bufsz, "%s%s", g_tmp_dir, path + 4);
        return buf;
    }
    return path;
}
/* at 变体：tmp 映射激活时改用绝对映射路径 + AT_FDCWD，否则保持 (dirfd, path)。 */
#define XPAT_EXEC(fn, dirfd, path, real, ...) \
    ((g_tmp_dir[0] && (real) && (real)[0]) \
         ? (fn)(AT_FDCWD, (real), __VA_ARGS__) \
         : (fn)((dirfd), (path), __VA_ARGS__))

/* *at() helper: absolute input string from dirfd+path (malloc'd) */
static char *at_abs(int dirfd, const char *path)
{
    if (!path) return NULL;
    if (path[0] == '/') return dbox_strdup(path);
    char *base = fd_path(dirfd);
    if (!base) return NULL;
    if (!path[0]) return base;
    char *j = dbox_path_join(base, path);
    dbox_free(base);
    return j;
}

static int acc_from_open_flags(int flags)
{
    int w = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND | O_TMPFILE;
    if (flags & w) return ACC_WRITE | ACC_READ;
    return ACC_READ;
}

static int mode_to_acc(int mode)
{
    if (mode & X_OK) return ACC_EXEC;
    if (mode & W_OK) return ACC_WRITE;
    return ACC_READ;   /* R_OK / F_OK */
}

/* ------------------------------------------------------------------ */
/* exec / env helpers                                                  */
/* ------------------------------------------------------------------ */

static const char *const k_inject_names[] = {
    "LD_PRELOAD", "DYNOBOX_CFG", "DYNOBOX_PRELOAD", "DYNOBOX_WATCH_FD",
    "DYNOBOX_SHM_FD", "DYNOBOX_LOG", "DYNOBOX_VERBOSE", "DYNOBOX_TMP",
    "DYNOBOX_TRASH", NULL
};

static char **build_envp(char *const *envp, size_t *first_new)
{
    size_t n = 0;
    if (envp) while (envp[n]) n++;
    char **out = dbox_malloc(sizeof(char *) * (n + 16));
    size_t w = 0;
    for (size_t i = 0; i < n; i++) {
        const char *e = envp[i];
        int skip = 0;
        for (int k = 0; k_inject_names[k]; k++) {
            size_t l = strlen(k_inject_names[k]);
            if (strncmp(e, k_inject_names[k], l) == 0 && e[l] == '=') { skip = 1; break; }
        }
        if (!skip) out[w++] = (char *)e;
    }
    size_t base = w;   /* index of the first entry this function owns */
    char buf[65536 + DBOX_PATH_MAX * 2 + 64];
    snprintf(buf, sizeof buf, "LD_PRELOAD=%s", g_inject_ldpreload);
    out[w++] = dbox_strdup(buf);
    snprintf(buf, sizeof buf, "DYNOBOX_CFG=%s", g_cfg_b64);
    out[w++] = dbox_strdup(buf);
    snprintf(buf, sizeof buf, "DYNOBOX_PRELOAD=%s", g_self_so);
    out[w++] = dbox_strdup(buf);
    if (g_watch_fd >= 0) {
        snprintf(buf, sizeof buf, "DYNOBOX_WATCH_FD=%d", g_watch_fd);
        out[w++] = dbox_strdup(buf);
    }
    if (g_shm_fd >= 0) {
        snprintf(buf, sizeof buf, "DYNOBOX_SHM_FD=%d", g_shm_fd);
        out[w++] = dbox_strdup(buf);
    }
    if (dbox_log_path()) {
        snprintf(buf, sizeof buf, "DYNOBOX_LOG=%s", dbox_log_path());
        out[w++] = dbox_strdup(buf);
    }
    if (dbox_verbose_enabled) out[w++] = dbox_strdup("DYNOBOX_VERBOSE=1");
    if (g_tmp_dir[0]) {
        snprintf(buf, sizeof buf, "DYNOBOX_TMP=%s", g_tmp_dir);
        out[w++] = dbox_strdup(buf);
    }
    if (g_trash_dir[0]) {
        snprintf(buf, sizeof buf, "DYNOBOX_TRASH=%s", g_trash_dir);
        out[w++] = dbox_strdup(buf);
    }
    out[w] = NULL;
    *first_new = base;
    return out;
}

/* Only the entries build_envp() created are ours to free. Matching on the
 * "DYNOBOX_" prefix instead also frees DYNOBOX_SANDBOX, which arrives from the
 * launcher through environ and is not heap-allocated: freeing it corrupts the
 * heap and surfaces later as SIGTRAP/SIGSEGV (seen inside posix_spawn).
 * `first_new` is the index build_envp() reported. */
static void free_envp(char **env, size_t first_new)
{
    if (!env) return;
    for (size_t i = first_new; env[i]; i++) dbox_free(env[i]);
    dbox_free(env);
}

/* Extract the interpreter from a script's shebang line (raw syscalls, so
 * this never re-enters the interposed wrappers). `real_path` must be a
 * real-space path. Returns 1 and fills `out` when the file starts with
 * "#!"; relative interpreters are resolved against the script's directory
 * (Linux >= 5.3 semantics). */
static int shebang_interpreter(const char *real_path, char *out, size_t outsz)
{
    int fd = (int)syscall(SYS_openat, AT_FDCWD_C, real_path, O_RDONLY, 0);
    if (fd < 0) return 0;
    char buf[320];
    ssize_t n = syscall(SYS_read, fd, buf, (size_t)(sizeof buf - 1));
    syscall(SYS_close, fd);
    if (n < 4 || buf[0] != '#' || buf[1] != '!') return 0;
    /* first line, without the leading "#!" */
    char *line = buf + 2;
    ssize_t len = n - 2;
    for (ssize_t i = 0; i < len; i++)
        if (line[i] == '\n') { len = i; break; }
    while (len > 0 && (line[len-1] == ' ' || line[len-1] == '\t' ||
                       line[len-1] == '\r'))
        len--;
    char *s = line;
    size_t rem = (size_t)len;
    while (rem > 0 && (*s == ' ' || *s == '\t')) { s++; rem--; }
    size_t ilen = 0;
    while (ilen < rem && s[ilen] != ' ' && s[ilen] != '\t') ilen++;
    if (ilen == 0 || ilen >= outsz) return 0;
    if (s[0] == '/') {
        memcpy(out, s, ilen);
        out[ilen] = '\0';
    } else {
        /* relative interpreter: kernel resolves it against the script dir */
        const char *slash = strrchr(real_path, '/');
        size_t dl = slash ? (size_t)(slash - real_path) : 0;
        if (dl + 1 + ilen >= outsz) return 0;
        memcpy(out, real_path, dl);
        out[dl] = '/';
        memcpy(out + dl + 1, s, ilen);
        out[dl + 1 + ilen] = '\0';
    }
    return 1;
}

/* gate exec of `input` (execute rule + setuid/setgid + shebang interpreter).
 * Returns 0 = allowed, -1 = denied (errno set). */
static int gate_exec_d(const char *input, int depth)
{
    if (!g_ready) return 0;
    char *real = NULL;
    if (!gate1(input, 0, ACC_EXEC, "exec", &real)) return -1;
    /* refuse setuid/setgid binaries: the loader drops LD_PRELOAD for them,
     * which would silently defeat the sandbox */
    struct stat st;
    const char *rp = real ? real : input;
    if (syscall(SYS_newfstatat, AT_FDCWD_C, rp, &st, 0) == 0 &&
        (st.st_mode & (S_ISUID | S_ISGID))) {
        dbox_logf("DENY exec (setuid/setgid): %s", input);
        dbox_free(real);
        errno = EACCES;
        return -1;
    }
    /* The kernel loads a script's shebang interpreter WITHOUT consulting
     * this layer, so an allowed script could smuggle in a denied
     * interpreter. Parse "#!" and gate the interpreter as execute too. */
    if (depth < 5 && rp) {
        char interp[DBOX_PATH_MAX];
        if (shebang_interpreter(rp, interp, sizeof interp)) {
            dbox_logf("exec shebang interpreter: %s", interp);
            if (gate_exec_d(interp, depth + 1) != 0) {
                dbox_logf("DENY exec (shebang interpreter denied): %s", interp);
                dbox_free(real);
                errno = EACCES;
                return -1;
            }
        }
    }
    dbox_free(real);
    return 0;
}

static int gate_exec(const char *input)
{
    return gate_exec_d(input, 0);
}

/* PATH search mirroring execvp/execvpe so every candidate is gated */
static char *find_in_path(const char *name, char *const *envp)
{
    const char *pathv = NULL;
    for (char *const *e = envp; e && *e; e++)
        if (strncmp(*e, "PATH=", 5) == 0) { pathv = *e + 5; break; }
    if (!pathv) pathv = "/usr/bin:/bin";
    if (strchr(name, '/')) return dbox_strdup(name);
    char pbuf[DBOX_PATH_MAX];
    snprintf(pbuf, sizeof pbuf, "%s", pathv);
    char *save = NULL;
    for (char *dir = strtok_r(pbuf, ":", &save); dir; dir = strtok_r(NULL, ":", &save)) {
        char cand[DBOX_PATH_MAX];
        if (dir[0]) snprintf(cand, sizeof cand, "%s/%s", dir, name);
        else snprintf(cand, sizeof cand, "%s", name);
        if (gate_exec(cand) != 0) { errno = EACCES; continue; }
        /* verify the candidate really exists before committing to it, so
         * the kernel-level ENOENT fallback of execvp keeps working */
        struct stat st;
        if (syscall(SYS_newfstatat, AT_FDCWD_C, cand, &st, 0) != 0) continue;
        return dbox_strdup(cand);   /* allowed */
    }
    errno = EACCES;
    return NULL;
}

/* ------------------------------------------------------------------ */
/* watchdog: launcher died => kill this subtree (fail-safe)            */
/* ------------------------------------------------------------------ */

static void *watch_thread(void *arg)
{
    (void)arg;
    /* Poll in short ticks: closing the watched fd does NOT wake a blocked
     * poll(), so a daemon-style close() must be detected by re-checking
     * fd validity between ticks (fail-closed either way). */
    for (;;) {
        struct pollfd p = { .fd = g_watch_fd, .events = POLLIN | POLLHUP };
        int r = dbox_raw_poll(&p, 1, 250);
        if (r > 0) {
            char c;
            ssize_t n = syscall(SYS_read, g_watch_fd, &c, 1);
            if (n == 0) break;                       /* EOF: launcher gone */
            if (n > 0) continue;                     /* spurious byte */
            if (errno != EINTR && errno != EAGAIN) break;
        } else if (r == 0) {
            if (syscall(SYS_fcntl, g_watch_fd, F_GETFD) == -1 && errno == EBADF)
                break;                               /* fd closed by process */
        } else if (errno != EINTR) {
            break;
        }
    }
    dbox_logf("launcher gone: killing sandboxed process tree");
    long pg = syscall(SYS_getpgid, 0L);
    if (pg > 0) syscall(SYS_kill, -pg, SIGKILL);
    syscall(SYS_exit_group, 129);
    return NULL;
}

static void start_watch(void)
{
    /* Verify the watch fd before arming the watchdog. A re-exec through
     * posix_spawn with close-on-exec file actions (node's execFileSync, for
     * instance) closes it; watch_thread would then read the resulting EBADF
     * as "launcher gone" and kill the whole tree. Without a usable channel
     * there is nothing to watch — the launcher's process-group kill still
     * applies, so the fail-safe degrades rather than firing spuriously. */
    if (g_watch_fd < 0) return;
    if (syscall(SYS_fcntl, g_watch_fd, F_GETFD) == -1) return;
    pthread_t t;
    pthread_attr_t a;
    pthread_attr_init(&a);
    pthread_attr_setdetachstate(&a, PTHREAD_CREATE_DETACHED);
    pthread_attr_setstacksize(&a, 256 * 1024);
    if (pthread_create(&t, &a, watch_thread, NULL) != 0) {
        /* watchdog unavailable: the launcher's group kill still applies */
    }
    pthread_attr_destroy(&a);
}

static void atfork_prepare(void)
{
    pthread_mutex_lock(&g_ctx_mu);
    pthread_mutex_lock(&g_pol_mu);
    pthread_mutex_lock(&g_fd_mu);
}
static void atfork_parent(void)
{
    pthread_mutex_unlock(&g_fd_mu);
    pthread_mutex_unlock(&g_pol_mu);
    pthread_mutex_unlock(&g_ctx_mu);
}
static void atfork_child(void)
{
    /* The child inherits the locks' owner (the parent's TID) but none of its
     * threads, so a recursive mutex would look "held by another thread" and
     * block forever. Only this thread survives the fork, so start clean.
     * Deliberately no start_watch() here: only async-signal-safe work is
     * permitted between fork() and exec(), and creating a thread there breaks
     * subprocess-style forks. exec() restores the watchdog by re-running our
     * constructor in the new image. */
    pthread_mutex_init(&g_fd_mu, &g_mu_attr);
    pthread_mutex_init(&g_pol_mu, &g_mu_attr);
    pthread_mutex_init(&g_ctx_mu, &g_mu_attr);
}

/* ------------------------------------------------------------------ */
/* constructor                                                         */
/* ------------------------------------------------------------------ */

static void init_from_env(void)
{
    const char *cfg = getenv("DYNOBOX_CFG");
    if (!cfg || !cfg[0]) return;   /* not sandboxed: full passthrough */
    snprintf(g_cfg_b64, sizeof g_cfg_b64, "%s", cfg);
    dbox_policy_init(&g_ctx.pol);
    if (dbox_cfg_decode(g_cfg_b64, &g_ctx.pol) != 0) {
        fprintf(stderr, "dynobox: invalid DYNOBOX_CFG; sandbox not enabled\n");
        return;
    }
    if (syscall(SYS_getcwd, g_ctx.rpwd, sizeof g_ctx.rpwd) <= 0)
        strcpy(g_ctx.rpwd, "/");
    const char *wf = getenv("DYNOBOX_WATCH_FD");
    if (wf && wf[0]) {
        g_watch_fd = atoi(wf);
        if (g_watch_fd >= 0) start_watch();
    }
    const char *shmenv = getenv("DYNOBOX_SHM_FD");
    if (shmenv && shmenv[0]) {
        g_shm_fd = atoi(shmenv);
        dbox_shared_attach(g_shm_fd);
    }
    const char *lg = getenv("DYNOBOX_LOG");
    if (lg && lg[0]) dbox_log_open(lg);
    if (getenv("DYNOBOX_VERBOSE")) dbox_verbose_enabled = 1;
    const char *tmpenv = getenv("DYNOBOX_TMP");
    if (tmpenv && tmpenv[0]) {
        char *n = dbox_normpath(tmpenv);
        if (n && n[0] == '/')
            snprintf(g_tmp_dir, sizeof g_tmp_dir, "%s", n);
        dbox_free(n);
    }
    const char *trash = getenv("DYNOBOX_TRASH");
    if (trash && trash[0]) {
        char *n = dbox_normpath(trash);
        if (n && n[0] == '/')
            snprintf(g_trash_dir, sizeof g_trash_dir, "%s", n);
        dbox_free(n);
    }

    g_ready = 1;
    dbox_logf("sandbox active (pid %ld, cwd %s, %d rules)",
              (long)getpid(), g_ctx.rpwd, g_ctx.pol.nrules);
}

__attribute__((constructor(150)))
static void dbox_preload_ctor(void)
{
    ensure_ready();
}

static void dbox_preload_ctor_body(void)
{
    Dl_info info;
    if (dladdr((void *)&dbox_preload_ctor_body, &info) && info.dli_fname) {
        if (info.dli_fname[0] == '/') {
            snprintf(g_self_so, sizeof g_self_so, "%s", info.dli_fname);
        } else {
            char cwd[DBOX_PATH_MAX];
            if (syscall(SYS_getcwd, cwd, sizeof cwd) > 0) {
                char *j = dbox_path_join(cwd, info.dli_fname);
                snprintf(g_self_so, sizeof g_self_so, "%s", j);
                dbox_free(j);
            } else {
                snprintf(g_self_so, sizeof g_self_so, "%s", info.dli_fname);
            }
        }
    }
    const char *ld = getenv("LD_PRELOAD");
    if (ld && ld[0] && g_self_so[0]) {
        if (strstr(ld, g_self_so))
            snprintf(g_inject_ldpreload, sizeof g_inject_ldpreload, "%s", ld);
        else
            snprintf(g_inject_ldpreload, sizeof g_inject_ldpreload, "%s %s",
                     ld, g_self_so);
    } else {
        snprintf(g_inject_ldpreload, sizeof g_inject_ldpreload, "%s", g_self_so);
    }
    resolve_all();
    pthread_atfork(atfork_prepare, atfork_parent, atfork_child);
    init_from_env();
}

/* ------------------------------------------------------------------ */
/* open family                                                         */
/* ------------------------------------------------------------------ */

int open(const char *path, int flags, ...)
{
    char *real = NULL;
    int acc = acc_from_open_flags(flags);
    int nofollow = (flags & O_NOFOLLOW) ? 1 : 0;
    if (!gate1(path, nofollow, acc, "open", &real)) return -1;
    const char *p = xpath(path, real);
    int fd;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = (mode_t)va_arg(ap, int);
        va_end(ap);
        fd = real_open(p, flags, mode);
    } else {
        fd = real_open(p, flags);
    }
    int e = errno;
    if (fd >= 0) {
        fd_record(fd, real ? real : p, NULL, acc);
        /* 本次沙箱实例新建的文件：删除时直接清除，不进回收站（临时文件语义） */
        if (flags & O_CREAT) dbox_shm_newfile_add(real ? real : p);
    }

    dbox_free(real);
    errno = e;
    return fd;
}

#ifndef DBOX_LFS64_ARE_MACROS
int open64(const char *path, int flags, ...)
{
    char *real = NULL;
    int acc = acc_from_open_flags(flags);
    int nofollow = (flags & O_NOFOLLOW) ? 1 : 0;
    if (!gate1(path, nofollow, acc, "open64", &real)) return -1;
    const char *p = xpath(path, real);
    int fd;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = (mode_t)va_arg(ap, int);
        va_end(ap);
        fd = real_open64(p, flags, mode);
    } else {
        fd = real_open64(p, flags);
    }
    int e = errno;
    if (fd >= 0) {
        fd_record(fd, real ? real : p, NULL, acc);
        if (flags & O_CREAT) dbox_shm_newfile_add(real ? real : p);
    }

    dbox_free(real);
    errno = e;
    return fd;
}
#endif

int openat(int dirfd, const char *path, int flags, ...)
{
    char *abs = NULL, *real = NULL;
    int acc = acc_from_open_flags(flags);
    int nofollow = (flags & O_NOFOLLOW) ? 1 : 0;
    int fd = -1;
    ensure_ready();
    if (!g_ready) {
        if (flags & (O_CREAT | O_TMPFILE)) {
            va_list ap; va_start(ap, flags);
            mode_t mode = (mode_t)va_arg(ap, int);
            va_end(ap);
            return real_openat(dirfd, path, flags, mode);
        }
        return real_openat(dirfd, path, flags);
    }
    abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    if (!gate1(abs, nofollow, acc, "openat", &real)) { dbox_free(abs); return -1; }
    const char *p = xpath(path, real);
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = (mode_t)va_arg(ap, int);
        va_end(ap);
        fd = real_openat(dirfd, p, flags, mode);
    } else {
        fd = real_openat(dirfd, p, flags);
    }
    int e = errno;
    if (fd >= 0) {
        fd_record(fd, real ? real : abs, NULL, acc);
        if (flags & O_CREAT) dbox_shm_newfile_add(real ? real : abs);
    }
    dbox_free(abs);

    dbox_free(real);
    errno = e;
    return fd;
}

#ifndef DBOX_LFS64_ARE_MACROS
int openat64(int dirfd, const char *path, int flags, ...)
{
    char *abs = NULL, *real = NULL;
    int acc = acc_from_open_flags(flags);
    int nofollow = (flags & O_NOFOLLOW) ? 1 : 0;
    int fd = -1;
    ensure_ready();
    if (!g_ready) {
        if (flags & (O_CREAT | O_TMPFILE)) {
            va_list ap; va_start(ap, flags);
            mode_t mode = (mode_t)va_arg(ap, int);
            va_end(ap);
            return real_openat64(dirfd, path, flags, mode);
        }
        return real_openat64(dirfd, path, flags);
    }
    abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    if (!gate1(abs, nofollow, acc, "openat64", &real)) { dbox_free(abs); return -1; }
    const char *p = xpath(path, real);
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = (mode_t)va_arg(ap, int);
        va_end(ap);
        fd = real_openat64(dirfd, p, flags, mode);
    } else {
        fd = real_openat64(dirfd, p, flags);
    }
    int e = errno;
    if (fd >= 0) {
        fd_record(fd, real ? real : abs, NULL, acc);
        if (flags & O_CREAT) dbox_shm_newfile_add(real ? real : abs);
    }
    dbox_free(abs);

    dbox_free(real);
    errno = e;
    return fd;
}
#endif

int creat(const char *path, mode_t mode)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE | ACC_READ, "creat", &real)) return -1;
    int fd = real_creat(xpath(path, real), mode);
    int e = errno;
    if (fd >= 0) {
        fd_record(fd, real ? real : path, NULL, ACC_WRITE | ACC_READ);
        dbox_shm_newfile_add(real ? real : path);
    }

    dbox_free(real);
    errno = e;
    return fd;
}

#ifndef DBOX_LFS64_ARE_MACROS
int creat64(const char *path, mode_t mode)
{
    return creat(path, mode);
}
#endif

static FILE *fopen_common(FILE *(*fn)(const char *, const char *),
                          const char *path, const char *mstr, const char *what)
{
    int w = strchr(mstr, 'w') || strchr(mstr, 'a') || strchr(mstr, '+');
    char *real = NULL;
    if (!gate1(path, 0, w ? ACC_WRITE | ACC_READ : ACC_READ, what, &real))
        return NULL;
    FILE *f = fn(xpath(path, real), mstr);
    int e = errno;
    if (f) {
        int fd = fileno(f);
        if (fd >= 0) fd_record(fd, real ? real : path, NULL,
                               w ? ACC_WRITE | ACC_READ : ACC_READ);
    }

    dbox_free(real);
    errno = e;
    return f;
}

FILE *fopen(const char *path, const char *mode)
{
    return fopen_common(real_fopen, path, mode, "fopen");
}
#ifndef DBOX_LFS64_ARE_MACROS
FILE *fopen64(const char *path, const char *mode)
{
    return fopen_common(real_fopen64, path, mode, "fopen64");
}
#endif

static FILE *freopen_common(FILE *(*fn)(const char *, const char *, FILE *),
                            const char *path, const char *mstr, FILE *f,
                            const char *what)
{
    int fd_old = f ? fileno(f) : -1;
    int w = strchr(mstr, 'w') || strchr(mstr, 'a') || strchr(mstr, '+');
    char *real = NULL;
    if (!gate1(path, 0, w ? ACC_WRITE | ACC_READ : ACC_READ, what, &real))
        return NULL;
    FILE *nf = fn(xpath(path, real), mstr, f);
    int e = errno;
    if (nf) {
        int fd = fileno(nf);
        if (fd >= 0) {
            if (fd_old >= 0 && fd != fd_old) fd_clear(fd_old);
            fd_record(fd, real ? real : path, NULL,
                      w ? ACC_WRITE | ACC_READ : ACC_READ);
        }
    }

    dbox_free(real);
    errno = e;
    return nf;
}

FILE *freopen(const char *path, const char *mode, FILE *f)
{
    return freopen_common(real_freopen, path, mode, f, "freopen");
}
#ifndef DBOX_LFS64_ARE_MACROS
FILE *freopen64(const char *path, const char *mode, FILE *f)
{
    return freopen_common(real_freopen64, path, mode, f, "freopen64");
}
#endif

static FILE *tmpfile_common(FILE *(*fn)(void), const char *what)
{
    ensure_ready();
    if (g_ready) {
        /* glibc tmpfile() always creates the file in /tmp (it ignores
         * TMPDIR), so the gate must match the real location */
        char *real = NULL;
        if (!gate1("/tmp", 0, ACC_WRITE, what, &real)) return NULL;
        dbox_free(real);
    }
    return fn();
}

FILE *tmpfile(void) { return tmpfile_common(real_tmpfile, "tmpfile"); }
#ifndef DBOX_LFS64_ARE_MACROS
FILE *tmpfile64(void) { return tmpfile_common(real_tmpfile64, "tmpfile64"); }
#endif

/* ------------------------------------------------------------------ */
/* stat / attribute reads                                              */
/* ------------------------------------------------------------------ */

int stat(const char *path, struct stat *st)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "stat", &real)) return -1;
    int r = real_stat(xpath(path, real), st);

    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int stat64(const char *path, struct stat64 *st)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "stat64", &real)) return -1;
    int r = real_stat64(xpath(path, real), st);

    return r;
}
#endif

int lstat(const char *path, struct stat *st)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_READ, "lstat", &real)) return -1;
    int r = real_lstat(xpath(path, real), st);

    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int lstat64(const char *path, struct stat64 *st)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_READ, "lstat64", &real)) return -1;
    int r = real_lstat64(xpath(path, real), st);

    return r;
}
#endif

int fstatat(int dirfd, const char *path, struct stat *st, int flags)
{
    if (!g_ready || !path || !path[0])
        return real_fstatat(dirfd, path, st, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    int nofollow = (flags & AT_SYMLINK_NOFOLLOW) ? 1 : 0;
    if (!gate1(abs, nofollow, ACC_READ, "fstatat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_fstatat, dirfd, path, real, st, flags);
    dbox_free(abs); dbox_free(real);
    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags)
{
    if (!g_ready || !path || !path[0])
        return real_fstatat64(dirfd, path, st, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    int nofollow = (flags & AT_SYMLINK_NOFOLLOW) ? 1 : 0;
    if (!gate1(abs, nofollow, ACC_READ, "fstatat64", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_fstatat64, dirfd, path, real, st, flags);
    dbox_free(abs); dbox_free(real);
    return r;
}
#endif

int statx(int dirfd, const char *path, int flags, unsigned int mask,
          struct statx *stx)
{
    if (!g_ready || !path || !path[0] || (flags & AT_EMPTY_PATH))
        return real_statx(dirfd, path, flags, mask, stx);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    int nofollow = (flags & AT_SYMLINK_NOFOLLOW) ? 1 : 0;
    if (!gate1(abs, nofollow, ACC_READ, "statx", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_statx, dirfd, path, real, flags, mask, stx);
    dbox_free(abs); dbox_free(real);
    return r;
}

int access(const char *path, int mode)
{
    char *real = NULL;
    if (!gate1(path, 0, mode_to_acc(mode), "access", &real)) return -1;
    int r = real_access(xpath(path, real), mode);

    return r;
}

int faccessat(int dirfd, const char *path, int mode, int flags)
{
    if (!g_ready || !path || !path[0])
        return real_faccessat(dirfd, path, mode, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 0, mode_to_acc(mode), "faccessat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_faccessat, dirfd, path, real, mode, flags);
    dbox_free(abs); dbox_free(real);
    return r;
}

#ifdef DBOX_EXTRA_HOOKS
int faccessat2(int dirfd, const char *path, int mode, int flags)
{
    if (!real_faccessat2) return faccessat(dirfd, path, mode, flags);
    if (!g_ready || !path || !path[0])
        return real_faccessat2(dirfd, path, mode, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    int nofollow = (flags & AT_SYMLINK_NOFOLLOW) ? 1 : 0;
    if (!gate1(abs, nofollow, mode_to_acc(mode), "faccessat2", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_faccessat2, dirfd, path, real, mode, flags);
    dbox_free(abs); dbox_free(real);
    return r;
}
#endif

ssize_t readlink(const char *path, char *buf, size_t sz)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_READ, "readlink", &real)) return -1;
    ssize_t r = real_readlink(xpath(path, real), buf, sz);

    return r;
}

ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t sz)
{
    if (!g_ready || !path || !path[0])
        return real_readlinkat(dirfd, path, buf, sz);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 1, ACC_READ, "readlinkat", &real)) { dbox_free(abs); return -1; }
    ssize_t r = XPAT_EXEC(real_readlinkat, dirfd, path, real, buf, sz);
    dbox_free(abs); dbox_free(real);
    return r;
}

char *realpath(const char *path, char *resolved)
{
    if (!g_ready || !path || !path[0]) return real_realpath(path, resolved);
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "realpath", &real)) return NULL;
    char *r = real_realpath(xpath(path, real), resolved);

    return r;
}

int statfs(const char *path, struct statfs *buf)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "statfs", &real)) return -1;
    int r = real_statfs(xpath(path, real), buf);

    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int statfs64(const char *path, struct statfs64 *buf)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "statfs64", &real)) return -1;
    int r = real_statfs64(xpath(path, real), buf);

    return r;
}
#endif

int statvfs(const char *path, struct statvfs *buf)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "statvfs", &real)) return -1;
    int r = real_statvfs(xpath(path, real), buf);

    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int statvfs64(const char *path, struct statvfs64 *buf)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "statvfs64", &real)) return -1;
    int r = real_statvfs64(xpath(path, real), buf);

    return r;
}
#endif

/* ------------------------------------------------------------------ */
/* directory listing                                                   */
/* ------------------------------------------------------------------ */

DIR *opendir(const char *path)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "opendir", &real)) return NULL;
    DIR *d = real_opendir(xpath(path, real));
    int e = errno;
    if (d) {
        int fd = dirfd(d);
        if (fd >= 0) fd_record(fd, real ? real : path, NULL, ACC_READ);
    }

    errno = e;
    return d;
}

static int scandir_common(int (*fn)(const char *, struct dirent ***, int (*)(const struct dirent *), int (*)(const struct dirent **, const struct dirent **)),
                          const char *path, struct dirent ***out,
                          int (*sel)(const struct dirent *),
                          int (*cmp)(const struct dirent **, const struct dirent **))
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "scandir", &real)) return -1;
    int r = fn(xpath(path, real), out, sel, cmp);

    return r;
}

int scandir(const char *path, struct dirent ***out,
            int (*sel)(const struct dirent *),
            int (*cmp)(const struct dirent **, const struct dirent **))
{
    return scandir_common(real_scandir, path, out, sel, cmp);
}

#ifndef DBOX_LFS64_ARE_MACROS
int scandir64(const char *path, struct dirent64 ***out,
              int (*sel)(const struct dirent64 *),
              int (*cmp)(const struct dirent64 **, const struct dirent64 **))
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "scandir64", &real)) return -1;
    int r = real_scandir64(xpath(path, real), out, sel, cmp);

    return r;
}
#endif

#ifdef DBOX_EXTRA_HOOKS
int scandirat(int dirfd, const char *path, struct dirent ***out,
              int (*sel)(const struct dirent *),
              int (*cmp)(const struct dirent **, const struct dirent **))
{
    if (!g_ready || !path || !path[0])
        return real_scandirat(dirfd, path, out, sel, cmp);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 0, ACC_READ, "scandirat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_scandirat, dirfd, path, real, out, sel, cmp);
    dbox_free(abs); dbox_free(real);
    return r;
}
#endif

int ftw(const char *path, int (*fn)(const char *, const struct stat *, int), int nfd)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "ftw", &real)) return -1;
    int r = real_ftw(xpath(path, real), fn, nfd);

    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int ftw64(const char *path, int (*fn)(const char *, const struct stat64 *, int), int nfd)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "ftw64", &real)) return -1;
    int r = real_ftw64(xpath(path, real), fn, nfd);

    return r;
}
#endif

int nftw(const char *path, int (*fn)(const char *, const struct stat *, int, struct FTW *), int nfd, int flags)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "nftw", &real)) return -1;
    int r = real_nftw(xpath(path, real), fn, nfd, flags);

    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int nftw64(const char *path, int (*fn)(const char *, const struct stat64 *, int, struct FTW *), int nfd, int flags)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "nftw64", &real)) return -1;
    int r = real_nftw64(xpath(path, real), fn, nfd, flags);

    return r;
}
#endif

/* ------------------------------------------------------------------ */
/* mutations                                                           */
/* ------------------------------------------------------------------ */

/* --del-to-trash：把删除目标移入回收站目录（Windows 回收站等价物）。
 * 保留原文件名；同名冲突时追加短序号（.1/.2/…）。回收站目录由 launcher 创建，
 * 此处防御性重建；跨文件系统（rename 失败）时退回 -1，由调用方直接删除。 */
static int trash_move(const char *path, const char *what)
{
    if (!g_trash_dir[0] || !path || !path[0]) return -1;
    {
        char tb[DBOX_PATH_MAX];
        snprintf(tb, sizeof tb, "%s", g_trash_dir);
        for (char *p = tb + 1; *p; p++) {
            if (*p == '/') {
                *p = 0;
                if (syscall(SYS_mkdirat, AT_FDCWD, tb, 0755) != 0 && errno != EEXIST) { *p = '/'; return -1; }
                *p = '/';
            }
        }
        if (syscall(SYS_mkdirat, AT_FDCWD, tb, 0755) != 0 && errno != EEXIST) return -1;
    }
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    const char *name = base && base[0] ? base : "unnamed";
    char dest[DBOX_PATH_MAX];
    int n = 0;
    do {
        if (n == 0) snprintf(dest, sizeof dest, "%s/%s", g_trash_dir, name);
        else snprintf(dest, sizeof dest, "%s/%s.%d", g_trash_dir, name, n);
        n++;
    } while (n < 1000 && syscall(SYS_faccessat, AT_FDCWD, dest, F_OK) == 0);
    if (n >= 1000) {
        dbox_logf("trash %s: name collision for %s", what, path);
        return -1;
    }
    int r = real_rename(path, dest);
    if (r == 0) { dbox_logf("trash %s: %s -> %s", what, path, dest); return 0; }
    dbox_logf("trash %s failed (%s), fallback unlink: %s", what, strerror(errno), path);
    return -1;
}

int unlink(const char *path)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_WRITE, "unlink", &real)) return -1;
    const char *xp = xpath(path, real);
    /* 本次沙箱实例新建的文件：删除直接清除，不进回收站（临时文件语义） */
    if (g_trash_dir[0] && !dbox_shm_newfile_has(xp) && trash_move(xp, "unlink") == 0) {
        dbox_free(real);
        return 0;
    }
    int r = real_unlink(xp);
    dbox_free(real);
    return r;
}

int unlinkat(int dirfd, const char *path, int flags)
{
    if (!g_ready || !path || !path[0])
        return real_unlinkat(dirfd, path, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 1, ACC_WRITE, "unlinkat", &real)) { dbox_free(abs); return -1; }
    const char *target = real && real[0] ? real : abs;
    int r;
    if (g_trash_dir[0] && !dbox_shm_newfile_has(target) && trash_move(target, "unlinkat") == 0) {
        r = 0;
    } else {
        r = XPAT_EXEC(real_unlinkat, dirfd, path, real, flags);
    }
    dbox_free(abs); dbox_free(real);
    return r;
}

int rmdir(const char *path)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_WRITE, "rmdir", &real)) return -1;
    const char *xp = xpath(path, real);
    if (g_trash_dir[0] && !dbox_shm_newfile_has(xp) && trash_move(xp, "rmdir") == 0) {
        dbox_free(real);
        return 0;
    }
    int r = real_rmdir(xp);
    dbox_free(real);
    return r;
}

/* gate both ends of a rename */
static int gate_rename(const char *old, const char *newp,
                       char **oreal_out, char **nreal_out)
{
    char *oreal = NULL;
    char *nreal = NULL;
    if (!gate1(old, 1, ACC_WRITE, "rename", &oreal)) return 0;
    if (!gate1(newp, 1, ACC_WRITE, "rename", &nreal)) {
        dbox_free(oreal);
        return 0;
    }
    if (oreal_out) *oreal_out = oreal; else dbox_free(oreal);
    if (nreal_out) *nreal_out = nreal; else dbox_free(nreal);
    return 1;
}

int rename(const char *old, const char *newp)
{
    ensure_ready();
    if (!g_ready) return real_rename(old, newp);
    char *oreal = NULL, *nreal = NULL;
    if (!gate_rename(old, newp, &oreal, &nreal)) return -1;
    int r = real_rename(xpath(old, oreal), xpath(newp, nreal));
    dbox_free(oreal); dbox_free(nreal);
    return r;
}

int renameat(int oldfd, const char *old, int newfd, const char *newp)
{
    ensure_ready();
    if (!g_ready) return real_renameat(oldfd, old, newfd, newp);
    char *ao = at_abs(oldfd, old);
    char *an = at_abs(newfd, newp);
    if (!ao || !an) { dbox_free(ao); dbox_free(an); errno = EBADF; return -1; }
    char *oreal = NULL, *nreal = NULL;
    if (!gate_rename(ao, an, &oreal, &nreal)) { dbox_free(ao); dbox_free(an); return -1; }
    int r = (g_tmp_dir[0] && oreal && nreal)
                ? real_renameat(AT_FDCWD, oreal, AT_FDCWD, nreal)
                : real_renameat(oldfd, old, newfd, newp);
    dbox_free(ao); dbox_free(an); dbox_free(oreal); dbox_free(nreal);
    return r;
}

int renameat2(int oldfd, const char *old, int newfd, const char *newp,
              unsigned int flags)
{
    if (!real_renameat2)
        return (int)syscall(SYS_renameat2, oldfd, old, newfd, newp, flags);
    if (!g_ready)
        return real_renameat2(oldfd, old, newfd, newp, flags);
    /* RENAME_EXCHANGE / RENAME_NOREPLACE still move data between the two
     * paths; gate them the same way */
    char *ao = at_abs(oldfd, old);
    char *an = at_abs(newfd, newp);
    if (!ao || !an) { dbox_free(ao); dbox_free(an); errno = EBADF; return -1; }
    char *oreal = NULL, *nreal = NULL;
    if (!gate_rename(ao, an, &oreal, &nreal)) { dbox_free(ao); dbox_free(an); return -1; }
    int r = (g_tmp_dir[0] && oreal && nreal)
                ? real_renameat2(AT_FDCWD, oreal, AT_FDCWD, nreal, flags)
                : real_renameat2(oldfd, old, newfd, newp, flags);
    dbox_free(ao); dbox_free(an); dbox_free(oreal); dbox_free(nreal);
    return r;
}

int mkdir(const char *path, mode_t mode)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE, "mkdir", &real)) return -1;
    const char *p = xpath(path, real);
    int r = real_mkdir(p, mode);
    int e = errno;
    if (r == 0) dbox_shm_newfile_add(p);   /* 新建目录：删除时不进回收站 */
    dbox_free(real);
    errno = e;
    return r;
}

int mkdirat(int dirfd, const char *path, mode_t mode)
{
    if (!g_ready || !path || !path[0])
        return real_mkdirat(dirfd, path, mode);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 0, ACC_WRITE, "mkdirat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_mkdirat, dirfd, path, real, mode);
    dbox_free(abs); dbox_free(real);
    return r;
}

int chmod(const char *path, mode_t mode)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE, "chmod", &real)) return -1;
    int r = real_chmod(xpath(path, real), mode);

    return r;
}

int fchmodat(int dirfd, const char *path, mode_t mode, int flags)
{
    if (!g_ready || !path || !path[0])
        return real_fchmodat(dirfd, path, mode, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    int nofollow = (flags & AT_SYMLINK_NOFOLLOW) ? 1 : 0;
    if (!gate1(abs, nofollow, ACC_WRITE, "fchmodat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_fchmodat, dirfd, path, real, mode, flags);
    dbox_free(abs); dbox_free(real);
    return r;
}

int chown(const char *path, uid_t u, gid_t g)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE, "chown", &real)) return -1;
    int r = real_chown(xpath(path, real), u, g);

    return r;
}

int lchown(const char *path, uid_t u, gid_t g)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_WRITE, "lchown", &real)) return -1;
    int r = real_lchown(xpath(path, real), u, g);

    return r;
}

int fchownat(int dirfd, const char *path, uid_t u, gid_t g, int flags)
{
    if (!g_ready || !path || !path[0] || (flags & AT_EMPTY_PATH))
        return real_fchownat(dirfd, path, u, g, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    int nofollow = (flags & AT_SYMLINK_NOFOLLOW) ? 1 : 0;
    if (!gate1(abs, nofollow, ACC_WRITE, "fchownat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_fchownat, dirfd, path, real, u, g, flags);
    dbox_free(abs); dbox_free(real);
    return r;
}

int truncate(const char *path, off_t len)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE, "truncate", &real)) return -1;
    int r = real_truncate(xpath(path, real), len);

    return r;
}

#ifndef DBOX_LFS64_ARE_MACROS
int truncate64(const char *path, off64_t len)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE, "truncate64", &real)) return -1;
    int r = real_truncate64(xpath(path, real), len);

    return r;
}
#endif

int link(const char *old, const char *newp)
{
    char *oreal = NULL;
    char *nreal = NULL;
    /* hardlink source: the built-in system allowlist must NOT count as
     * read access here, or a system file could be hardlinked into a
     * writable area and exfiltrated */
    if (!gate1x(old, 1, ACC_READ, "link", 0, &oreal)) return -1;
    if (!gate1(newp, 1, ACC_WRITE, "link", &nreal)) {
        dbox_free(oreal); dbox_free(nreal); return -1;
    }
    int r = real_link(xpath(old, oreal), xpath(newp, nreal));
    dbox_free(oreal); dbox_free(nreal);
    return r;
}

int linkat(int oldfd, const char *old, int newfd, const char *newp, int flags)
{
    if (!g_ready || !old || !old[0] || !newp || !newp[0])
        return real_linkat(oldfd, old, newfd, newp, flags);
    char *ao = at_abs(oldfd, old);
    char *an = at_abs(newfd, newp);
    if (!ao || !an) { dbox_free(ao); dbox_free(an); errno = EBADF; return -1; }
    char *oreal = NULL;
    char *nreal = NULL;
    int nofollow_old = (flags & AT_SYMLINK_FOLLOW) ? 0 : 1;
    /* hardlink source: system allowlist must not grant this (see link) */
    if (!gate1x(ao, nofollow_old, ACC_READ, "linkat", 0, &oreal)) {
        dbox_free(ao); dbox_free(an); return -1;
    }
    if (!gate1(an, 1, ACC_WRITE, "linkat", &nreal)) {
        dbox_free(ao); dbox_free(an);
        dbox_free(oreal); dbox_free(nreal);
        return -1;
    }
    int r = (g_tmp_dir[0] && oreal && nreal)
                ? real_linkat(AT_FDCWD, oreal, AT_FDCWD, nreal, flags)
                : real_linkat(oldfd, old, newfd, newp, flags);
    dbox_free(ao); dbox_free(an);
    dbox_free(oreal); dbox_free(nreal);
    return r;
}

/* symlink targets are used exactly as the program wrote them: in the
 * identity namespace there is nothing to translate, and dangling links are
 * the kernel's business. Escape attempts are caught at open time via
 * resolved-path attribution. */
int symlink(const char *target, const char *linkpath)
{
    char *real = NULL;
    if (!gate1(linkpath, 1, ACC_WRITE, "symlink", &real)) return -1;
    int r = real_symlink(target, xpath(linkpath, real));
    int e = errno;

    errno = e;
    return r;
}

int symlinkat(const char *target, int newdirfd, const char *linkpath)
{
    if (!g_ready || !linkpath || !linkpath[0])
        return real_symlinkat(target, newdirfd, linkpath);
    char *an = at_abs(newdirfd, linkpath);
    if (!an) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(an, 1, ACC_WRITE, "symlinkat", &real)) { dbox_free(an); return -1; }
    int r = (g_tmp_dir[0] && real)
                ? real_symlinkat(target, AT_FDCWD, real)
                : real_symlinkat(target, newdirfd, linkpath);
    int e = errno;
    dbox_free(an); dbox_free(real);
    errno = e;
    return r;
}

int mknod(const char *path, mode_t mode, dev_t dev)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_WRITE, "mknod", &real)) return -1;
    int r = real_mknod(xpath(path, real), mode, dev);

    return r;
}

int mknodat(int dirfd, const char *path, mode_t mode, dev_t dev)
{
    if (!g_ready || !path || !path[0])
        return real_mknodat(dirfd, path, mode, dev);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 1, ACC_WRITE, "mknodat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_mknodat, dirfd, path, real, mode, dev);
    dbox_free(abs); dbox_free(real);
    return r;
}

int mkfifo(const char *path, mode_t mode)
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_WRITE, "mkfifo", &real)) return -1;
    int r = real_mkfifo(xpath(path, real), mode);

    return r;
}

int mkfifoat(int dirfd, const char *path, mode_t mode)
{
    if (!g_ready || !path || !path[0])
        return real_mkfifoat(dirfd, path, mode);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 1, ACC_WRITE, "mkfifoat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_mkfifoat, dirfd, path, real, mode);
    dbox_free(abs); dbox_free(real);
    return r;
}

int utime(const char *path, const struct utimbuf *t)
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE, "utime", &real)) return -1;
    int r = real_utime(xpath(path, real), t);

    return r;
}

int utimes(const char *path, const struct timeval t[2])
{
    char *real = NULL;
    if (!gate1(path, 0, ACC_WRITE, "utimes", &real)) return -1;
    int r = real_utimes(xpath(path, real), t);

    return r;
}

int lutimes(const char *path, const struct timeval t[2])
{
    char *real = NULL;
    if (!gate1(path, 1, ACC_WRITE, "lutimes", &real)) return -1;
    int r = real_lutimes(xpath(path, real), t);

    return r;
}

int futimesat(int dirfd, const char *path, const struct timeval t[2])
{
    if (!g_ready || !path || !path[0])
        return real_futimesat(dirfd, path, t);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    if (!gate1(abs, 0, ACC_WRITE, "futimesat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_futimesat, dirfd, path, real, t);
    dbox_free(abs); dbox_free(real);
    return r;
}

int utimensat(int dirfd, const char *path, const struct timespec t[2], int flags)
{
    if (!g_ready || !path || !path[0])
        return real_utimensat(dirfd, path, t, flags);
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    char *real = NULL;
    int nofollow = (flags & AT_SYMLINK_NOFOLLOW) ? 1 : 0;
    if (!gate1(abs, nofollow, ACC_WRITE, "utimensat", &real)) { dbox_free(abs); return -1; }
    int r = XPAT_EXEC(real_utimensat, dirfd, path, real, t, flags);
    dbox_free(abs); dbox_free(real);
    return r;
}

/* ------------------------------------------------------------------ */
/* exec family                                                         */
/* ------------------------------------------------------------------ */

int execve(const char *path, char *const argv[], char *const envp[])
{
    ensure_ready();
    if (!g_ready || g_in_spawn) return real_execve(path, argv, envp);
    if (gate_exec(path) != 0) { errno = EACCES; return -1; }
    /* identity namespace: no argv rewriting */
    size_t env_owned = 0;
    char **env = build_envp(envp, &env_owned);
    char ebuf[DBOX_PATH_MAX];
    const char *ep = xtmp_prefix(path, ebuf, sizeof ebuf);
    int r = real_execve(ep, argv, env);
    int e = errno;
    free_envp(env, env_owned);

    errno = e;
    return r;
}

#ifdef DBOX_EXTRA_HOOKS
int execveat(int dirfd, const char *path, char *const argv[],
             char *const envp[], int flags)
{
    ensure_ready();
    if (!g_ready || g_in_spawn) return real_execveat(dirfd, path, argv, envp, flags);
    if (!path || !path[0]) {   /* AT_EMPTY_PATH: fd-based */
        errno = EACCES;
        return -1;
    }
    char *abs = at_abs(dirfd, path);
    if (!abs) { errno = EBADF; return -1; }
    if (gate_exec(abs) != 0) { dbox_free(abs); errno = EACCES; return -1; }
    /* identity namespace: no argv rewriting */
    size_t env_owned = 0;
    char **env = build_envp(envp, &env_owned);
    int r = XPAT_EXEC(real_execveat, dirfd, path, real, argv, env, flags);
    int e = errno;
    free_envp(env, env_owned);
    dbox_free(abs);

    errno = e;
    return r;
}
#endif

int fexecve(int fd, char *const argv[], char *const envp[])
{
    /* /proc/self/fd/<fd> re-open would dodge attribution; refuse fd-based
     * exec unless the fd is one we opened and can name */
    ensure_ready();
    if (g_ready && !g_in_spawn) {
        char *rp = fd_path(fd);
        if (!rp) { errno = EACCES; return -1; }
        if (gate_exec(rp) != 0) { dbox_free(rp); errno = EACCES; return -1; }
        size_t env_owned = 0;
    char **env = build_envp(envp, &env_owned);
        const char *pp = rp;
        int r = real_execve(pp, argv, env);
        int e = errno;
        free_envp(env, env_owned);
        dbox_free(rp);
        errno = e;
        return r;
    }
    return real_fexecve(fd, argv, envp);
}

int execv(const char *path, char *const argv[])
{
    return execve(path, argv, environ);
}

int execvp(const char *file, char *const argv[])
{
    ensure_ready();
    if (!g_ready || g_in_spawn) return real_execvp(file, argv);
    if (strchr(file, '/'))
        return execve(file, argv, environ);   /* gate + translate */
    char *cand = find_in_path(file, environ);
    if (!cand) return -1;   /* errno from search (EACCES or ENOENT) */
    /* identity namespace: no argv rewriting */
    size_t env_owned = 0;
    char **env = build_envp(environ, &env_owned);
    int r = real_execve(cand, argv, env);
    int e = errno;
    free_envp(env, env_owned);
    dbox_free(cand);
    errno = e;
    return r;
}

int execvpe(const char *file, char *const argv[], char *const envp[])
{
    ensure_ready();
    if (!g_ready || g_in_spawn) return real_execvpe(file, argv, envp);
    if (strchr(file, '/'))
        return execve(file, argv, envp);      /* gate + translate */
    char *cand = find_in_path(file, envp);
    if (!cand) return -1;
    /* identity namespace: no argv rewriting */
    size_t env_owned = 0;
    char **env = build_envp(envp, &env_owned);
    int r = real_execve(cand, argv, env);
    int e = errno;
    free_envp(env, env_owned);
    dbox_free(cand);
    errno = e;
    return r;
}

/* execl/execlp/execle are libc-internal execve callers in glibc, so they
 * must be gated here rather than relying on the execve hook */
static int execv_gate(const char *path, char *const argv[], char *const envp[])
{
    return execve(path, argv, envp);
}

int execl(const char *path, const char *arg, ...)
{
    va_list ap;
    size_t n = 0;
    va_start(ap, arg);
    for (const char *a = arg; a; a = va_arg(ap, const char *)) n++;
    va_end(ap);
    char **argv = dbox_malloc(sizeof(char *) * (n + 2));
    va_start(ap, arg);
    size_t i = 0;
    for (const char *a = arg; a; a = va_arg(ap, const char *)) argv[i++] = (char *)a;
    argv[i] = NULL;
    va_end(ap);
    int r = execv_gate(path, argv, environ);
    int e = errno;
    dbox_free(argv);
    errno = e;
    return r;
}

int execle(const char *path, const char *arg, ...)
{
    va_list ap;
    size_t n = 0;
    va_start(ap, arg);
    for (const char *a = arg; a; a = va_arg(ap, const char *)) n++;
    va_end(ap);
    char **argv = dbox_malloc(sizeof(char *) * (n + 2));
    va_start(ap, arg);
    size_t i = 0;
    for (const char *a = arg; a; a = va_arg(ap, const char *)) argv[i++] = (char *)a;
    argv[i] = NULL;
    char *const *envp = va_arg(ap, char *const *);
    va_end(ap);
    int r = execv_gate(path, argv, envp);
    int e = errno;
    dbox_free(argv);
    errno = e;
    return r;
}

int execlp(const char *file, const char *arg, ...)
{
    va_list ap;
    size_t n = 0;
    va_start(ap, arg);
    for (const char *a = arg; a; a = va_arg(ap, const char *)) n++;
    va_end(ap);
    char **argv = dbox_malloc(sizeof(char *) * (n + 2));
    va_start(ap, arg);
    size_t i = 0;
    for (const char *a = arg; a; a = va_arg(ap, const char *)) argv[i++] = (char *)a;
    argv[i] = NULL;
    va_end(ap);
    int r = execvp(file, argv);
    int e = errno;
    dbox_free(argv);
    errno = e;
    return r;
}

int system(const char *cmd)
{
    ensure_ready();
    if (!g_ready) return real_system(cmd);
    if (gate_exec("/bin/sh") != 0) return -1;

    /* the shell execs its children through our hooks, so the command line
     * is governed per-program; /bin/sh itself was just gated */
    return real_system(cmd);
}

FILE *popen(const char *cmd, const char *type)
{
    ensure_ready();
    if (!g_ready) return real_popen(cmd, type);
    if (gate_exec("/bin/sh") != 0) return NULL;

    return real_popen(cmd, type);
}

int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attr,
                char *const argv[], char *const envp[])
{
    ensure_ready();
    if (!g_ready) return real_posix_spawn(pid, path, fa, attr, argv, envp);
    if (gate_exec(path) != 0) return EACCES;
    /* identity namespace: no argv rewriting */
    size_t env_owned = 0;
    char **env = build_envp(envp, &env_owned);
    g_in_spawn = 1;
    int r = real_posix_spawn(pid, path, fa, attr, argv, env);
    g_in_spawn = 0;
    int e = errno;
    free_envp(env, env_owned);
    errno = e;
    return r;
}

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr,
                 char *const argv[], char *const envp[])
{
    ensure_ready();
    if (!g_ready) return real_posix_spawnp(pid, file, fa, attr, argv, envp);
    if (strchr(file, '/'))
        return posix_spawn(pid, file, fa, attr, argv, envp);
    char *cand = find_in_path(file, envp);
    if (!cand) return EACCES;
    /* identity namespace: no argv rewriting */
    size_t env_owned = 0;
    char **env = build_envp(envp, &env_owned);
    g_in_spawn = 1;
    int r = real_posix_spawn(pid, cand, fa, attr, argv, env);
    g_in_spawn = 0;
    int e = errno;
    free_envp(env, env_owned);
    dbox_free(cand);
    errno = e;
    return r;
}

/* ------------------------------------------------------------------ */
/* cwd                                                                 */
/* ------------------------------------------------------------------ */

static void ctx_set_cwd(const char *real)
{
    pthread_mutex_lock(&g_ctx_mu);
    snprintf(g_ctx.rpwd, sizeof g_ctx.rpwd, "%s", real);
    pthread_mutex_unlock(&g_ctx_mu);
}

int chdir(const char *path)
{
    ensure_ready();
    if (!g_ready) return real_chdir(path);
    char *real = NULL;
    if (!gate1(path, 0, ACC_READ, "chdir", &real)) return -1;
    int r = real_chdir(xpath(path, real));
    if (r == 0 && real) ctx_set_cwd(real);

    dbox_free(real);
    return r;
}

int fchdir(int fd)
{
    ensure_ready();
    if (!g_ready) return real_fchdir(fd);
    char *rp = fd_path(fd);
    if (!rp) { errno = EACCES; return -1; }
    /* gate the directory the fd refers to */
    char *real = NULL;
    if (!gate1(rp, 0, ACC_READ, "fchdir", &real)) {
        dbox_free(rp);
        return -1;
    }
    int r = real_fchdir(fd);
    if (r == 0) ctx_set_cwd(real ? real : rp);
    dbox_free(rp);

    dbox_free(real);
    return r;
}

char *getcwd(char *buf, size_t size)
{
    ensure_ready();
    if (!g_ready) return real_getcwd(buf, size);
    pthread_mutex_lock(&g_ctx_mu);
    char v[DBOX_PATH_MAX];
    snprintf(v, sizeof v, "%s", g_ctx.rpwd);
    pthread_mutex_unlock(&g_ctx_mu);
    size_t vl = strlen(v);
    if (!buf) {
        size_t alloc = size > vl + 1 ? size : vl + 1;
        char *m = malloc(alloc);
        if (!m) { errno = ENOMEM; return NULL; }
        memcpy(m, v, vl + 1);
        return m;
    }
    if (size < vl + 1) { errno = ERANGE; return NULL; }
    memcpy(buf, v, vl + 1);
    return buf;
}

/* ------------------------------------------------------------------ */
/* dlopen + exec-mapping gate                                          */
/* ------------------------------------------------------------------ */

void *dlopen(const char *path, int flags)
{
    ensure_ready();
    if (g_ready && path && path[0] && !(flags & RTLD_NOLOAD)) {
        /* a shared object is code: treat loading it as execute */
        char *real = NULL;
        if (!gate1(path, 0, ACC_EXEC, "dlopen", &real)) return NULL;
        void *h = real_dlopen(xpath(path, real), flags);
        dbox_free(real);
        return h;
    }
    return real_dlopen(path, flags);
}

#ifdef DBOX_EXTRA_HOOKS
void *dlmopen(Lmid_t lmid, const char *path, int flags)
{
    ensure_ready();
    if (g_ready && path && path[0] && !(flags & RTLD_NOLOAD)) {
        char *real = NULL;
        if (!gate1(path, 0, ACC_EXEC, "dlmopen", &real)) return NULL;
        void *h = real_dlmopen(lmid, path, flags);
        dbox_free(real);
        return h;
    }
    return real_dlmopen(lmid, path, flags);
}
#endif

/* mmap(PROT_EXEC) on a file-backed fd is gated by the CURRENT policy on
 * the fd's path (not by the access recorded at open time), so JIT-style
 * read-then-exec flows work wherever execute is allowed. Untracked fds
 * (dynamic loader) are allowed; a path that cannot be attributed is
 * allowed too (documented boundary). Returns 1 = allow, 0 = deny. */
static int mmap_exec_allowed(int fd)
{
    if (!g_ready) return 1;
    char *rp = fd_path(fd);
    if (!rp) return 1;
    char *real = NULL;
    int ok = gate1x(rp, 0, ACC_EXEC, "mmap-exec", 1, &real);
    if (!ok)
        dbox_logf("DENY mmap(PROT_EXEC) on %s (no execute grant)", rp);
    dbox_free(rp);
    return ok;
}

void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t off)
{
    ensure_ready();
    if ((prot & PROT_EXEC) && fd >= 0 && !(flags & MAP_ANONYMOUS)) {
        if (!mmap_exec_allowed(fd)) { errno = EPERM; return MAP_FAILED; }
    }
    return real_mmap(addr, len, prot, flags, fd, off);
}

#ifndef DBOX_LFS64_ARE_MACROS
void *mmap64(void *addr, size_t len, int prot, int flags, int fd, off64_t off)
{
    ensure_ready();
    if ((prot & PROT_EXEC) && fd >= 0 && !(flags & MAP_ANONYMOUS)) {
        if (!mmap_exec_allowed(fd)) { errno = EPERM; return MAP_FAILED; }
    }
    return real_mmap64(addr, len, prot, flags, fd, off);
}
#endif

/* ------------------------------------------------------------------ */
/* fd lifecycle                                                        */
/* ------------------------------------------------------------------ */

int close(int fd)
{
    fd_clear(fd);
    return real_close(fd);
}

#ifdef DBOX_EXTRA_HOOKS
int close_range(unsigned int first, unsigned int last, int flags)
{
    ensure_ready();
    if (g_ready && !(flags & CLOSE_RANGE_UNSHARE)) {
        for (unsigned int f = first; f <= last && f < MAX_FD; f++)
            fd_clear((int)f);
    }
    if (real_close_range) return real_close_range(first, last, flags);
    return (int)syscall(SYS_close_range, first, last, flags);
}
#endif

int dup(int fd)
{
    int r = real_dup(fd);
    if (r >= 0 && g_ready) fd_copy(fd, r);
    return r;
}

int dup2(int oldfd, int newfd)
{
    int r = real_dup2(oldfd, newfd);
    if (r >= 0 && g_ready) {
        fd_clear(newfd);
        fd_copy(oldfd, newfd);
    }
    return r;
}

int dup3(int oldfd, int newfd, int flags)
{
    int r = real_dup3(oldfd, newfd, flags);
    if (r >= 0 && g_ready) {
        fd_clear(newfd);
        fd_copy(oldfd, newfd);
    }
    return r;
}

int fcntl(int fd, int cmd, ...)
{
    if (cmd == F_DUPFD || cmd == F_DUPFD_CLOEXEC) {
        va_list ap; va_start(ap, cmd);
        long arg = va_arg(ap, long);
        va_end(ap);
        int r = real_fcntl(fd, cmd, arg);
        if (r >= 0 && g_ready) fd_copy(fd, r);
        return r;
    }
    switch (cmd) {
    case F_GETFD: case F_GETFL: case F_GETOWN: case F_GETSIG:
    case F_GETLEASE: case F_GETPIPE_SZ: case F_GET_SEALS:
        return real_fcntl(fd, cmd);
    case F_SETFD: case F_SETFL: case F_SETOWN: case F_SETSIG:
    case F_SETLEASE: case F_NOTIFY: case F_SETPIPE_SZ: case F_ADD_SEALS:
    case F_SET_RW_HINT: case F_GET_RW_HINT: case F_SET_FILE_RW_HINT:
    case F_GET_FILE_RW_HINT: {
        va_list ap; va_start(ap, cmd);
        long arg = va_arg(ap, long);
        va_end(ap);
        return real_fcntl(fd, cmd, arg);
    }
    default: {   /* F_GETLK / F_SETLK / F_SETLKW / F_OFD_*: pointer arg */
        va_list ap; va_start(ap, cmd);
        void *arg = va_arg(ap, void *);
        va_end(ap);
        return real_fcntl(fd, cmd, arg);
    }
    }
}

/* ------------------------------------------------------------------ */
/* network gating                                                      */
/* ------------------------------------------------------------------ */

static int sockaddr_is_loopback(const struct sockaddr *sa)
{
    if (sa->sa_family == AF_INET) {
        const struct sockaddr_in *s4 = (const struct sockaddr_in *)sa;
        return (ntohl(s4->sin_addr.s_addr) >> 24) == 127;
    }
    if (sa->sa_family == AF_INET6) {
        const struct sockaddr_in6 *s6 = (const struct sockaddr_in6 *)sa;
        return IN6_IS_ADDR_LOOPBACK(&s6->sin6_addr);
    }
    return 0;
}

int socket(int domain, int type, int protocol)
{
    ensure_ready();
    if (g_ready && (domain == AF_INET || domain == AF_INET6) &&
        g_ctx.pol.net_mode == NET_DENY) {
        dbox_logf("DENY socket(inet) — [network] deny");
        errno = EACCES;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

int connect(int fd, const struct sockaddr *sa, socklen_t sl)
{
    ensure_ready();
    if (g_ready && sa && (sa->sa_family == AF_INET || sa->sa_family == AF_INET6) &&
        g_ctx.pol.net_mode == NET_LOOPBACK && !sockaddr_is_loopback(sa)) {
        dbox_logf("DENY connect(non-loopback) — [network] loopback");
        errno = EACCES;
        return -1;
    }
    return real_connect(fd, sa, sl);
}

int bind(int fd, const struct sockaddr *sa, socklen_t sl)
{
    ensure_ready();
    if (g_ready && sa && (sa->sa_family == AF_INET || sa->sa_family == AF_INET6) &&
        g_ctx.pol.net_mode == NET_LOOPBACK && !sockaddr_is_loopback(sa)) {
        dbox_logf("DENY bind(non-loopback) — [network] loopback");
        errno = EACCES;
        return -1;
    }
    return real_bind(fd, sa, sl);
}
