import { beforeEach, expect, jest, test } from '@jest/globals';

const networkConfig = {
    use_proxy: 'system',
    custom_proxy_addr: '',
    no_proxy: 'imap.private.example, localhost'
};
const systemProxy = { url: 'http://proxy.example.com:8080', bypassList: 'localhost,.corp.example.com' };

jest.unstable_mockModule('../../../platforms/base.js', () => ({
    getPlatform: () => ({ getNetworkConfig: () => networkConfig })
}));
jest.unstable_mockModule('../../../main/utils/proxy-env.js', () => ({
    getEffectiveSystemProxy: async () => systemProxy
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}));

beforeEach(() => {
    jest.resetModules();
    networkConfig.no_proxy = 'imap.private.example, localhost';
    networkConfig.use_proxy = 'system';
    networkConfig.custom_proxy_addr = '';
    systemProxy.bypassList = 'localhost,.corp.example.com';
});

test('system proxy keeps both system and application mail bypass rules', async () => {
    const { resolveMailEndpoint, resolveMailProxyConfig } =
        await import('../../../main/applications/mailbox/service/proxy-tunnel.js');
    expect(await resolveMailProxyConfig()).toEqual({
        url: systemProxy.url,
        noProxy: 'localhost,.corp.example.com,imap.private.example',
        tryDirect: true
    });
    expect(await resolveMailEndpoint('smtp.corp.example.com', 465)).toBeNull();
    expect(await resolveMailEndpoint('imap.private.example', 993)).toBeNull();
});

test('system proxy tries direct connections without requiring a bypass list', async () => {
    networkConfig.no_proxy = '';
    systemProxy.bypassList = '';
    const { resolveMailProxyConfig } = await import('../../../main/applications/mailbox/service/proxy-tunnel.js');
    expect(await resolveMailProxyConfig()).toEqual({ url: systemProxy.url, noProxy: '', tryDirect: true });
});

test('custom proxy keeps explicit routing without automatic direct attempts', async () => {
    networkConfig.use_proxy = 'custom';
    networkConfig.custom_proxy_addr = 'socks5://custom-proxy:1080';
    const { resolveMailProxyConfig } = await import('../../../main/applications/mailbox/service/proxy-tunnel.js');
    expect(await resolveMailProxyConfig()).toEqual({
        url: networkConfig.custom_proxy_addr,
        noProxy: networkConfig.no_proxy
    });
});

test('none mode connects directly without detecting a proxy', async () => {
    networkConfig.use_proxy = 'none';
    const { resolveMailEndpoint } = await import('../../../main/applications/mailbox/service/proxy-tunnel.js');
    expect(await resolveMailEndpoint('203.0.113.10', 993)).toBeNull();
});
