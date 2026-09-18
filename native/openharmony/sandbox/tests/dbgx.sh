#!/usr/bin/env bash
cd ~/dynobox-linux
bash -x tests/run_all.sh 2>/tmp/xtrace.log >/tmp/xtout.log
echo "SUITE_RC=$?"
grep -E "DBG|grant TTL" /tmp/xtrace.log | tail -30
tail -6 /tmp/xtout.log
