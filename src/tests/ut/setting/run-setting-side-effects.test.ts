/**
 * 保存设置后的生效步骤执行器：单项失败不中断、不抛出，失败信息按顺序收集并带上步骤 id。
 */

import { describe, expect, test } from '@jest/globals';
import { runSettingSideEffects } from '../../../main/utils/setting-side-effects.js';

describe('runSettingSideEffects', () => {
    test('单个步骤失败不中断后续步骤，失败信息被收集并带步骤 id 记日志', async () => {
        const executed: string[] = [];
        const logged: string[] = [];

        const failures = await runSettingSideEffects(
            [
                {
                    label: 'worker-settings-sync',
                    run: () => {
                        executed.push('worker');
                        throw new Error('worker unavailable');
                    }
                },
                {
                    label: 'theme-apply',
                    run: () => {
                        executed.push('theme');
                    }
                },
                {
                    label: 'telemetry-reload',
                    run: async () => {
                        executed.push('telemetry');
                        throw new Error('reload failed');
                    }
                }
            ],
            (label, message) => logged.push(`${label}: ${message}`)
        );

        // 中间失败的步骤不会挡住后面的步骤
        expect(executed).toEqual(['worker', 'theme', 'telemetry']);
        // label 必须随失败信息返回：renderer 靠它映射本地化文案
        expect(failures).toEqual([
            { label: 'worker-settings-sync', message: 'worker unavailable' },
            { label: 'telemetry-reload', message: 'reload failed' }
        ]);
        expect(logged).toEqual(['worker-settings-sync: worker unavailable', 'telemetry-reload: reload failed']);
    });

    test('全部成功时返回空数组且不记错误日志', async () => {
        const logged: string[] = [];

        const failures = await runSettingSideEffects(
            [
                { label: 'theme-apply', run: () => undefined },
                { label: 'debug-log-mode', run: async () => Promise.resolve(true) }
            ],
            (label) => logged.push(label)
        );

        expect(failures).toEqual([]);
        expect(logged).toEqual([]);
    });

    test('非 Error 的失败原因按字符串收集', async () => {
        const failures = await runSettingSideEffects(
            [{ label: 'proxy-env-refresh', run: () => Promise.reject('plain-failure') }],
            () => {
                /* 忽略日志断言 */
            }
        );

        expect(failures).toEqual([{ label: 'proxy-env-refresh', message: 'plain-failure' }]);
    });
});
