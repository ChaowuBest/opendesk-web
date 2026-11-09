/*
 * t_io_storm.c — 小文件创建/写入风暴压测探针。
 *
 * 模拟 tar 解压、npm/ohpm 安装、工具链解包这类"大量 O_CREAT 写"负载：
 * 对每个文件执行 open(O_CREAT|O_WRONLY|O_TRUNC) -> write -> close，
 * 最后 unlink 清理。与 t_stat_storm（属性访问风暴）互补，二者共同覆盖
 * 沙箱拦截层的两条热路径。
 *
 * 用法:
 *   t_io_storm <dir> <count> [depth]
 *     <dir>    目标目录（必须已存在且可写）
 *     <count>  创建的文件数（>0）
 *     <depth>  在 dir 下额外创建的嵌套目录层数（默认 0），用于模拟深层路径
 * 输出（单行，便于脚本提取）:
 *   IOSTORM files=<文件数> elapsed_ms=<毫秒> files_per_sec=<整数>
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>
#include <sys/stat.h>

#define MAXP 4096

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: t_io_storm <dir> <count> [depth]\n");
        return 2;
    }
    const char *dir = argv[1];
    int count = atoi(argv[2]);
    int depth = argc > 3 ? atoi(argv[3]) : 0;
    if (count <= 0) { fprintf(stderr, "count must be > 0\n"); return 2; }

    char base[MAXP];
    int n = snprintf(base, sizeof base, "%s", dir);
    if (n < 0 || (size_t)n >= sizeof base) { fprintf(stderr, "dir too long\n"); return 2; }
    for (int d = 0; d < depth; d++) {
        size_t l = strlen(base);
        int w = snprintf(base + l, sizeof base - l, "/d%d", d);
        if (w < 0 || (size_t)w >= sizeof base - l) { fprintf(stderr, "path too long\n"); return 2; }
        if (mkdir(base, 0755) != 0 && errno != EEXIST) { perror("mkdir"); return 1; }
    }

    struct timespec t0, t1;
    if (clock_gettime(CLOCK_MONOTONIC, &t0) != 0) { perror("clock_gettime"); return 1; }

    static const char payload[] = "0123456789abcdef";
    char p[MAXP];
    for (int i = 0; i < count; i++) {
        int w = snprintf(p, sizeof p, "%s/f%06d.dat", base, i);
        if (w < 0 || (size_t)w >= sizeof p) { fprintf(stderr, "path too long\n"); return 1; }
        int fd = open(p, O_CREAT | O_WRONLY | O_TRUNC, 0644);
        if (fd < 0) { perror("open"); return 1; }
        if (write(fd, payload, sizeof payload - 1) < 0) { perror("write"); close(fd); return 1; }
        if (close(fd) != 0) { perror("close"); return 1; }
    }

    if (clock_gettime(CLOCK_MONOTONIC, &t1) != 0) { perror("clock_gettime"); return 1; }
    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 +
                (t1.tv_nsec - t0.tv_nsec) / 1e6;

    for (int i = 0; i < count; i++) {
        snprintf(p, sizeof p, "%s/f%06d.dat", base, i);
        unlink(p);
    }

    long per_sec = ms > 0.0 ? (long)(count * 1000.0 / ms) : 0;
    printf("IOSTORM files=%d elapsed_ms=%.1f files_per_sec=%ld\n", count, ms, per_sec);
    return 0;
}
