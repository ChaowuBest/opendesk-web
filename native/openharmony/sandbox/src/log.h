/* log.h — sandbox diagnostic logging (raw-syscall file writes only) */
#ifndef DYNOBOX_LOG_H
#define DYNOBOX_LOG_H

#include <stddef.h>

/* Open (or create, append) the log file. Raw syscalls; never consults the
 * sandbox policy. Call once per process. */
void dbox_log_open(const char *path);

/* 1 = log every policy decision (DYNOBOX_VERBOSE). */
extern int dbox_verbose_enabled;

void dbox_logf(const char *fmt, ...)
    __attribute__((format(printf, 1, 2)));

/* Access a copy of the log file path (for the launcher to inherit). */
const char *dbox_log_path(void);

#endif
