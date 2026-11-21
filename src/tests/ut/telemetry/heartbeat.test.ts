import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

/**
 * 设备心跳的 telemetry 特性门控。
 *
 * 心跳绕开遥测协议（reporter.ts 的 /api/heartbeat），GUI（desktop）与 CLI（cli）
 * 都通过 telemetry/heartbeat.ts 管理它。这里验证三条行为：启动时机按当前特性状态决定、
 * 启停跟随 telemetry 特性变化、重复同步不叠加定时器。
 */

const startCalls: string[] = [];
const stopCalls: string[] = [];

jest.unstable_mockModule('../../../main/utils/reporter.js', () => ({
    startReporter: (clientType: string) => {
        startCalls.push(clientType);
        return () => {
            stopCalls.push(clientType);
        };
    }
}));

const { getFeatureManager, resetFeatureManagerForTests } = await import('../../../common/features/manager.js');
const heartbeat = await import('../../../main/telemetry/heartbeat.js');

describe('设备心跳的 telemetry 特性门控', () => {
    beforeEach(() => {
        resetFeatureManagerForTests();
        heartbeat.resetHeartbeatReporterForTests();
        startCalls.length = 0;
        stopCalls.length = 0;
    });

    afterEach(() => {
        resetFeatureManagerForTests();
    });

    test('未启动过心跳时同步不产生任何调度（serve 等场景）', () => {
        heartbeat.syncHeartbeatReporter();

        expect(startCalls).toEqual([]);
        expect(stopCalls).toEqual([]);
    });

    test('启动时按当前特性状态调度，重复调用不叠加定时器', () => {
        heartbeat.startHeartbeatReporter('desktop');
        heartbeat.startHeartbeatReporter('desktop');
        heartbeat.syncHeartbeatReporter();

        expect(startCalls).toEqual(['desktop']);
        expect(stopCalls).toEqual([]);
    });

    test('特性已禁用时启动不会发出首次上报', () => {
        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', true);

        heartbeat.startHeartbeatReporter('cli');

        expect(heartbeat.isRemoteTelemetryDisabled()).toBe(true);
        expect(startCalls).toEqual([]);
    });

    test('运行期禁用停掉调度，恢复后重新调度', () => {
        heartbeat.startHeartbeatReporter('cli');
        expect(startCalls).toEqual(['cli']);

        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', true);
        heartbeat.syncHeartbeatReporter();
        expect(stopCalls).toEqual(['cli']);
        // 已经停了：继续同步不会重复 stop
        heartbeat.syncHeartbeatReporter();
        expect(stopCalls).toEqual(['cli']);

        getFeatureManager().setFeatureDisabled('telemetry', 'plugin-a', false);
        heartbeat.syncHeartbeatReporter();
        expect(startCalls).toEqual(['cli', 'cli']);
        expect(stopCalls).toEqual(['cli']);
    });
});
