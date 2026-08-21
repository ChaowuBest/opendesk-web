import test from 'node:test';
import assert from 'node:assert/strict';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { setPlatform, type AbstractPlatform } from '../../../platforms/base.js';
import { buildChildProcessEnv } from '../../../main/utils/shellExec.js';
import { refreshProxyEnvCache, getCachedProxyEnvVars } from '../../../main/utils/proxy-env.js';

setPlatform({
    getInjectedEnviron: () => new Map()
} as AbstractPlatform);

const tmpDir = import.meta.dirname + '/.tmp-proxy-e2e';
setCustomOpendeskDirectory(tmpDir);

test('custom mode injects HTTP_PROXY into child process env after cache refresh', async () => {
    const setting = Setting.getInstance();
    const data = setting.getData();
    data.network_config = {
        no_ssl: false,
        use_proxy: 'custom',
        custom_proxy_addr: 'http://e2e-proxy:9090',
        no_proxy: 'intranet.example.com'
    };
    setting.setData(data);

    await refreshProxyEnvCache();
    const cached = getCachedProxyEnvVars();
    assert.ok(cached, 'cache should be populated after refresh');
    assert.equal(cached!.HTTP_PROXY, 'http://e2e-proxy:9090');

    const env = buildChildProcessEnv();
    assert.equal(env.HTTP_PROXY, 'http://e2e-proxy:9090');
    assert.equal(env.HTTPS_PROXY, 'http://e2e-proxy:9090');
    assert.equal(env.http_proxy, 'http://e2e-proxy:9090');
    assert.equal(env.https_proxy, 'http://e2e-proxy:9090');
    assert.equal(env.NO_PROXY, 'intranet.example.com');
    assert.equal(env.no_proxy, 'intranet.example.com');
});

test('none mode clears existing HTTP_PROXY from child process env', async () => {
    process.env.HTTP_PROXY = 'http://should-be-cleared:1234';
    process.env.http_proxy = 'http://should-be-cleared:1234';

    const setting = Setting.getInstance();
    const data = setting.getData();
    data.network_config = {
        no_ssl: false,
        use_proxy: 'none',
        custom_proxy_addr: '',
        no_proxy: ''
    };
    setting.setData(data);

    await refreshProxyEnvCache();
    const env = buildChildProcessEnv();
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.http_proxy, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.https_proxy, undefined);

    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
});

test('system mode on non-openharmony without env proxy returns empty cache', async () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;

    const setting = Setting.getInstance();
    const data = setting.getData();
    data.network_config = {
        no_ssl: false,
        use_proxy: 'system',
        custom_proxy_addr: '',
        no_proxy: ''
    };
    setting.setData(data);

    await refreshProxyEnvCache();
    const cached = getCachedProxyEnvVars();
    // Linux 平台无 env 代理时缓存为空对象
    if (cached) {
        assert.equal(cached.HTTP_PROXY, undefined);
    }
});

test('config change via onNetworkConfigChanged updates cache immediately', async () => {
    const { onNetworkConfigChanged } = await import('../../../main/utils/proxy-env.js');
    const setting = Setting.getInstance();
    const data = setting.getData();
    data.network_config = {
        no_ssl: false,
        use_proxy: 'custom',
        custom_proxy_addr: 'http://old:8080',
        no_proxy: ''
    };
    setting.setData(data);

    await refreshProxyEnvCache();
    assert.equal(getCachedProxyEnvVars()?.HTTP_PROXY, 'http://old:8080');

    data.network_config.custom_proxy_addr = 'http://new:9090';
    setting.setData(data);
    await onNetworkConfigChanged();

    assert.equal(getCachedProxyEnvVars()?.HTTP_PROXY, 'http://new:9090');
    assert.equal(buildChildProcessEnv().HTTP_PROXY, 'http://new:9090');
});
