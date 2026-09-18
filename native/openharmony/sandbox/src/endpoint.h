/* endpoint.h — reference decision endpoint (demo rules) */
#ifndef DYNOBOX_ENDPOINT_H
#define DYNOBOX_ENDPOINT_H

typedef struct {
    int    port;          /* HTTP TCP port, 0 = disabled */
    const char *unix_path; /* unix socket path ("" = disabled) */
    int    default_perm;  /* PERM_ALLOW / PERM_DENY */
    const char *log_file;  /* optional audit log */
    long   grant_ttl;     /* ttl (s) the demo endpoint puts into grants */
} dbox_endpoint_opts_t;

/* Blocks until SIGINT/SIGTERM. Returns 0 on clean shutdown. */
int dbox_endpoint_serve(const dbox_endpoint_opts_t *opts);

#endif
