/*
 * t_stat_storm.c — 文件属性访问风暴压测探针。
 *
 * 模拟构建工具链 / LLM 工具的高频属性访问：对若干路径反复执行
 * stat / lstat / access / realpath / open(+close)，统计总调用数与
 * 墙钟耗时，输出 ops/s。用于对比"宿主直跑"与"沙箱内运行"的性能退化
 * （对标 Windows 侧 npm run test 宿主 92s / 沙箱 117.5s +27.7% 的记录方式）。
 *
 * 用法:
 *   t_stat_storm <rounds> <path> [path ...]
 *     <rounds>  每条路径的重复轮数（>0）
 * 输出（单行，便于脚本提取）:
 *   STORM ops=<总调用数> elapsed_ms=<毫秒> ops_per_sec=<整数>
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <sys/stat.h>

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: t_stat_storm <rounds> <path> [path ...]\n");
        return 2;
    }
    int rounds = atoi(argv[1]);
    if (rounds <= 0) { fprintf(stderr, "rounds must be > 0\n"); return 2; }
    int npaths = argc - 2;
    char **paths = argv + 2;

    struct timespec t0, t1;
    if (clock_gettime(CLOCK_MONOTONIC, &t0) != 0) { perror("clock_gettime"); return 1; }

    long ops = 0;
    struct stat st;
    char buf[4096];
    for (int r = 0; r < rounds; r++) {
        for (int i = 0; i < npaths; i++) {
            const char *p = paths[i];
            stat(p, &st);            ops++;
            lstat(p, &st);           ops++;
            access(p, F_OK);         ops++;
            realpath(p, buf);        ops++;
            int fd = open(p, O_RDONLY);
            if (fd >= 0) { close(fd); }
            ops++;
        }
    }

    if (clock_gettime(CLOCK_MONOTONIC, &t1) != 0) { perror("clock_gettime"); return 1; }
    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 +
                (t1.tv_nsec - t0.tv_nsec) / 1e6;
    long ops_per_sec = ms > 0.0 ? (long)(ops * 1000.0 / ms) : 0;
    printf("STORM ops=%ld elapsed_ms=%.1f ops_per_sec=%ld\n", ops, ms, ops_per_sec);
    return 0;
}