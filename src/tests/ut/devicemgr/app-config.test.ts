import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

type GatewayConfig = {
    enabled: boolean;
    host: string;
    port: number;
    autoApproveLocal: boolean;
};

const gatewayInstances: MockDeviceGateway[] = [];
const registerOpenClawMethodsMock = jest.fn();

class MockDeviceGateway {
    config: GatewayConfig;
    start = jest.fn(async () => {});
    stop = jest.fn(async () => {});
    updateConfig = jest.fn((config: GatewayConfig) => {
        this.config = config;
    });
    onEvent = jest.fn();

    constructor(_dataDir: string, config: GatewayConfig) {
        this.config = config;
        gatewayInstances.push(this);
    }

    isRunning(): boolean {
        return true;
    }

    getHost(): string {
        return this.config.host;
    }

    getPort(): number {
        return this.config.port;
    }
}

jest.unstable_mockModule('../../../main/applications/devicemgr/gateway.js', () => ({
    DeviceGateway: MockDeviceGateway
}));

jest.unstable_mockModule('../../../main/applications/devicemgr/gateway-methods.js', () => ({
    registerOpenClawMethods: registerOpenClawMethodsMock
}));

jest.unstable_mockModule('../../../main/applications/channelmgr/tools.js', () => ({
    SendFileTool: class {}
}));

jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: {
        getInstance: () => ({
            taskManagerState: {}
        })
    }
}));

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-devicemgr-test-'));
}

function setDeviceConfig(config: Partial<GatewayConfig>): void {
    const setting = Setting.getInstance();
    (setting.data as any).applications = {
        ...(setting.data as any).applications,
        devicemgr: config
    };
}

describe('DeviceMgrApplication gateway config hot update', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = makeTempDir();
        setCustomOpendeskDirectory(tempDir);
        Setting.clearCache();
        gatewayInstances.length = 0;
        registerOpenClawMethodsMock.mockClear();
    });

    afterEach(() => {
        Setting.clearCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('parses legacy empty config as enabled localhost default port', async () => {
        const { parseDeviceMgrConfig } = await import('../../../main/applications/devicemgr/common.js');

        expect(parseDeviceMgrConfig({})).toMatchObject({
            enabled: true,
            host: '127.0.0.1',
            port: 19010,
            autoApproveLocal: true
        });
    });

    test('normalizes none host as disabled gateway', async () => {
        const { parseDeviceMgrConfig, isDeviceGatewayEnabled } =
            await import('../../../main/applications/devicemgr/common.js');

        const config = parseDeviceMgrConfig({ enabled: true, host: 'none', port: 19010 });

        expect(config.enabled).toBe(false);
        expect(config.host).toBe('none');
        expect(isDeviceGatewayEnabled(config)).toBe(false);
    });

    test('stops a running gateway when listen address changes to none', async () => {
        const { DeviceMgrApplication } = await import('../../../main/applications/devicemgr/app.js');
        const app = new DeviceMgrApplication();
        setDeviceConfig({ enabled: true, host: '127.0.0.1', port: 19010, autoApproveLocal: true });

        await app.startGateway();
        const gateway = gatewayInstances[0];

        setDeviceConfig({ enabled: false, host: 'none', port: 19010, autoApproveLocal: true });
        await app.onConfigChanged();

        expect(gateway.stop).toHaveBeenCalledTimes(1);
        expect(app.getGateway()).toBeNull();
    });

    test('restarts gateway when port changes at runtime', async () => {
        const { DeviceMgrApplication } = await import('../../../main/applications/devicemgr/app.js');
        const app = new DeviceMgrApplication();
        setDeviceConfig({ enabled: true, host: '127.0.0.1', port: 19010, autoApproveLocal: true });

        await app.startGateway();
        const firstGateway = gatewayInstances[0];

        setDeviceConfig({ enabled: true, host: '127.0.0.1', port: 18800, autoApproveLocal: true });
        await app.onConfigChanged();

        expect(firstGateway.stop).toHaveBeenCalledTimes(1);
        expect(gatewayInstances).toHaveLength(2);
        expect(gatewayInstances[1].start).toHaveBeenCalledTimes(1);
        expect(gatewayInstances[1].getPort()).toBe(18800);
    });

    test('restarts gateway when listen host changes at runtime', async () => {
        const { DeviceMgrApplication } = await import('../../../main/applications/devicemgr/app.js');
        const app = new DeviceMgrApplication();
        setDeviceConfig({ enabled: true, host: '127.0.0.1', port: 19010, autoApproveLocal: true });

        await app.startGateway();
        const firstGateway = gatewayInstances[0];

        setDeviceConfig({ enabled: true, host: '0.0.0.0', port: 19010, autoApproveLocal: true });
        await app.onConfigChanged();

        expect(firstGateway.stop).toHaveBeenCalledTimes(1);
        expect(gatewayInstances).toHaveLength(2);
        expect(gatewayInstances[1].getHost()).toBe('0.0.0.0');
    });

    test('updates non-listen config without restarting gateway', async () => {
        const { DeviceMgrApplication } = await import('../../../main/applications/devicemgr/app.js');
        const app = new DeviceMgrApplication();
        setDeviceConfig({ enabled: true, host: '127.0.0.1', port: 19010, autoApproveLocal: true });

        await app.startGateway();
        const gateway = gatewayInstances[0];

        setDeviceConfig({ enabled: true, host: '127.0.0.1', port: 19010, autoApproveLocal: false });
        await app.onConfigChanged();

        expect(gateway.stop).not.toHaveBeenCalled();
        expect(gateway.updateConfig).toHaveBeenCalledTimes(1);
        expect(gateway.config.autoApproveLocal).toBe(false);
        expect(gatewayInstances).toHaveLength(1);
    });
});
