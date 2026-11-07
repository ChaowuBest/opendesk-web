import { describe, expect, test } from '@jest/globals';
import {
    describeHostVersionIssue,
    describeHostVersionRange,
    formatPluginDiagnostic,
    isHostVersionCompatible,
    parsePluginHostVersionMessage,
    PluginHostVersionError,
    resolveMarketInstallState
} from '../../../main/applications/pluginmgr/catalog-common.js';
import { OPENDESK_RUNTIME_VERSION } from '../../../main/utils/version.js';

/**
 * 插件市场的状态判定（纯函数，主进程与渲染层共用）。
 *
 * 关键约定：
 * - 安装状态只看版本：清单版本高于本地才算「可更新」，任一侧没版本就不提示；
 * - 宿主版本上下界含边界、省略即不限；声明了却解析不了的按不满足处理。
 */

describe('resolveMarketInstallState', () => {
    test('未安装时是 not-installed', () => {
        expect(resolveMarketInstallState(false, undefined, '1.0.0')).toBe('not-installed');
        // 清单没声明版本也一样：没装就是没装
        expect(resolveMarketInstallState(false, undefined, undefined)).toBe('not-installed');
    });

    test('清单版本更高时才提示可更新', () => {
        expect(resolveMarketInstallState(true, '1.0.0', '2.0.0')).toBe('update-available');
        expect(resolveMarketInstallState(true, '1.0.0', '1.0.1-beta.1')).toBe('update-available');
        expect(resolveMarketInstallState(true, '1.0.0', '1.0.0')).toBe('installed');
        // `v` 前缀与两段式都按 SemVer 归一，不算更新
        expect(resolveMarketInstallState(true, 'v1.0.0', '1.0.0')).toBe('installed');
        expect(resolveMarketInstallState(true, '1.0', '1.0.0')).toBe('installed');
    });

    test('本地版本更高（回滚/手动装新版）不提示降级', () => {
        expect(resolveMarketInstallState(true, '3.0.0', '2.0.0')).toBe('installed');
    });

    test('任一侧没有可比较的版本时按已安装处理，不打扰用户', () => {
        // 重装插件会重启插件，不能像测评集那样「没版本就让人重下一次」
        expect(resolveMarketInstallState(true, undefined, '2.0.0')).toBe('installed');
        expect(resolveMarketInstallState(true, '1.0.0', undefined)).toBe('installed');
    });
});

describe('isHostVersionCompatible', () => {
    test('没声明上下界时不限制', () => {
        expect(isHostVersionCompatible({})).toBe(true);
    });

    test('上下界都包含边界', () => {
        expect(isHostVersionCompatible({ minOpenDeskVersion: OPENDESK_RUNTIME_VERSION })).toBe(true);
        expect(isHostVersionCompatible({ maxOpenDeskVersion: OPENDESK_RUNTIME_VERSION })).toBe(true);
        expect(
            isHostVersionCompatible({
                minOpenDeskVersion: '0.0.1',
                maxOpenDeskVersion: '99.0.0'
            })
        ).toBe(true);
    });

    test('宿主太旧或太新都不满足', () => {
        expect(isHostVersionCompatible({ minOpenDeskVersion: '99.0.0' })).toBe(false);
        expect(isHostVersionCompatible({ maxOpenDeskVersion: '0.0.1' })).toBe(false);
        // 用显式宿主版本更像线上：测试不依赖当前 package.json 的版本号
        expect(isHostVersionCompatible({ minOpenDeskVersion: '2.0.0' }, '2.1.0')).toBe(true);
        expect(isHostVersionCompatible({ maxOpenDeskVersion: '2.0.0' }, '2.1.0')).toBe(false);
    });

    test('声明了却解析不了的上下界按不满足处理', () => {
        // 宁可拦下来，也不要把一个装完必然加载失败的包装进用户机器
        expect(isHostVersionCompatible({ minOpenDeskVersion: 'next' })).toBe(false);
        expect(isHostVersionCompatible({ maxOpenDeskVersion: '2024-09' })).toBe(false);
    });
});

describe('describeHostVersionRange', () => {
    test('按声明的一侧或两侧拼出范围', () => {
        expect(describeHostVersionRange({ minOpenDeskVersion: '1.2.0' })).toBe('≥ 1.2.0');
        expect(describeHostVersionRange({ maxOpenDeskVersion: '2.0.0' })).toBe('≤ 2.0.0');
        expect(describeHostVersionRange({ minOpenDeskVersion: '1.2.0', maxOpenDeskVersion: '2.0.0' })).toBe(
            '1.2.0 – 2.0.0'
        );
        expect(describeHostVersionRange({})).toBeUndefined();
    });
});

