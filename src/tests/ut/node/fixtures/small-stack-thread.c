/* small-stack-thread.c — 回归探针：在挂载 libdynobox.so 的进程里创建小栈线程。
 *
 * libdynobox.so 的静态 TLS 会被 glibc 的 allocate_stack 计入线程栈最小尺寸，
 * TLS 过大时这里的 pthread_create 会返回 EINVAL(22)。逐行打印
 * "<stacksize>:<rc>"，由 node 测试断言全部为 0。
 */
#define _GNU_SOURCE
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

static void *worker(void *arg)
{
    (void)arg;
    return NULL;
}

int main(void)
{
    /* 32KB：Node/V8 平台线程的典型栈大小；64KB：glibc 判定边界的敏感区。 */
    static const size_t sizes[] = { 32768, 65536 };
    for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setstacksize(&attr, sizes[i]);
        pthread_t tid;
        int rc = pthread_create(&tid, &attr, worker, NULL);
        printf("%zu:%d\n", sizes[i], rc);
        if (rc == 0) pthread_join(tid, NULL);
        pthread_attr_destroy(&attr);
    }
    return 0;
}