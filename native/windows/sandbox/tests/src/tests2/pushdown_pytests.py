"""子树授权推权验证（沙箱内运行）：写 /scratch 下 5 个新文件。
第一次写触发 ask（端点 allow + 下发 /scratch/** all 授权），
后续文件应命中本地授权零问询。ask 次数由编排器通过端点 /log 断言。"""

from __future__ import annotations
import os, sys

ROOT = os.environ.get("SBX_ROOT", "S:\\")

def main() -> int:
    print("=== dynobox 子树授权推权测试 ===")
    try:
        for i in range(1, 6):
            fp = os.path.join(ROOT, "scratch", f"push{i}.txt")
            with open(fp, "w") as f:
                f.write(f"payload-{i}")
            with open(fp) as f:
                assert f.read() == f"payload-{i}"
            os.remove(fp)
        print("PASS  5 个新文件全部写入成功（后续文件零问询）")
        return 0
    except OSError as exc:
        print(f"FAIL  {type(exc).__name__}: {exc}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
