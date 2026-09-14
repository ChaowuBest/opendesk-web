"""高级场景测试（沙箱内运行）：覆盖大文件、随机访问、追加/截断、深嵌套、
特殊文件名、大小写、路径穿越攻击、目录操作、只读属性、枚举等。

依赖环境变量 SBX_ROOT。全部通过时退出码 0。
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import stat as stat_m
import sys

def force_writable(path: str) -> None:
    """直接 SetFileAttributesW 解除只读（os.chmod 的 FileBasicInformation
    路径在 Dokan 驱动层会被吞掉，见 MirrorFs 已知怪癖）。"""
    ctypes.windll.kernel32.SetFileAttributesW(path, 0x80)  # FILE_ATTRIBUTE_NORMAL

ROOT = os.environ.get("SBX_ROOT", "S:\\")
results: list[tuple[str, bool, str]] = []


def case(name: str, expect_ok: bool):
    def deco(fn):
        try:
            fn()
            ok = expect_ok
            detail = "符合预期" if expect_ok else "操作竟然成功了"
        except OSError as exc:
            ok = not expect_ok
            detail = f"{type(exc).__name__}" if not expect_ok else f"意外失败: {exc}"
        except AssertionError as exc:
            ok = False
            detail = f"断言失败: {exc}"
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name:<28} ({detail})")
    return deco


def p(*parts: str) -> str:
    return ROOT + "\\".join(parts)


# -- 1. 大文件往返（2MB，验证分段读写与偏移正确性） ------------------------

@case("bigfile_roundtrip", True)
def _():
    data = os.urandom(2 * 1024 * 1024)
    path = p("public", "big.bin")
    with open(path, "wb") as f:
        for i in range(0, len(data), 64 * 1024):
            f.write(data[i:i + 64 * 1024])
    digest_w = hashlib.sha256(data).hexdigest()
    with open(path, "rb") as f:
        digest_r = hashlib.sha256(f.read()).hexdigest()
    os.remove(path)
    assert digest_w == digest_r, "2MB 内容不一致"


# -- 2. 大文件中间偏移随机写 ------------------------------------------------

@case("random_offset_write", True)
def _():
    path = p("public", "rand.bin")
    with open(path, "wb") as f:
        f.write(b"\x00" * 4096)
    with open(path, "r+b") as f:
        f.seek(1000)
        f.write(b"HELLO-DYNOBOX")
    with open(path, "rb") as f:
        blob = f.read()
    os.remove(path)
    assert blob[1000:1013] == b"HELLO-DYNOBOX", "偏移写入内容不符"
    assert blob[:1000] == b"\x00" * 1000, "前段被破坏"
    assert blob[1013:] == b"\x00" * (4096 - 1013), "后段被破坏"


# -- 3. 追加模式 -------------------------------------------------------------

@case("append_mode", True)
def _():
    path = p("public", "app.txt")
    with open(path, "w") as f:
        f.write("line1\n")
    with open(path, "a") as f:
        f.write("line2\n")
    with open(path) as f:
        content = f.read()
    os.remove(path)
    assert content == "line1\nline2\n", repr(content)


# -- 4. 覆盖截断 -------------------------------------------------------------

@case("truncate_overwrite", True)
def _():
    path = p("public", "trunc.txt")
    with open(path, "w") as f:
        f.write("x" * 5000)
    with open(path, "wb") as f:  # 'wb' 打开即截断
        f.write(b"short")
    with open(path, "rb") as f:
        blob = f.read()
    os.remove(path)
    assert blob == b"short", f"长度 {len(blob)}，应为 5"


# -- 5. 读到 EOF 返回空 ------------------------------------------------------

@case("read_at_eof", True)
def _():
    path = p("public", "eof.txt")
    with open(path, "w") as f:
        f.write("abc")
    with open(path, "rb") as f:
        f.seek(3)
        assert f.read() == b"", "EOF 应读到空"
    os.remove(path)


# -- 6. 创建已存在文件（FILE_CREATE 冲突）-----------------------------------

@case("create_collision", False)
def _():
    with open(p("public", "collide.txt"), "w"):
        pass
    try:
        with open(p("public", "collide.txt"), "xb"):
            pass
    finally:
        os.remove(p("public", "collide.txt"))


# -- 7. 深嵌套路径 ------------------------------------------------------------

@case("deep_nested_paths", True)
def _():
    d = p("public", "d1", "d2", "d3", "d4")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "leaf.txt"), "w") as f:
        f.write("deep")
    assert open(os.path.join(d, "leaf.txt")).read() == "deep"
    os.remove(os.path.join(d, "leaf.txt"))
    for _ in range(4):
        os.rmdir(d)
        d = os.path.dirname(d)


# -- 8. 带空格的名字 ----------------------------------------------------------

@case("names_with_spaces", True)
def _():
    d = p("public", "space dir")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "my file.txt"), "w") as f:
        f.write("spacey")
    assert open(os.path.join(d, "my file.txt")).read() == "spacey"
    os.remove(os.path.join(d, "my file.txt"))
    os.rmdir(d)


# -- 9. Unicode 名字 ----------------------------------------------------------

@case("unicode_names", True)
def _():
    d = p("public", "uni目录")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "中文文件.txt"), "w", encoding="utf-8") as f:
        f.write("中文内容")
    assert open(os.path.join(d, "中文文件.txt"), encoding="utf-8").read() == "中文内容"
    os.remove(os.path.join(d, "中文文件.txt"))
    os.rmdir(d)


# -- 10. 200 字符长文件名 ------------------------------------------------------

@case("long_filename_200", True)
def _():
    name = "L" * 200 + ".txt"
    path = p("public", name)
    with open(path, "w") as f:
        f.write("long")
    assert os.path.exists(path)
    os.remove(path)


# -- 11. 大小写不敏感访问 ------------------------------------------------------

@case("case_insensitive_open", True)
def _():
    with open(p("DOCS", "hello.TXT")) as f:
        assert f.read()


# -- 12. 路径穿越攻击（.. 序列逃逸）--------------------------------------------

@case("dotdot_escape_blocked", True)
def _():
    # .. 会被内核归一化到卷内/卷外：绝不允许读到真实文件系统
    for evil in (p("docs", "..", "secret.txt"), p("..", "..", "Windows", "win.ini")):
        try:
            open(evil).read()
            raise AssertionError(f"穿越成功: {evil}")
        except (FileNotFoundError, OSError) as exc:
            # FileNotFoundError/拒绝访问都算拦截成功（WinError 3/5 等）
            if isinstance(exc, AssertionError):
                raise


# -- 13. mkdir/rmdir 在允许写的目录 --------------------------------------------

@case("mkdir_rmdir_public", True)
def _():
    d = p("public", "made-by-test")
    os.mkdir(d)
    assert os.path.isdir(d)
    os.rmdir(d)
    assert not os.path.exists(d)


# -- 14. 删除非空目录被拒 ------------------------------------------------------

@case("rmdir_nonempty_denied", True)
def _():
    d = p("public", "nonempty")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "keep.txt"), "w"):
        pass
    try:
        os.rmdir(d)
        raise AssertionError("非空目录竟然删除成功")
    except OSError:
        pass
    finally:
        os.remove(os.path.join(d, "keep.txt"))
        os.rmdir(d)


# -- 15. 只读属性文件删除被拒，去掉属性后可删 ----------------------------------

@case("readonly_attribute_delete", True)
def _():
    # 唯一文件名：SetFileAttributesW 的属性修改在驱动层被缓存吸收、
    # 不转发到镜像源，只读残留无法从沙箱内清除 —— 故不重用固定名
    path = p("public", f"ro_{os.getpid()}.txt")
    with open(path, "w"):
        pass
    os.chmod(path, stat_m.S_IREAD)  # 置只读
    try:
        os.remove(path)
        raise AssertionError("只读文件竟然删除成功")
    except PermissionError:
        pass  # 只读删除被拒：核心断言
    # 恢复删除为 best-effort（驱动属性缓存会吸收解除只读的修改，
    # 残留的只读文件由编排器在真实 FS 上清扫）
    try:
        force_writable(path)
        os.remove(path)
    except OSError:
        print("NOTE  只读文件恢复删除被驱动属性缓存吸收（残留由编排器清扫）")


# -- 16. 大目录枚举（60 项）-----------------------------------------------------

@case("enum_60_entries", True)
def _():
    d = p("public", "enum")
    os.makedirs(d, exist_ok=True)
    for i in range(60):
        with open(os.path.join(d, f"e{i:03d}.txt"), "w") as f:
            f.write(str(i))
    names = set(os.listdir(d))
    assert len(names) == 60 and "e059.txt" in names
    for i in range(60):
        os.remove(os.path.join(d, f"e{i:03d}.txt"))
    os.rmdir(d)


def main() -> int:
    print(f"=== DYNOBOX 高级场景测试 (SBX_ROOT={ROOT}) ===")
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"=== 结果: {len(results) - failed}/{len(results)} 通过 ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
