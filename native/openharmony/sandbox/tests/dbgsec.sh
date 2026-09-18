#!/usr/bin/env bash
cd ~/dynobox-linux
pkill -f "dynobox end" 2>/dev/null; sleep 0.3
build/dynobox endpoint --port 18099 --default deny >/dev/null 2>&1 &
EP=$!
sleep 0.5
sed -e "s|@SRC@|/root/dynobox-linux/tests/work/src|g" \
    -e "s|@UP@|http://127.0.0.1:18099/decide|g" \
    -e "s|@ROOT@|/root/dynobox-linux|g" \
    tests/policies/func.toml.in > tests/work/func.toml
rm -f /tmp/d30.log
build/dynobox run --policy tests/work/func.toml --log /tmp/d30.log -v -- /root/dynobox-linux/build/t_probe fexecve_fail /root/dynobox-linux/tests/work/src/vault/secret.txt
echo "rc=$?"
grep -E "allow|DENY|ask" /tmp/d30.log | tail -4
kill $EP 2>/dev/null
