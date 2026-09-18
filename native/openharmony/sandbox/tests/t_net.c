/* t_net.c — network policy probe.
 *   udp_connect <ip> <port>   connect(2) a UDP socket (no packets sent);
 *                             exit 0 when connect succeeds
 *   udp_connect_fail <ip> <port>  expect EACCES
 *   tcp_connect <ip> <port>   real TCP connect; exit 0 on success
 *   tcp_connect_fail <ip> <port>  expect EACCES (fast, policy-level)
 *   bind_ok / bind_fail <ip> <port>
 *   unix_ok                   AF_UNIX socketpair works even in deny mode
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

static int ip_version(const char *ip)
{
    return strchr(ip, ':') ? AF_INET6 : AF_INET;
}

static int try_connect(const char *ip, int port, int tcp)
{
    int dom = ip_version(ip);
    int type = tcp ? SOCK_STREAM : SOCK_DGRAM;
    int fd = socket(dom, type, 0);
    if (fd < 0) return -1;
    int r;
    if (dom == AF_INET) {
        struct sockaddr_in sa;
        memset(&sa, 0, sizeof sa);
        sa.sin_family = AF_INET;
        sa.sin_port = htons((uint16_t)port);
        inet_pton(AF_INET, ip, &sa.sin_addr);
        r = connect(fd, (struct sockaddr *)&sa, sizeof sa);
    } else {
        struct sockaddr_in6 sa;
        memset(&sa, 0, sizeof sa);
        sa.sin6_family = AF_INET6;
        sa.sin6_port = htons((uint16_t)port);
        inet_pton(AF_INET6, ip, &sa.sin6_addr);
        r = connect(fd, (struct sockaddr *)&sa, sizeof sa);
    }
    int e = errno;
    close(fd);
    errno = e;
    return r;
}

static int try_bind(const char *ip, int port)
{
    int dom = ip_version(ip);
    int fd = socket(dom, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    int r;
    if (dom == AF_INET) {
        struct sockaddr_in sa;
        memset(&sa, 0, sizeof sa);
        sa.sin_family = AF_INET;
        sa.sin_port = htons((uint16_t)port);
        inet_pton(AF_INET, ip, &sa.sin_addr);
        r = bind(fd, (struct sockaddr *)&sa, sizeof sa);
    } else {
        struct sockaddr_in6 sa;
        memset(&sa, 0, sizeof sa);
        sa.sin6_family = AF_INET6;
        sa.sin6_port = htons((uint16_t)port);
        inet_pton(AF_INET6, ip, &sa.sin6_addr);
        r = bind(fd, (struct sockaddr *)&sa, sizeof sa);
    }
    int e = errno;
    close(fd);
    errno = e;
    return r;
}

int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    errno = 0;
    if (!strcmp(argv[1], "udp_connect"))
        return try_connect(argv[2], atoi(argv[3]), 0) ? 1 : 0;
    if (!strcmp(argv[1], "udp_connect_fail")) {
        if (try_connect(argv[2], atoi(argv[3]), 0) == 0) { printf("PROBE-FAIL udp_connect succeeded\n"); return 1; }
        if (errno != EACCES) { printf("PROBE-FAIL wrong errno %s\n", strerror(errno)); return 1; }
        return 0;
    }
    if (!strcmp(argv[1], "tcp_connect")) {
        return try_connect(argv[2], atoi(argv[3]), 1) ? 1 : 0;
    }
    if (!strcmp(argv[1], "tcp_connect_fail")) {
        if (try_connect(argv[2], atoi(argv[3]), 1) == 0) { printf("PROBE-FAIL tcp_connect succeeded\n"); return 1; }
        if (errno != EACCES) { printf("PROBE-FAIL wrong errno %s\n", strerror(errno)); return 1; }
        return 0;
    }
    if (!strcmp(argv[1], "bind_ok"))
        return try_bind(argv[2], atoi(argv[3])) ? 1 : 0;
    if (!strcmp(argv[1], "bind_fail")) {
        if (try_bind(argv[2], atoi(argv[3])) == 0) { printf("PROBE-FAIL bind succeeded\n"); return 1; }
        if (errno != EACCES) { printf("PROBE-FAIL wrong errno %s\n", strerror(errno)); return 1; }
        return 0;
    }
    if (!strcmp(argv[1], "unix_ok")) {
        int sv[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) return 1;
        if (write(sv[0], "x", 1) < 0) return 1;
        char c;
        int r = read(sv[1], &c, 1) == 1;
        close(sv[0]); close(sv[1]);
        return r ? 0 : 1;
    }
    return 2;
}
