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
import { configureCommonEnvironment, injectBashEnv, injectZshEnv } from './environment.mjs';
import { setupRecovery } from './recovery.mjs';
import { setupSkillFallback } from './skill-fallback.mjs';
import { setupDependencyQuery } from './dependency-query.mjs';

export default definePlugin({
    id: 'hm-compat',
    setup(context) {
        // harmonyos-recovery 知识库hook注册
        setupRecovery(context);

        // HarmonyOS skill fallback 经验记录 hook 与工具注册
        setupSkillFallback(context);

        // HarmonyOS 依赖支持情况查询工具（mcp服务）
        setupDependencyQuery(context);

        // openharmony平板不添加命令行执行工具，不执行运行环境配置
        if (process.env.OPENDESK_HARMONY_BUILD_VARIANT === 'tablet') {
            return;
        }
        // bash/zsh 共用的环境变量：与 shell 类型无关，setup 时一次性写入 process.env
        configureCommonEnvironment(context.configDir);
        // bash/zsh 特有的环境变量：主线运行时可切换 shell，每次命令执行前按当次 shell 类型注入本次子进程 env
        context.hooks.on('shell.env', (input, output) => {
            if (input.shellType === 'zsh') {
                injectZshEnv(output.env);
            } else if (input.shellType === 'bash') {
                injectBashEnv(output.env);
            }
        });
    }
});
