#!/usr/bin/env bash
# ==============================================================================
# OpenDesk CLI 一键安装脚本 (鸿蒙平台专用)
#
# 用法:
#   curl -sSL https://path/to/install_ohos.sh | bash
#
# 该脚本会自动:
#   1. 检测平台是否为鸿蒙 (OpenHarmony)
#   2. 检测 NodeJS / NPM 环境
#   3. 确保 $(npm prefix -g)/bin 在 PATH 中
#   4. 配置国内镜像加速
#   5. 安装 opendesk-cli
#   6. 验证安装
# ==============================================================================

set -euo pipefail

# ---- 颜色定义 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ---- 常量 ----
DOCS_URL="https://opendesk.bitclub.ai/docs/quickstart/cli"
NPM_PACKAGE="@bitclub.ai/opendesk-cli"
MIRROR_REGISTRY="https://registry.npmmirror.com"
RC_FILE="$HOME/.zshrc"

# ---- 辅助函数 ----

# 从 /dev/tty 读取用户输入（因为脚本可能通过管道执行 curl|bash）
read_input() {
    local prompt="$1"
    local default="$2"
    local answer=""

    # 始终将提示打印到 stderr，确保在管道场景下用户可见
    printf "%s" "${prompt}" >&2

    if [ -t 0 ]; then
        # 情形 1: stdin 是终端（如直接执行 ./install_ohos.sh），直接读取
        read -r answer
    elif [ -c /dev/tty ] && [ -t 1 ]; then
        # 情形 2: stdout 是终端且 /dev/tty 存在
        # 典型场景：curl -sSL URL | bash（stdin=管道, stdout=终端）
        # 使用带超时的 read 来测试 /dev/tty 是否真正可用
        # 在某些平台（如 OpenHarmony）上 /dev/tty 可能存在但无法读取
        if read -t 1 -r answer 2>/dev/null </dev/tty; then
            # 成功从 tty 读取
            echo "${answer:-$default}"
            return
        fi
        # tty 不可用或读取超时，使用默认值
        printf "%s\n" "${default}" >&2
        echo "${default}"
        return
    else
        # 情形 3: 完全非交互环境（如 CI），使用默认值
        printf "%s\n" "${default}" >&2
        echo "${default}"
        return
    fi

    echo "${answer:-$default}"
}

# 询问 yes/no，返回 0 表示 yes，1 表示 no
ask_yes_no() {
    local prompt="$1"
    local default="$2"  # "y" or "n"
    local answer
    if [ "$default" = "y" ]; then
        answer=$(read_input "${prompt} [Y/n]: " "y")
        case "$answer" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            *) return 1 ;;
        esac
    else
        answer=$(read_input "${prompt} [y/N]: " "n")
        case "$answer" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            *) return 1 ;;
        esac
    fi
}

print_header() {
    echo ""
    echo -e "${CYAN}${BOLD}============================================${NC}"
    echo -e "${CYAN}${BOLD}   OpenDesk CLI 安装向导 (鸿蒙平台)${NC}"
    echo -e "${CYAN}${BOLD}============================================${NC}"
    echo ""
}

print_step() {
    echo -e "${BLUE}${BOLD}>>>${NC} ${BOLD}$1${NC}"
}

