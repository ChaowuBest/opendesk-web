#!/usr/bin/env bash
# prepare-ohos.sh - 为鸿蒙构建准备 FillipDesk app（构建、拷贝到目标目录，在目标内裁剪）
#
# 用法:
#   ./prepare-ohos.sh /foo/bar/app             # 构建并拷贝到指定目录（仓库可放任意位置）
#   ./prepare-ohos.sh /foo/bar/app --no-build  # 指定目标，并跳过 build
#
# 目标路径为必选参数，未传入则报错退出。
#
# 选项: --no-build  跳过 npm run build    --no-prune  跳过 npm prune
#       --no-slim   不裁剪 node_modules   -h, --help  显示帮助
#
# 环境变量:
#   APP_ROOT  - FillipDesk 源码目录，默认: 脚本所在目录的上一级 (app/)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${APP_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

DO_BUILD=1
DO_PRUNE=1
DO_SLIM=1
TARGET_ARG=""

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --no-prune) DO_PRUNE=0 ;;
    --no-slim)  DO_SLIM=0 ;;
    -h|--help)
      head -15 "$0" | tail -14
      exit 0
      ;;
    -*)
      ;;
    *)
      if [[ -z "$TARGET_ARG" ]]; then TARGET_ARG="$arg"; fi
      ;;
  esac
done

if [[ -z "$TARGET_ARG" ]]; then
  echo "[prepare-ohos] 错误: 必须指定目标目录路径。用法: $0 <目标路径> [--no-build] [--no-prune] [--no-slim]" >&2
  exit 1
fi
TARGET="$TARGET_ARG"

echo "[prepare-ohos] APP_ROOT=$APP_ROOT"
echo "[prepare-ohos] TARGET=$TARGET"

if [[ ! -f "$APP_ROOT/package.json" ]]; then
  echo "[prepare-ohos] 错误: $APP_ROOT/package.json 不存在。请将 FillipDesk 源码放入 app/ 或设置 APP_ROOT。" >&2
  exit 1
fi

if ! grep -q '"build"' "$APP_ROOT/package.json" 2>/dev/null; then
  echo "[prepare-ohos] 错误: package.json 中未找到 build 脚本。" >&2
  exit 1
fi

# 若以 resfile 中的 app 为源码（APP_ROOT == TARGET），需要“就地”构建再删除多余内容，而不是拷贝
# 此处仅支持“从 APP_ROOT 拷贝到 TARGET”；若 APP_ROOT 与 TARGET 相同，则先 build+prune，再就地删除多余
IN_PLACE=0
if [[ "$(cd "$APP_ROOT" && pwd)" == "$(cd "$TARGET" 2>/dev/null && pwd)" ]] 2>/dev/null; then
  IN_PLACE=1
  echo "[prepare-ohos] 检测到就地模式 (APP_ROOT == TARGET)，将构建后删除多余文件。"
fi

# ---------- 1. 构建 ----------
if [[ $DO_BUILD -eq 1 ]]; then
  echo "[prepare-ohos] 执行: npm run build"
  (cd "$APP_ROOT" && npm run build)
  if [[ ! -d "$APP_ROOT/dist" ]]; then
    echo "[prepare-ohos] 错误: 构建后未找到 dist/。" >&2
    exit 1
  fi
else
  echo "[prepare-ohos] 跳过 build (--no-build)"
  if [[ $IN_PLACE -eq 0 ]] && [[ ! -d "$APP_ROOT/dist" ]]; then
    echo "[prepare-ohos] 错误: 未构建且 dist/ 不存在。" >&2
    exit 1
  fi
fi

# ---------- 2. 输出到 TARGET（仅拷贝，不修改源目录） ----------
if [[ $IN_PLACE -eq 1 ]]; then
  # 就地: 删除除 dist、resources、package.json、node_modules 以外的内容
  # 注意：scripts/ 等会被删除；若本脚本位于该 app 内，运行后将被移除。
  echo "[prepare-ohos] 就地删除多余文件…"
  (cd "$APP_ROOT" && find . -maxdepth 1 -mindepth 1 \
    ! -name 'dist' ! -name 'resources' ! -name 'package.json' ! -name 'node_modules' \
    -exec rm -rf {} +)
else
  # 拷贝模式: 清空 TARGET 后完整拷贝，源目录不受影响；prune/slim 在目标内再做
  echo "[prepare-ohos] 清空并拷贝到 $TARGET（完整 node_modules，后续在目标内裁剪）"
  rm -rf "$TARGET"
  mkdir -p "$TARGET"

  for name in dist resources package.json node_modules; do
    if [[ -e "$APP_ROOT/$name" ]]; then
      cp -R "$APP_ROOT/$name" "$TARGET/"
    else
      echo "[prepare-ohos] 警告: 不存在 $APP_ROOT/$name，跳过。"
    fi
  done
fi

# ---------- 3. 在 TARGET 内：裁剪依赖（仅生产，不碰源目录） ----------
if [[ $DO_PRUNE -eq 1 ]]; then
  if [[ -f "$TARGET/package.json" ]] && [[ -d "$TARGET/node_modules" ]]; then
    echo "[prepare-ohos] 在目标目录执行: npm prune --omit=dev"
    (cd "$TARGET" && npm prune --omit=dev)
  else
    echo "[prepare-ohos] 跳过 npm prune（目标无 package.json 或 node_modules）"
  fi
else
  echo "[prepare-ohos] 跳过 npm prune (--no-prune)"
fi

# ---------- 4. 在 TARGET 内：裁剪 node_modules（.ts、.map、文档等） ----------
NM="$TARGET/node_modules"
if [[ $DO_SLIM -eq 1 ]] && [[ -d "$NM" ]]; then
  echo "[prepare-ohos] 裁剪 node_modules（删除 .ts、.map、README、tests、docs 等）…"
  (cd "$NM" && find . -type f \( \
    -name '*.ts' -o -name '*.tsx' -o \
    -name '*.map' -o \
    -name 'README*' -o -name 'CHANGELOG*' -o -name 'HISTORY*' -o -name '*.md' \
  \) -delete 2>/dev/null || true)
  # 先删子目录再删父目录（-depth），避免 find 进入已删除目录
  (cd "$NM" && find . -depth -type d \( \
    -name 'test' -o -name 'tests' -o -name '__tests__' -o \
    -name 'doc' -o -name 'docs' -o -name '.github' -o \
    -name 'example' -o -name 'examples' \
  \) -exec rm -rf {} + 2>/dev/null || true)
  (cd "$NM" && find . -depth -type d -empty -delete 2>/dev/null || true)
fi

echo "[prepare-ohos] 删除 node_modules 中不需要的依赖目录"
rm -rf "$NM/electron"
rm -rf "$NM/lightningcss-darwin-arm64"
rm -rf "$NM/.vite"
rm -rf "$NM/tsx"
rm -rf "$NM/@img"

# ---------- 5. 简要体积 ----------
if command -v du >/dev/null 2>&1; then
  if [[ -d "$TARGET" ]]; then
    SIZE="$(du -sh "$TARGET" 2>/dev/null | cut -f1)"
    echo "[prepare-ohos] 完成。目标目录体积: $SIZE"
  fi
else
  echo "[prepare-ohos] 完成。"
fi
