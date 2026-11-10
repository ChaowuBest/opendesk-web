#!/usr/bin/env bash
# ============================================================
# dynobox-linux test suite (identity namespace: 虚拟路径 == 真实路径)
#
# Mirrors the Windows dynobox test layers:
#   - unit        policy engine / path attribution / config codec
#   - functional  allow/deny/ask/grants/exec/traversal/symlink
#   - advanced    big files, unicode, concurrency, dlopen, mmap,
#                 network gating
#   - reliability launcher death, endpoint death, parallel
#                 sandboxes, grant push, governance chain
#
# Run:  make tests && bash tests/run_all.sh     (WSL: tests/wsl_run.sh)
# ============================================================
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
B="$ROOT/build/dynobox"
PROBE="$ROOT/build/t_probe"
# Fixture and log workspace. Overridable because the default location can sit
# on a filesystem that does not preserve what parts of the suite assert on
# (HarmonyOS HMDFS drops mkdir permission bits, for instance):
#   DYNOBOX_TEST_WORK=/data/storage/el2/base/temp/dynobox-test bash tests/run_all.sh
WORK="${DYNOBOX_TEST_WORK:-${ROOT}/tests/work}"
SRC="$WORK/src"
AUDIT="$WORK/audit.log"
# Unix domain sockets: HMDFS (the HarmonyOS $HOME) rejects bind() with EPERM
# and its tmpfs mounts (/dev/shm) are blocked by SELinux, so prefer the app
# data filesystem where they do work, then a local tmpfs.
SOCKDIR=""
for d in "${TMPDIR:-}" /data/storage/el2/base/temp /dev/shm "$WORK"; do
    [ -n "$d" ] && [ -d "$d" ] && [ -w "$d" ] && { SOCKDIR="$d"; break; }
done
PORT=18099

PASS=0; FAIL=0; FAILED_NAMES=()

check() { # check <name> <rc>
    local name="$1" rc="$2"
    if [ "$rc" = "0" ]; then PASS=$((PASS+1)); echo "ok   $name";
    else FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); echo "FAIL $name (rc=$rc)"; fi
}

run_probe() { # run_probe <expected-rc> <name> <probe args...>
    local expect="$1" name="$2"; shift 2
    "$B" run --policy "$POL" --log "$LOG" -- "$PROBE" "$@" >/dev/null 2>&1
    local rc=$?
    if [ "$rc" = "$expect" ]; then PASS=$((PASS+1)); echo "ok   $name";
    else FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); echo "FAIL $name (rc=$rc want $expect)"; fi
}

# ------------------------------------------------------------------
echo "== unit =="
"$ROOT/build/unit_policy" >/dev/null 2>&1
check "unit: policy engine" $?

# ------------------------------------------------------------------
echo "== fixtures =="
pkill -f "dynobox endpoint" 2>/dev/null && sleep 0.3
rm -rf "$WORK"
mkdir -p "$SRC"/{public,docs,vault,notes,staging,scratch,reject,guarded,slow,tools/bin,tools/blocked,tools/ask,tools/sub,deep/x1/x2/x3/x4,denied}
echo "TOP-SECRET-adv-sentinel" > "$SRC/denied/secret.txt"
echo "denied-data"            > "$SRC/denied/data.txt"
printf '#!/bin/sh\necho forbidden-ran\n' > "$SRC/denied/no.sh"
chmod +x "$SRC/denied/no.sh"
printf '#!/bin/sh\necho ok-tool-ran\n'   > "$SRC/public/ok.sh"
chmod +x "$SRC/public/ok.sh"
echo "allowed-content"        > "$SRC/public/in.txt"
cp "$ROOT/build/libadv_helper.so" "$SRC/public/" 2>/dev/null
echo "deep-data" > "$SRC/deep/x1/x2/x3/x4/leaf.txt"
echo "hello-docs"      > "$SRC/docs/readme.txt"
echo "secret-content"  > "$SRC/docs/secret.txt"
echo "vault-secret"    > "$SRC/vault/secret.txt"
echo "note-base"       > "$SRC/notes/base.txt"
echo "cache-me"        > "$SRC/notes/cache-me.txt"
echo "after-death"     > "$SRC/notes/after-death.txt"
echo "timed"           > "$SRC/slow/timed.txt"
echo "timed"           > "$SRC/slow/slow2.txt"
printf 'staging-base'  > "$SRC/staging/base.txt"
printf '#!/bin/sh\necho tool-ok\n' > "$SRC/tools/bin/ok.sh"
chmod +x "$SRC/tools/bin/ok.sh"
printf '#!/bin/sh\necho blocked-ran\n' > "$SRC/tools/blocked/no.sh"
chmod +x "$SRC/tools/blocked/no.sh"
printf '#!/bin/sh\necho ask-ran\n' > "$SRC/tools/ask/ask.sh"
chmod +x "$SRC/tools/ask/ask.sh"
echo "legacy-data"     > "$SRC/public/legacy.txt"
ln -sf /usr/bin/env "$SRC/public/slink"
echo "unicode"   > "$SRC/public/文件 名.txt"
cat > "$SRC/public/libhello.c" <<'EOC'
int hello(void) { return 42; }
EOC
"${CC:-cc}" -shared -fPIC -o "$SRC/public/libhello.so" "$SRC/public/libhello.c"
printf '\xf4\x14\x40\x00\x00\x00\x00\x00padding-padding' > "$SRC/public/blob.bin"

