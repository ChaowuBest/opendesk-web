import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const settingData = {
    network_config: {
        no_ssl: false,
        use_proxy: 'none' as string,
        custom_proxy_addr: '',
        no_proxy: ''
    }
};

const getHarmonyOSSystemProxyMock = jest.fn(async () => null);

const execFileMock = jest.fn();

jest.unstable_mockModule('child_process', () => ({
    execFile: execFileMock,
    spawn: jest.fn(),
    spawnSync: jest.fn()
}));

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: {
        getInstance: () => ({
            getData: () => settingData
        })
    }
}));

jest.unstable_mockModule('../../../platforms/bridges/harmonyos/proxy.js', () => ({
    getHarmonyOSSystemProxy: getHarmonyOSSystemProxyMock
}));

const originalPlatform = process.platform;
let originalHttpProxy: string | undefined;
let originalHttpsProxy: string | undefined;
let originalLowerHttpProxy: string | undefined;
let originalLowerHttpsProxy: string | undefined;

function setPlatform(p: string): void {
    Object.defineProperty(process, 'platform', {
        value: p,
        configurable: true
    });
}

beforeEach(() => {
    originalHttpProxy = process.env.HTTP_PROXY;
    originalHttpsProxy = process.env.HTTPS_PROXY;
    originalLowerHttpProxy = process.env.http_proxy;
    originalLowerHttpsProxy = process.env.https_proxy;

    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;

    jest.resetModules();
    getHarmonyOSSystemProxyMock.mockReset();
    execFileMock.mockReset();
    settingData.network_config.use_proxy = 'none';
    settingData.network_config.custom_proxy_addr = '';
    settingData.network_config.no_proxy = '';
});

afterEach(() => {
    setPlatform(originalPlatform);
    if (originalHttpProxy !== undefined) process.env.HTTP_PROXY = originalHttpProxy;
    else delete process.env.HTTP_PROXY;
    if (originalHttpsProxy !== undefined) process.env.HTTPS_PROXY = originalHttpsProxy;
    else delete process.env.HTTPS_PROXY;
    if (originalLowerHttpProxy !== undefined) process.env.http_proxy = originalLowerHttpProxy;
    else delete process.env.http_proxy;
    if (originalLowerHttpsProxy !== undefined) process.env.https_proxy = originalLowerHttpsProxy;
    else delete process.env.https_proxy;
});

