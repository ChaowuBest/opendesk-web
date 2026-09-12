import assert from 'node:assert/strict';
import test from 'node:test';
import hmCompatPlugin from '../../../../resources/plugins/hm-compat/index.mjs';
import { runBootstrapOnce } from '../../../../resources/plugins/hm-compat/bootstrap/zsh.mjs';

const ENV_KEYS = [
    'PATH',
    'PIP_INDEX_URL',
    'PIP_TRUSTED_HOST',
    'PIP_ONLY_BINARY',
    'npm_config_registry',
    'NODE_OPTIONS'
] as const;

function preserveEnvironment() {
    const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    return () => {
        for (const key of ENV_KEYS) {
            if (original[key] === undefined) delete process.env[key];
            else process.env[key] = original[key];
        }
    };
}

test('runBootstrapOnce shares one promise per process and resolves step results', async () => {
    const first = runBootstrapOnce({ platform: 'win32' });
    const second = runBootstrapOnce({ platform: 'win32' });

    assert.equal(first, second);
    // 非 openharmony 平台短路：无步骤执行，结果为空对象
    assert.deepEqual(await first, {});
});

test('hm-compat setup returns synchronously without awaiting bootstrap', () => {
    const restore = preserveEnvironment();
    try {
        delete process.env.OPENDESK_HARMONY_BUILD_VARIANT;
        const result = hmCompatPlugin.setup({ configDir: '/data/opendesk' } as never);

        // setup 不得返回安装 promise（否则宿主 await plugin.setup 会把环境安装
        // 拉进 initializePluginHost 的 await 链，阻塞 CLI 启动）
        assert.equal(result, undefined);
    } finally {
        restore();
    }
});
