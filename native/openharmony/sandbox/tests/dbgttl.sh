#!/usr/bin/env bash
cd ~/dynobox-linux
SRC=/root/dynobox-linux/tests/work/src
ROOT=/root/dynobox-linux
GTPORT=18106
pkill -f "dynobox end" 2>/dev/null; sleep 0.3
sed -e "s|@SRC@|$SRC|g" -e "s|@UP@|http://127.0.0.1:$GTPORT/decide|g" -e "s|@ROOT@|$ROOT|g" \
        -e "s/cache_ttl_seconds = 60/cache_ttl_seconds = 0/" \
        tests/policies/func.toml.in > tests/work/gt.toml
rm -f tests/work/gtaudit.log
build/dynobox endpoint --port $GTPORT --default deny --grant-ttl 1 --log tests/work/gtaudit.log >/dev/null 2>&1 &
GEP=$!
sleep 0.6
build/dynobox run --policy tests/work/gt.toml -- /build/t_probe wr /scratch/ex1.txt a
echo "wr1 rc=$?"
sleep 1.4
build/dynobox run --policy tests/work/gt.toml -- /build/t_probe wr /scratch/ex2.txt b
echo "wr2 rc=$?"
sleep 0.2
echo "AUDX1=$(grep -c 'path=/scratch' tests/work/gtaudit.log 2>/dev/null)"
cat tests/work/gtaudit.log 2>/dev/null
kill -9 $GEP 2>/dev/null