describe('resolveProxyEnvVars', () => {
    async function loadModule() {
        return (await import('../../../main/utils/proxy-env.js')) as typeof import('../../../main/utils/proxy-env.js');
    }

    test('none mode returns empty object', async () => {
        settingData.network_config.use_proxy = 'none';
        const { resolveProxyEnvVars } = await loadModule();
        expect(await resolveProxyEnvVars()).toEqual({});
    });

    test('custom mode with address returns HTTP/HTTPS proxy + NO_PROXY', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://my-proxy:8080';
        settingData.network_config.no_proxy = 'intranet.example.com,localhost';

        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(result.HTTP_PROXY).toBe('http://my-proxy:8080');
        expect(result.HTTPS_PROXY).toBe('http://my-proxy:8080');
        expect(result.http_proxy).toBe('http://my-proxy:8080');
        expect(result.https_proxy).toBe('http://my-proxy:8080');
        expect(result.NO_PROXY).toBe('intranet.example.com,localhost');
        expect(result.no_proxy).toBe('intranet.example.com,localhost');
    });

    test('custom mode with empty address returns empty object', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = '   ';
        const { resolveProxyEnvVars } = await loadModule();
        expect(await resolveProxyEnvVars()).toEqual({});
    });

    test('custom mode without no_proxy omits NO_PROXY', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://my-proxy:8080';
        settingData.network_config.no_proxy = '';
        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(result.NO_PROXY).toBeUndefined();
        expect(result.no_proxy).toBeUndefined();
    });

    test('system mode on OpenHarmony bridges to ArkTS proxy', async () => {
        setPlatform('openharmony');
        settingData.network_config.use_proxy = 'system';
        getHarmonyOSSystemProxyMock.mockResolvedValue({
            host: 'proxy.example.com',
            port: 8080,
            exclusionList: ['intranet.example.com', '10.0.0.0/8']
        });

        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(getHarmonyOSSystemProxyMock).toHaveBeenCalledTimes(1);
        expect(result.HTTP_PROXY).toBe('http://proxy.example.com:8080');
        expect(result.HTTPS_PROXY).toBe('http://proxy.example.com:8080');
        expect(result.http_proxy).toBe('http://proxy.example.com:8080');
        expect(result.https_proxy).toBe('http://proxy.example.com:8080');
        expect(result.NO_PROXY).toBe('intranet.example.com,10.0.0.0/8');
        expect(result.no_proxy).toBe('intranet.example.com,10.0.0.0/8');
    });

    test('system mode on OpenHarmony returns empty when bridge returns null', async () => {
        setPlatform('openharmony');
        settingData.network_config.use_proxy = 'system';
        getHarmonyOSSystemProxyMock.mockResolvedValue(null);

        const { resolveProxyEnvVars } = await loadModule();
        expect(await resolveProxyEnvVars()).toEqual({});
    });

    test.each([
        { exclusions: [], expected: 'imap.private.example,localhost' },
        { exclusions: ['localhost', '.corp.example.com'], expected: 'localhost,.corp.example.com,imap.private.example' }
    ])(
        'system mode adds application bypass addresses to system exclusions $exclusions',
        async ({ exclusions, expected }) => {
            setPlatform('openharmony');
            settingData.network_config.use_proxy = 'system';
            settingData.network_config.no_proxy = 'imap.private.example, localhost';
            getHarmonyOSSystemProxyMock.mockResolvedValue({
                host: 'proxy.example.com',
                port: 8080,
                exclusionList: exclusions
            });

            const { resolveProxyEnvVars } = await loadModule();
            const result = await resolveProxyEnvVars();
            expect(result.HTTP_PROXY).toBe('http://proxy.example.com:8080');
            expect(result.NO_PROXY).toBe(expected);
            expect(result.no_proxy).toBe(expected);
        }
    );

    test('system mode on OpenHarmony strips protocol prefix from host', async () => {
        setPlatform('openharmony');
        settingData.network_config.use_proxy = 'system';
        getHarmonyOSSystemProxyMock.mockResolvedValue({
            host: 'http://124.70.231.74',
            port: 8080,
            exclusionList: []
        });

        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(result.HTTP_PROXY).toBe('http://124.70.231.74:8080');
    });

    test('system mode on OpenHarmony omits NO_PROXY when exclusionList is empty', async () => {
        setPlatform('openharmony');
        settingData.network_config.use_proxy = 'system';
        getHarmonyOSSystemProxyMock.mockResolvedValue({
            host: 'proxy.example.com',
            port: 3128,
            exclusionList: []
        });

        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(result.NO_PROXY).toBeUndefined();
        expect(result.no_proxy).toBeUndefined();
    });

    test('system mode on Linux passes through env HTTP_PROXY', async () => {
        setPlatform('linux');
        settingData.network_config.use_proxy = 'system';
        process.env.HTTP_PROXY = 'http://env-proxy:3128';
        process.env.HTTPS_PROXY = 'http://env-proxy:3128';

        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(result.HTTP_PROXY).toBe('http://env-proxy:3128');
        expect(result.HTTPS_PROXY).toBe('http://env-proxy:3128');
        expect(result.http_proxy).toBe('http://env-proxy:3128');
        expect(result.https_proxy).toBe('http://env-proxy:3128');
        expect(execFileMock).not.toHaveBeenCalled();
    });

    test('system mode on Linux returns empty when env has no proxy', async () => {
        setPlatform('linux');
        settingData.network_config.use_proxy = 'system';

        const { resolveProxyEnvVars } = await loadModule();
        expect(await resolveProxyEnvVars()).toEqual({});
    });

    test('system mode on Windows reads registry ProxyServer', async () => {
        setPlatform('win32');
        settingData.network_config.use_proxy = 'system';
        // 模拟 reg query 输出：ProxyEnable=1, ProxyServer=127.0.0.1:7890, ProxyOverride=intranet;localhost
        execFileMock.mockImplementation(
            (
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: Error | null, stdout: string, stderr: string) => void
            ) => {
                cb(
                    null,
                    'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:7890\r\nProxyOverride    REG_SZ    intranet;localhost',
                    ''
                );
            }
        );

        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(result.HTTP_PROXY).toBe('http://127.0.0.1:7890');
        expect(result.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
        expect(result.http_proxy).toBe('http://127.0.0.1:7890');
        expect(result.https_proxy).toBe('http://127.0.0.1:7890');
        expect(result.NO_PROXY).toBe('intranet,localhost');
        expect(result.no_proxy).toBe('intranet,localhost');
    });

    test('system mode on Windows returns empty when ProxyEnable=0', async () => {
        setPlatform('win32');
        settingData.network_config.use_proxy = 'system';
        execFileMock.mockImplementation(
            (
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: Error | null, stdout: string, stderr: string) => void
            ) => {
                cb(null, 'ProxyEnable    REG_DWORD    0x0\r\nProxyServer    REG_SZ    127.0.0.1:7890', '');
            }
        );

        const { resolveProxyEnvVars } = await loadModule();
        expect(await resolveProxyEnvVars()).toEqual({});
    });

    test('system mode on Windows returns empty when registry query fails', async () => {
        setPlatform('win32');
        settingData.network_config.use_proxy = 'system';
        execFileMock.mockImplementation(
            (
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: Error | null, stdout: string, stderr: string) => void
            ) => {
                cb(new Error('reg query failed'), '', '');
            }
        );

        const { resolveProxyEnvVars } = await loadModule();
        expect(await resolveProxyEnvVars()).toEqual({});
    });

    test('system mode on macOS reads scutil --proxy output', async () => {
        setPlatform('darwin');
        settingData.network_config.use_proxy = 'system';
        const scutilOutput = [
            '<dictionary> {',
            'HTTPEnable : 1',
            'HTTPProxy : 127.0.0.1',
            'HTTPPort : 8080',
            'HTTPSEnable : 1',
            'HTTPSProxy : 127.0.0.1',
            'HTTPSPort : 8080',
            'ExceptionsList : <array> {',
            '  0 : intranet.example.com',
            '  1 : localhost',
            '}',
            '}',
            ''
        ].join('\n');
        execFileMock.mockImplementation(
            (
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: Error | null, stdout: string, stderr: string) => void
            ) => {
                cb(null, scutilOutput, '');
            }
        );

        const { resolveProxyEnvVars } = await loadModule();
        const result = await resolveProxyEnvVars();
        expect(result.HTTP_PROXY).toBe('http://127.0.0.1:8080');
        expect(result.HTTPS_PROXY).toBe('http://127.0.0.1:8080');
        expect(result.http_proxy).toBe('http://127.0.0.1:8080');
        expect(result.https_proxy).toBe('http://127.0.0.1:8080');
        expect(result.NO_PROXY).toBe('intranet.example.com,localhost');
        expect(result.no_proxy).toBe('intranet.example.com,localhost');
    });

    test('system mode on macOS returns empty when HTTPEnable=0', async () => {
        setPlatform('darwin');
        settingData.network_config.use_proxy = 'system';
        const scutilOutput = 'HTTPEnable : 0\nHTTPSEnable : 0\n';
        execFileMock.mockImplementation(
            (
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: Error | null, stdout: string, stderr: string) => void
            ) => {
                cb(null, scutilOutput, '');
            }
        );

        const { resolveProxyEnvVars } = await loadModule();
        expect(await resolveProxyEnvVars()).toEqual({});
    });

    test('system mode on non-OpenHarmony platform does not call ArkTS bridge', async () => {
        setPlatform('win32');
        settingData.network_config.use_proxy = 'system';
        execFileMock.mockImplementation(
            (
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: Error | null, stdout: string, stderr: string) => void
            ) => {
                cb(null, 'ProxyEnable    REG_DWORD    0x0', '');
            }
        );

        const { resolveProxyEnvVars } = await loadModule();
        await resolveProxyEnvVars();
        expect(getHarmonyOSSystemProxyMock).not.toHaveBeenCalled();
    });
});

