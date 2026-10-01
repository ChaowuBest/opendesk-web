import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateOpenDeskPluginPackage } from '../../../../packages/plugin-sdk/src/package.js';
import { computePluginIntegrity } from '../../../main/applications/pluginmgr/discovery/integrity.js';

describe('OpenDesk plugin distribution security', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-integrity-'));
        fs.mkdirSync(path.join(root, 'dist'));
        fs.writeFileSync(path.join(root, 'dist', 'plugin.js'), 'export default { id: "secure" };', 'utf-8');
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify(
                {
                    name: 'opendesk-plugin-secure',
                    version: '1.0.0',
                    type: 'module',
                    opendesk: {
                        plugin: './dist/plugin.js',
                        schemaVersion: 1,
                        id: 'secure',
                        apiVersion: 1,
                        capabilities: ['tool']
                    }
                },
                null,
                4
            ),
            'utf-8'
        );
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('校验分发声明和入口', () => {
        expect(validateOpenDeskPluginPackage(root)).toMatchObject({
            name: 'opendesk-plugin-secure',
            version: '1.0.0',
            apiVersion: 1,
            capabilities: ['tool']
        });
    });

    test('检测安装后文件篡改', () => {
        const before = computePluginIntegrity(root);
        fs.appendFileSync(path.join(root, 'dist', 'plugin.js'), '\n// changed', 'utf-8');
        expect(computePluginIntegrity(root)).not.toBe(before);
    });

    test('拒绝未纳入摘要保护的符号链接', () => {
        const outside = path.join(os.tmpdir(), `opendesk-plugin-outside-${crypto.randomUUID()}.js`);
        fs.writeFileSync(outside, 'export default {};', 'utf-8');
        try {
            try {
                fs.symlinkSync(outside, path.join(root, 'dist', 'linked.js'));
            } catch (error) {
                // Windows 上创建符号链接需要管理员/开发者模式权限，权限不足时跳过该用例；
                // 语义等价于"当前环境不支持符号链接"。
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EISDIR') return;
                throw error;
            }
            expect(() => computePluginIntegrity(root)).toThrow('plugin.integrity_symlink_unsupported');
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });
});
