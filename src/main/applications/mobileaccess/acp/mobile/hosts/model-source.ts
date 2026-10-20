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

import { Setting, getEnvDefaultModelInstance } from '../../../../../utils/setting.js';
import type { HostSessionModelSource } from '../remote-session-service/host-binding.js';

export function createMobileSessionModelSource(getOverride?: () => string | undefined): HostSessionModelSource {
    return {
        listConfiguredModelAliases: () =>
            Setting.getInstance()
                .getData()
                .models.map((model) => model.alias),
        resolveChatModel: (alias) => {
            const model = Setting.getInstance().getModelInstance(alias, 'chat');
            return model ? { alias, modelName: model.model_name } : undefined;
        },
        resolveEffectiveDefaultModel: () => {
            const setting = Setting.getInstance();
            const override = getOverride?.();
            if (override && setting.getModelInstance(override, 'chat'))
                return { kind: 'configured_alias', alias: override };
            if (getEnvDefaultModelInstance() !== null) return { kind: 'unrepresentable' };
            const alias = setting.getData().default_model;
            return alias && setting.getModelInstance(alias, 'chat')
                ? { kind: 'configured_alias', alias }
                : { kind: 'none' };
        }
    };
}
