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
import { isRemoteTelemetryDisabled, syncHeartbeatReporter } from './heartbeat.js';
import { initLangfuse } from './langfuse/init.js';
import { initOpenTelemetry } from './opentelemetry/init.js';
import { installProtocols, shutdownProtocols, type TelemetryProtocol } from './protocol.js';

export * from './local-telemetry.js';
// 设备心跳与特性判定都在 heartbeat.js：那里是唯一权威实现，这里只做对外重导出
export { isRemoteTelemetryDisabled } from './heartbeat.js';

/** 外部是否请求过遥测（窗口显示后 / CLI 启动），特性恢复时据此决定是否重新初始化 */
let requested = false;
/** 是否已完成初始化：阻止重复 install（初始化失败后同样不再重试，与既有行为一致） */
let installed = false;
let activeProtocols: TelemetryProtocol[] = [];

/**
 * 关闭当前已装配的协议并复位状态。
 * 单个协议 shutdown 失败不能阻断门控流程（特性禁用必须走完），失败只记日志。
 */
async function stopProtocols(): Promise<void> {
    try {
        await shutdownProtocols(activeProtocols);
    } catch (error) {
        logger.warn(`[Telemetry] Failed to shutdown protocols: ${error}`);
    } finally {
        activeProtocols = [];
        installed = false;
    }
}

/**
 * 初始化所有已配置的遥测协议。每个协议负责自己的配置解析、实现注册和资源生命周期，
 * 顶层仅负责协议装配。
 */
export async function initTelemetry(): Promise<void> {
    requested = true;
    if (isRemoteTelemetryDisabled()) {
        // 插件可能在遥测已经初始化之后才禁用特性，这里顺手撤掉已装上的协议
        if (installed) await stopProtocols();
        logger.info('[Telemetry] 远程遥测已被特性门控禁用，跳过初始化');
        return;
    }
    if (installed) return;
    installed = true;
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
        // 初始化过程是异步的：插件可能在这段时间里禁用了特性。此时不能把刚建好的协议装上，
        // 否则特性禁用后仍会继续远程上报（装配与门控判断之间不能留窗口）
        if (isRemoteTelemetryDisabled()) {
            await shutdownProtocols([...activeProtocols, ...pendingProtocols]);
            activeProtocols = [];
            installed = false;
            logger.info('[Telemetry] 远程遥测在初始化期间被特性门控禁用，已回收本次装配');
            return;
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
    requested = false;
    await stopProtocols();
}

/**
 * 遥测配置热重载：先按协议关闭并刷新现有资源，再重新初始化。
 */
export async function reloadTelemetry(): Promise<void> {
    await shutdownTelemetry();
    await initTelemetry();
}

/**
 * 特性门控联动：telemetry 特性被禁用时停掉全部远程遥测协议并刷新在途数据，
 * 恢复后按既有请求状态重新初始化（未请求过则保持延迟初始化的约定）。
 * 设备心跳绕开遥测协议，但跟随同一个特性状态，一并在这里启停。
 */
export async function syncTelemetryFeatureGate(): Promise<void> {
    syncHeartbeatReporter();
    if (isRemoteTelemetryDisabled()) {
        if (!installed) return;
        await stopProtocols();
        logger.info('[Telemetry] 远程遥测已被特性门控禁用');
        return;
    }
    if (requested && !installed) {
        await initTelemetry();
    }
}
