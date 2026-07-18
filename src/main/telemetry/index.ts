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
import { Setting } from '../utils/setting.js';
import { initOpenTelemetry, shutdownOpenTelemetry } from './opentelemetry-telemetry.js';

export {
    getTracer,
    withSpan,
    context,
    trace,
    SpanStatusCode,
    type Span,
    type SpanOptions
} from './opentelemetry-telemetry.js';

export * from './local-telemetry.js';

let initialized = false;

/**
 * 初始化遥测系统。从系统设置中读取 OpenTelemetry 配置（端点列表），
 * 如果启用则初始化 OTel SDK；LocalTelemetry（本地用量记录）始终启用。
 */
export async function initTelemetry(): Promise<void> {
    if (initialized) return;
    initialized = true;

    try {
        const telemetryConfig = Setting.getInstance().getData().telemetry;
        const allEndpoints = telemetryConfig?.opentelemetry?.endpoints ?? [];
        const enabledEndpoints = allEndpoints.filter((ep) => ep.enabled && ep.url).map((ep) => ep.url);
        if (enabledEndpoints.length > 0) {
            initOpenTelemetry(enabledEndpoints);
        } else {
            logger.info('[Telemetry] OpenTelemetry disabled (no enabled endpoints)');
        }
    } catch (err) {
        logger.warn(`[Telemetry] Failed to read telemetry config: ${err}`);
    }
}

/**
 * 关闭遥测系统，刷新所有待发送的 span。
 */
export async function shutdownTelemetry(): Promise<void> {
    await shutdownOpenTelemetry();
    initialized = false;
}

/**
 * 热重载遥测配置：先关闭现有 provider（刷新待发送 span），
 * 再从设置中重新读取配置并初始化。用于设置变更后无需重启即可生效。
 */
export async function reloadTelemetry(): Promise<void> {
    await shutdownOpenTelemetry();
    initialized = false;
    await initTelemetry();
}
