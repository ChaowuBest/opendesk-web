/* t_mmap.c — mmap(PROT_EXEC) gate probe: maps a file it may read but may
 * not execute. Expects EPERM. With `allow` argument, expects success. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <sys/mman.h>
#include <sys/stat.h>

int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    int expect_ok = argc > 2 && !strcmp(argv[2], "allow");
    int fd = open(argv[1], O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }
    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size < 8) { fprintf(stderr, "bad file\n"); return 1; }
    void *p = mmap(NULL, (size_t)st.st_size, PROT_READ | PROT_EXEC, MAP_PRIVATE, fd, 0);
    int e = errno;
    close(fd);
    if (expect_ok) {
        if (p == MAP_FAILED) { printf("PROBE-FAIL mmap denied: %s\n", strerror(e)); return 1; }
        munmap(p, (size_t)st.st_size);
        return 0;
    }
    if (p != MAP_FAILED) { munmap(p, (size_t)st.st_size); printf("PROBE-FAIL mmap succeeded\n"); return 1; }
    if (e != EPERM) { printf("PROBE-FAIL wrong errno %s\n", strerror(e)); return 1; }
    return 0;
}
