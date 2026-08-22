import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { mock } from 'node:test';
import { getTempWorkspaceDirectory } from '../../../../main/utils/setting.js';

test('getTempWorkspaceDirectory falls back to home OpenDesk when Documents is not writable on OpenHarmony', () => {
    const originalPlatform = process.platform;
    const runtimeEnvironment = {
        OPENDESK_HARMONY_BUILD_VARIANT: 'pc',
        OPENDESK_HARMONY_DEVICE_TYPE: '2in1',
        OPENDESK_HARMONY_APP_DATA_DIR: '/data/storage/el2/base/files',
        OPENDESK_HARMONY_TEMP_DIR: '/data/storage/el2/base/temp',
        OPENDESK_HARMONY_CACHE_DIR: '/data/storage/el2/base/cache',
        OPENDESK_HARMONY_USER_HOME_DIR: '/storage/Users/currentUser'
    };
    const affectedEnvironmentKeys = [
        ...Object.keys(runtimeEnvironment),
        'USER_DATA_PATH',
        'HOME',
        'TMPDIR',
        'TMP',
        'TEMP',
        'XDG_CACHE_HOME'
    ];
    const originalEnvironment = Object.fromEntries(affectedEnvironmentKeys.map((key) => [key, process.env[key]]));

    // 模拟鸿蒙平台上 Documents 目录创建失败（权限不足），但回退路径可创建
    const mkdirMock = mock.method(fs, 'mkdirSync', (p: string | URL) => {
        const pathStr = typeof p === 'string' ? p : p.toString();
        if (pathStr.includes('Documents')) {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        // 回退路径及其他路径正常创建（no-op）
    });

    try {
        Object.defineProperty(process, 'platform', {
            value: 'openharmony',
            configurable: true
        });
        Object.assign(process.env, runtimeEnvironment);

        const result = getTempWorkspaceDirectory();

        // 应回退到家目录下的 OpenDesk
        assert.equal(result, '/storage/Users/currentUser/OpenDesk', '应回退到家目录下的 OpenDesk 目录');

        // 验证确实尝试过创建 Documents 路径
        const triedDocuments = mkdirMock.mock.calls.some((c) => {
            const arg = c.arguments[0];
            const argStr = typeof arg === 'string' ? arg : arg.toString();
            return argStr.includes('Documents');
        });
        assert.ok(triedDocuments, '应先尝试创建 Documents/OpenDesk 目录');
    } finally {
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true
        });
        for (const [key, value] of Object.entries(originalEnvironment)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        mkdirMock.mock.restore();
    }
});
