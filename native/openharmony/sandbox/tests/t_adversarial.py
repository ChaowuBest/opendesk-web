#!/usr/bin/env python3
"""t_adversarial.py — Python 侧的对抗性边界探针（在沙箱内运行）。

与 t_adversarial.c 同一套约定：
    must-block : 正常 Python API，策略必须拦住
    boundary   : README 已声明的机制限制（ctypes 直接发系统调用）
退出码 0 = 与预期一致，1 = 不一致。

用法: t_adversarial.py <technique> <sentinel> <allow-dir>
"""
import ctypes
import os
import platform
import subprocess
import sys

MARK = b"TOP-SECRET"

# SYS_openat（本探针只需这一个，按架构取号）
SYS_OPENAT = {"aarch64": 56, "arm64": 56, "x86_64": 257}.get(
    platform.machine(), 257)


def finish(tech, expect_blocked, leaked):
    print("ADV %-16s expect=%-10s result=%s" % (
        tech,
        "must-block" if expect_blocked else "boundary",
        "leaked" if leaked else "blocked"))
    ok = (not leaked) if expect_blocked else leaked
    sys.exit(0 if ok else 1)


def read_fd(fd):
    try:
        return MARK in os.read(fd, 256)
    except OSError:
        return False


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    tech, sent, allow = sys.argv[1], sys.argv[2], sys.argv[3]

    if tech == "py-open":
        try:
            with open(sent, "rb") as f:
                finish(tech, True, MARK in f.read(256))
        except OSError:
            finish(tech, True, False)

    if tech == "py-os-open":
        try:
            fd = os.open(sent, os.O_RDONLY)
        except OSError:
            finish(tech, True, False)
        r = read_fd(fd)
        os.close(fd)
        finish(tech, True, r)

    if tech == "py-stat":
        try:
            os.stat(sent)
            finish(tech, True, True)
        except OSError:
            finish(tech, True, False)

    if tech == "py-symlink":
        link = os.path.join(allow, "adv-py-link")
        try:
            os.unlink(link)
        except OSError:
            pass
        try:
            os.symlink(sent, link)
        except OSError:
            finish(tech, True, False)
        try:
            with open(link, "rb") as f:
                r = MARK in f.read(256)
        except OSError:
            r = False
        try:
            os.unlink(link)
        except OSError:
            pass
        finish(tech, True, r)

    if tech == "py-subprocess":
        r = subprocess.run(["/bin/cat", sent], capture_output=True)
        finish(tech, True, MARK in r.stdout)

    if tech == "py-ctypes-syscall":
        libc = ctypes.CDLL(None, use_errno=True)
        fd = libc.syscall(ctypes.c_long(SYS_OPENAT), ctypes.c_int(-100),
                          sent.encode(), ctypes.c_int(0), ctypes.c_int(0))
        if fd < 0:
            finish(tech, False, False)
        r = read_fd(fd)
        os.close(fd)
        finish(tech, False, r)

    print("unknown technique: %s" % tech, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