print_success() {
    echo -e "    ${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "    ${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "    ${RED}✗${NC} $1"
}

print_info() {
    echo -e "    ${CYAN}ℹ${NC} $1"
}

# ---- 步骤 1: 检测平台是否为鸿蒙 ----
check_platform() {
    print_step "步骤 1/5: 检测平台环境..."

    local node_platform
    if command -v node &>/dev/null; then
        node_platform=$(node -p "process.platform" 2>/dev/null || echo "unknown")
    else
        print_error "未找到 Node.js，无法检测平台"
        exit 1
    fi

    if [ "$node_platform" = "openharmony" ]; then
        print_success "检测到 OpenHarmony 平台"
    else
        print_error "不支持的平台: ${node_platform}"
        echo ""
        echo -e "  ${RED}此安装脚本仅支持 OpenHarmony 鸿蒙平台。${NC}"
        echo -e "  当前平台: ${node_platform}"
        echo ""
        echo "  请使用对应的安装脚本或前往以下地址获取帮助:"
        echo -e "  ${CYAN}${DOCS_URL}${NC}"
        echo ""
        exit 1
    fi

    echo ""
}

# ---- 步骤 2: 检测 NodeJS 和 NPM ----
check_nodejs() {
    print_step "步骤 2/5: 检测 NodeJS 和 NPM 环境..."

    local node_ok=false
    local npm_ok=false

    # 检测 node
    if command -v node &>/dev/null; then
        local node_version
        node_version=$(node --version 2>/dev/null)
        print_success "NodeJS 已安装 (${node_version})"
        node_ok=true
    else
        print_error "未检测到 NodeJS"
    fi

    # 检测 npm
    if command -v npm &>/dev/null; then
        local npm_version
        npm_version=$(npm --version 2>/dev/null)
        print_success "NPM 已安装 (v${npm_version})"
        npm_ok=true
    else
        print_error "未检测到 NPM"
    fi

    if ! $node_ok || ! $npm_ok; then
        echo ""
        echo -e "${YELLOW}${BOLD}⚠ 缺少必要的运行环境${NC}"
        echo ""
        echo "  请参考以下文档安装 NodeJS 和 NPM:"
        echo -e "  ${CYAN}${DOCS_URL}${NC}"
        echo ""
        echo "  简要说明:"
        echo "  - 鸿蒙 PC: 在应用市场搜索 DevNode-OH 安装"
        echo ""
        exit 1
    fi

    echo ""
}

# ---- 步骤 3: 检测并修复 PATH ----
check_and_fix_path() {
    print_step "步骤 3/5: 配置 PATH 环境变量..."

    local npm_global_bin
    npm_global_bin="$(npm prefix -g)/bin"

    print_info "NPM 全局 bin 目录: ${npm_global_bin}"

    # 检查 PATH 中是否已包含该目录
    if echo "$PATH" | tr ':' '\n' | grep -qFx "${npm_global_bin}"; then
        print_success "PATH 中已包含 NPM 全局 bin 目录"
        echo ""
        return 0
    fi

    print_warning "PATH 中未包含 NPM 全局 bin 目录"
    echo ""
    echo -e "  需要将 ${CYAN}${npm_global_bin}${NC} 添加到 PATH 中，"
    echo "  否则安装后无法直接运行 opendesk 命令。"
    echo ""
    echo -e "  将修改配置文件: ${CYAN}${RC_FILE}${NC}"
    echo ""

    if ask_yes_no "是否自动添加 PATH 配置？" "y"; then
        # 确保文件存在
        touch "${RC_FILE}"

        # 检查文件中是否已有类似配置
        if grep -q "npm prefix -g.*bin.*PATH" "${RC_FILE}" 2>/dev/null || \
           grep -q "export PATH=.*npm prefix -g" "${RC_FILE}" 2>/dev/null; then
            print_info "配置文件中已存在 NPM PATH 配置，跳过"
        else
            # 添加配置
            echo "" >> "${RC_FILE}"
            echo "# Added by OpenDesk CLI installer ($(date '+%Y-%m-%d %H:%M:%S'))" >> "${RC_FILE}"
            echo "export PATH=\$(npm prefix -g)/bin:\$PATH" >> "${RC_FILE}"
            print_success "已将 PATH 配置添加到 ${RC_FILE}"
        fi
    else
        print_warning "跳过 PATH 配置（安装后可能需要手动配置）"
    fi

    echo ""
}

# ---- 步骤 4: 配置镜像加速 ----
configure_mirror() {
    print_step "步骤 4/5: 配置 NPM 镜像加速..."

    echo ""
    echo -e "  配置国内镜像加速 (${MIRROR_REGISTRY})..."
    echo ""

    npm config set registry "${MIRROR_REGISTRY}"
    print_success "已将 NPM registry 设置为 ${MIRROR_REGISTRY}"
    print_info "如需恢复，可运行: npm config delete registry"

    echo ""
}

# ---- 步骤 5: 安装 opendesk-cli ----
install_opendesk() {
    print_step "步骤 5/5: 安装 OpenDesk CLI..."

    local install_cmd="npm i -g ${NPM_PACKAGE}"

    # 查询最新稳定版本号用于展示（查询失败时回退为"稳定版本"）
    local target_version
    target_version=$(npm view "${NPM_PACKAGE}" version 2>/dev/null || echo "")
    local version_label="稳定版本"
    if [ -n "$target_version" ]; then
        version_label="${target_version}"
    fi

    # 保存版本标签供 print_finish 使用
    INSTALLED_VERSION_LABEL="${version_label}"

    echo ""
    echo -e "  将安装： ${BOLD}${version_label}${NC}"

    # 检查是否已安装
    if command -v opendesk &>/dev/null || npm list -g --depth=0 2>/dev/null | grep -q "${NPM_PACKAGE}"; then
        local existing_version=""
        if command -v opendesk &>/dev/null; then
            existing_version=$(opendesk --version 2>/dev/null || echo "未知版本")
        fi
        echo ""
        echo -e "  ${YELLOW}检测到已安装 OpenDesk CLI${NC}"
        if [ -n "$existing_version" ]; then
            echo -e "  当前版本: ${existing_version}"
        fi
        echo ""

        if ! ask_yes_no "是否覆盖安装？" "y"; then
            print_info "已取消安装"
            exit 0
        fi
    fi

    echo ""
    print_info "正在安装，请稍候..."
    echo ""

    # 执行安装
    if eval "${install_cmd}"; then
        print_success "安装完成!"
    else
        echo ""
        print_error "安装失败，请检查网络连接或重试"
        echo ""
        echo "  如果因为网络问题安装失败，可以尝试:"
        echo "  1. 检查镜像配置后重试"
        echo "  2. 手动运行: ${install_cmd}"
        exit 1
    fi

    echo ""
}

# ---- 验证安装 ----
verify_installation() {
    local npm_global_bin
    npm_global_bin="$(npm prefix -g)/bin"

    # 如果 bin 目录不在当前 PATH 中，临时加入当前会话
    if ! echo "$PATH" | tr ':' '\n' | grep -qFx "${npm_global_bin}"; then
        export PATH="${npm_global_bin}:$PATH"
        print_info "临时将 ${npm_global_bin} 添加到 PATH（当前会话）"
    fi

    # 使用 which 验证 opendesk 是否存在
    local opendesk_path
    if opendesk_path=$(which opendesk 2>/dev/null) || command -v opendesk &>/dev/null; then
        print_success "opendesk 已就绪!"
        if [ -n "$opendesk_path" ]; then
            print_info "路径: ${opendesk_path}"
        fi

        local installed_version
        if installed_version=$(opendesk --version 2>/dev/null); then
            print_info "版本: ${installed_version}"
        fi

        echo ""
        echo -e "  ${GREEN}验证 opendesk 命令:${NC}"
        echo -e "  ${CYAN}$ which opendesk${NC}"
        which opendesk 2>/dev/null || echo "  (使用 command -v 找到)"
    else
        print_warning "未能直接找到 opendesk 命令"
        echo ""
        echo "  请尝试手动运行以下命令使配置生效:"
        echo -e "  ${CYAN}source ${RC_FILE}${NC}"
        echo ""
        echo "  然后运行:"
        echo -e "  ${CYAN}opendesk${NC}"
        return 1
    fi
}

# ---- 完成提示 ----
print_finish() {
    echo ""
    echo -e "${GREEN}${BOLD}============================================${NC}"
    echo -e "${GREEN}${BOLD}   安装完成! 🎉${NC}"
    echo -e "${GREEN}${BOLD}============================================${NC}"
    echo ""

    # 显示安装的版本信息
    if [ -n "${INSTALLED_VERSION_LABEL:-}" ]; then
        echo -e "  ${BOLD}安装版本:${NC} ${INSTALLED_VERSION_LABEL}"
    fi
    if installed_ver=$(opendesk --version 2>/dev/null); then
        echo -e "  ${BOLD}版本号:${NC}   ${installed_ver}"
    fi
    echo ""

    echo -e "  ${YELLOW}${BOLD}⚠ 重要提示:${NC}"
    echo ""
    echo -e "  为使 opendesk 命令生效，请执行以下操作之一:"
    echo ""
    echo -e "  ${BOLD}方式一:${NC} 重启终端应用"
    echo ""
    echo -e "  ${BOLD}方式二:${NC} 在当前终端运行:"
    echo -e "    ${CYAN}source ${RC_FILE}${NC}"
    echo ""
    echo -e "  然后运行以下命令开始使用 OpenDesk:"
    echo -e "    ${CYAN}opendesk${NC}"
    echo ""
    echo -e "  更多信息请参考: ${CYAN}${DOCS_URL}${NC}"
    echo ""
}

# ---- 主流程 ----
main() {
    print_header

    check_platform
    check_nodejs
    check_and_fix_path
    configure_mirror
    install_opendesk
    verify_installation || true  # 即使验证有警告也不中断，继续显示完成提示
    print_finish
}

# 执行主流程
main "$@"
