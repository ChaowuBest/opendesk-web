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
import { OpenDeskAccountBackend } from './runtime/service.mjs';

// displayName / capabilities 等静态元数据只声明在 opendesk.plugin.json，入口不重复声明
export default definePlugin({
    id: 'opendesk-account',
    setup(context) {
        context.accounts.registerBackend(new OpenDeskAccountBackend(context.accounts));
    }
});
