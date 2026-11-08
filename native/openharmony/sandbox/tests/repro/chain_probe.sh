#!/bin/sh
# 手动复现「launcher 被 kill -9 后整棵树必须死」并打印看护日志
cd /storage/Users/currentUser/Projects/OpenDesk/native/openharmony/sandbox || exit 1
L=/storage/Users/currentUser/Documents/OpenDesk/sbx-tmp/chain.log
MARK=/storage/Users/currentUser/Documents/OpenDesk/sbx-tmp/chain.marker
rm -f "$L" "$MARK"

./build/dynobox run -v --log "$L" --policy tests/repro/stdmode_allow.toml -- \
  /bin/sh -c 'exec ./build/t_exec_chain ./build/t_exec_chain 3 KEEPER keep' > "$MARK" 2>/dev/null &
LPID=$!
sleep 2
echo "--- launcher pid=$LPID ---"
echo "--- marker ---"; cat "$MARK" 2>/dev/null
echo "--- alive before kill ---"; pgrep -fc t_exec_chain 2>/dev/null || echo 0
kill -9 "$LPID" 2>/dev/null
sleep 3
echo "--- alive after kill ---"; pgrep -fc t_exec_chain 2>/dev/null || echo 0
echo "--- 详细存活列表 ---"; ps -A -o pid,ppid,pgid,args 2>/dev/null | grep t_exec_chain | grep -v grep
echo "--- log (watchdog 相关) ---"; grep -E "watchdog|launcher gone|sandbox active" "$L" 2>/dev/null | tail -12