describe('proxy env cache', () => {
    async function loadModule() {
        return (await import('../../../main/utils/proxy-env.js')) as typeof import('../../../main/utils/proxy-env.js');
    }

    test('getCachedProxyEnvVars returns null before refresh', async () => {
        const { getCachedProxyEnvVars } = await loadModule();
        expect(getCachedProxyEnvVars()).toBeNull();
    });

    test('refreshProxyEnvCache populates cache from resolveProxyEnvVars', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://cached-proxy:8080';

        const { refreshProxyEnvCache, getCachedProxyEnvVars } = await loadModule();
        await refreshProxyEnvCache();
        const cached = getCachedProxyEnvVars();
        expect(cached?.HTTP_PROXY).toBe('http://cached-proxy:8080');
        expect(cached?.HTTPS_PROXY).toBe('http://cached-proxy:8080');
    });

    test('refreshProxyEnvCache on failure sets cache to null', async () => {
        settingData.network_config.use_proxy = 'system';
        setPlatform('openharmony');
        getHarmonyOSSystemProxyMock.mockRejectedValue(new Error('bridge down'));

        const { refreshProxyEnvCache, getCachedProxyEnvVars } = await loadModule();
        await refreshProxyEnvCache();
        expect(getCachedProxyEnvVars()).toBeNull();
    });

    test('getCachedProxyEnvVars returns null when expired', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://cached-proxy:8080';

        const { refreshProxyEnvCache, getCachedProxyEnvVars } = await loadModule();
        await refreshProxyEnvCache();
        expect(getCachedProxyEnvVars()).not.toBeNull();

        // 模拟时间流逝超过 TTL（30s）
        const now = Date.now;
        Date.now = () => now() + 31_000;
        expect(getCachedProxyEnvVars()).toBeNull();
        Date.now = now;
    });

    test('refreshProxyEnvCache replaces stale cache with fresh value', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://old:8080';

        const { refreshProxyEnvCache, getCachedProxyEnvVars } = await loadModule();
        await refreshProxyEnvCache();
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBe('http://old:8080');

        settingData.network_config.custom_proxy_addr = 'http://new:9090';
        await refreshProxyEnvCache();
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBe('http://new:9090');
    });
});

