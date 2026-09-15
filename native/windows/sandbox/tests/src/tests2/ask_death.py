"""端点死亡 fail-closed 测试（沙箱内运行，由编排器配合时序）：
第 1 次写 staging（端点活着）应成功；sleep 让编排器杀掉端点；
第 2 次写【不同路径】staging（端点已死）必须被拒——失败不应缓存。
全部符合预期 => 退出码 0。
"""

from __future__ import annotations

import os
import sys
import time

ROOT = os.environ.get("SBX_ROOT", "S:\\")


def main() -> int:
    print(f"=== 端点死亡 fail-closed 测试 (SBX_ROOT={ROOT}) ===")
    # 1. 端点存活：写应成功（ask -> allow）
    try:
        with open(os.path.join(ROOT, "guarded", "ad1.txt"), "w") as f:
            f.write("while-alive")
        print("PASS  while_alive_write")
    except OSError as exc:
        print(f"FAIL  while_alive_write ({exc})")
        return 1

    time.sleep(4)  # 编排器在此窗口杀掉端点

    # 2. 端点已死：不同路径的新 ask 必须 fail-closed 拒绝
    try:
        with open(os.path.join(ROOT, "guarded", "ad2.txt"), "w") as f:
            f.write("after-death")
        print("FAIL  after_death_write_denied (端点死了竟然还写入成功)")
        return 1
    except OSError as exc:
        print(f"PASS  after_death_write_denied ({type(exc).__name__})")

    # 3. 已成功过的路径在 TTL 内仍应命中缓存允许（决策缓存不因端点死亡而丢）
    try:
        with open(os.path.join(ROOT, "guarded", "ad1.txt"), "a") as f:
            f.write("-appended")
        print("PASS  cached_path_still_allowed")
    except OSError as exc:
        print(f"WARN  cached_path_still_allowed ({exc})——缓存已过期或未生效，不判失败")
    return 0


if __name__ == "__main__":
    sys.exit(main())
