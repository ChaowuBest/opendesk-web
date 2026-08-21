import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const settingData = {
    network_config: {
        no_ssl: false,
        use_proxy: 'none' as string,
        custom_proxy_addr: '',
        no_proxy: ''
    },
    cli_config: {
        inherit_venv: true
    }
};

const getCachedProxyEnvVarsMock = jest.fn((): any => null);

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: {
        getInstance: () => ({
            getData: () => settingData
        })
    },
    getOpendeskDirectory: () => '/tmp/opendesk-test'
}));

jest.unstable_mockModule('../../../platforms/base.js', () => ({
    getPlatform: () => ({ getInjectedEnviron: () => new Map() })
}));

jest.unstable_mockModule('../../../main/utils/proxy-env.js', () => ({
    resolveProxyEnvVars: jest.fn(async () => ({})),
    getCachedProxyEnvVars: getCachedProxyEnvVarsMock
}));

let originalHttpProxy: string | undefined;
let originalHttpsProxy: string | undefined;
let originalLowerHttpProxy: string | undefined;
let originalLowerHttpsProxy: string | undefined;
let originalNoProxy: string | undefined;
let originalLowerNoProxy: string | undefined;

beforeEach(() => {
    originalHttpProxy = process.env.HTTP_PROXY;
    originalHttpsProxy = process.env.HTTPS_PROXY;
    originalLowerHttpProxy = process.env.http_proxy;
    originalLowerHttpsProxy = process.env.https_proxy;
    originalNoProxy = process.env.NO_PROXY;
    originalLowerNoProxy = process.env.no_proxy;

    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    jest.resetModules();
    getCachedProxyEnvVarsMock.mockReset();
    getCachedProxyEnvVarsMock.mockReturnValue(null);
    settingData.network_config.use_proxy = 'none';
    settingData.network_config.custom_proxy_addr = '';
    settingData.network_config.no_proxy = '';
});

afterEach(() => {
    if (originalHttpProxy !== undefined) process.env.HTTP_PROXY = originalHttpProxy;
    else delete process.env.HTTP_PROXY;
    if (originalHttpsProxy !== undefined) process.env.HTTPS_PROXY = originalHttpsProxy;
    else delete process.env.HTTPS_PROXY;
    if (originalLowerHttpProxy !== undefined) process.env.http_proxy = originalLowerHttpProxy;
    else delete process.env.http_proxy;
    if (originalLowerHttpsProxy !== undefined) process.env.https_proxy = originalLowerHttpsProxy;
    else delete process.env.https_proxy;
    if (originalNoProxy !== undefined) process.env.NO_PROXY = originalNoProxy;
    else delete process.env.NO_PROXY;
    if (originalLowerNoProxy !== undefined) process.env.no_proxy = originalLowerNoProxy;
    else delete process.env.no_proxy;
});

describe('buildChildProcessEnv proxy injection', () => {
    async function loadModule() {
        const mod = await import('../../../main/utils/shellExec.js');
        return mod.buildChildProcessEnv;
    }

    test('custom mode overrides existing env HTTP_PROXY', async () => {
        process.env.HTTP_PROXY = 'http://old-proxy:3128';
        process.env.http_proxy = 'http://old-proxy:3128';
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://new-proxy:8080';
        getCachedProxyEnvVarsMock.mockReturnValue({
            HTTP_PROXY: 'http://new-proxy:8080',
            HTTPS_PROXY: 'http://new-proxy:8080',
            http_proxy: 'http://new-proxy:8080',
            https_proxy: 'http://new-proxy:8080'
        });

        const buildChildProcessEnv = await loadModule();
        const env = buildChildProcessEnv();
        expect(env.HTTP_PROXY).toBe('http://new-proxy:8080');
        expect(env.HTTPS_PROXY).toBe('http://new-proxy:8080');
        expect(env.http_proxy).toBe('http://new-proxy:8080');
        expect(env.https_proxy).toBe('http://new-proxy:8080');
    });

    test('none mode clears existing env HTTP_PROXY', async () => {
        process.env.HTTP_PROXY = 'http://old-proxy:3128';
        process.env.HTTPS_PROXY = 'http://old-proxy:3128';
        process.env.http_proxy = 'http://old-proxy:3128';
        process.env.https_proxy = 'http://old-proxy:3128';
        process.env.NO_PROXY = 'intranet.example.com';
        process.env.no_proxy = 'intranet.example.com';
        settingData.network_config.use_proxy = 'none';

        const buildChildProcessEnv = await loadModule();
        const env = buildChildProcessEnv();
        expect(env.HTTP_PROXY).toBeUndefined();
        expect(env.HTTPS_PROXY).toBeUndefined();
        expect(env.http_proxy).toBeUndefined();
        expect(env.https_proxy).toBeUndefined();
        expect(env.NO_PROXY).toBeUndefined();
        expect(env.no_proxy).toBeUndefined();
    });

    test('system mode with cached proxy overrides env', async () => {
        process.env.HTTP_PROXY = 'http://old-proxy:3128';
        settingData.network_config.use_proxy = 'system';
        getCachedProxyEnvVarsMock.mockReturnValue({
            HTTP_PROXY: 'http://sys-proxy:8080',
            HTTPS_PROXY: 'http://sys-proxy:8080',
            http_proxy: 'http://sys-proxy:8080',
            https_proxy: 'http://sys-proxy:8080',
            NO_PROXY: '10.0.0.0/8',
            no_proxy: '10.0.0.0/8'
        });

        const buildChildProcessEnv = await loadModule();
        const env = buildChildProcessEnv();
        expect(env.HTTP_PROXY).toBe('http://sys-proxy:8080');
        expect(env.HTTPS_PROXY).toBe('http://sys-proxy:8080');
        expect(env.http_proxy).toBe('http://sys-proxy:8080');
        expect(env.https_proxy).toBe('http://sys-proxy:8080');
        expect(env.NO_PROXY).toBe('10.0.0.0/8');
        expect(env.no_proxy).toBe('10.0.0.0/8');
    });

    test('system mode with cache not ready does not modify env', async () => {
        process.env.HTTP_PROXY = 'http://old-proxy:3128';
        settingData.network_config.use_proxy = 'system';
        getCachedProxyEnvVarsMock.mockReturnValue(null);

        const buildChildProcessEnv = await loadModule();
        const env = buildChildProcessEnv();
        expect(env.HTTP_PROXY).toBe('http://old-proxy:3128');
    });

    test('user environ HTTP_PROXY is overridden by network_config (B policy)', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://config-proxy:9090';
        getCachedProxyEnvVarsMock.mockReturnValue({
            HTTP_PROXY: 'http://config-proxy:9090',
            HTTPS_PROXY: 'http://config-proxy:9090',
            http_proxy: 'http://config-proxy:9090',
            https_proxy: 'http://config-proxy:9090'
        });

        const buildChildProcessEnv = await loadModule();
        const env = buildChildProcessEnv({ HTTP_PROXY: 'http://environ-proxy:1234' });
        expect(env.HTTP_PROXY).toBe('http://config-proxy:9090');
    });
});
