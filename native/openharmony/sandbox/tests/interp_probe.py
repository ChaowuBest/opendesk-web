#!/usr/bin/env python3
"""interp_probe.py — Python 解释器侧的权限拦截验证（在沙箱内运行）。

覆盖：允许区读/写/执行放行，拒绝区读/写/删/查询属性/枚举/执行全部拦下，
并验证 subprocess 拉起的子进程同样受控。
输出每项一行；全部符合预期时退出码为 0。

用法: interp_probe.py <allow-dir> <deny-dir>
"""
import os
import subprocess
import sys

A, D = sys.argv[1], sys.argv[2]
fails = []


def chk(name, expect, actual):
    if actual == expect:
        print("ok   %s" % name)
    else:
        print("FAIL %s (got %s want %s)" % (name, actual, expect))
        fails.append(name)


def rd(p):
    try:
        with open(p, "rb") as f:
            f.read()
        return "ok"
    except OSError:
        return "blocked"


def wr(p):
    try:
        with open(p, "w") as f:
            f.write("x")
        return "ok"
    except OSError:
        return "blocked"


def dl(p):
    try:
        os.remove(p)
        return "ok"
    except OSError:
        return "blocked"


def ls(p):
    try:
        os.listdir(p)
        return "ok"
    except OSError:
        return "blocked"


def st(p):
    try:
        os.stat(p)
        return "ok"
    except OSError:
        return "blocked"


def ex(p):
    try:
        subprocess.check_call([p], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
        return "ok"
    except Exception:
        return "blocked"


chk("py: read allow",   "ok",      rd(A + "/in.txt"))
chk("py: write allow",  "ok",      wr(A + "/py-out.txt"))
chk("py: read deny",    "blocked", rd(D + "/secret.txt"))
chk("py: write deny",   "blocked", wr(D + "/py-hack.txt"))
chk("py: delete deny",  "blocked", dl(D + "/data.txt"))
chk("py: stat deny",    "blocked", st(D + "/secret.txt"))
chk("py: list deny",    "blocked", ls(D))
chk("py: exec allow",   "ok",      ex(A + "/ok.sh"))
chk("py: exec deny",    "blocked", ex(D + "/no.sh"))

sys.exit(1 if fails else 0)
