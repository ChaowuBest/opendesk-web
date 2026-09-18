#!/usr/bin/env bash
# Run the dynobox-linux test suite on the WSL native filesystem.
#
# The project lives on /mnt/d (Windows NTFS via drvfs/9p), where file
# locking and O_APPEND atomicity are not reliable — the concurrency tests
# would report false failures. This script copies the tree to the native
# ext4 filesystem, builds and runs the suite there.
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HOME/dynobox-linux"

rm -rf "$DST"
mkdir -p "$DST"
cp -a "$SRC"/. "$DST"/

cd "$DST"
timeout 900 make tests
timeout 1200 bash tests/run_all.sh
