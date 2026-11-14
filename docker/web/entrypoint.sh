#!/bin/sh
# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
# You can use this software according to the terms and conditions of the Mulan PSL v2.
# You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
# EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
# MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
# See the Mulan PSL v2 for more details.

# OpenDesk Web UI 容器入口：Electron 主进程以 web 模式运行（OPENDESK_WEB_PORT），不显示窗口。
set -e

# Electron 在 Linux 上启动需要一个 X 显示；容器内用 Xvfb 提供（窗口始终隐藏，不消耗 GPU）
if [ -z "${DISPLAY:-}" ]; then
    rm -f /tmp/.X99-lock
    Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
    export DISPLAY=:99
fi

# 容器内通常没有用户命名空间/SUID，Chromium 沙箱无法启用；主窗口只加载 about:blank
exec /opt/opendesk/opendesk \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    "$@"
