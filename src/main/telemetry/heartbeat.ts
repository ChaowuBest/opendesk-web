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

import { getFeatureManager } from '../../common/features/manager.js';
import { startReporter, type ClientType } from '../utils/reporter.js';

/**
 * 设备心跳（reporter.ts 的 /api/heartbeat）完全绕开遥测协议，只能单独按
 * `telemetry` 特性门控启停。GUI 主进程与 CLI 默认入口都只通过本模块管理心跳，
 * 避免两个入口各写一份「禁用时停、恢复时起」的逻辑。
 *
 * 本模块只依赖 features manager 与 reporter，保持轻量：GUI 启动期就要用到它，
 * 不能把 opentelemetry / langfuse 这些重量级依赖一并拖进启动路径。
 * 遥测协议的启停见 `telemetry/index.ts` 的 `syncTelemetryFeatureGate`。
 */

/** telemetry 特性 id：插件通过 ctx.features.disableFeature('telemetry') 停用全部远程遥测 */
const TELEMETRY_FEATURE_ID = 'telemetry';

/**
 * 远程遥测是否被插件特性门控禁用。
 * 命中时连 Langfuse 的环境变量端点也会被挡住（该端点不受设置项控制），
 * 用户主动提交的反馈走独立通道，不受影响。
 */
export function isRemoteTelemetryDisabled(): boolean {
    return getFeatureManager().isFeatureDisabled(TELEMETRY_FEATURE_ID);
}

/** 心跳的客户端类型（desktop / cli）；从未启动过心跳时为 undefined */
let heartbeatClientType: ClientType | undefined;
let stopHeartbeatReporter: (() => void) | null = null;

/**
 * 按当前特性状态启停心跳调度。幂等：重复调用不会叠加定时器。
 *
 * startReporter 会立即上报一次并挂定时器，所以特性禁用期间不能调用它；
 * 未启动过心跳（如 serve 子命令）时这里什么都不做。
 */
export function syncHeartbeatReporter(): void {
    if (heartbeatClientType === undefined) return;
    if (isRemoteTelemetryDisabled()) {
        stopHeartbeatReporter?.();
        stopHeartbeatReporter = null;
        return;
    }
    stopHeartbeatReporter ??= startReporter(heartbeatClientType);
}

/**
 * 启动设备心跳：记住客户端类型后立即按当前特性状态启停，之后由
 * syncHeartbeatReporter 跟随 telemetry 特性变化。
 *
 * CLI 在插件宿主初始化之前调用（插件宿主失败也照常上报），插件在 setup() 里禁用
 * telemetry 时由特性变更订阅把调度停掉；GUI 在插件 setup 之后调用，禁用时不会发出
 * 首次上报。
 */
export function startHeartbeatReporter(clientType: ClientType): void {
    heartbeatClientType = clientType;
    syncHeartbeatReporter();
}

/** 复位模块级状态（仅测试使用） */
export function resetHeartbeatReporterForTests(): void {
    stopHeartbeatReporter?.();
    stopHeartbeatReporter = null;
    heartbeatClientType = undefined;
}
