"""沙箱内运行的访问控制测试（Python 部分）。

依赖沙箱设置的环境变量 SBX_ROOT（形如 S:\\）。
每个用例打印 PASS/FAIL，全部通过则退出码 0。
"""

from __future__ import annotations

import os
import sys

ROOT = os.environ.get("SBX_ROOT", "S:\\")
results: list[tuple[str, bool, str]] = []


def case(name: str, expect_ok: bool):
    def run(fn):
        try:
            fn()
            ok = expect_ok
            detail = "符合预期" if expect_ok else "操作竟然成功了"
        except (PermissionError, OSError) as exc:
            ok = not expect_ok
            detail = f"{type(exc).__name__}: {exc}" if not expect_ok else f"意外失败: {exc}"
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name:<24} ({detail})")
    return run


# 1. 读放行
@case("read_allow_docs", True)
def _():
    with open(ROOT + r"docs\hello.txt", "rb") as f:
        assert f.read()


# 2. 读拒绝（静态 deny 规则）
@case("read_deny_secret", False)
def _():
    with open(ROOT + r"docs\secret.txt", "rb") as f:
        f.read()


# 3. 写放行（public 全放行）
@case("write_allow_public", True)
def _():
    with open(ROOT + r"public\py_ok.txt", "w") as f:
        f.write("hello")
    with open(ROOT + r"public\py_ok.txt") as f:
        assert f.read() == "hello"


# 4. 写拒绝（vault 全拒）
@case("write_deny_vault", False)
def _():
    with open(ROOT + r"vault\x.txt", "w") as f:
        f.write("nope")


# 5. 写 ask -> 上游 allow
@case("write_ask_allow_staging", True)
def _():
    with open(ROOT + r"staging\py_ok.txt", "w") as f:
        f.write("ok")


# 6. 写 ask -> 上游 deny（/reject 子树端点恒拒且不下发授权）
@case("write_ask_deny_reject", False)
def _():
    with open(ROOT + r"reject\py_denied.txt", "w") as f:
        f.write("nope")


# 7. 读 ask -> 上游 allow
@case("read_ask_allow_notes", True)
def _():
    with open(ROOT + r"notes\a.txt") as f:
        f.read()


# 8. ask 超时 -> fail-closed 拒绝（端点挂起 8s，沙箱 2s 超时）
@case("ask_timeout_fail_closed", False)
def _():
    with open(ROOT + r"slow\x.txt", "w") as f:
        f.write("nope")


# 9. 改名（两端都在 staging，写 ask -> allow）
@case("rename_within_staging", True)
def _():
    os.rename(ROOT + r"staging\py_ok.txt", ROOT + r"staging\py_ok2.txt")


# 10. 改名到拒绝目录
@case("rename_into_vault", False)
def _():
    os.rename(ROOT + r"staging\py_ok2.txt", ROOT + r"vault\x2.txt")


# 11. 删除放行（staging 写 ask -> allow）
@case("delete_allow_staging", True)
def _():
    os.remove(ROOT + r"staging\py_ok2.txt")


# 12. 删除拒绝（docs 只允许读）
@case("delete_deny_docs", False)
def _():
    os.remove(ROOT + r"docs\hello.txt")


# 13. 根目录枚举放行
@case("list_root", True)
def _():
    assert "docs" in os.listdir(ROOT)


def main() -> int:
    print(f"=== dynobox 沙箱内访问控制测试 (SBX_ROOT={ROOT}) ===")
    failed = 0
    for name, ok, _ in results:
        if not ok:
            failed += 1
    print(f"=== 结果: {len(results) - failed}/{len(results)} 通过 ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
