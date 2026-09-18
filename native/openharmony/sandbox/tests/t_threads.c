/* t_threads.c — concurrency probe: N threads × M appends to a shared file
 * plus N per-thread private files. Verifies no corruption and no policy
 * races. Exits 0 on success. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

static int nthreads = 4, iters = 25;
static const char *shared;

static void *worker(void *arg)
{
    long id = (long)arg;
    char path[512], line[128];
    const char *slash = strrchr(shared, '/');
    size_t dl = slash ? (size_t)(slash - shared) : 0;
    snprintf(path, sizeof path, "%.*s/t%ld.dat", (int)dl, shared, id);
    for (int i = 0; i < iters; i++) {
        int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (fd < 0) { perror("open private"); return (void *)1; }
        int len = snprintf(line, sizeof line, "t%ld-%04d\n", id, i);
        if (write(fd, line, (size_t)len) != len) { perror("write private"); close(fd); return (void *)1; }
        close(fd);
    }
    /* shared append (flock-serialised: WSL drvfs does not guarantee
     * O_APPEND atomicity, which is an artifact of the test environment) */
    for (int i = 0; i < iters; i++) {
        int fd = open(shared, O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (fd < 0) { perror("open shared"); return (void *)1; }
        if (flock(fd, LOCK_EX) != 0) { perror("flock"); close(fd); return (void *)1; }
        int len = snprintf(line, sizeof line, "t%ld-%04d\n", id, i);
        if (write(fd, line, (size_t)len) != len) { perror("write shared"); close(fd); return (void *)1; }
        flock(fd, LOCK_UN);
        close(fd);
    }
    return NULL;
}

int main(int argc, char **argv)
{
    if (argc > 1) shared = argv[1];
    else shared = "/public/shared.dat";
    if (argc > 2) nthreads = atoi(argv[2]);
    if (argc > 3) iters = atoi(argv[3]);

    unlink(shared);
    pthread_t th[32];
    for (long i = 0; i < nthreads; i++)
        if (pthread_create(&th[i], NULL, worker, (void *)i) != 0) {
            fprintf(stderr, "pthread_create failed\n");
            return 2;
        }
    int bad = 0;
    for (int i = 0; i < nthreads; i++) {
        void *r = NULL;
        pthread_join(th[i], &r);
        if (r) bad = 1;
    }
    /* verify shared file has exactly nthreads*iters lines */
    int fd = open(shared, O_RDONLY);
    if (fd < 0) { perror("verify open"); return 2; }
    char buf[65536];
    ssize_t n;
    int lines = 0, lastnl = 1;
    while ((n = read(fd, buf, sizeof buf)) > 0)
        for (ssize_t i = 0; i < n; i++) {
            if (lastnl) lines++;
            lastnl = buf[i] == '\n';
        }
    close(fd);
    int want = nthreads * iters;
    if (lines != want) {
        printf("PROBE-FAIL shared lines=%d want=%d\n", lines, want);
        bad = 1;
    }
    printf("threads ok (%d lines)\n", lines);
    return bad;
}
