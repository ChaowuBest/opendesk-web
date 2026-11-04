import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPluginCli } from '../../../../packages/plugin-sdk/src/cli.js';

describe('opendesk-plugin-sdk CLI', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-cli-'));
        fs.mkdirSync(path.join(root, 'dist'));
        fs.writeFileSync(path.join(root, 'dist', 'plugin.js'), 'export default {};', 'utf-8');
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'cli-plugin',
                version: '1.0.0',
                opendesk: {
                    plugin: './dist/plugin.js',
                    apiVersion: 1,
                    capabilities: []
                }
            }),
            'utf-8'
        );
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('validate 输出校验后的插件元数据', () => {
        const messages: string[] = [];
        const exitCode = runPluginCli(['validate', root], {
            log: (message) => messages.push(message),
            error: (message) => messages.push(message)
        });

        expect(exitCode).toBe(0);
        expect(JSON.parse(messages[0])).toMatchObject({
            id: 'cli-plugin',
            name: 'cli-plugin',
            version: '1.0.0',
            apiVersion: 1
        });
    });

    test('拒绝未知命令并输出用法', () => {
        const errors: string[] = [];
        const exitCode = runPluginCli(['pack', root], {
            log: () => undefined,
            error: (message) => errors.push(message)
        });

        expect(exitCode).toBe(1);
        expect(errors).toEqual(['Usage: opendesk-plugin-sdk validate <plugin-dir>']);
    });
});
