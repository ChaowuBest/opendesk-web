import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * telemetry 特性门控（ctx.features.disableFeature('telemetry')）：
 * 禁用后不再装配任何远程遥测协议（含 Langfuse 环境变量端点这类旁路），
 * 恢复后按既有请求状态重新初始化。用户反馈走独立通道，不在本模块范围内。
 */

const initLangfuseCalls: string[] = [];
const initOpenTelemetryCalls: string[] = [];
const shutdownCalls: string[] = [];

jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
}));

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getData: () => ({ telemetry: {} }) }) },
    // telemetry/index.ts 只做 schema 解析，测试里直接透传
    TelemetrySchema: { parse: (value: unknown) => value },
    getOpendeskDirectory: () => '/tmp/opendesk-telemetry-test'
}));

jest.unstable_mockModule('../../../main/telemetry/langfuse/init.js', () => ({
    initLangfuse: async () => {
        initLangfuseCalls.push('langfuse');
        return undefined;
    }
}));

jest.unstable_mockModule('../../../main/telemetry/opentelemetry/init.js', () => ({
    initOpenTelemetry: async () => {
        initOpenTelemetryCalls.push('opentelemetry');
        // 供用例模拟「初始化期间插件禁用特性」的并发窗口
        (globalThis as { __telemetryInitHook?: () => void }).__telemetryInitHook?.();
        return {
            name: 'opentelemetry',
            shutdown: async () => {
                shutdownCalls.push('opentelemetry');
            }
        };
    }
}));

const { getFeatureManager, resetFeatureManagerForTests } = await import('../../../common/features/manager.js');
const telemetry = await import('../../../main/telemetry/index.js');

describe('telemetry 特性门控', () => {
    beforeEach(async () => {
        resetFeatureManagerForTests();
        initLangfuseCalls.length = 0;
        initOpenTelemetryCalls.length = 0;
        shutdownCalls.length = 0;
        delete (globalThis as { __telemetryInitHook?: () => void }).__telemetryInitHook;
        // 模块级状态（requested/installed）在用例之间复位
        await telemetry.shutdownTelemetry();
        shutdownCalls.length = 0;
    });

    afterEach(() => {
        resetFeatureManagerForTests();
        delete (globalThis as { __telemetryInitHook?: () => void }).__telemetryInitHook;
    });

    test('特性禁用时跳过初始化，恢复后重新初始化，再次禁用立即关闭协议', async () => {
        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', true);
        expect(telemetry.isRemoteTelemetryDisabled()).toBe(true);

        await telemetry.initTelemetry();
        expect(initLangfuseCalls).toEqual([]);
        expect(initOpenTelemetryCalls).toEqual([]);

        // 特性恢复：外部已请求过初始化，门控联动把协议重新装上
        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', false);
        await telemetry.syncTelemetryFeatureGate();
        expect(initOpenTelemetryCalls).toEqual(['opentelemetry']);

        // 插件再次禁用：已装上的协议要立刻停掉并刷新，不能继续远程上报
        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', true);
        await telemetry.syncTelemetryFeatureGate();
        expect(shutdownCalls).toEqual(['opentelemetry']);

        // 特性仍禁用时不会重新初始化
        await telemetry.syncTelemetryFeatureGate();
        expect(initOpenTelemetryCalls).toEqual(['opentelemetry']);
    });

    test('shutdownTelemetry 之后不再受门控恢复影响', async () => {
        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', false);
        await telemetry.initTelemetry();
        expect(initOpenTelemetryCalls).toEqual(['opentelemetry']);

        await telemetry.shutdownTelemetry();
        // 退出/热重载路径下的显式关闭不算"已请求初始化"，门控恢复不应把它又拉起来
        await telemetry.syncTelemetryFeatureGate();
        expect(initOpenTelemetryCalls).toEqual(['opentelemetry']);
    });

    test('初始化期间被禁用：刚装配的协议立即回收，不会装着继续远程上报', async () => {
        (globalThis as { __telemetryInitHook?: () => void }).__telemetryInitHook = () => {
            getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', true);
        };

        await telemetry.initTelemetry();
        expect(initOpenTelemetryCalls).toEqual(['opentelemetry']);
        // 装配完成后发现门控已禁用：立刻 shutdown，而不是 installProtocols
        expect(shutdownCalls).toEqual(['opentelemetry']);
        expect(telemetry.isRemoteTelemetryDisabled()).toBe(true);

        // 恢复后再走一次门控联动，协议重新装上
        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', false);
        await telemetry.syncTelemetryFeatureGate();
        expect(initOpenTelemetryCalls).toEqual(['opentelemetry', 'opentelemetry']);
    });
});
