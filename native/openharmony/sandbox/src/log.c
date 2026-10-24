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
    /* 时间戳用纯算术格式化（gmtime 语义），不走 localtime_r：tzset()
     * 首次调用会分配时区数据，在 PIE 宿主（Electron/Chromium）的分配器
     * shim 未就绪期触发 malloc 重入 → shim 自旋锁死锁（见 util.c 的
     * allocator bootstrap guard 注释）。诊断日志用 UTC 足够。 */
    time_t sec = ts.tv_sec;
    int ms = (int)(ts.tv_nsec / 1000000);
    long days = (long)(sec / 86400);
    int sod = (int)(sec % 86400);
    if (sod < 0) { sod += 86400; days--; }
    /* civil-from-days（Howard Hinnant 算法）：days 自 1970-01-01 */
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
    int n = snprintf(buf, sizeof buf,
                     "%04ld-%02ld-%02ld %02d:%02d:%02d.%03d [%ld] ",
                     y, m, d, sod / 3600, (sod / 60) % 60, sod % 60, ms,
                     (long)getpid());
    va_list ap;
    va_start(ap, fmt);
    int mm = vsnprintf(buf + n, sizeof buf - n - 1, fmt, ap);
    va_end(ap);
    if (mm < 0) return;
    n += mm;
    if (n > (int)sizeof buf - 2) n = (int)sizeof buf - 2;
    buf[n++] = '\n';
    pthread_mutex_lock(&g_mu);
    if (g_fd >= 0) dbox_raw_write(g_fd, buf, (size_t)n);
    pthread_mutex_unlock(&g_mu);
}
