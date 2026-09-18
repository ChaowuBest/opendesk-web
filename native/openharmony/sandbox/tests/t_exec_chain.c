/* t_exec_chain.c — process-tree probe for governance tests.
 * t_exec_chain <self> <depth> <marker> [sleep]
 * Each level prints MARKER-<pid>, then forks a child that execs itself
 * with depth-1 (so the tree has `depth` distinct processes). The deepest
 * level re-prints every second when the sleep argument is present, so the
 * harness can verify the whole tree died. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

int main(int argc, char **argv)
{
    if (argc < 4) { fprintf(stderr, "usage: t_exec_chain <self> <depth> <marker> [sleep]\n"); return 2; }
    const char *self = argv[1];
    int depth = atoi(argv[2]);
    const char *marker = argv[3];

    printf("%s-%d\n", marker, (int)getpid());
    fflush(stdout);

    if (depth > 1) {
        char next[16];
        snprintf(next, sizeof next, "%d", depth - 1);
        pid_t pid = fork();
        if (pid < 0) { perror("fork"); return 2; }
        if (pid == 0) {
            if (argc > 4)
                execl(self, "t_exec_chain", self, next, marker, argv[4], (char *)NULL);
            else
                execl(self, "t_exec_chain", self, next, marker, (char *)NULL);
            perror("execl");
            _exit(126);
        }
        int st = 0;
        waitpid(pid, &st, 0);
        if (WIFEXITED(st) && WEXITSTATUS(st) != 0) return WEXITSTATUS(st);
    }

    if (argc > 4) {
        for (;;) {
            sleep(1);
            printf("%s-%d\n", marker, (int)getpid());
            fflush(stdout);
        }
    }
    return 0;
}
