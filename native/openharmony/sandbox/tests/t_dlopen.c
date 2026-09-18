/* t_dlopen.c — dlopen execute-gate probe. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>

int main(int argc, char **argv)
{
    if (argc < 3) return 2;
    int expect_ok = !strcmp(argv[2], "ok");
    void *h = dlopen(argv[1], RTLD_NOW);
    if (expect_ok) {
        if (!h) { printf("PROBE-FAIL dlopen: %s\n", dlerror()); return 1; }
        dlclose(h);
        return 0;
    }
    if (h) { dlclose(h); printf("PROBE-FAIL dlopen succeeded\n"); return 1; }
    return 0;
}
