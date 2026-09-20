#!/bin/sh
# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
# You can use this software according to the terms and conditions of the Mulan PSL v2.
# You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
# EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
# MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
# See the Mulan PSL v2 for more details.

# rpmbuild 的 %install 使用 cp -r 复制应用目录，Chrome 的 setuid sandbox helper
# 会在该阶段丢失 setuid 位；非 root 用户运行 Electron 时依赖该位，因此安装后恢复。
SANDBOX_HELPER="/usr/lib/opendesk/chrome-sandbox"
if [ -f "$SANDBOX_HELPER" ]; then
    chmod 4755 "$SANDBOX_HELPER"
fi
