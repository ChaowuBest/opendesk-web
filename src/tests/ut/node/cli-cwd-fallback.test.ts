import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Issue #219: headless 模式执行中若 CWD 被删除，再次启动 opendesk CLI 时
 * process.cwd() 抛出 ENOENT。
 *
 * 之前的修复方案是静默回退到家目录，但可能导致不符合预期的行为。
 * 现改为不再容错：CliPlatform 构造时直接使用 process.cwd()，
 * CWD 失效时由 parseCommandLineArgs 中的早期检查抛出清晰错误并退出。
 */

let CliPlatform: typeof import('../../../platforms/cli.js').CliPlatform;

const originalCwd = process.cwd;

test('CliPlatform 在 CWD 正常时 workspace 等于 process.cwd()', async () => {
    const mod = await import('../../../platforms/cli.js');
    CliPlatform = mod.CliPlatform;
    process.cwd = originalCwd;
    const platform = new CliPlatform();
    assert.equal(platform.getEffectiveWorkspace(), originalCwd());
});

test('CliPlatform 在 CWD 被删除后构造直接抛出 ENOENT，不回退到家目录', async () => {
    const mod = await import('../../../platforms/cli.js');
    CliPlatform = mod.CliPlatform;
    const enoentError = Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT' });
    process.cwd = () => {
        throw enoentError;
    };
    try {
        assert.throws(
            () => new CliPlatform(),
            (err: Error & { code?: string }) => err.code === 'ENOENT'
        );
    } finally {
        process.cwd = originalCwd;
    }
});
