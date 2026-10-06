/* log.c — thread-safe diagnostic logging via raw I/O.
 * Deliberately avoids hooked libc entry points (open/fopen/write), so the
 * sandbox library can log from inside its own interposed wrappers. The
 * underlying I/O goes through the rawio abstraction (Linux: syscall to bypass
 * LD_PRELOAD; macOS/Windows: libc/Win32 with interpose guard). */
#define _GNU_SOURCE
#include "log.h"
#include "rawio.h"
#include "util.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>

int dbox_verbose_enabled = 0;

static int g_fd = -1;
static char g_path[1024];
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

const char *dbox_log_path(void) { return g_path[0] ? g_path : NULL; }

void dbox_log_open(const char *path)
{
    if (!path || !path[0]) return;
    pthread_mutex_lock(&g_mu);
    if (g_fd >= 0) { dbox_raw_close(g_fd); g_fd = -1; }
    snprintf(g_path, sizeof g_path, "%s", path);
    g_fd = dbox_raw_openat(-100 /*AT_FDCWD*/, path,
                           O_WRONLY | O_APPEND | O_CREAT, 0644);
    pthread_mutex_unlock(&g_mu);
}

void dbox_logf(const char *fmt, ...)
{
    if (g_fd < 0) return;
    char buf[2048];
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    localtime_r(&ts.tv_sec, &tm);
    int n = snprintf(buf, sizeof buf, "%04d-%02d-%02d %02d:%02d:%02d.%03d [%ld] ",
                     tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                     tm.tm_hour, tm.tm_min, tm.tm_sec,
                     (int)(ts.tv_nsec / 1000000), (long)getpid());
    va_list ap;
    va_start(ap, fmt);
    int m = vsnprintf(buf + n, sizeof buf - n - 1, fmt, ap);
    va_end(ap);
    if (m < 0) return;
    n += m;
    if (n > (int)sizeof buf - 2) n = (int)sizeof buf - 2;
    buf[n++] = '\n';
    pthread_mutex_lock(&g_mu);
    if (g_fd >= 0) dbox_raw_write(g_fd, buf, (size_t)n);
    pthread_mutex_unlock(&g_mu);
}
