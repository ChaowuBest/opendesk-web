/* adv_helper.c — 对抗测试用的第三方库。
 *
 * 库内部直接调用 open()/read()，用于验证「经 dlopen 载入的第三方库内部
 * 发起的文件访问」是否与主程序一样受策略管控。由 t_adversarial 的
 * dlopen-lib 手段载入。
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <unistd.h>
#include <string.h>

int adv_read_helper(const char *p)
{
    int fd = open(p, O_RDONLY);
    if (fd < 0) return 0;
    char b[64];
    ssize_t n = read(fd, b, sizeof b - 1);
    close(fd);
    if (n <= 0) return 0;
    b[n] = 0;
    return strstr(b, "TOP-SECRET") != NULL;
}
