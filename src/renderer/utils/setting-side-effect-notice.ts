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

import { createRendererTranslator } from '../locale.ts';

/**
 * 提示「设置已保存、但部分改动未能立即生效」。
 *
 * 所有保存设置的入口（设置面板、首次配置向导、输入框模型切换、schema 编辑器、导入 JSON）
 * 共用这一份实现：label 映射到 `sp.save.sideEffect.<label>` 文案，映射缺失时退回原始信息；
 * 原始异常只进控制台，避免把内部错误细节直接塞进通知正文。
 *
 * @param failures - 主进程回报的失败步骤，为空时不提示
 * @param translate - 与调用方界面语言一致的翻译函数，默认按当前系统语言
 */
export function notifySettingSideEffectFailures(
    failures: ReadonlyArray<SettingSideEffectFailure>,
    translate: (key: string) => string = createRendererTranslator()
): void {
    if (failures.length === 0) return;
    try {
        console.warn('setting side effects failed after save', failures);
        const lines = failures.map(({ label, message }) => {
            const key = `sp.save.sideEffect.${label}`;
            const localized = translate(key);
            return localized === key ? message : localized;
        });
        window.notificationAPI?.sendNotification?.(
            'error',
            translate('sp.title'),
            translate('sp.save.sideEffectFailed'),
            lines.join('\n')
        );
    } catch (error) {
        // 提示本身不能把「保存成功」变成「保存失败」：调用方可能把它包在自己的 try 里
        console.warn('failed to notify setting side effect failures:', error);
    }
}

/**
 * 提示「设置保存失败」：配置根本没写进磁盘，与上一个是两回事。
 * 用于那些没有常驻设置面板的后台保存入口（切模型、输入框选项、schema 编辑器等）。
 *
 * @param error - 保存时抛出的异常
 * @param translate - 与调用方界面语言一致的翻译函数
 */
export function notifySettingSaveFailed(
    error: unknown,
    translate: (key: string) => string = createRendererTranslator()
): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
        window.notificationAPI?.sendNotification?.(
            'error',
            translate('sp.title'),
            translate('sp.save.failed'),
            message
        );
    } catch (notifyError) {
        console.warn('failed to notify setting save failure:', notifyError);
    }
}
