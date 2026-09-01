import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { buildBuiltinPlugins } from '../../../../scripts/build-builtin-plugins.js';

function makePluginFixture(
    sourceDirectory: string,
    id: string,
    options: {
        packageJson?: Record<string, unknown>;
        nodeModules?: Record<string, string>;
        bundle?: boolean;
        indexContent?: string;
        files?: Record<string, string>;
    } = {}
): string {
    const pluginDirectory = path.join(sourceDirectory, id);
    fs.mkdirSync(pluginDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(pluginDirectory, 'opendesk.plugin.json'),
        JSON.stringify({
            schemaVersion: 1,
            id,
            entry: './index.mjs',
            apiVersion: 1,
            capabilities: ['hook'],
            ...(options.bundle ? { bundle: true } : {})
        })
    );
    if (options.packageJson) {
        fs.writeFileSync(
            path.join(pluginDirectory, 'package.json'),
            JSON.stringify({
                name: id,
                version: '0.1.0',
                type: 'module',
                ...options.packageJson
            })
        );
    }
    fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), options.indexContent ?? 'export default {};');
    for (const [relativePath, content] of Object.entries(options.files ?? {})) {
        const target = path.join(pluginDirectory, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    for (const [relativePath, content] of Object.entries(options.nodeModules ?? {})) {
        const target = path.join(pluginDirectory, 'node_modules', relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return pluginDirectory;
}

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
        const pluginDirectory = makePluginFixture(sourceDirectory, 'builtin-review');
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

    test('插件声明运行时依赖且缺 node_modules 时在源目录安装依赖', async () => {
        const pluginDirectory = makePluginFixture(sourceDirectory, 'with-deps', {
            packageJson: { dependencies: { 'some-lib': '1.0.0' } }
        });

        const runNpm = jest.fn().mockResolvedValue(undefined);
        await buildBuiltinPlugins({ sourceDirectory, outputDirectory, runNpm });

        expect(runNpm).toHaveBeenCalledTimes(1);
        const [args, cwd] = runNpm.mock.calls[0] as [string[], string];
        expect(args).toContain('some-lib@1.0.0');
        expect(args).toContain('--no-save');
        expect(cwd).toBe(pluginDirectory);
        expect(fs.existsSync(path.join(outputDirectory, 'with-deps', 'index.mjs'))).toBe(true);
    });

    test('源目录已有 node_modules 时跳过安装并整体复制到输出目录', async () => {
        makePluginFixture(sourceDirectory, 'with-deps-installed', {
            packageJson: { dependencies: { 'some-lib': '1.0.0' } },
            nodeModules: { 'some-lib/index.js': 'module.exports = {};' }
        });

        const runNpm = jest.fn().mockResolvedValue(undefined);
        await buildBuiltinPlugins({ sourceDirectory, outputDirectory, runNpm });

        expect(runNpm).not.toHaveBeenCalled();
        expect(
            fs.existsSync(path.join(outputDirectory, 'with-deps-installed', 'node_modules', 'some-lib', 'index.js'))
        ).toBe(true);
    });

    test('宿主映射包不触发依赖安装', async () => {
        makePluginFixture(sourceDirectory, 'host-mapped', {
            packageJson: { dependencies: { zod: '^4.0.0' } }
        });

        const runNpm = jest.fn().mockResolvedValue(undefined);
        await buildBuiltinPlugins({ sourceDirectory, outputDirectory, runNpm });

        expect(runNpm).not.toHaveBeenCalled();
    });

    test('bundle 插件从入口内联依赖为单文件且不携带 node_modules', async () => {
        makePluginFixture(sourceDirectory, 'bundled', {
            bundle: true,
            indexContent: `import { marker } from './lib.mjs';
export default { id: 'bundled', setup() { return marker; } };`,
            files: { 'lib.mjs': `export const marker = 'bundled-marker';` }
        });

        await buildBuiltinPlugins({ sourceDirectory, outputDirectory, runNpm: async () => {} });

        const outputEntry = path.join(outputDirectory, 'bundled', 'index.mjs');
        expect(fs.existsSync(outputEntry)).toBe(true);
        expect(fs.existsSync(path.join(outputDirectory, 'bundled', 'node_modules'))).toBe(false);
        expect(fs.readFileSync(outputEntry, 'utf-8')).toContain('bundled-marker');

        const loaded = (await import(`${pathToFileURL(outputEntry).href}?test=${Date.now()}`)) as {
            default: { setup(): string };
        };
        expect(loaded.default.setup()).toBe('bundled-marker');
    });

    test('bundle 产物保留宿主映射包为外部引用', async () => {
        makePluginFixture(sourceDirectory, 'bundled-external', {
            bundle: true,
            indexContent: `import { z } from 'zod';
export default { id: 'bundled-external', setup() { return typeof z; } };`
        });

        await buildBuiltinPlugins({ sourceDirectory, outputDirectory, runNpm: async () => {} });

        const text = fs.readFileSync(path.join(outputDirectory, 'bundled-external', 'index.mjs'), 'utf-8');
        expect(text).toMatch(/from\s*"zod"/);
        expect(text).not.toContain('zod/v4');
    });
});
