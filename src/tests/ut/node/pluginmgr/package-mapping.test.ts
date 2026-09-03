import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    registerSdkPackageMapping,
    resolveWorkspacePackageUrl
} from '../../../../main/applications/pluginmgr/runtime/package-mapping.js';

async function createSdkImportingPlugin(pluginId: string): Promise<{ directory: string; url: string }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-sdk-map-'));
    await writeFile(
        path.join(directory, 'index.mjs'),
        [
            "import { definePlugin, tool } from '@bitclub.ai/opendesk-plugin-sdk';",
            '',
            'export default definePlugin({',
            `    id: '${pluginId}',`,
            "    displayName: 'SDK Map Probe',",
            "    capabilities: ['tool'],",
            '    setup(ctx) {',
            '        ctx.tools.register(',
            '            tool({',
            "                name: 'probe',",
            "                description: 'Probe the mapped SDK.',",
            '                args: { input: tool.schema.string() },',
            '                async execute(args) { return { output: args.input }; }',
            '            })',
            '        );',
            '    }',
            '});',
            ''
        ].join('\n')
    );
    return { directory, url: pathToFileURL(path.join(directory, 'index.mjs')).href };
}

test('未注册包路径映射时，缺 node_modules 的插件入口解析 SDK 失败', async () => {
    const { directory, url } = await createSdkImportingPlugin('sdk-map-probe');
    try {
        await assert.rejects(import(`${url}?case=no-map`), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as NodeJS.ErrnoException).code, 'ERR_MODULE_NOT_FOUND');
            assert.match(error.message, /Cannot find package '@bitclub\.ai\/opendesk-plugin-sdk'/);
            return true;
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('注册包路径映射后，无 node_modules 的插件可通过宿主 SDK 正常加载', async () => {
    registerSdkPackageMapping();
    const { directory, url } = await createSdkImportingPlugin('sdk-map-probe');
    try {
        const module = (await import(`${url}?case=mapped`)) as {
            default: { id: string; capabilities: string[]; setup: unknown };
        };
        assert.equal(module.default.id, 'sdk-map-probe');
        assert.deepEqual(module.default.capabilities, ['tool']);
        assert.equal(typeof module.default.setup, 'function');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('插件自带 SDK 时优先使用插件自身的包', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-sdk-own-'));
    const sdkDirectory = path.join(directory, 'node_modules', '@bitclub.ai', 'opendesk-plugin-sdk');
    await mkdir(sdkDirectory, { recursive: true });
    await writeFile(
        path.join(sdkDirectory, 'package.json'),
        JSON.stringify(
            {
                name: '@bitclub.ai/opendesk-plugin-sdk',
                version: '0.0.0-test',
                type: 'module',
                exports: { '.': './index.js' }
            },
            null,
            2
        )
    );
    await writeFile(
        path.join(sdkDirectory, 'index.js'),
        [
            "export const SELF_MARKER = 'plugin-owned-sdk';",
            'export const definePlugin = (plugin) => plugin;',
            'export const tool = Object.assign((definition) => definition, {',
            "    schema: { string: () => 'string-schema' }",
            '});',
            ''
        ].join('\n')
    );
    await writeFile(
        path.join(directory, 'index.mjs'),
        [
            "import { definePlugin, SELF_MARKER } from '@bitclub.ai/opendesk-plugin-sdk';",
            '',
            'export default {',
            '    ...definePlugin({',
            "        id: 'sdk-map-self',",
            "        capabilities: ['tool'],",
            '        setup() {}',
            '    }),',
            '    marker: SELF_MARKER',
            '};',
            ''
        ].join('\n')
    );
    try {
        registerSdkPackageMapping();
        const url = `${pathToFileURL(path.join(directory, 'index.mjs')).href}?case=self`;
        const module = (await import(url)) as { default: { id: string; marker: string } };
        assert.equal(module.default.id, 'sdk-map-self');
        assert.equal(module.default.marker, 'plugin-owned-sdk');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Plugin SDK 以 `file:packages/plugin-sdk` 被宿主依赖，`node_modules` 下只是一个指向
 * workspace 目录的符号链接。打包、复制或裁剪应用目录时该链接可能不被保留，宿主侧
 * require.resolve 随之失败，兜底映射失效。workspace 目录（packages/plugin-sdk）仍随
 * 应用分发，故必须能从应用根直接解析到它。
 */
async function createAppRootWithWorkspaceSdk(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opendesk-workspace-sdk-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'opendesk-fixture' }));
    const sdkRoot = path.join(root, 'packages', 'plugin-sdk');
    await mkdir(path.join(sdkRoot, 'dist'), { recursive: true });
    await writeFile(
        path.join(sdkRoot, 'package.json'),
        JSON.stringify({
            name: '@bitclub.ai/opendesk-plugin-sdk',
            version: '0.0.0-workspace',
            type: 'module',
            exports: {
                '.': { default: './dist/index.js' },
                './package': { default: './dist/package.js' }
            }
        })
    );
    await writeFile(path.join(sdkRoot, 'dist', 'index.js'), 'export const definePlugin = (plugin) => plugin;\n');
    await writeFile(path.join(sdkRoot, 'dist', 'package.js'), 'export const validate = () => true;\n');
    await mkdir(path.join(root, 'dist', 'main', 'chunks'), { recursive: true });
    return root;
}

test('node_modules 链接缺失时，从应用根的 workspace 目录解析宿主 SDK', async () => {
    const root = await createAppRootWithWorkspaceSdk();
    try {
        const start = path.join(root, 'dist', 'main', 'chunks');
        const resolved = resolveWorkspacePackageUrl('@bitclub.ai/opendesk-plugin-sdk', start);

        assert.equal(resolved, pathToFileURL(path.join(root, 'packages/plugin-sdk/dist/index.js')).href);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('workspace 兜底按包声明的 exports 解析子路径', async () => {
    const root = await createAppRootWithWorkspaceSdk();
    try {
        const start = path.join(root, 'dist', 'main', 'chunks');
        const resolved = resolveWorkspacePackageUrl('@bitclub.ai/opendesk-plugin-sdk/package', start);

        assert.equal(resolved, pathToFileURL(path.join(root, 'packages/plugin-sdk/dist/package.js')).href);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('应用根缺少 workspace 目录时不返回兜底路径', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opendesk-workspace-missing-'));
    try {
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'opendesk-fixture' }));
        const start = path.join(root, 'dist', 'main', 'chunks');
        await mkdir(start, { recursive: true });

        assert.equal(resolveWorkspacePackageUrl('@bitclub.ai/opendesk-plugin-sdk', start), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('未声明 workspace 位置的宿主包不参与兜底解析', async () => {
    const root = await createAppRootWithWorkspaceSdk();
    try {
        const start = path.join(root, 'dist', 'main', 'chunks');

        assert.equal(resolveWorkspacePackageUrl('zod', start), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
