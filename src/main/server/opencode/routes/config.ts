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

import { Hono } from 'hono';
import { Setting } from '../../../utils/setting.js';
import {
    buildOpenCodeConfig,
    buildOpenCodeConfigProviders,
    hasOpenCodePermissionPatch,
    isOpenDeskConfigReloadRequest,
    mergeOpenCodeConfigPatch,
    notifyOpenCodeConfigUpdated,
    reloadServerConfigFromDisk
} from '../config-compat.js';
import type { ConfigPermissionRuntime } from '../config-permission-runtime.js';
import { ServerPermissionBroker } from '../permission-broker.js';

/**
 * Config 路由。
 * 对应 opencode 的 /config/* 端点。
 */
export function ConfigRoutes(permissionRuntime?: ConfigPermissionRuntime) {
    const app = new Hono();

    // GET /config - 获取配置
    app.get('/', (c) => {
        const setting = Setting.getInstance();
        const data = setting.getData();
        return c.json(buildOpenCodeConfig(data));
    });

    // PATCH /config - 更新配置
    app.patch('/', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const setting = Setting.getInstance();
        if (isOpenDeskConfigReloadRequest(body)) {
            return c.json(buildOpenCodeConfig(await reloadServerConfigFromDisk(permissionRuntime)));
        }

        const nextData = mergeOpenCodeConfigPatch(setting.getData(), body);
        setting.setData(nextData);
        if (hasOpenCodePermissionPatch(body)) {
            const reloadResult = permissionRuntime?.reload(setting.getData().permission);
            if (reloadResult && reloadResult.status !== 'disabled') {
                ServerPermissionBroker.getInstance().dispose();
            }
        }
        notifyOpenCodeConfigUpdated(setting.getData());
        return c.json(buildOpenCodeConfig(setting.getData()));
    });

    // GET /config/providers - 列出 providers 和默认模型
    app.get('/providers', (c) => {
        const setting = Setting.getInstance();
        const data = setting.getData();

        return c.json(buildOpenCodeConfigProviders(data));
    });

    return app;
}