# ------------------------------------------------------------------
echo "== endpoint =="
rm -f "$AUDIT"
"$B" endpoint --port $PORT --default deny --log "$AUDIT" >/dev/null 2>&1 &
EPID=$!
trap 'kill $EPID 2>/dev/null' EXIT
for i in $(seq 1 50); do
    if (timeout -k 1 2 bash -c "echo > /dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then break; fi
    sleep 0.1
done
(timeout -k 1 2 bash -c "echo > /dev/tcp/127.0.0.1/$PORT") 2>/dev/null
check "endpoint: listening" $?

# ------------------------------------------------------------------
POL="$WORK/func.toml"
LOG="$WORK/sandbox.log"
UP="http://127.0.0.1:$PORT/decide"
sed -e "s|@SRC@|$SRC|g" -e "s|@UP@|$UP|g" -e "s|@ROOT@|$ROOT|g" \
    "$ROOT/tests/policies/func.toml.in" > "$POL"

T() { "$B" run --policy "$POL" --log "$LOG" -- "$PROBE" "$@"; }

# ------------------------------------------------------------------
# 扩展策略：对抗测试与解释器测试需要额外的只读/执行路径。
# 解释器相关的规则在非 HarmonyOS 平台上不会匹配任何真实路径，属无害冗余。
APOL="$WORK/adv.toml"
sed -e "s|@SRC@|$SRC|g" -e "s|@UP@|$UP|g" -e "s|@ROOT@|$ROOT|g" \
    "$ROOT/tests/policies/func.toml.in" > "$APOL"
add_rule() {   # add_rule <path-glob> <read|write|execute|all>
    [ -n "$1" ] || return
    printf '\n[[rules]]\npath = "%s"\naccess = "%s"\nperm = "allow"\n' "$1" "$2" >> "$APOL"
}
# 注意：不要放 "$ROOT/tests/**" 这类宽规则 —— fixture 就位于 tests/work 下，
# 会把拒绝区一并放开。探针脚本另行复制到 @SRC@/public/（该处已 all allow）。
add_rule "$HOME/usr/**" read
add_rule "$HOME/usr/**" execute
add_rule "$HOME/.harmonybrew/**" read
add_rule "$HOME/.harmonybrew/**" execute
add_rule "/data/storage/el2/base/files/interpreters/**" read
add_rule "/data/storage/el2/base/files/interpreters/**" execute

echo "== functional: read/write/enum =="
rm -f "$LOG"
T wr "$SRC/public/w1.txt" "written"                     >/dev/null; check "write allow public" $?
T cat_eq "$SRC/public/w1.txt" "written"                 >/dev/null; check "read back written" $?
T rd "$SRC/docs/readme.txt"                             >/dev/null; check "read allow docs" $?
T rd_fail_eacces "$SRC/vault/secret.txt"                >/dev/null; check "read deny vault (EACCES)" $?
T rd_fail "$SRC/docs/secret.txt"                        >/dev/null; check "specific deny docs/secret.txt" $?
T ls "$SRC/public"                                      >/dev/null; check "enum allow public" $?
T ls_fail "$SRC/vault"                                  >/dev/null; check "enum deny vault" $?
T stat_ok "$SRC/docs/readme.txt"                        >/dev/null; check "stat allow" $?
T stat_fail "$SRC/vault/secret.txt"                     >/dev/null; check "stat deny" $?
T wr_fail "$SRC/docs/new.txt"                           >/dev/null; check "write deny docs (read-only rule)" $?
T app "$SRC/public/w1.txt" "-more"                      >/dev/null; check "append allow" $?
T cat_eq "$SRC/public/w1.txt" "written-more"            >/dev/null; check "append content" $?
T trunc "$SRC/public/w1.txt"                            >/dev/null; check "truncate allow" $?
T oexcl_fail "$SRC/public/w1.txt"                       >/dev/null; check "O_EXCL conflict semantics" $?

echo "== functional: delete/rename/mkdir =="
T wr "$SRC/public/del.txt" "x"                          >/dev/null
T rm "$SRC/public/del.txt"                              >/dev/null; check "delete allow" $?
T rm_fail "$SRC/vault/secret.txt"                       >/dev/null; check "delete deny" $?
T wr "$SRC/public/mvsrc.txt" "m"                        >/dev/null
T mv "$SRC/public/mvsrc.txt" "$SRC/public/mvdst.txt"    >/dev/null; check "rename allow" $?
T mv_fail "$SRC/public/mvdst.txt" "$SRC/vault/escaped.txt" >/dev/null; check "rename deny (into vault)" $?
T mkdir "$SRC/public/dir1"                              >/dev/null; check "mkdir allow" $?
T mkdir_fail "$SRC/vault/dir2"                          >/dev/null; check "mkdir deny" $?
T rmdir "$SRC/public/dir1"                              >/dev/null; check "rmdir allow" $?
# 尾斜杠：内核接受 mkdir("a/b/")，"父链缺失透传"不能把目标自身当成父目录
# （git init 用 mkdir(".git/hooks/")，误判曾让它整条失败）
T mkdir "$SRC/public/dir-trail/"                        >/dev/null; check "mkdir allow (trailing slash)" $?
T rmdir "$SRC/public/dir-trail"                         >/dev/null; check "rmdir trailing-slash dir" $?
T mkdir_fail "$SRC/vault/dir-trail/"                    >/dev/null; check "mkdir deny (trailing slash)" $?
T chmod_ok "$SRC/public/w1.txt"                         >/dev/null; check "chmod allow" $?
T chmod_fail "$SRC/vault/secret.txt"                    >/dev/null; check "chmod deny" $?

echo "== functional: traversal & symlinks =="
T rd_fail "$SRC/public/../../../etc/shadow"             >/dev/null; check "dotdot traversal blocked" $?
T rd_fail "$SRC/deep/../vault/secret.txt"               >/dev/null 2>&1; check "mid-path dotdot blocked" $?
T symlink_ok "$SRC/docs/readme.txt" "$SRC/public/link-in" >/dev/null; check "symlink create allow" $?
T rd "$SRC/public/link-in"                              >/dev/null; check "symlink to allowed target reads" $?
T symlink_ok "$SRC/vault/secret.txt" "$SRC/public/link-out" >/dev/null; check "symlink create (escape link) allowed" $?
T rd_fail "$SRC/public/link-out"                        >/dev/null; check "symlink escape DENIED via resolved path" $?
T symlink_fail "$SRC/docs/readme.txt" "$SRC/vault/link-v" >/dev/null; check "symlink create in deny area" $?
T readlink_ok "$SRC/public/link-in"                     >/dev/null; check "readlink allowed" $?

# 目录前缀缓存（pathmap 的 pcache）不能变成"符号链接替换"的绕过通道：
# 先访问 allow 区的文件填充缓存，再把该目录换成指向 deny 区的链接，
# 原路径访问 deny 内容必须仍被拦截。
CACHEDIR="$SRC/public/symcache"
rm -rf "$CACHEDIR" "$CACHEDIR.orig"; mkdir -p "$CACHEDIR"
printf 'x' > "$CACHEDIR/f.txt"
T pcache_symlink "$CACHEDIR" "$SRC/vault" "secret.txt" >/dev/null
check "目录缓存命中后仍按当前解析判定（符号链接替换不绕过 deny）" $?
rm -rf "$CACHEDIR" "$CACHEDIR.orig"

echo "== functional: exec control =="
T x_ok "$SRC/tools/bin/ok.sh"                           >/dev/null; check "x_ok allowed tool" $?
T spawn "$SRC/tools/bin/ok.sh"                          >/dev/null; check "exec allowed tool" $?
T x_fail "$SRC/tools/blocked/no.sh"                     >/dev/null; check "x_fail blocked tool" $?
T spawn "$SRC/tools/blocked/no.sh" >/dev/null 2>&1; rc=$?
[ "$rc" = "126" ] && rc=0 || rc=1
check "exec blocked tool (sh 126)" $rc
T x_ok /bin/ls                                          >/dev/null; check "system exec allowed (/bin/ls)" $?
T spawn /usr/bin/touch "$SRC/public/touch.txt"          >/dev/null; check "PATH spawn of system tool" $?
T popen_ok "/bin/echo hello"                            >/dev/null; check "popen works" $?
T popen_rc_fail "/bin/cat $SRC/vault/secret.txt"        >/dev/null; check "popen child file-deny" $?
T rd "$SRC/tools/bin/ok.sh"                             >/dev/null; check "read tool script" $?

echo "== functional: cwd =="
"$B" run --policy "$POL" --cwd "$SRC" --log "$LOG" -- \
    /bin/sh -c "$PROBE env_set DYNOBOX_SANDBOX >/dev/null && $PROBE env_set SBX_ROOT >/dev/null && $PROBE getcwd_is $SRC" >/dev/null 2>&1
check "env DYNOBOX_SANDBOX/SBX_ROOT + cwd" $?
"$B" run --policy "$POL" --cwd "$SRC" --log "$LOG" -- \
    /bin/sh -c "cd $SRC/public && $PROBE wr rel-probe.txt rel && $PROBE cat_eq $SRC/public/rel-probe.txt rel" >/dev/null 2>&1
check "relative paths after chdir" $?

echo "== advanced: files =="
T rd "$SRC/deep/x1/x2/x3/x4/leaf.txt"                   >/dev/null; check "deep nesting read" $?
T rd "$SRC/public/文件 名.txt"                          >/dev/null; check "unicode+space filename" $?
T wr "$SRC/public/文 件-2.txt" "u"                      >/dev/null; check "unicode create" $?
"$B" run --policy "$POL" --log "$LOG" -- /bin/sh -c "
set -e
dd if=/dev/urandom of=$SRC/public/big.src bs=65536 count=32 2>/dev/null
$PROBE rd $SRC/public/big.src >/dev/null
cp $SRC/public/big.src $SRC/public/big.copy
cmp $SRC/public/big.src $SRC/public/big.copy
rm $SRC/public/big.copy
" >/dev/null 2>&1
check "2MB binary roundtrip" $?
T fnv "$SRC/public/big.src" >/dev/null; check "big file readable" $?

echo "== advanced: threads =="
"$B" run --policy "$POL" --log "$LOG" -- "$ROOT/build/t_threads" "$SRC/public/shared.dat" 4 25 >/dev/null 2>&1
check "4 threads x 25 appends + private files" $?

echo "== advanced: dlopen / mmap exec =="
T spawn "$ROOT/build/t_dlopen" "$SRC/public/libhello.so" ok >/dev/null; check "dlopen allowed .so" $?
T spawn "$ROOT/build/t_dlopen" "$SRC/docs/readme.txt" fail  >/dev/null; check "dlopen non-library denied" $?
# mmap PROT_EXEC follows the CURRENT policy on the fd's path:
#  - public is all-allow  -> allowed (JIT-style read-then-exec works)
#  - docs is read-only    -> denied (EPERM)
# Some kernels (HarmonyOS) refuse file-backed PROT_EXEC mappings outright, so
# probe the kernel without the sandbox before asserting the allow direction.
if "$ROOT/build/t_mmap" "$SRC/public/blob.bin" allow >/dev/null 2>&1; then
    T spawn "$ROOT/build/t_mmap" "$SRC/public/blob.bin" allow   >/dev/null; check "mmap PROT_EXEC allowed (exec rule)" $?
else
    echo "skip mmap PROT_EXEC allow (kernel refuses file-backed PROT_EXEC)"
fi
T spawn "$ROOT/build/t_mmap" "$SRC/docs/readme.txt" deny    >/dev/null; check "mmap PROT_EXEC denied (no exec rule)" $?
# fexecve with attribution
T spawn "$ROOT/build/t_probe" fexecve_fail "$SRC/vault/secret.txt" >/dev/null 2>&1
check "fexecve deny 区 fd 拒绝" $?

echo "== advanced: network =="
T spawn "$ROOT/build/t_net" unix_ok                     >/dev/null; check "AF_UNIX socketpair always ok" $?
T spawn "$ROOT/build/t_net" udp_connect 127.0.0.1 $PORT >/dev/null; check "loopback udp connect (default allow)" $?
NETPOL="$WORK/net.toml"
cat > "$NETPOL" <<EOT
version = 1
default = "deny"
[network]
default = "deny"
[[rules]]
path = "$ROOT/build/**"
access = "all"
perm = "allow"
[[rules]]
path = "$SRC/public/**"
access = "all"
perm = "allow"
EOT
"$B" run --policy "$NETPOL" -- "$ROOT/build/t_net" udp_connect_fail 127.0.0.1 $PORT >/dev/null 2>&1
check "[network] deny blocks loopback socket" $?
cat > "$NETPOL" <<EOT
version = 1
default = "deny"
[network]
default = "loopback"
[[rules]]
path = "$ROOT/build/**"
access = "all"
perm = "allow"
[[rules]]
path = "$SRC/public/**"
access = "all"
perm = "allow"
EOT
"$B" run --policy "$NETPOL" -- "$ROOT/build/t_net" udp_connect 127.0.0.1 $PORT >/dev/null 2>&1
check "[network] loopback allows 127.0.0.1" $?
"$B" run --policy "$NETPOL" -- "$ROOT/build/t_net" udp_connect_fail 192.0.2.1 53 >/dev/null 2>&1
check "[network] loopback blocks external IP" $?

echo "== device baseline: catch-all rules must not shadow /dev/tty =="
# 回归（devecocli 卡死）：OpenDesk 标准/受限模式用 `/** write = ask` 兜底，而
# node / devecocli 启动即 open("/dev/tty", O_WRONLY)。设备白名单若被兜底规则
# 遮蔽，这个 open 会变成一次 ask，上游不响应时命令卡满 timeout（330s）。
TTYPOL="$WORK/tty.toml"
cat > "$TTYPOL" <<EOT
version = 1
default = "deny"

[ask]
endpoint = "http://127.0.0.1:$PORT/decide"
timeout_ms = 1500
cache_ttl_seconds = 0

[[rules]]
path = "/**"
access = "write"
perm = "ask"
EOT
TTY_A0=$(grep -c "/dev/tty" "$AUDIT" 2>/dev/null); TTY_A0=${TTY_A0:-0}
"$B" run --policy "$TTYPOL" -- /bin/sh -c 'exec 3>/dev/tty 2>/dev/null || true' >/dev/null 2>&1
TTY_A1=$(grep -c "/dev/tty" "$AUDIT" 2>/dev/null); TTY_A1=${TTY_A1:-0}
# 断言"没有产生 ask"而不是"open 成功"：测试环境可能没有控制终端（ENXIO）
[ "$TTY_A1" = "$TTY_A0" ] && rc=0 || rc=1
check "device baseline: no ask for /dev/tty write (base=$TTY_A0 now=$TTY_A1)" $rc
"$B" run --policy "$TTYPOL" -- /bin/sh -c 'exec 3>/dev/null' >/dev/null 2>&1
check "device baseline: /dev/null write bypasses catch-all ask" $?

echo "== ask: http decisions =="
# Each TSH runs a whole shell SEQUENCE inside ONE sandbox tree so the
# shared ask cache and endpoint grants are exercised across processes.
TSH() { "$B" run --policy "$POL" --log "$LOG" -- /bin/sh -c "$1"; }

AUD0=$(grep -c "decide" "$AUDIT" 2>/dev/null); AUD0=${AUD0:-0}
TSH "$PROBE rd $SRC/notes/base.txt"                    >/dev/null; check "ask -> endpoint allow (read)" $?
AUD1=$(grep -c "decide" "$AUDIT"); AUD1=${AUD1:-0}
[ "$AUD1" -gt "$AUD0" ] && rc=0 || rc=1
check "ask hit the endpoint (audit)" $rc
TSH "$PROBE rd $SRC/notes/base.txt; $PROBE rd $SRC/notes/base.txt" >/dev/null
AUD2=$(grep -c "decide" "$AUDIT"); AUD2=${AUD2:-0}
[ "$AUD2" = "$((AUD1+1))" ] && rc=0 || rc=1
check "decision cached across processes (1 new ask)" $rc
TSH "$PROBE rd_fail_eacces $SRC/reject/x.txt"          >/dev/null; check "ask -> endpoint deny" $?
TSH "$PROBE wr $SRC/guarded/g1.txt x; $PROBE wr $SRC/guarded/g2.txt x" >/dev/null; check "guarded: allow without grants" $?
AUD3=$(grep -c "guarded" "$AUDIT"); AUD3=${AUD3:-0}
[ "$AUD3" = "4" ] && rc=0 || rc=1
check "guarded: per-category asks, no grant caching (4)" $rc

echo "== ask: timeout fail-closed =="
TSH "$PROBE rd_fail_eacces $SRC/slow/slow.txt"         >/dev/null; check "slow endpoint -> timeout -> deny" $?
TSH "$PROBE wr_fail $SRC/slow/slow2.txt"               >/dev/null; check "timeout denial not cached" $?

echo "== ask: grants (subtree push) =="
AUDG0=$(grep -c "/scratch" "$AUDIT" 2>/dev/null); AUDG0=${AUDG0:-0}
TSH "for i in 1 2 3 4 5; do $PROBE wr $SRC/scratch/grant\$i.txt g\$i || exit 1; done" >/dev/null; check "grants: 5 files in one tree" $?
AUDG1=$(grep -c "/scratch" "$AUDIT"); AUDG1=${AUDG1:-0}
# the read ask returns an ALL grant, which covers the write category too
[ "$AUDG1" = "$((AUDG0+1))" ] && rc=0 || rc=1
check "grants: 5 files, 1 ask round (grant covers write, got=$AUDG1 base=$AUDG0)" $rc
TSH "for i in 6 7 8; do $PROBE wr $SRC/scratch/grant\$i.txt g\$i || exit 1; done" >/dev/null; check "grant persists for more files" $?

echo "== regression: directory-open is never write (find ask storm) =="
# `find` 的 fts 用 openat(O_RDONLY|O_DIRECTORY) 打开每个被遍历目录。
# acc_from_open_flags 曾把 O_TMPFILE（定义 = __O_TMPFILE | O_DIRECTORY）按位
# 检测，使一切目录打开误判为写模式——standard 形态（write 兜底 ask）下
# `find /` 对每个被遍历目录触发一次幽灵 write ask（弹"编辑 /"）。
# 回归策略 = standard 形态：read 全放行、write 兜底 ask、endpoint deny。
RPOL="$WORK/regress-odir.toml"
{
    printf 'version = 1\ndefault = "deny"\n\n'
    printf '[ask]\nendpoint = "%s"\ntimeout_ms = 2000\ncache_ttl_seconds = 0\ngrant_ttl_seconds = 0\n\n' "$UP"
    printf '[[rules]]\npath = "@SRC@/vault/**"\naccess = "read"\nperm = "deny"\n\n'
    printf '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n\n'
    printf '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
} | sed -e "s|@SRC@|$SRC|g" > "$RPOL"
RT() { "$B" run --policy "$RPOL" --log "$LOG" -- "$PROBE" "$@"; }
RT odir_open_ok "$SRC/public"                       >/dev/null; check "dir open (O_DIRECTORY) never write-asked" $?
RT otmpfile_fail "$SRC/public"                      >/dev/null; check "O_TMPFILE still write-checked (EACCES)" $?
RT odir_open_fail "$SRC/vault"                      >/dev/null; check "dir open honors read-deny rules" $?
RT ls "$SRC/public"                                 >/dev/null; check "opendir unaffected" $?
# 回归（hdcthis connect 卡死根因）：mkdir -p 式逐级创建会对 /storage、$HOME 这些
# 早已存在的层级反复 mkdir。目标已存在时本次调用只会得到 EEXIST，没有副作用，
# 沙箱不该为它 ask 上游（上游不响应时整条命令卡满 ask 超时）。
RT mkdir_eexist "$SRC/public"                       >/dev/null; check "mkdir on existing dir -> EEXIST, never write-asked" $?
# 同一捷径不得绕过 deny：已存在目录若在写-deny 区，仍必须被拒（Windows 侧
# CreateDirectoryW 用的是 deny-only 判定，这里保持同一语义）
MKDENY="$WORK/mkdir-deny.toml"
{
    printf 'version = 1\ndefault = "deny"\n\n'
    printf '[[rules]]\npath = "@SRC@/vault"\naccess = "write"\nperm = "deny"\n\n'
    printf '[[rules]]\npath = "/**"\naccess = "read"\nperm = "allow"\n\n'
    printf '[[rules]]\npath = "/**"\naccess = "write"\nperm = "ask"\n'
} | sed -e "s|@SRC@|$SRC|g" > "$MKDENY"
"$B" run --policy "$MKDENY" -- "$PROBE" mkdir_eexist "$SRC/vault" >/dev/null 2>&1
rc=$?; [ "$rc" != "0" ] && rc=0 || rc=1
check "mkdir on existing dir in write-deny area still denied" $rc
AUDR0=$(grep -c "decide" "$AUDIT" 2>/dev/null); AUDR0=${AUDR0:-0}
"$B" run --policy "$RPOL" --log "$LOG" -- /usr/bin/find "$SRC" -maxdepth 3 >/dev/null 2>&1
check "find traversal rc=0 (no EACCES)" $?
AUDR1=$(grep -c "decide" "$AUDIT"); AUDR1=${AUDR1:-0}
[ "$AUDR1" = "$AUDR0" ] && rc=0 || rc=1
check "find traversal zero asks (audit)" $rc

echo "== regression: write into a missing parent chain never asks (ENOENT pass-through) =="
# 符号引擎（dbghelp/SymSrv）按模块内嵌 CodeView 路径探测并写入符号缓存
# （Windows 侧真实事故：node.exe 的 c:\ws\out\Release\node.pdb 在多数机器上
# 不存在，write 兜底 ask 下每次探测都弹写审批框）。父链缺失的写注定 ENOENT，
# 必须透传内核错误码且零 ask——deny 规则仍优先（拒绝）。
RT wr_enoent "$SRC/no-such-parent/deeper/probe.txt"  >/dev/null; check "write missing-parent -> ENOENT (no ask)" $?
AUMP0=$(grep -c "decide" "$AUDIT" 2>/dev/null); AUMP0=${AUMP0:-0}
RT wr_enoent "$SRC/no-such-parent/deeper/probe.txt"  >/dev/null; check "write missing-parent repeatable ENOENT" $?
AUMP1=$(grep -c "decide" "$AUDIT"); AUMP1=${AUMP1:-0}
[ "$AUMP1" = "$AUMP0" ] && rc=0 || rc=1
check "write missing-parent zero asks (audit)" $rc
# 父目录存在但文件不存在 = 正常创建（必须正常判定，不可被"缺失"逻辑误放行）：
# 在 write 兜底 ask + endpoint deny 策略下，正常判定会走到 ask → deny（fail-closed
# EACCES），"父链缺失透传"不能把它变成 ENOENT 放行。
RT wr_fail "$SRC/public/mkprobe.txt"                  >/dev/null; check "create in existing parent still judged (ask->deny)" $?
# mkdir 的父链缺失同样注定 ENOENT、不 ask
RT mkdir "$SRC/no-such-parent/deeper" 2>/dev/null;     rc=$?
[ "$rc" != "0" ] && rc=0 || rc=1
check "mkdir missing-parent fails without hanging on ask" $rc
# 尾斜杠变体同样必须判为父链缺失（不得因先剥末段而把目标自身当父目录后放行）
RT mkdir "$SRC/no-such-parent/deeper/" 2>/dev/null;    rc=$?
[ "$rc" != "0" ] && rc=0 || rc=1
check "mkdir missing-parent (trailing slash) fails without ask" $rc

echo "== ask: staging write approval =="
TSH "$PROBE app $SRC/staging/base.txt -ap; $PROBE app $SRC/staging/base.txt -ap2" >/dev/null; check "staging write ask -> allow + grant covers appends" $?

echo "== ask: exec approval =="
AUDX1=$(grep -c "tools/ask" "$AUDIT" 2>/dev/null); AUDX1=${AUDX1:-0}
TSH "$PROBE spawn $SRC/tools/ask/ask.sh; $PROBE spawn $SRC/tools/ask/ask.sh" >/dev/null 2>&1
check "ask-approved exec runs (twice)" $?
AUDX2=$(grep -c "tools/ask" "$AUDIT"); AUDX2=${AUDX2:-0}
[ "$AUDX2" = "$((AUDX1+1))" ] && rc=0 || rc=1
check "ask decision cached for exec too" $rc

echo "== reliability: endpoint death (fail-closed) =="
EPID="$EPID" "$B" run --policy "$POL" --log "$LOG" -- /bin/sh -c "
$PROBE rd $SRC/notes/cache-me.txt || exit 1
kill \$EPID 2>/dev/null
sleep 0.3
$PROBE rd $SRC/notes/cache-me.txt || exit 1
$PROBE wr_fail $SRC/guarded/after-death.txt || exit 1
" >/dev/null 2>&1
check "grants survive endpoint death; non-granted ask fail-closed" $?
rm -f "$AUDIT"
"$B" endpoint --port $PORT --default deny --log "$AUDIT" >/dev/null 2>&1 &
EPID=$!
for i in $(seq 1 50); do
    if (timeout -k 1 2 bash -c "echo > /dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then break; fi
    sleep 0.1
done
check "endpoint restarted" $?

echo "== reliability: governance (launcher death kills tree) =="
MARK="$WORK/marker.out"
"$B" run --policy "$POL" --log "$LOG" -- /bin/sh -c "exec $ROOT/build/t_exec_chain $ROOT/build/t_exec_chain 3 KEEPER keep" > "$MARK" 2>/dev/null &
LPID=$!
for i in $(seq 1 50); do
    [ "$(grep -c KEEPER "$MARK" 2>/dev/null)" -ge 3 ] && break
    sleep 0.1
done
U0=$(grep KEEPER "$MARK" | sort -u | wc -l)
kill -9 $LPID 2>/dev/null
sleep 3
U1=$(grep KEEPER "$MARK" | sort -u | wc -l)
SURV=$(pgrep -fc "t_exec_chain" 2>/dev/null || true)
if [ "$U0" -ge 3 ] && [ "$U1" = "$U0" ] && [ "${SURV:-0}" = "0" ]; then rc=0; else rc=1; fi
check "kill launcher -> whole tree dies (levels=$U0, after=$U1, surv=${SURV:-0})" $rc

echo "== reliability: chain survives while launcher alive =="
"$B" run --policy "$POL" --log "$LOG" -- "$ROOT/build/t_exec_chain" "$ROOT/build/t_exec_chain" 3 CHAIN >/dev/null 2>&1
check "grandchild chain completes normally" $?

echo "== reliability: reused watch fd must not kill the tree =="
# 回归（devecocli 卡在 "Start generating p12" 的根因）：exec 后宿主程序关闭看护
# fd，紧接着把同一个 fd 号复用为普通文件（node spawn 的 close-on-exec + JDK/node
# 的 open）。旧实现只校验 F_GETFD，于是把"读到别的对象 EOF"当作 launcher 已死，
# kill(-pgid) 抹掉整棵树 —— 外部表现为命令毫无输出地消失。t_watch 精确复现该状态。
"$B" run --policy "$POL" --log "$LOG" -- "$ROOT/build/t_watch" >/dev/null 2>&1
check "reused watch fd does not kill tree (fd number recycled after exec)" $?

echo "== reliability: parallel sandboxes =="
"$B" run --policy "$POL" --log "$LOG" -- "$ROOT/build/t_threads" "$SRC/public/p1.dat" 2 15 >/dev/null 2>&1 &
PID_A=$!
"$B" run --policy "$POL" --log "$LOG" -- "$ROOT/build/t_threads" "$SRC/public/p2.dat" 2 15 >/dev/null 2>&1 &
PID_B=$!
wait $PID_A; RA=$?
wait $PID_B; RB=$?
[ "$RA" = "0" ] && [ "$RB" = "0" ] && rc=0 || rc=1
check "two sandboxes in parallel" $rc

echo "== reliability: bad policy refuses to start =="
echo "this is not toml {{{" > "$WORK/bad.toml"
"$B" run --policy "$WORK/bad.toml" -- /bin/true >/dev/null 2>&1
[ "$?" != "0" ] && rc=0 || rc=1
check "invalid TOML rejected" $rc
printf 'version = 1\ndefault = "deny"\n[[rules]]\npath = "/x"\naccess = "sometimes"\nperm = "allow"\n' > "$WORK/bad2.toml"
"$B" run --policy "$WORK/bad2.toml" -- /bin/true >/dev/null 2>&1
[ "$?" != "0" ] && rc=0 || rc=1
check "invalid rule rejected" $rc
printf 'version = 1\ndefault = "deny"\n[[roots]]\nvirtual = "/C"\nreal = "/host"\n' > "$WORK/bad3.toml"
"$B" run --policy "$WORK/bad3.toml" -- /bin/true >/dev/null 2>&1
[ "$?" != "0" ] && rc=0 || rc=1
check "[[roots]] rejected in identity namespace" $rc

echo "== reliability: setuid exec denied =="
cp /usr/bin/id "$SRC/public/suid-tool" 2>/dev/null
chmod u+s "$SRC/public/suid-tool" 2>/dev/null
if [ -u "$SRC/public/suid-tool" ]; then
    T spawn "$SRC/public/suid-tool" >/dev/null 2>&1
    [ "$?" != "0" ] && rc=0 || rc=1
    check "setuid binary exec denied" $rc
    rm -f "$SRC/public/suid-tool"
else
    echo "skip setuid (cannot create)"
fi

echo "== reliability: ask via unix socket transport =="
UEND="$SOCKDIR/dynobox-test-ep.sock"
rm -f "$UEND"
"$B" endpoint --unix "$UEND" --default deny >/dev/null 2>&1 &
UPID=$!
for i in $(seq 1 50); do [ -S "$UEND" ] && break; sleep 0.1; done
sleep 0.3
UNIPOL="$WORK/unix.toml"
sed -e "s|@SRC@|$SRC|g" -e "s|@UP@|unix://$UEND|g" -e "s|@ROOT@|$ROOT|g" \
    "$ROOT/tests/policies/func.toml.in" > "$UNIPOL"
"$B" run --policy "$UNIPOL" --log "$LOG" -- "$PROBE" rd "$SRC/notes/base.txt" >/dev/null 2>&1
check "unix-socket ask transport works" $?
kill $UPID 2>/dev/null; wait $UPID 2>/dev/null
rm -f "$UEND"

echo
echo "== round6: identity view consistency =="
# readlink/realpath return the REAL path (identity namespace: no leak
# possible because there is no mapping to leak)
T readlink_eq "$SRC/public/link-in" "$SRC/docs/readme.txt" >/dev/null; check "r6: readlink 返回真实目标" $?
T realpath_eq "$SRC/docs/readme.txt" "$SRC/docs/readme.txt" >/dev/null; check "r6: realpath 返回真实路径" $?
# A real system file, resolved first: on HarmonyOS /usr/bin/ls (and /bin, /lib)
# are symlinks into /system, so a hard-coded literal would not round-trip.
SYSREAL=$(readlink -f /bin/sh)
T realpath_eq "$SYSREAL" "$SYSREAL" >/dev/null; check "r6: realpath 系统路径不受影响" $?
# relative script execution
"$B" run --policy "$POL" --log "$LOG" -- /bin/sh -c "cd $SRC/tools/bin && $PROBE spawn ./ok.sh" >/dev/null 2>&1
check "r6: 相对路径执行脚本" $?
# ENOTDIR semantics through an allowed parent
T enotdir_fail "$SRC/docs/readme.txt" "$SRC/docs/readme.txt/x" >/dev/null; check "r6: ENOTDIR 语义" $?
# X_OK through symlink to allowed system binary
T x_ok_through_symlink "$SRC/public/slink"               >/dev/null; check "r6: X_OK 经符号链接解析目标" $?
# mkdir permission bits
# mkdir permission bits — HMDFS (the HarmonyOS $HOME) does not preserve the
# requested mode, so probe the workspace filesystem first and skip where the
# assertion cannot hold for reasons that have nothing to do with the sandbox.
T mkdir "$SRC/public/dirmode"                            >/dev/null
rm -rf "$WORK/modeprobe"; mkdir -m 0755 "$WORK/modeprobe"
if [ "$(stat -c '%a' "$WORK/modeprobe" 2>/dev/null)" = "755" ]; then
    T mode_is "$SRC/public/dirmode" 755                      >/dev/null; check "r6: mkdir 权限位 0755" $?
else
    echo "skip mkdir mode (workspace filesystem does not preserve permission bits)"
fi
rm -rf "$WORK/modeprobe"

echo
echo "== round7: protocol robustness & misc semantics =="
# ask-area files with quote and unicode names (JSON escaping + UTF-8 bytes)
echo "quoted" > "$SRC/notes/a\"b.txt"
echo "unicode-ask" > "$SRC/notes/文件 名.txt"
TSH "$PROBE rd '$SRC/notes/a\"b.txt'"                   >/dev/null; check "ask: 文件名含引号正确解析" $?
TSH "$PROBE rd '$SRC/notes/文件 名.txt'"                >/dev/null; check "ask: UTF-8 文件名" $?
# exact directory rule (no glob) allows the dir but not its children
DIONLY="$WORK/dironly.toml"
mkdir -p "$SRC/dironly"
echo "inside" > "$SRC/dironly/f.txt"
cat > "$DIONLY" <<EOT
version = 1
default = "deny"
[[rules]]
path = "$SRC/dironly"
access = "read"
perm = "allow"
EOT
"$B" run --policy "$DIONLY" -- "$PROBE" ls "$SRC/dironly" >/dev/null 2>&1
check "r7: 精确目录规则允许列目录" $?
"$B" run --policy "$DIONLY" -- "$PROBE" rd_fail "$SRC/dironly/f.txt" >/dev/null 2>&1
check "r7: 精确目录规则不覆盖子文件" $?
# SIGTERM exit-code propagation (child kills itself with TERM -> 128+15)
"$B" run --policy "$POL" -- /bin/sh -c 'kill -TERM $$' >/dev/null 2>&1
[ "$?" = "143" ] && rc=0 || rc=1
check "r7: SIGTERM 退出码 143" $rc
# stdin passthrough
printf 'from-stdin' | "$B" run --policy "$POL" -- /bin/sh -c "cat > $SRC/public/from-stdin.txt" >/dev/null 2>&1
T cat_eq "$SRC/public/from-stdin.txt" "from-stdin"      >/dev/null; check "r7: stdin 透传写入沙箱文件" $?
# attribute reads on deny area
T statx_fail "$SRC/vault/secret.txt"                    >/dev/null; check "r7: statx deny" $?
T f_ok_fail "$SRC/vault/secret.txt"                     >/dev/null; check "r7: F_OK deny (EACCES)" $?
T statfs_fail "$SRC/vault/secret.txt"                   >/dev/null; check "r7: statfs deny" $?
# dlopen of a system library (system exec allowance). The path differs by
# libc and architecture, so probe for one that exists.
SYSLIB=""
for c in /lib/x86_64-linux-gnu/libm.so.6 /lib/aarch64-linux-gnu/libm.so.6 \
         /lib/ld-musl-aarch64.so.1 /lib/ld-musl-x86_64.so.1; do
    [ -e "$c" ] && { SYSLIB="$c"; break; }
done
T spawn "$ROOT/build/t_dlopen" "$SYSLIB" ok >/dev/null; check "r7: dlopen 系统库 ($SYSLIB)" $?
# verbose logging behavior
VLOG="$WORK/vlog.log"
rm -f "$VLOG"
"$B" run --policy "$POL" --log "$VLOG" -- "$PROBE" rd "$SRC/docs/readme.txt" >/dev/null 2>&1
grep -q " allow " "$VLOG" 2>/dev/null && rc=1 || rc=0
check "r7: 非 verbose 不记录放行" $rc
rm -f "$VLOG"
"$B" run --policy "$POL" -v --log "$VLOG" -- "$PROBE" rd "$SRC/docs/readme.txt" >/dev/null 2>&1
grep -q " allow " "$VLOG" 2>/dev/null && rc=0 || rc=1
check "r7: verbose 记录放行" $rc
# log to a nonexistent directory must not break the run
rm -f "$VLOG"
"$B" run --policy "$POL" --log /nonexistent-dir/x.log -- "$PROBE" rd "$SRC/docs/readme.txt" >/dev/null 2>&1
check "r7: 日志目录缺失不影响运行" $?

# ------------------------------------------------------------------
echo
echo "== adversarial: sandbox escape attempts =="
# 每种手段尝试读取'禁读哨兵文件'。t_adversarial 自带预期判定：
#   must-block -> 必须被拦住
#   boundary   -> 必须仍可绕过（README「安全边界」已声明的机制限制）
# 边界若被意外扩大（must-block 泄露）或收窄（boundary 失效）都会在此报出。
ASENT="$SRC/denied/secret.txt"
AALLOW="$SRC/public"
A() { "$B" run --policy "$APOL" --log "$LOG" -- "$ROOT/build/t_adversarial" "$@"; }

for t in open openat fopen access statx symlink hardlink rename chmod dotdot \
         cwd-rel proc-root proc-cwd exec-cat popen system dlopen-lib fork-noexec \
         dlsym-next wipe-preload tamper-cfg; do
    A "$t" "$ASENT" "$AALLOW" >/dev/null 2>&1
    check "adv: $t is blocked" $?
done
for t in raw-openat raw-statx dlopen-libc raw-exec; do
    A "$t" "$ASENT" "$AALLOW" >/dev/null 2>&1
    check "adv: $t still bypasses (documented boundary)" $?
done

# ------------------------------------------------------------------
echo
echo "== interpreters: shell / python / node =="
PYBIN=""
for c in python3 /usr/bin/python3 "$HOME/usr/local/bin/python3"; do
    if [ -x "$c" ]; then PYBIN="$c"; break; fi
    if command -v "$c" >/dev/null 2>&1; then PYBIN=$(command -v "$c"); break; fi
done
NODEBIN=""
for c in node /usr/bin/node "$HOME/usr/local/bin/node"; do
    if [ -x "$c" ]; then NODEBIN="$c"; break; fi
    if command -v "$c" >/dev/null 2>&1; then NODEBIN=$(command -v "$c"); break; fi
done

cp "$ROOT/tests/interp_probe.sh" "$SRC/public/" 2>/dev/null
"$B" run --policy "$APOL" --log "$LOG" -- /bin/sh "$SRC/public/interp_probe.sh" \
    "$SRC/public" "$SRC/denied" >/dev/null 2>&1
check "interp(sh): allow/deny matrix" $?

if [ -n "$PYBIN" ]; then
    cp "$ROOT/tests/interp_probe.py" "$SRC/public/" 2>/dev/null
    "$B" run --policy "$APOL" --log "$LOG" -- "$PYBIN" "$SRC/public/interp_probe.py" \
        "$SRC/public" "$SRC/denied" >/dev/null 2>&1
    check "interp(python3): allow/deny matrix" $?
    cp "$ROOT/tests/t_adversarial.py" "$SRC/public/" 2>/dev/null
    for t in py-open py-os-open py-stat py-symlink py-subprocess; do
        "$B" run --policy "$APOL" --log "$LOG" -- "$PYBIN" "$SRC/public/t_adversarial.py" \
            "$t" "$ASENT" "$AALLOW" >/dev/null 2>&1
        check "adv(python3): $t is blocked" $?
    done
    "$B" run --policy "$APOL" --log "$LOG" -- "$PYBIN" "$SRC/public/t_adversarial.py" \
        py-ctypes-syscall "$ASENT" "$AALLOW" >/dev/null 2>&1
    check "adv(python3): ctypes syscall still bypasses (documented boundary)" $?
else
    echo "skip python3 probes (interpreter not found)"
fi

if [ -n "$NODEBIN" ]; then
    cp "$ROOT/tests/interp_probe.js" "$SRC/public/" 2>/dev/null
    "$B" run --policy "$APOL" --log "$LOG" -- "$NODEBIN" "$SRC/public/interp_probe.js" \
        "$SRC/public" "$SRC/denied" >/dev/null 2>&1
    check "interp(node): allow/deny matrix" $?
    cp "$ROOT/tests/t_adversarial.js" "$SRC/public/" 2>/dev/null
    for t in js-read js-open js-child; do
        "$B" run --policy "$APOL" --log "$LOG" -- "$NODEBIN" "$SRC/public/t_adversarial.js" \
            "$t" "$ASENT" "$AALLOW" >/dev/null 2>&1
        check "adv(node): $t is blocked" $?
    done
    "$B" run --policy "$APOL" --log "$LOG" -- "$NODEBIN" "$SRC/public/t_adversarial.js" \
        js-stat "$ASENT" "$AALLOW" >/dev/null 2>&1
    check "adv(node): statSync still bypasses (libuv raw syscall)" $?
else
    echo "skip node probes (interpreter not found)"
fi

# ------------------------------------------------------------------
echo
echo "== trash (del-to-trash 回收站分流) =="
# 回收站只收"有恢复价值"的删除：非空普通文件与非空目录树。空目录
# （rmdir / unlinkat AT_REMOVEDIR 的内核语义保证为空）与 0 字节普通文件
# 直接真删，不产生 <uuid>.back 与 summary.json 条目——rm -rf 的收尾 rmdir
# 与构建零时文件曾是回收站条目的主要噪音源。
# 注意：本段依赖 LD_PRELOAD 注入里层沙箱；若本脚本自身已运行在 dynobox
# 沙箱内（宿主终端集成等场景），外层会按防逃逸语义强制重注入 LD_PRELOAD，
# 里层分流不生效、本段全部失真——在无外层沙箱的环境执行本套件即可。
TRASH="$WORK/trash-task"
trash_count() { # 输出 "<summary条目数>/<back文件数>"
    local entries=0 backs=0
    if [ -f "$TRASH/summary.json" ]; then
        entries=$(grep -c '"uuid"' "$TRASH/summary.json")
    fi
    backs=$(ls "$TRASH" 2>/dev/null | grep -c '\.back$')
    echo "$entries/$backs"
}
T_TRASH() { "$B" run --policy "$POL" --log "$LOG" --del-to-trash --trash "$TRASH" -- "$PROBE" "$@"; }

rm -rf "$TRASH"
printf 'real-content' > "$SRC/public/tr-data.txt"
: > "$SRC/public/tr-zero.txt"
mkdir -p "$SRC/public/tr-empty-dir" "$SRC/public/tr-full-dir"
echo "inner" > "$SRC/public/tr-full-dir/inner.txt"

# 非空普通文件 → 入回收站（.back + summary 条目 + 原路径消失）
T_TRASH rm "$SRC/public/tr-data.txt" >/dev/null 2>&1
rc=0
[ ! -e "$SRC/public/tr-data.txt" ] || rc=1
[ "$(trash_count)" = "1/1" ] || rc=1
check "trash: non-empty file lands in trash" $rc

# 0 字节普通文件 → 真删，不入站
T_TRASH rm "$SRC/public/tr-zero.txt" >/dev/null 2>&1
rc=0
[ ! -e "$SRC/public/tr-zero.txt" ] || rc=1
[ "$(trash_count)" = "1/1" ] || rc=1
check "trash: zero-byte file is hard-deleted" $rc

# 空目录 rmdir → 真删，不入站
T_TRASH rmdir "$SRC/public/tr-empty-dir" >/dev/null 2>&1
rc=0
[ ! -e "$SRC/public/tr-empty-dir" ] || rc=1
[ "$(trash_count)" = "1/1" ] || rc=1
check "trash: empty dir via rmdir is hard-deleted" $rc

# 空目录 unlinkat(AT_REMOVEDIR)（Node fs.rmdir 的实际路径）→ 同样真删不入站
mkdir -p "$SRC/public/tr-empty-dir2"
T_TRASH rmdirat "$SRC/public/tr-empty-dir2" >/dev/null 2>&1
rc=0
[ ! -e "$SRC/public/tr-empty-dir2" ] || rc=1
[ "$(trash_count)" = "1/1" ] || rc=1
check "trash: empty dir via unlinkat(AT_REMOVEDIR) is hard-deleted" $rc

# rm -rf 语义：目录内文件入站，收尾 rmdir 目录壳不入站（最终只有内容条目）
T_TRASH rm "$SRC/public/tr-full-dir/inner.txt" >/dev/null 2>&1
T_TRASH rmdir "$SRC/public/tr-full-dir" >/dev/null 2>&1
rc=0
[ ! -e "$SRC/public/tr-full-dir" ] || rc=1
[ "$(trash_count)" = "2/2" ] || rc=1
check "trash: rm -rf leaves only content entry, no empty shell" $rc

# 非空目录 rmdir → ENOTEMPTY 失败，目录与内容保留（内核语义不受分流影响）
mkdir -p "$SRC/public/tr-guarded-dir"
echo "guard" > "$SRC/public/tr-guarded-dir/keep.txt"
T_TRASH rmdir_fail "$SRC/public/tr-guarded-dir" >/dev/null 2>&1
rc=0
[ -e "$SRC/public/tr-guarded-dir/keep.txt" ] || rc=1
[ "$(trash_count)" = "2/2" ] || rc=1
check "trash: rmdir on non-empty dir still fails with ENOTEMPTY" $rc

# --trash-exclude：命中清单的删除直接真删（临时目录零噪音），清单外照常入站
echo "cache" > "$SRC/public/tr-excl.txt"
echo "real" > "$SRC/public/tr-keep.txt"
"$B" run --policy "$POL" --log "$LOG" --del-to-trash --trash "$TRASH" \
    --trash-exclude "$SRC/public" -- "$PROBE" rm "$SRC/public/tr-excl.txt" >/dev/null 2>&1
rc=0
[ ! -e "$SRC/public/tr-excl.txt" ] || rc=1
[ "$(trash_count)" = "2/2" ] || rc=1
check "trash: --trash-exclude hard-deletes without index entry" $rc
"$B" run --policy "$POL" --log "$LOG" --del-to-trash --trash "$TRASH" \
    -- "$PROBE" rm "$SRC/public/tr-keep.txt" >/dev/null 2>&1
rc=0
[ ! -e "$SRC/public/tr-keep.txt" ] || rc=1
[ "$(trash_count)" = "3/3" ] || rc=1
check "trash: outside exclude list still lands in trash" $rc

# ------------------------------------------------------------------
echo
echo "== regression: interposition-layer robustness =="
# 对应历史上真实出现过的缺陷，防止回归。
T path >/dev/null 2>&1
check "reg: NULL/empty path does not fault the sandbox" $?
"$B" run --policy "$POL" --log "$LOG" -- "$PROBE" posix_spawn /bin/true >/dev/null 2>&1
check "reg: posix_spawn starts child normally" $?
"$B" run --policy "$POL" --log "$LOG" -- "$PROBE" posix_spawn /bin/true closefds >/dev/null 2>&1
check "reg: posix_spawn with close_fds keeps tree alive" $?
"$B" run --policy "$POL" --log "$LOG" -- "$PROBE" spawn_env DYNOBOX_SANDBOX >/dev/null 2>&1
check "reg: child environment intact after exec" $?

# ------------------------------------------------------------------
echo
echo "== runtime artifacts (locally built) =="
# runtime/<target>/ 下是本机构建的运行时产物（不入库，make runtime 现场生成）。
# 这里在**独立工作区**里验证它开箱可用（不依赖 build/），避免"源码改了、
# 产物忘了重新生成"的静默腐化。
RTROOT="$ROOT/runtime"
rt_seen=0
for d in "$RTROOT"/*/; do
    [ -x "$d/dynobox" ] || continue
    rt_seen=1
    rtag=$(basename "$d")
    RTW="$WORK/runtime-check"
    rm -rf "$RTW"
    mkdir -p "$RTW/allowed" "$RTW/denied"
    echo "TOP-SECRET-rt" > "$RTW/denied/secret.txt"
    printf 'version = 1\ndefault = "deny"\n\n[[rules]]\npath = "%s/allowed/**"\naccess = "all"\nperm = "allow"\n' \
        "$RTW" > "$RTW/pol.toml"

    "$d/dynobox" version >/dev/null 2>&1
    check "runtime($rtag): launcher executes" $?
    "$d/dynobox" run --policy "$RTW/pol.toml" -- /bin/sh -c "echo ok > $RTW/allowed/a.txt" >/dev/null 2>&1
    check "runtime($rtag): permits allowed write" $?
    "$d/dynobox" run --policy "$RTW/pol.toml" -- /bin/sh -c "cat $RTW/denied/secret.txt" >/dev/null 2>&1
    if [ $? -eq 0 ]; then rc=1; else rc=0; fi
    check "runtime($rtag): denies unpermitted read" $rc
    rm -rf "$RTW"
done
[ "$rt_seen" = "0" ] && echo "skip runtime artifacts (none built locally)"

echo
echo "== boundary documentation (mechanism limits, see README) =="
# raw syscall bypass is REAL and must stay observable; if this ever fails,
# the interposition mechanism changed and README/log must be updated
"$B" run --policy "$POL" -- "$PROBE" raw_open_rd "$SRC/vault/secret.txt" >/dev/null 2>&1
[ "$?" = "0" ] && rc=0 || rc=1
check "边界[!]: 裸 syscall 绕过真实存在（文档化边界验证）" $rc

echo
echo "========================================="
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" != "0" ]; then
    printf 'failed: %s\n' "${FAILED_NAMES[@]}"
    exit 1
fi
echo "ALL TESTS PASSED"
