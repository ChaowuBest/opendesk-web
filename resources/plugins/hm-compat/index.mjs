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

// 制品仓地址来源：resources/knowledges/harmonyos-recovery/01-download-and-network.md
const HARMONY_PIP_INDEX_URL = 'https://pypi.repo.openharmony.cn/artifactory/openharmony-pypi/simple';
const HARMONY_PIP_TRUSTED_HOST = 'pypi.repo.openharmony.cn';
const HARMONY_PIP_ONLY_BINARY = ':all:';
const HARMONY_NPM_REGISTRY = 'https://npm.cnb.cool/OpenHarmonyPCDeveloper/npm/-/packages/';

// 展示名称等静态元数据统一声明在 opendesk.plugin.json，入口只保留运行时字段。
export default definePlugin({
    id: 'hm-compat',
    setup(ctx) {
        ctx.hooks.on('shell.env', (_input, output) => {
            output.env.PIP_INDEX_URL = HARMONY_PIP_INDEX_URL;
            output.env.PIP_TRUSTED_HOST = HARMONY_PIP_TRUSTED_HOST;
            // 鸿蒙上无编译工具链，tgz 源码包装不上，仅允许 wheel 二进制分发
            output.env.PIP_ONLY_BINARY = HARMONY_PIP_ONLY_BINARY;
            output.env.npm_config_registry = HARMONY_NPM_REGISTRY;
        });
    }
});
