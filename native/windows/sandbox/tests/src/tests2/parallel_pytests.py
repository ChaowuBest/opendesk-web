"""多线程并发 IO（同一进程内 4 线程同时读写不同文件 + 共享文件追加）。"""

from __future__ import annotations
import os, threading, sys

ROOT = os.environ.get("SBX_ROOT", "S:\\")
errors: list[str] = []

def worker(idx: int):
    try:
        for i in range(15):
            fp = os.path.join(ROOT, "public", "thr", f"w{idx}_{i:03d}.txt")
            with open(fp, "w") as f:
                f.write(f"t{idx}-{i}")
            with open(fp) as f:
                assert f.read() == f"t{idx}-{i}"
            os.remove(fp)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"worker{idx}: {type(exc).__name__}: {exc}")

def appender():
    # 多线程向同一个共享文件交替追加（句柄级锁下顺序写入）
    try:
        shared = os.path.join(ROOT, "public", "thr", "shared.log")
        for i in range(30):
            with open(shared, "a") as f:
                f.write(f"{i}\n")
        with open(shared) as f:
            lines = [x for x in f.read().splitlines() if x]
        assert len(lines) == 30, f"共享文件行数 {len(lines)} != 30"
        os.remove(shared)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"appender: {type(exc).__name__}: {exc}")

def main() -> int:
    print("=== dynobox 多线程并发 IO 测试 ===")
    os.makedirs(os.path.join(ROOT, "public", "thr"), exist_ok=True)
    threads = [threading.Thread(target=worker, args=(k,)) for k in range(4)]
    threads.append(threading.Thread(target=appender))
    for t in threads: t.start()
    for t in threads: t.join()
    for e in errors: print("ERR ", e)
    print(f"=== 结果: {'全部通过' if not errors else f'{len(errors)} 个错误'} ===")
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main())
