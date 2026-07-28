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

import { logger } from '../utils/logger.js';
import { Setting, TelemetrySchema } from '../utils/setting.js';
import { initLangfuse } from './langfuse/init.js';
import { initOpenTelemetry } from './opentelemetry/init.js';
import { installProtocols, shutdownProtocols, type TelemetryProtocol } from './protocol.js';

export * from './local-telemetry.js';

let initialized = false;
let activeProtocols: TelemetryProtocol[] = [];

/**
 * 初始化所有已配置的遥测协议。每个协议负责自己的配置解析、实现注册和资源生命周期，
 * 顶层仅负责协议装配。
 */
export async function initTelemetry(): Promise<void> {
    if (initialized) return;
    initialized = true;
    let pendingProtocols: TelemetryProtocol[] = [];

    try {
        const config = TelemetrySchema.parse(Setting.getInstance().getData().telemetry);
        const langfuse = await initLangfuse(config.langfuse);
        pendingProtocols = langfuse ? [langfuse] : [];
        const opentelemetry = await initOpenTelemetry(config.opentelemetry, langfuse ? [langfuse] : []);
        if (!opentelemetry) {
            await shutdownProtocols(pendingProtocols);
            pendingProtocols = [];
        } else {
            activeProtocols = [...pendingProtocols, opentelemetry];
            pendingProtocols = [];
        }
        installProtocols(activeProtocols);
    } catch (err) {
        await shutdownProtocols([...activeProtocols, ...pendingProtocols]);
        activeProtocols = [];
        logger.warn(`[Telemetry] Failed to initialize protocols: ${err}`);
    }
}

/**
 * 关闭遥测系统，刷新所有待发送的 span。
 */
export async function shutdownTelemetry(): Promise<void> {
    await shutdownProtocols(activeProtocols);
    activeProtocols = [];
    initialized = false;
}

/**
 * 热重载遥测配置：先按协议关闭并刷新现有资源，再重新初始化。
 */
export async function reloadTelemetry(): Promise<void> {
    await shutdownTelemetry();
    await initTelemetry();
}
