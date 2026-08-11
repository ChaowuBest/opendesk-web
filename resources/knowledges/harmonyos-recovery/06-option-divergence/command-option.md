# 命令选项差异

常见的命令行工具能在 HarmonyOS 运行，但选项和行为与标准 Linux 上存在差异不同。本文档记录一些已知的差异化表现。

[⬆ 返回桶6](./README.md)

---

## install 命令缺GNU扩展

```
install: command not found (旧版)
install: Unknown option 'C'
install: Unknown option 'strip'/'backup'/'compare'
```

（toybox install 基础 -d/-D/-m/-s 可用，缺 GNU 扩展）

```bash
# 简单替代: cp + chmod
mkdir -p $PREFIX/bin && cp program $PREFIX/bin/program && chmod 755 $PREFIX/bin/program

# 或安装 GNU coreutils
curl -fsSL https://gitcode.com/.../install.sh | sh -s -- coreutils 9.10

# Makefile 中 install -> ginstall
sed -i 's/install -d/ginstall -d/g; s/install -m0755/ginstall -m0755/g' tools/Makefile.in
```

---

## grep 正则元字符误匹配固定字符串

```
grep "test[0-9]value" 匹配到意外结果
grep "test.c" 匹配了 testXc（. 被当通配符）
```

```bash
# 用 grep -F 固定字符串模式
echo "$V" | grep -F "GNU sed 4.9"

# 或用 case（POSIX 原生）
case "$V" in *substring*) echo OK;; esac
```

---

## locale 支持不完整

```
test_strcoll_with_diacritic ... FAIL
locale 命令不可用 / localeconv 返回大量空值
```

```bash
export LC_ALL=C
# 跳过 locale 相关测试
python3 -m test -x test_locale test_c_locale_coercion
```

---

## BASH_SOURCE 在 toybox ash 中不可用

```
source activate.sh 后环境变量未生效
PYTHON_DIR 为空，后续 PATH/LD_LIBRARY_PATH 全部错误
```

```bash
# ❌ 不兼容 toybox ash
PYTHON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ✅ 兼容 toybox ash / bash / dash
PYTHON_DIR="$(cd "$(dirname "$0")" && pwd)"
```

---

## 交互式 read 阻塞非交互执行

```
Process hangs indefinitely when run with --version
L2 smoke test times out
read -r void ← blocks waiting for stdin
```

```bash
# 非阻塞 read
read -r void < /dev/null 2>/dev/null || true

# 终端检测
[ -t 0 ] && read -r var || true

# 早期参数处理（避免进入 read 逻辑）
for arg in "$@"; do
    case "$arg" in
        --version|-V) echo "Tool $VERSION"; exit 0 ;;
    esac
done
```
