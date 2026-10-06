/* pthread_compat.h — MSVC 的最小 pthread shim（仅覆盖 core 所需子集）。
 *
 * core（native/openharmony/sandbox/src）在 Windows 上只走 in-process 路径
 * （dbox_shared_create/attach 返回 -1，g_shm 恒 NULL），互斥仅用于进程内
 * 决策缓存/grants 的并发保护。本 shim 把 pthread_mutex_* 映射到
 * CRITICAL_SECTION（递归语义，与 PTHREAD_MUTEX_RECURSIVE 一致）。
 *
 * 仅 Windows/MSVC 构建引入；POSIX 平台继续用系统 pthread。
 */
#ifndef DYNOBOX_PTHREAD_COMPAT_H
#define DYNOBOX_PTHREAD_COMPAT_H

#ifndef _WIN32
#error "pthread_compat.h is Windows-only"
#endif

#include <windows.h>

typedef CRITICAL_SECTION pthread_mutex_t;
typedef void pthread_mutexattr_t;

#define PTHREAD_MUTEX_INITIALIZER { 0 }
#define PTHREAD_MUTEX_RECURSIVE 1
#define PTHREAD_PROCESS_SHARED 1

static inline int pthread_mutex_init(pthread_mutex_t *m, pthread_mutexattr_t *attr)
{
    (void)attr;
    InitializeCriticalSection(m);
    return 0;
}
static inline int pthread_mutex_destroy(pthread_mutex_t *m)
{
    DeleteCriticalSection(m);
    return 0;
}
static inline int pthread_mutex_lock(pthread_mutex_t *m)
{
    EnterCriticalSection(m);
    return 0;
}
static inline int pthread_mutex_unlock(pthread_mutex_t *m)
{
    LeaveCriticalSection(m);
    return 0;
}
static inline int pthread_mutex_trylock(pthread_mutex_t *m)
{
    return TryEnterCriticalSection(m) ? 0 : EBUSY;
}
static inline int pthread_mutexattr_init(pthread_mutexattr_t *a) { (void)a; return 0; }
static inline int pthread_mutexattr_destroy(pthread_mutexattr_t *a) { (void)a; return 0; }
static inline int pthread_mutexattr_setpshared(pthread_mutexattr_t *a, int v) { (void)a; (void)v; return 0; }
static inline int pthread_mutexattr_settype(pthread_mutexattr_t *a, int v) { (void)a; (void)v; return 0; }

#endif /* DYNOBOX_PTHREAD_COMPAT_H */