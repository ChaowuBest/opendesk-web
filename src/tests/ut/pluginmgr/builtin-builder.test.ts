import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { buildBuiltinPlugins } from '../../../../scripts/build-builtin-plugins.js';

describe('builtin plugin builder', () => {
    let temporaryDirectory: string;
    let sourceDirectory: string;
    let outputDirectory: string;

    beforeEach(() => {
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-builtin-plugin-build-'));
        sourceDirectory = path.join(temporaryDirectory, 'resources', 'plugins');
        outputDirectory = path.join(temporaryDirectory, 'dist', 'plugins');
    });

    afterEach(() => {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    test('复制可直接运行的插件入口为只读构建产物', async () => {
        const pluginDirectory = path.join(sourceDirectory, 'builtin-review');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'builtin-review',
                displayName: 'Builtin Review',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: ['hook']
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'message.mjs'), `export const message = 'builtin';`);
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `import { message } from './message.mjs';
             export default {
                 id: 'builtin-review',
                 setup() {
                     return message;
                 }
             };`
        );

        const result = await buildBuiltinPlugins({
            sourceDirectory,
            outputDirectory
        });

        expect(result).toEqual([
            {
                id: 'builtin-review',
                sourceDirectory: pluginDirectory,
                outputDirectory: path.join(outputDirectory, 'builtin-review'),
                entry: path.join(outputDirectory, 'builtin-review', 'index.mjs')
            }
        ]);
        const outputManifest = JSON.parse(
            fs.readFileSync(path.join(outputDirectory, 'builtin-review', 'opendesk.plugin.json'), 'utf-8')
        ) as Record<string, unknown>;
        expect(outputManifest).toMatchObject({
            id: 'builtin-review',
            entry: './index.mjs'
        });
        expect(fs.existsSync(path.join(outputDirectory, 'builtin-review', 'index.mjs'))).toBe(true);

        const loaded = (await import(`${pathToFileURL(result[0].entry).href}?test=${Date.now()}`)) as {
            default: { id: string; setup(): string };
        };
        expect(loaded.default.id).toBe('builtin-review');
        expect(loaded.default.setup()).toBe('builtin');
    });

    test('拒绝没有 manifest 的内置插件目录', async () => {
        const pluginDirectory = path.join(sourceDirectory, 'invalid');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), 'export default {};');

        await expect(
            buildBuiltinPlugins({
                sourceDirectory,
                outputDirectory
            })
        ).rejects.toThrow('plugin.builtin_manifest_not_found:invalid');
    });
});
