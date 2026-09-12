/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';
import { configureZshEnvironment } from './environment.mjs';
import { setupBash } from './bootstrap/bash.mjs';
import { isZshRunnable, runBootstrapOnce } from './bootstrap/zsh.mjs';

export default definePlugin({
    id: 'hm-compat',
    setup(context) {
        // openharmony平板不添加命令行执行工具，不执行运行环境配置
        if (process.env.OPENDESK_HARMONY_BUILD_VARIANT === 'tablet') {
            return;
        }
        if (isZshRunnable()) {
            configureZshEnvironment(context.configDir);
            // fire-and-forget：安装后台执行，不阻塞插件加载链路
            void runBootstrapOnce({ opendeskDir: context.configDir }).catch((err) => {
                console.error('[dev-env:openharmony] bootstrap failed:', err);
            });
            return;
        } else {
            setupBash(context.configDir);
        }
    }
});
