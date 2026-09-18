#!/usr/bin/env bash
cd ~/dynobox-linux
pkill -f "dynobox end" 2>/dev/null; sleep 0.3
build/dynobox endpoint --port 18099 --default deny --log tests/work/audit.log >/dev/null 2>&1 &
EP=$!
sleep 0.5
rm -f /tmp/d28.log
build/dynobox run --policy tests/work/func.toml --log /tmp/d28.log -v -- /root/dynobox-linux/build/t_probe rd_fail_eacces /root/dynobox-linux/tests/work/src/slow/timed.txt
echo "rd rc=$?"
grep -E "allow|DENY|ask" /tmp/d28.log | tail -5
echo "--- audit ---"
grep slow tests/work/audit.log 2>/dev/null | tail -2
kill $EP 2>/dev/null
