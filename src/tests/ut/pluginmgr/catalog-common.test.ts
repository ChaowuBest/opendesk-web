import { describe, expect, test } from '@jest/globals';
import {
    describeHostVersionRange,
    isHostVersionCompatible,
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
