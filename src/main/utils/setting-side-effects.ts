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

/**
 * 保存设置后的「生效步骤」执行器。
 *
 * 配置已经成功落盘时，后续让新配置在各处生效的步骤（通知 Worker、切换主题、刷新代理缓存等）
 * 失败，并不代表保存失败：这里逐项执行、逐项收集异常，既不中断后续步骤，也不把异常抛给调用方，
 * 由调用方用返回的失败信息单独提示用户。
 */

/**
 * 全部生效步骤 id。renderer 按 `sp.save.sideEffect.<label>` 映射本地化文案，
 * 因此新增步骤必须同时补文案（由 setting-side-effect-locale 测试保证）。
 */
export const SETTING_SIDE_EFFECT_LABELS = [
    'llm-adapter-cache',
    'worker-settings-sync',
    'filemgr-embedding-config',
    'debug-log-mode',
    'theme-apply',
    'filemgr-workspace-marker',
    'proxy-env-refresh',
    'telemetry-reload'
] as const;

export type SettingSideEffectLabel = (typeof SETTING_SIDE_EFFECT_LABELS)[number];

export interface SettingSideEffect {
    /** 稳定的步骤 id，用于日志定位与 renderer 侧本地化文案映射 */
    label: SettingSideEffectLabel;
    run: () => unknown | Promise<unknown>;
}

/** 单个生效步骤的失败信息：label 由调用方映射成本地化文案，message 仅用于日志与诊断 */
export interface SettingSideEffectFailure {
    label: SettingSideEffectLabel;
    message: string;
}

/**
 * 依次执行生效步骤，返回失败步骤的信息（成功时为空数组）。
 * @param effects - 按执行顺序排列的生效步骤
 * @param onError - 单个步骤失败时的回调，用于记录带步骤 id 的日志
 */
export async function runSettingSideEffects(
    effects: ReadonlyArray<SettingSideEffect>,
    onError: (label: SettingSideEffectLabel, message: string) => void
): Promise<SettingSideEffectFailure[]> {
    const failures: SettingSideEffectFailure[] = [];
    for (const effect of effects) {
        try {
            await effect.run();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(effect.label, message);
            failures.push({ label: effect.label, message });
        }
    }
    return failures;
}
