/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/*
 * Launcher binary for the Darwin speech helper.
 *
 * macOS TCC uses a "responsible process" model: when a child process
 * requests access to a TCC-protected resource, macOS checks the
 * *responsible* process's Info.plist for NS*UsageDescription keys.
 * The responsible process is typically the topmost .app bundle in the
 * process tree (e.g. VS Code when launching from its terminal).
 *
 * This launcher uses the responsibility_spawnattrs_setdisclaim() SPI to
 * make the daemon its own responsible process, so TCC checks the
 * speech helper's own .app bundle Info.plist instead of the parent's.
 */

#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <stdio.h>

extern char **environ;

int main(int argc, char *argv[]) {
    (void)argc;

    /* Determine the directory containing this executable */
    char exec_path[4096];
    uint32_t size = sizeof(exec_path);
    if (_NSGetExecutablePath(exec_path, &size) != 0) {
        strncpy(exec_path, argv[0], sizeof(exec_path) - 1);
        exec_path[sizeof(exec_path) - 1] = '\0';
    }

    char *last_slash = strrchr(exec_path, '/');
    if (!last_slash) {
        fprintf(stderr, "[darwin-speech] cannot determine executable directory\n");
        return 1;
    }

    /* Build daemon path: <dir>/opendesk-speech-helper-daemon */
    size_t dir_len = (size_t)(last_slash - exec_path) + 1;
    if (dir_len + strlen("opendesk-speech-helper-daemon") >= sizeof(exec_path)) {
        fprintf(stderr, "[darwin-speech] executable path too long\n");
        return 1;
    }
    char daemon_path[4096];
    memcpy(daemon_path, exec_path, dir_len);
    strcpy(daemon_path + dir_len, "opendesk-speech-helper-daemon");

    /* Set up posix_spawn attributes with responsibility disclaim */
    posix_spawnattr_t attrs;
    posix_spawnattr_init(&attrs);

    /*
     * responsibility_spawnattrs_setdisclaim is a private SPI available
     * since macOS 10.10. It's used by Qt Creator and other IDEs to
     * solve the same TCC responsible-process problem.
     */
    int (*set_disclaim)(posix_spawnattr_t *, int) =
        (int (*)(posix_spawnattr_t *, int))dlsym(RTLD_DEFAULT,
            "responsibility_spawnattrs_setdisclaim");
    if (set_disclaim) {
        set_disclaim(&attrs, 1);
    } else {
        fprintf(stderr,
            "[darwin-speech] warning: responsibility_spawnattrs_setdisclaim not available\n");
    }

    /* Spawn the daemon, inheriting all file descriptors (stdio) */
    pid_t pid;
    int rc = posix_spawn(&pid, daemon_path, NULL, &attrs, argv, environ);
    posix_spawnattr_destroy(&attrs);

    if (rc != 0) {
        fprintf(stderr, "[darwin-speech] failed to spawn daemon: %s\n", strerror(rc));
        return 1;
    }

    /* Wait for the daemon and propagate its exit status */
    int status;
    waitpid(pid, &status, 0);

    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        kill(getpid(), WTERMSIG(status));
    }
    return 1;
}
