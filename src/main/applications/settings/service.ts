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

import { Setting } from '../../utils/setting.js';
import { QuickPassHelper } from '../../utils/quickpass.js';
import { logger, setDebugMode } from '../../utils/logger.js';
import {
    runSettingSideEffects,
    type SettingSideEffect,
    type SettingSideEffectFailure
} from '../../utils/setting-side-effects.js';
import { onNetworkConfigChanged } from '../../utils/proxy-env.js';
import { LLM } from '../../aikernel/llm.js';
import { ApplicationRegistry, notifyWorkerSettingUpdate } from '../registry.js';
import { prepareFileMgrWorkspaceSettings } from '../filemgr/workspace.js';
import { notifyFileMgrEmbeddingConfigChanged } from '../filemgr/embedding-config.js';
import { toErrorMessage } from '../../../common/utils/error.js';

export interface SettingsRuntimeOptions {
    preferredSystemLanguages?: readonly string[];
    getPreferredSystemLanguages?: () => readonly string[];
}

export interface SettingsApplicationOptions extends SettingsRuntimeOptions {
    applyTheme: () => unknown | Promise<unknown>;
}

export type SettingsApplicationResult =
    | { status: 'ok'; data: ReturnType<Setting['getData']>; sideEffectFailures: SettingSideEffectFailure[] }
    | { status: 'error'; message: string };

/** Save shared settings and apply the existing blocking/background side-effect policy. */
export async function saveSettingObject(
    settingObject: unknown,
    options: SettingsApplicationOptions
): Promise<SettingsApplicationResult> {
    const oldSettings = Setting.getInstance().getData();
    let prepared: ReturnType<typeof prepareFileMgrWorkspaceSettings>;
    try {
        prepared = prepareFileMgrWorkspaceSettings(settingObject, oldSettings);
        Setting.getInstance().setData(prepared.data);
    } catch (error) {
        // 持久化失败：配置未提交，内存与磁盘都保持旧值，按「保存失败」上报
        return { status: 'error', message: toErrorMessage(error) };
    }

    // 配置已落盘：以下步骤只是让新配置在各处立即生效。它们失败时配置本身是对的，
    // 因此逐项收集失败信息单独提示，不再把它们混报成「保存失败」。
    const currentSettings = Setting.getInstance().getData();
    const debugLogChanged = !!oldSettings?.debug?.debug_log !== !!currentSettings.debug?.debug_log;
    const telemetryChanged = JSON.stringify(oldSettings?.telemetry) !== JSON.stringify(currentSettings.telemetry);
    const logSideEffectFailure = (label: string, message: string) =>
        logger.warn(`[setting] ${label} failed after save: ${message}`);

    // 阻塞组：调用方依赖其完成后的状态，且都是进程内调用，耗时为毫秒级
    const blockingEffects: SettingSideEffect[] = [
        // 模型配置可能已变更，清理 adapter 缓存使旧连接池释放
        { label: 'llm-adapter-cache', run: () => LLM.clearAdapterCache() },
        // 通知 Worker 线程更新设置，使新的模型配置立即生效
        {
            label: 'worker-settings-sync',
            run: () =>
                notifyWorkerSettingUpdate(Setting.getInstance().getData(), {
                    preferredSystemLanguages:
                        options.getPreferredSystemLanguages?.() ?? options.preferredSystemLanguages
                })
        },
        {
            label: 'filemgr-embedding-config',
            run: () => notifyFileMgrEmbeddingConfigChanged(oldSettings, Setting.getInstance().getData())
        }
    ];
    // 调试日志开关变更后立即生效（winston 级别随 setDebugMode 切换）
    if (debugLogChanged) {
        blockingEffects.push({
            label: 'debug-log-mode',
            run: () => setDebugMode(!!Setting.getInstance().getData().debug?.debug_log)
        });
    }
    blockingEffects.push({ label: 'theme-apply', run: () => options.applyTheme() });
    // AgentGate 的 bridge 启停已由 AgentGateApplication.onConfigChanged 内部处理，无需在此同步
    const pendingWorkspace = prepared.shouldNotifyWorkspaceChanged ? prepared.defaultWorkspace : undefined;
    if (pendingWorkspace) {
        blockingEffects.push({
            label: 'filemgr-workspace-marker',
            run: () => {
                // Another save can commit while this request awaits earlier side effects.
                const workspace = Setting.getInstance().getData().default_workspace;
                if (workspace) return ApplicationRegistry.callWorker('filemgr', 'workspaceChanged', workspace);
            }
        });
    }
    const sideEffectFailures = await runSettingSideEffects(blockingEffects, logSideEffectFailure);

    // 后台组：会 spawn 系统命令（Windows 查注册表、macOS 走 scutil）或重建 OTel SDK，
    // 耗时不可控。设置面板是防抖自动保存，放进阻塞组会把保存响应拖慢，
    // 因此放到后台执行，失败只记日志（与这些步骤引入前的行为一致）。
    const deferredEffects: SettingSideEffect[] = [
        // 网络配置变更后立即刷新代理 env 缓存，使命令行子进程即时生效
        { label: 'proxy-env-refresh', run: () => onNetworkConfigChanged() }
    ];
    // 遥测配置变更时热重载 OTel SDK
    if (telemetryChanged) {
        deferredEffects.push({
            label: 'telemetry-reload',
            run: async () => {
                // Keep telemetry initialization lazy, as in the host startup path.
                const telemetry = await import('../../telemetry/index.js');
                await telemetry.reloadTelemetry();
            }
        });
    }
    void runSettingSideEffects(deferredEffects, logSideEffectFailure);

    return { status: 'ok', data: Setting.getInstance().getData(), sideEffectFailures };
}

export type QuickPassConfigurationResult =
    { status: 'ok'; data: ReturnType<typeof QuickPassHelper.importConfig> } | { status: 'error'; message: string };

/** Preserve QuickPass import's existing synchronization and result semantics. */
export async function importQuickPassConfiguration(
    quickpass: string,
    options: SettingsRuntimeOptions = {}
): Promise<QuickPassConfigurationResult> {
    try {
        const oldSettings = Setting.getInstance().getData();
        const cleaned = quickpass.trim().replace(/[\r\n]+/g, '');
        const result = QuickPassHelper.importConfig(cleaned);
        await notifyWorkerSettingUpdate(Setting.getInstance().getData(), options);
        await notifyFileMgrEmbeddingConfigChanged(oldSettings, Setting.getInstance().getData());
        return { status: 'ok', data: result };
    } catch (error) {
        return { status: 'error', message: toErrorMessage(error) };
    }
}
