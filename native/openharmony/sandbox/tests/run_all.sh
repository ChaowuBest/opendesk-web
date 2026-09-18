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
SRC="$ROOT/tests/work/src"
AUDIT="$ROOT/tests/work/audit.log"
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
rm -rf "$ROOT/tests/work"
mkdir -p "$SRC"/{public,docs,vault,notes,staging,scratch,reject,guarded,slow,tools/bin,tools/blocked,tools/ask,tools/sub,deep/x1/x2/x3/x4}
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
gcc -shared -fPIC -o "$SRC/public/libhello.so" "$SRC/public/libhello.c"
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
POL="$ROOT/tests/work/func.toml"
LOG="$ROOT/tests/work/sandbox.log"
UP="http://127.0.0.1:$PORT/decide"
sed -e "s|@SRC@|$SRC|g" -e "s|@UP@|$UP|g" -e "s|@ROOT@|$ROOT|g" \
    "$ROOT/tests/policies/func.toml.in" > "$POL"

T() { "$B" run --policy "$POL" --log "$LOG" -- "$PROBE" "$@"; }

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
T spawn "$ROOT/build/t_mmap" "$SRC/public/blob.bin" allow   >/dev/null; check "mmap PROT_EXEC allowed (exec rule)" $?
T spawn "$ROOT/build/t_mmap" "$SRC/docs/readme.txt" deny    >/dev/null; check "mmap PROT_EXEC denied (no exec rule)" $?
# fexecve with attribution
T spawn "$ROOT/build/t_probe" fexecve_fail "$SRC/vault/secret.txt" >/dev/null 2>&1
check "fexecve deny 区 fd 拒绝" $?

echo "== advanced: network =="
T spawn "$ROOT/build/t_net" unix_ok                     >/dev/null; check "AF_UNIX socketpair always ok" $?
T spawn "$ROOT/build/t_net" udp_connect 127.0.0.1 $PORT >/dev/null; check "loopback udp connect (default allow)" $?
NETPOL="$ROOT/tests/work/net.toml"
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
MARK="$ROOT/tests/work/marker.out"
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
echo "this is not toml {{{" > "$ROOT/tests/work/bad.toml"
"$B" run --policy "$ROOT/tests/work/bad.toml" -- /bin/true >/dev/null 2>&1
[ "$?" != "0" ] && rc=0 || rc=1
check "invalid TOML rejected" $rc
printf 'version = 1\ndefault = "deny"\n[[rules]]\npath = "/x"\naccess = "sometimes"\nperm = "allow"\n' > "$ROOT/tests/work/bad2.toml"
"$B" run --policy "$ROOT/tests/work/bad2.toml" -- /bin/true >/dev/null 2>&1
[ "$?" != "0" ] && rc=0 || rc=1
check "invalid rule rejected" $rc
printf 'version = 1\ndefault = "deny"\n[[roots]]\nvirtual = "/C"\nreal = "/host"\n' > "$ROOT/tests/work/bad3.toml"
"$B" run --policy "$ROOT/tests/work/bad3.toml" -- /bin/true >/dev/null 2>&1
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
UEND="/tmp/dynobox-test-ep.sock"
rm -f "$UEND"
"$B" endpoint --unix "$UEND" --default deny >/dev/null 2>&1 &
UPID=$!
for i in $(seq 1 50); do [ -S "$UEND" ] && break; sleep 0.1; done
sleep 0.3
UNIPOL="$ROOT/tests/work/unix.toml"
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
T realpath_eq /usr/bin/ls /usr/bin/ls                    >/dev/null; check "r6: realpath 系统路径不受影响" $?
# relative script execution
"$B" run --policy "$POL" --log "$LOG" -- /bin/sh -c "cd $SRC/tools/bin && $PROBE spawn ./ok.sh" >/dev/null 2>&1
check "r6: 相对路径执行脚本" $?
# ENOTDIR semantics through an allowed parent
T enotdir_fail "$SRC/docs/readme.txt" "$SRC/docs/readme.txt/x" >/dev/null; check "r6: ENOTDIR 语义" $?
# X_OK through symlink to allowed system binary
T x_ok_through_symlink "$SRC/public/slink"               >/dev/null; check "r6: X_OK 经符号链接解析目标" $?
# mkdir permission bits
T mkdir "$SRC/public/dirmode"                            >/dev/null
T mode_is "$SRC/public/dirmode" 755                      >/dev/null; check "r6: mkdir 权限位 0755" $?

echo
echo "== round7: protocol robustness & misc semantics =="
# ask-area files with quote and unicode names (JSON escaping + UTF-8 bytes)
echo "quoted" > "$SRC/notes/a\"b.txt"
echo "unicode-ask" > "$SRC/notes/文件 名.txt"
TSH "$PROBE rd '$SRC/notes/a\"b.txt'"                   >/dev/null; check "ask: 文件名含引号正确解析" $?
TSH "$PROBE rd '$SRC/notes/文件 名.txt'"                >/dev/null; check "ask: UTF-8 文件名" $?
# exact directory rule (no glob) allows the dir but not its children
DIONLY="$ROOT/tests/work/dironly.toml"
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
# dlopen of a system library (system exec allowance)
T spawn "$ROOT/build/t_dlopen" /lib/x86_64-linux-gnu/libm.so.6 ok >/dev/null; check "r7: dlopen 系统库" $?
# verbose logging behavior
VLOG="$ROOT/tests/work/vlog.log"
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