describe('describeHostVersionIssue', () => {
    test('兼容时没有 issue', () => {
        expect(describeHostVersionIssue({})).toBeUndefined();
        expect(describeHostVersionIssue({ minOpenDeskVersion: '0.0.1', maxOpenDeskVersion: '99.0.0' })).toBeUndefined();
    });

    test('宿主低于下界时报告 too_old 并给出范围描述', () => {
        expect(describeHostVersionIssue({ minOpenDeskVersion: '99.0.0' })).toEqual({
            direction: 'too_old',
            range: '≥ 99.0.0'
        });
        expect(describeHostVersionIssue({ minOpenDeskVersion: '2.0.0' }, '1.9.9')).toEqual({
            direction: 'too_old',
            range: '≥ 2.0.0'
        });
    });

    test('宿主高于上界时报告 too_new 并给出范围描述', () => {
        expect(describeHostVersionIssue({ maxOpenDeskVersion: '0.0.1' })).toEqual({
            direction: 'too_new',
            range: '≤ 0.0.1'
        });
        expect(describeHostVersionIssue({ maxOpenDeskVersion: '2.0.0' }, '2.1.0')).toEqual({
            direction: 'too_new',
            range: '≤ 2.0.0'
        });
    });

    test('声明了却解析不了的上下界也给出 issue（按不满足处理）', () => {
        expect(describeHostVersionIssue({ minOpenDeskVersion: 'next' })).toMatchObject({ direction: 'too_old' });
        expect(describeHostVersionIssue({ maxOpenDeskVersion: '2024-09' })).toMatchObject({ direction: 'too_new' });
    });

    test('两段式宿主版本按补齐 PATCH 后的版本比较，方向不因解析差异而反了', () => {
        // 修复前：宿主 '0.4' 不满足 min 2.0.0 时被误判成 too_new
        expect(describeHostVersionIssue({ minOpenDeskVersion: '2.0.0' }, '0.4')).toEqual({
            direction: 'too_old',
            range: '≥ 2.0.0'
        });
        expect(describeHostVersionIssue({ maxOpenDeskVersion: '0.3.0' }, '0.4')).toEqual({
            direction: 'too_new',
            range: '≤ 0.3.0'
        });
    });

    test('两段式宿主版本实际兼容时不产生 issue', () => {
        // 修复前的 host 侧比较解析不了两段式宿主版本，兼容范围也会被误判成越界
        expect(describeHostVersionIssue({ minOpenDeskVersion: '0.1.0' }, '0.4')).toBeUndefined();
        expect(describeHostVersionIssue({ maxOpenDeskVersion: '0.9.0' }, '0.4')).toBeUndefined();
    });

    test('空白声明的上下界按未声明处理', () => {
        expect(describeHostVersionIssue({ minOpenDeskVersion: '  ' })).toBeUndefined();
        expect(describeHostVersionIssue({ maxOpenDeskVersion: '' })).toBeUndefined();
    });
});

describe('PluginHostVersionError', () => {
    test('message 是渲染层可解析的结构化串', () => {
        const error = new PluginHostVersionError('too_old', '≥ 99.0.0', '0.4.1');
        expect(error.direction).toBe('too_old');
        expect(parsePluginHostVersionMessage(error.message)).toEqual({
            direction: 'too_old',
            range: '≥ 99.0.0',
            hostVersion: '0.4.1'
        });
    });

    test('parse 对非宿主版本错误返回 undefined', () => {
        expect(parsePluginHostVersionMessage('plugin.install_builtin_conflict:demo')).toBeUndefined();
        expect(parsePluginHostVersionMessage('plugin.install_host_version:too_old')).toBeUndefined();
    });

    test('空范围与含冒号的范围都能原样解析回来', () => {
        // 宿主版本取最后一个冒号之后：范围描述里即使带冒号也不会把宿主版本切坏
        expect(parsePluginHostVersionMessage('plugin.install_host_version:too_new::0.4.1')).toEqual({
            direction: 'too_new',
            range: '',
            hostVersion: '0.4.1'
        });
        expect(parsePluginHostVersionMessage('plugin.install_host_version:too_old:1.0.0 – 2.0.0:0.4.1')).toEqual({
            direction: 'too_old',
            range: '1.0.0 – 2.0.0',
            hostVersion: '0.4.1'
        });
    });
});

describe('formatPluginDiagnostic', () => {
    test('opendesk_version_too_old/_too_new 渲染成本地化文案而不是裸诊断码', () => {
        const translate = (key: string, params?: Record<string, string | number>) =>
            `[${key}]${params ? JSON.stringify(params) : ''}`;
        expect(
            formatPluginDiagnostic(
                { stage: 'validate', code: 'plugin.opendesk_version_too_old', detail: '0.4.1 < 99.0.0' },
                translate
            )
        ).toBe(`[plugin.diagnostic.opendeskVersionTooOld]{"detail":"0.4.1 < 99.0.0"}`);
        expect(
            formatPluginDiagnostic(
                { stage: 'validate', code: 'plugin.opendesk_version_too_new', detail: '9.9.9 > 1.0.0' },
                translate
            )
        ).toBe(`[plugin.diagnostic.opendeskVersionTooNew]{"detail":"9.9.9 > 1.0.0"}`);
    });

    test('没有映射的诊断码保持 stage/code/detail 原样输出', () => {
        const translate = (key: string) => key;
        expect(formatPluginDiagnostic({ stage: 'setup', code: 'plugin.setup_failed', detail: 'boom' }, translate)).toBe(
            'setup/plugin.setup_failed: boom'
        );
        expect(formatPluginDiagnostic({ stage: 'load', code: 'plugin.invalid_id' }, translate)).toBe(
            'load/plugin.invalid_id'
        );
    });
});