describe('startProxyEnvRefreshScheduler', () => {
    let stopScheduler: (() => void) | undefined;

    afterEach(() => {
        if (stopScheduler) {
            stopScheduler();
            stopScheduler = undefined;
        }
        jest.useRealTimers();
    });

    async function loadModule() {
        return (await import('../../../main/utils/proxy-env.js')) as typeof import('../../../main/utils/proxy-env.js');
    }

    test('scheduler immediately populates cache on start', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://sched-proxy:8080';

        const { startProxyEnvRefreshScheduler, getCachedProxyEnvVars } = await loadModule();
        stopScheduler = startProxyEnvRefreshScheduler();
        // 等待立即执行的 refresh 完成
        await new Promise((r) => setImmediate(r));
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBe('http://sched-proxy:8080');
    });

    test('scheduler returns a stop function that cancels the timer', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://sched-proxy:8080';

        const { startProxyEnvRefreshScheduler, getCachedProxyEnvVars } = await loadModule();
        const stop = startProxyEnvRefreshScheduler();
        stopScheduler = stop;
        await new Promise((r) => setImmediate(r));
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBe('http://sched-proxy:8080');

        // 修改配置后停止定时器，缓存不应被后续 refresh 更新
        settingData.network_config.custom_proxy_addr = 'http://updated:9090';
        stop();
        stopScheduler = undefined;
        // 立即检查：stop 后缓存仍是旧值（未被刷新）
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBe('http://sched-proxy:8080');
    });
});

describe('onNetworkConfigChanged', () => {
    async function loadModule() {
        return (await import('../../../main/utils/proxy-env.js')) as typeof import('../../../main/utils/proxy-env.js');
    }

    test('refreshes cache immediately after network_config changes', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://old:8080';

        const { onNetworkConfigChanged, getCachedProxyEnvVars, refreshProxyEnvCache } = await loadModule();
        await refreshProxyEnvCache();
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBe('http://old:8080');

        // 模拟用户在设置面板保存新代理地址
        settingData.network_config.custom_proxy_addr = 'http://new:9090';
        await onNetworkConfigChanged();

        // 缓存应立即反映新配置，无需等待 30s 定时器
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBe('http://new:9090');
    });

    test('refresh on system proxy query failure keeps cache empty without throwing', async () => {
        setPlatform('win32');
        settingData.network_config.use_proxy = 'system';
        execFileMock.mockImplementation(
            (
                _cmd: string,
                _args: string[],
                _opts: unknown,
                cb: (err: Error | null, stdout: string, stderr: string) => void
            ) => {
                cb(new Error('reg query failed'), '', '');
            }
        );

        const { onNetworkConfigChanged, getCachedProxyEnvVars } = await loadModule();
        await expect(onNetworkConfigChanged()).resolves.toBeUndefined();
        // 系统代理查询失败时 resolveProxyEnvVars 返回 {}（不抛异常），缓存存入空对象
        expect(getCachedProxyEnvVars()).toEqual({});
        expect(getCachedProxyEnvVars()?.HTTP_PROXY).toBeUndefined();
    });
});
