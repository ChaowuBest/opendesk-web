#!/bin/sh
# interp_probe.sh — shell 解释器侧的权限拦截验证（在沙箱内运行）。
#
# 覆盖：允许区读/写/执行放行，拒绝区读/写/删/枚举/执行全部拦下。
# 输出每项一行；全部符合预期时退出码为 0。
#
# 用法: interp_probe.sh <allow-dir> <deny-dir>
A="$1"; D="$2"
fail=0

chk() {   # chk <name> <expect> <actual>
    if [ "$3" = "$2" ]; then echo "ok   $1"
    else echo "FAIL $1 (got $3 want $2)"; fail=1; fi
}
rd()  { cat "$1" >/dev/null 2>&1 && echo ok || echo blocked; }
wr()  { echo x > "$1" 2>/dev/null && echo ok || echo blocked; }
dl()  { rm -f "$1" 2>/dev/null && echo ok || echo blocked; }
ls_() { ls "$1" >/dev/null 2>&1 && echo ok || echo blocked; }
ex_() { "$1" >/dev/null 2>&1 && echo ok || echo blocked; }

chk "sh: read allow"    ok      "$(rd  "$A/in.txt")"
chk "sh: write allow"   ok      "$(wr  "$A/sh-out.txt")"
chk "sh: read deny"     blocked "$(rd  "$D/secret.txt")"
chk "sh: write deny"    blocked "$(wr  "$D/sh-hack.txt")"
chk "sh: delete deny"   blocked "$(dl  "$D/data.txt")"
chk "sh: list deny"     blocked "$(ls_ "$D")"
chk "sh: exec allow"    ok      "$(ex_ "$A/ok.sh")"
chk "sh: exec deny"     blocked "$(ex_ "$D/no.sh")"

exit $fail
