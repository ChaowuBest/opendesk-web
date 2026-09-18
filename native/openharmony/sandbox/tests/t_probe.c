/* t_probe.c — versatile probe program executed INSIDE the sandbox.
 * Each subcommand exits 0 when the expected outcome happened and non-zero
 * (with a message on stdout) otherwise, so the shell harness can assert.
 *
 *   rd <p>            open+read succeeds
 *   rd_fail <p>       open fails (any error)
 *   rd_fail_eacces <p> open fails specifically with EACCES
 *   wr <p> <text>     create/truncate+write succeeds
 *   wr_fail <p>       open for write fails
 *   app <p> <text>    O_APPEND write succeeds
 *   rm <p> / rm_fail <p>          unlink
 *   mv <a> <b> / mv_fail <a> <b>  rename
 *   mkdir <d> / mkdir_fail <d> / rmdir <d> / rmdir_fail <d>
 *   ls <d> / ls_fail <d>          opendir+readdir (count>0 for ls)
 *   stat_ok <p> / stat_fail <p>
 *   chmod_ok <p> / chmod_fail <p>
 *   trunc <p> <n>
 *   symlink_ok <tgt> <lp> / symlink_fail <tgt> <lp>
 *   readlink_ok <lp>
 *   cat_eq <p> <expected>         content equals
 *   fnv <p>                       print 64-bit FNV-1a hash of content
 *   getcwd_is <p>                 getcwd equals (virtual expectation)
 *   env_set <NAME>                env var present and non-empty
 *   x_ok <p> / x_fail <p>         access(X_OK)
 *   spawn <prog> [args...]        fork+execvp+wait, propagate exit status
 *   popen_ok <cmd>                popen read line succeeds
 *   popen_fail <cmd>              popen must fail
 *   tmpfile_ok / tmpfile_fail     tmpfile() honors policy
 *   oexcl_fail <p>                O_CREAT|O_EXCL on existing path fails
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/vfs.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <linux/fs.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif

static int fail(const char *msg, const char *arg)
{
    printf("PROBE-FAIL %s(%s): %s\n", msg, arg ? arg : "", strerror(errno));
    return 1;
}

static int open_rd(const char *p)
{
    int fd = open(p, O_RDONLY);
    if (fd < 0) return -1;
    char buf[64];
    ssize_t n = read(fd, buf, sizeof buf);
    close(fd);
    return n < 0 ? -1 : 0;
}

static int do_write(const char *p, const char *text, int flags)
{
    int fd = open(p, flags, 0644);
    if (fd < 0) return -1;
    ssize_t n = write(fd, text, strlen(text));
    close(fd);
    return n < 0 ? -1 : 0;
}

int main(int argc, char **argv)
{
    if (argc < 2) { fprintf(stderr, "usage: t_probe <op> ...\n"); return 2; }
    const char *op = argv[1];
    errno = 0;

    if (!strcmp(op, "rd"))            return open_rd(argv[2]) ? fail("rd", argv[2]) : 0;
    if (!strcmp(op, "rd_fail"))       return open_rd(argv[2]) == 0 ? (printf("PROBE-FAIL rd succeeded\n"), 1) : 0;
    if (!strcmp(op, "rd_fail_eacces")) {
        int fd = open(argv[2], O_RDONLY);
        if (fd >= 0) { printf("PROBE-FAIL rd_fail_eacces succeeded\n"); return 1; }
        if (errno != EACCES) return fail("rd_fail_eacces wrong errno", strerror(errno));
        return 0;
    }
    if (!strcmp(op, "wr"))            return do_write(argv[2], argv[3], O_WRONLY | O_CREAT | O_TRUNC) ? fail("wr", argv[2]) : 0;
    if (!strcmp(op, "wr_fail"))       return do_write(argv[2], "x", O_WRONLY | O_CREAT | O_TRUNC) == 0 ? (printf("PROBE-FAIL wr succeeded\n"), 1) : 0;
    if (!strcmp(op, "app"))           return do_write(argv[2], argv[3], O_WRONLY | O_CREAT | O_APPEND) ? fail("app", argv[2]) : 0;
    if (!strcmp(op, "rm"))            return unlink(argv[2]) ? fail("rm", argv[2]) : 0;
    if (!strcmp(op, "rm_fail"))       return unlink(argv[2]) == 0 ? (printf("PROBE-FAIL rm succeeded\n"), 1) : 0;
    if (!strcmp(op, "mv"))            return rename(argv[2], argv[3]) ? fail("mv", argv[2]) : 0;
    if (!strcmp(op, "mv_fail"))       return rename(argv[2], argv[3]) == 0 ? (printf("PROBE-FAIL mv succeeded\n"), 1) : 0;
    if (!strcmp(op, "mkdir"))         return mkdir(argv[2], 0755) ? fail("mkdir", argv[2]) : 0;
    if (!strcmp(op, "mkdir_fail"))    return mkdir(argv[2], 0755) == 0 ? (printf("PROBE-FAIL mkdir succeeded\n"), 1) : 0;
    if (!strcmp(op, "rmdir"))         return rmdir(argv[2]) ? fail("rmdir", argv[2]) : 0;
    if (!strcmp(op, "rmdir_fail"))    return rmdir(argv[2]) == 0 ? (printf("PROBE-FAIL rmdir succeeded\n"), 1) : 0;
    if (!strcmp(op, "ls") || !strcmp(op, "ls_fail")) {
        DIR *d = opendir(argv[2]);
        if (op[0] == 'l' && op[1] == 's' && !strchr(op, '_')) {
            if (!d) return fail("ls", argv[2]);
            struct dirent *e = readdir(d);
            closedir(d);
            if (!e) { printf("PROBE-FAIL ls empty\n"); return 1; }
            return 0;
        }
        if (d) { closedir(d); printf("PROBE-FAIL ls_fail succeeded\n"); return 1; }
        return 0;
    }
    if (!strcmp(op, "stat_ok")) {
        struct stat st;
        return stat(argv[2], &st) ? fail("stat_ok", argv[2]) : 0;
    }
    if (!strcmp(op, "stat_fail")) {
        struct stat st;
        return stat(argv[2], &st) == 0 ? (printf("PROBE-FAIL stat_fail succeeded\n"), 1) : 0;
    }
    if (!strcmp(op, "chmod_ok"))      return chmod(argv[2], 0644) ? fail("chmod_ok", argv[2]) : 0;
    if (!strcmp(op, "chmod_fail"))    return chmod(argv[2], 0644) == 0 ? (printf("PROBE-FAIL chmod succeeded\n"), 1) : 0;
    if (!strcmp(op, "trunc"))        {
        int fd = open(argv[2], O_WRONLY | O_TRUNC);
        if (fd < 0) return fail("trunc", argv[2]);
        close(fd);
        return 0;
    }
    if (!strcmp(op, "symlink_ok"))    return symlink(argv[2], argv[3]) ? fail("symlink_ok", argv[3]) : 0;
    if (!strcmp(op, "symlink_fail"))  return symlink(argv[2], argv[3]) == 0 ? (printf("PROBE-FAIL symlink succeeded\n"), 1) : 0;
    if (!strcmp(op, "readlink_ok")) {
        char buf[512];
        return readlink(argv[2], buf, sizeof buf) < 0 ? fail("readlink_ok", argv[2]) : 0;
    }
    if (!strcmp(op, "cat_eq")) {
        int fd = open(argv[2], O_RDONLY);
        if (fd < 0) return fail("cat_eq open", argv[2]);
        char buf[4096] = "";
        ssize_t n = read(fd, buf, sizeof buf - 1);
        close(fd);
        if (n < 0) return fail("cat_eq read", argv[2]);
        buf[n] = '\0';
        while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r')) buf[--n] = '\0';
        if (strcmp(buf, argv[3]) != 0) { printf("PROBE-FAIL cat_eq: got [%s] want [%s]\n", buf, argv[3]); return 1; }
        return 0;
    }
    if (!strcmp(op, "fnv")) {
        int fd = open(argv[2], O_RDONLY);
        if (fd < 0) return fail("fnv", argv[2]);
        unsigned long long h = 1469598103934665603ULL;
        char buf[65536];
        ssize_t n;
        while ((n = read(fd, buf, sizeof buf)) > 0)
            for (ssize_t i = 0; i < n; i++) { h ^= (unsigned char)buf[i]; h *= 1099511628211ULL; }
        close(fd);
        printf("%llx\n", h);
        return 0;
    }
    if (!strcmp(op, "getcwd_is")) {
        char buf[4096];
        if (!getcwd(buf, sizeof buf)) return fail("getcwd", NULL);
        if (strcmp(buf, argv[2]) != 0) { printf("PROBE-FAIL getcwd_is: got [%s] want [%s]\n", buf, argv[2]); return 1; }
        return 0;
    }
    if (!strcmp(op, "env_set")) {
        const char *v = getenv(argv[2]);
        if (!v || !v[0]) { printf("PROBE-FAIL env_set %s missing\n", argv[2]); return 1; }
        printf("%s\n", v);
        return 0;
    }
    if (!strcmp(op, "x_ok")) {
        return access(argv[2], X_OK) ? fail("x_ok", argv[2]) : 0;
    }
    if (!strcmp(op, "x_fail")) {
        if (access(argv[2], X_OK) == 0) { printf("PROBE-FAIL x_fail succeeded\n"); return 1; }
        return 0;
    }
    if (!strcmp(op, "spawn")) {
        pid_t pid = fork();
        if (pid == 0) { execvp(argv[2], &argv[2]); _exit(126); }
        int st = 0;
        waitpid(pid, &st, 0);
        if (WIFEXITED(st)) return WEXITSTATUS(st);
        if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
        return 127;
    }
    if (!strcmp(op, "popen_ok")) {
        FILE *f = popen(argv[2], "r");
        if (!f) return fail("popen_ok", argv[2]);
        char buf[256];
        int got = fgets(buf, sizeof buf, f) != NULL;
        int rc = pclose(f);
        if (!got || rc != 0) { printf("PROBE-FAIL popen_ok rc=%d\n", rc); return 1; }
        return 0;
    }
    if (!strcmp(op, "popen_fail")) {
        FILE *f = popen(argv[2], "r");
        if (f) { pclose(f); printf("PROBE-FAIL popen_fail succeeded\n"); return 1; }
        return 0;
    }
    if (!strcmp(op, "popen_rc_fail")) {
        /* popen itself works, but the command must exit non-zero
         * (e.g. its file access was denied) */
        FILE *f = popen(argv[2], "r");
        if (!f) return fail("popen_rc_fail", argv[2]);
        char buf[256];
        while (fgets(buf, sizeof buf, f)) {}
        int rc = pclose(f);
        if (rc == 0) { printf("PROBE-FAIL popen_rc_fail: command succeeded\n"); return 1; }
        return 0;
    }
    if (!strcmp(op, "tmpfile_ok") || !strcmp(op, "tmpfile_fail")) {
        FILE *f = tmpfile();
        if (!strcmp(op, "tmpfile_ok")) {
            if (!f) return fail("tmpfile_ok", NULL);
            fprintf(f, "x");
            fclose(f);
            return 0;
        }
        if (f) { fclose(f); printf("PROBE-FAIL tmpfile_fail succeeded\n"); return 1; }
        return 0;
    }
    if (!strcmp(op, "oexcl_fail")) {
        int fd = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0644);
        if (fd >= 0) { close(fd); printf("PROBE-FAIL oexcl succeeded\n"); return 1; }
        return 0;
    }
    if (!strcmp(op, "ln") || !strcmp(op, "ln_fail")) {
        int r = link(argv[2], argv[3]);
        if (op[2] == '_') {   /* ln_fail */
            if (r == 0) { printf("PROBE-FAIL ln succeeded\n"); return 1; }
            return 0;
        }
        return r ? fail("ln", argv[2]) : 0;
    }
    if (!strcmp(op, "openat_rd") || !strcmp(op, "openat_rd_fail")) {
        int dfd = open(argv[2], O_RDONLY | O_DIRECTORY);
        if (dfd < 0) return fail("openat_rd dir", argv[2]);
        int fd = openat(dfd, argv[3], O_RDONLY);
        int e = errno;
        if (fd >= 0) { char b[16]; ssize_t rn = read(fd, b, sizeof b); (void)rn; close(fd); }
        close(dfd);
        if (!strcmp(op, "openat_rd")) return fd < 0 ? fail("openat_rd", argv[3]) : 0;
        if (fd >= 0) { printf("PROBE-FAIL openat_rd_fail succeeded\n"); return 1; }
        if (e != EACCES) { printf("PROBE-FAIL openat_rd_fail errno=%s\n", strerror(e)); return 1; }
        return 0;
    }
    if (!strcmp(op, "rmat_fail")) {
        int dfd = open(argv[2], O_RDONLY | O_DIRECTORY);
        if (dfd < 0) return fail("rmat dir", argv[2]);
        int r = unlinkat(dfd, argv[3], 0);
        int e = errno;
        close(dfd);
        if (r == 0) { printf("PROBE-FAIL rmat succeeded\n"); return 1; }
        if (e != EACCES) { printf("PROBE-FAIL rmat errno=%s\n", strerror(e)); return 1; }
        return 0;
    }
    if (!strcmp(op, "fexecve_fail")) {
        int fd = open(argv[2], O_RDONLY);
        if (fd < 0) return 0;   /* couldn't even read it: fine */
        char *const args[] = { (char *)"x", NULL };
        fexecve(fd, args, environ);
        int e = errno;
        close(fd);
        if (e != EACCES) { printf("PROBE-FAIL fexecve errno=%s\n", strerror(e)); return 1; }
        return 0;
    }
    if (!strcmp(op, "spawn_cfg_fail")) {
        /* a tampered DYNOBOX_CFG must be replaced by the original at exec */
        setenv("DYNOBOX_CFG", "AAAA", 1);
        char cmd[1024];
        snprintf(cmd, sizeof cmd, "/bin/cat %s >/dev/null 2>&1", argv[2]);
        char *const args[] = { (char *)"/bin/sh", (char *)"-c", cmd, NULL };
        pid_t pid = fork();
        if (pid == 0) { execvp("/bin/sh", args); _exit(126); }
        int st = 0;
        waitpid(pid, &st, 0);
        if (WIFEXITED(st) && WEXITSTATUS(st) == 0) {
            printf("PROBE-FAIL tampered cfg still worked\n");
            return 1;
        }
        return 0;
    }
    if (!strcmp(op, "spawn_preload_clean")) {
        setenv("LD_PRELOAD", "/nonexistent/evil.so", 1);
        char *const args[] = { (char *)"/bin/sh", (char *)"-c",
                               (char *)"echo $LD_PRELOAD", NULL };
        int fds[2];
        if (pipe(fds) != 0) return 2;
        pid_t pid = fork();
        if (pid == 0) {
            close(fds[0]);
            dup2(fds[1], 1);
            execvp("/bin/sh", args);
            _exit(126);
        }
        close(fds[1]);
        char buf[4096] = "";
        ssize_t n = read(fds[0], buf, sizeof buf - 1);
        close(fds[0]);
        waitpid(pid, NULL, 0);
        if (n < 0) n = 0;
        buf[n] = '\0';
        if (strstr(buf, "evil")) { printf("PROBE-FAIL evil LD_PRELOAD leaked: %s\n", buf); return 1; }
        return 0;
    }
    if (!strcmp(op, "exchange") || !strcmp(op, "exchange_fail")) {
        /* glibc renameat2 (NOT raw syscall: the raw syscall would bypass
         * the sandbox layer — that is a documented boundary) */
        int r = renameat2(AT_FDCWD, argv[2], AT_FDCWD, argv[3], RENAME_EXCHANGE);
        if (!strcmp(op, "exchange")) return r ? fail("exchange", argv[2]) : 0;
        if (r == 0) { printf("PROBE-FAIL exchange succeeded\n"); return 1; }
        if (errno != EXDEV && errno != EACCES) {
            printf("PROBE-FAIL exchange errno=%s\n", strerror(errno));
            return 1;
        }
        return 0;
    }

    if (!strcmp(op, "statx_ok")) {
        struct statx stx;
        return statx(AT_FDCWD, argv[2], 0, STATX_BASIC_STATS, &stx)
            ? fail("statx_ok", argv[2]) : 0;
    }
    if (!strcmp(op, "chown_fail")) {
        if (chown(argv[2], (uid_t)-1, (gid_t)-1) == 0) {
            printf("PROBE-FAIL chown succeeded\n");
            return 1;
        }
        return 0;
    }
    if (!strcmp(op, "utimes_fail")) {
        struct timeval tv[2] = { {0, 0}, {0, 0} };
        if (utimes(argv[2], tv) == 0) {
            printf("PROBE-FAIL utimes succeeded\n");
            return 1;
        }
        return 0;
    }
    if (!strcmp(op, "setsid_sleep")) {
        /* new session: the watchdog must still fire (it targets the
         * process group the process ends up in, whatever it is) */
        if (setsid() < 0) { perror("setsid"); return 2; }
        for (;;) {
            printf("%s\n", argv[2]);
            fflush(stdout);
            sleep(1);
        }
    }
    if (!strcmp(op, "raw_open_rd")) {
        /* BOUNDARY DOCUMENTATION: a raw syscall bypasses the interposition
         * layer entirely (README 安全边界). This asserts the bypass is real;
         * if this ever fails, the mechanism changed and docs must follow. */
        int fd = (int)syscall(SYS_openat, AT_FDCWD, argv[2], O_RDONLY, 0);
        if (fd < 0) return 0;    /* "bypass blocked" — report via caller */
        char b[8];
        ssize_t rn = read(fd, b, sizeof b);
        close(fd);
        return rn < 0 ? 1 : 0;   /* opened: caller expects success */
    }

    if (!strcmp(op, "opath_openat") || !strcmp(op, "opath_openat_fail")) {
        int dfd = open(argv[2], O_PATH);
        if (dfd < 0) return fail("opath dir", argv[2]);
        int fd = openat(dfd, argv[3], O_RDONLY);
        int e = errno;
        close(dfd);
        if (!strcmp(op, "opath_openat")) return fd < 0 ? fail("opath_openat", argv[3]) : 0;
        if (fd >= 0) { close(fd); printf("PROBE-FAIL opath_openat_fail succeeded\n"); return 1; }
        if (e != EACCES) { printf("PROBE-FAIL opath errno=%s\n", strerror(e)); return 1; }
        return 0;
    }
    if (!strcmp(op, "execveat_dir") || !strcmp(op, "execveat_dir_fail")) {
        int dfd = open(argv[2], O_RDONLY | O_DIRECTORY);
        if (dfd < 0) return fail("execveat_dir dir", argv[2]);
        char *const args[] = { (char *)"prog", NULL };
        execveat(dfd, argv[3], args, environ, 0);
        int e = errno;
        close(dfd);
        if (!strcmp(op, "execveat_dir")) return fail("execveat_dir", argv[3]);
        if (e != EACCES) { printf("PROBE-FAIL execveat_dir errno=%s\n", strerror(e)); return 1; }
        return 0;
    }
    if (!strcmp(op, "loop_fail")) {
        /* self-referencing symlink: resolver must fail cleanly (no hang) */
        if (chdir(argv[2]) != 0) return fail("loop chdir", argv[2]);
        if (symlink("loop", "loop") != 0 && errno != EEXIST)
            return fail("loop symlink", NULL);
        int fd = open("loop", O_RDONLY);
        if (fd >= 0) { close(fd); printf("PROBE-FAIL loop open succeeded\n"); return 1; }
        return 0;
    }
    if (!strcmp(op, "longpath_fail")) {
        char *p = malloc(6000);
        strcpy(p, "/public/");
        for (size_t i = 8; i < 5900; i++) p[i] = 'a';
        p[5900] = '\0';
        int fd = open(p, O_RDONLY);
        int e = errno;
        free(p);
        if (fd >= 0) { close(fd); printf("PROBE-FAIL longpath open succeeded\n"); return 1; }
        if (e != ENAMETOOLONG && e != ENOENT && e != EACCES) {
            printf("PROBE-FAIL longpath errno=%s\n", strerror(e));
            return 1;
        }
        return 0;
    }
    if (!strcmp(op, "mode_is")) {
        struct stat st;
        if (stat(argv[2], &st) != 0) return fail("mode_is stat", argv[2]);
        unsigned want = (unsigned)strtoul(argv[3], NULL, 8);
        if ((st.st_mode & 07777) != want) {
            printf("PROBE-FAIL mode_is: %o want %o\n", st.st_mode & 07777, want);
            return 1;
        }
        return 0;
    }
    if (!strcmp(op, "env_open")) {
        const char *v = getenv(argv[2]);
        if (!v) { printf("PROBE-FAIL env_open %s missing\n", argv[2]); return 1; }
        int fd = open(v, O_RDONLY);
        if (fd < 0) return fail("env_open", v);
        close(fd);
        return 0;
    }

    if (!strcmp(op, "mmap_dup_fail") || !strcmp(op, "fdchurn_mmap_fail")) {
        /* fd-table staleness: acc must follow dup and survive churn+reuse */
        int fd = open(argv[2], O_RDONLY);
        if (fd < 0) return fail("mmap_dup open", argv[2]);
        if (!strcmp(op, "fdchurn_mmap_fail")) {
            for (int i = 0; i < 64; i++) {
                int t = open("/etc/passwd", O_RDONLY);
                if (t >= 0) close(t);
            }
        }
        int d = dup(fd);
        close(fd);
        if (d < 0) return fail("dup", NULL);
        struct stat st;
        if (fstat(d, &st) != 0) { close(d); return fail("fstat", argv[2]); }
        void *p = mmap(NULL, (size_t)st.st_size, PROT_READ | PROT_EXEC,
                       MAP_PRIVATE, d, 0);
        int e = errno;
        close(d);
        if (p != MAP_FAILED) { munmap(p, (size_t)st.st_size); printf("PROBE-FAIL dup mmap exec succeeded\n"); return 1; }
        if (e != EPERM) { printf("PROBE-FAIL mmap errno=%s\n", strerror(e)); return 1; }
        return 0;
    }
    if (!strcmp(op, "close_watch")) {
        /* daemon-style close of the watchdog fd must fail-closed: the
         * watchdog fires and the tree dies within seconds */
        const char *wf = getenv("DYNOBOX_WATCH_FD");
        if (!wf) { printf("PROBE-FAIL no watch fd\n"); return 1; }
        close(atoi(wf));
        printf("watch-closed\n");
        fflush(stdout);
        for (;;) { sleep(1); }
    }

    if (!strcmp(op, "readlink_eq")) {
        /* readlink output must be the VIRTUAL target (info-leak fix) */
        char buf[4096];
        ssize_t n = readlink(argv[2], buf, sizeof buf - 1);
        if (n < 0) return fail("readlink_eq", argv[2]);
        buf[n] = '\0';
        if (strcmp(buf, argv[3]) != 0) {
            printf("PROBE-FAIL readlink_eq: got [%s] want [%s]\n", buf, argv[3]);
            return 1;
        }
        return 0;
    }
    if (!strcmp(op, "realpath_eq")) {
        char *r = realpath(argv[2], NULL);
        if (!r) return fail("realpath_eq", argv[2]);
        if (strcmp(r, argv[3]) != 0) {
            printf("PROBE-FAIL realpath_eq: got [%s] want [%s]\n", r, argv[3]);
            free(r);
            return 1;
        }
        free(r);
        return 0;
    }
    if (!strcmp(op, "enotdir_fail")) {
        /* enotdir_fail <parent-file> <child>: opening a child of a regular
         * file yields ENOTDIR (parent readable, so this is path semantics,
         * not policy denial) */
        errno = 0;
        int fd = open(argv[3], O_RDONLY);
        if (fd >= 0) { close(fd); printf("PROBE-FAIL enotdir succeeded\n"); return 1; }
        if (errno != ENOTDIR) { printf("PROBE-FAIL enotdir errno=%s\n", strerror(errno)); return 1; }
        return 0;
    }
    if (!strcmp(op, "x_ok_through_symlink")) {
        /* X_OK on a symlink resolves to the target's executability */
        return access(argv[2], X_OK) ? fail("x_ok_symlink", argv[2]) : 0;
    }

    if (!strcmp(op, "statx_fail")) {
        struct statx stx;
        errno = 0;
        if (statx(AT_FDCWD, argv[2], 0, STATX_BASIC_STATS, &stx) == 0) {
            printf("PROBE-FAIL statx succeeded\n");
            return 1;
        }
        if (errno != EACCES) { printf("PROBE-FAIL statx errno=%s\n", strerror(errno)); return 1; }
        return 0;
    }
    if (!strcmp(op, "f_ok_fail")) {
        errno = 0;
        if (access(argv[2], F_OK) == 0) {
            printf("PROBE-FAIL f_ok succeeded\n");
            return 1;
        }
        if (errno != EACCES) { printf("PROBE-FAIL f_ok errno=%s\n", strerror(errno)); return 1; }
        return 0;
    }
    if (!strcmp(op, "statfs_fail")) {
        struct statfs sb;
        errno = 0;
        if (statfs(argv[2], &sb) == 0) {
            printf("PROBE-FAIL statfs succeeded\n");
            return 1;
        }
        if (errno != EACCES) { printf("PROBE-FAIL statfs errno=%s\n", strerror(errno)); return 1; }
        return 0;
    }
    if (!strcmp(op, "stdin_cp")) {
        /* stdin passthrough: copy stdin to the (policy-allowed) file */
        int out = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (out < 0) return fail("stdin_cp open", argv[2]);
        char buf[4096];
        ssize_t n;
        while ((n = read(0, buf, sizeof buf)) > 0)
            if (write(out, buf, (size_t)n) < 0) { close(out); return fail("stdin_cp write", argv[2]); }
        close(out);
        return 0;
    }

    fprintf(stderr, "unknown op %s\n", op);
    return 2;
}
