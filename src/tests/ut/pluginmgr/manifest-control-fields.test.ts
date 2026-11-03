import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    declaresManifestControlFields,
    parsePluginManifest,
    readManifestDeclaration,
    resolveManifestControlFields
} from '../../../main/applications/pluginmgr/discovery/manifest.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { apiVersion: 1, capabilities: [], ...overrides };
}

describe('插件清单 system / enabled 字段', () => {
    test('接受布尔声明', () => {
        const parsed = parsePluginManifest(manifest({ system: true, enabled: false }));
        expect(parsed.system).toBe(true);
        expect(parsed.enabled).toBe(false);
    });

    test('未声明时保持 undefined', () => {
        const parsed = parsePluginManifest(manifest());
        expect(parsed.system).toBeUndefined();
        expect(parsed.enabled).toBeUndefined();
    });

    test('非布尔值被拒绝', () => {
        expect(() => parsePluginManifest(manifest({ system: 'true' }))).toThrow('plugin.manifest_invalid_system');
        expect(() => parsePluginManifest(manifest({ enabled: 1 }))).toThrow('plugin.manifest_invalid_enabled');
        expect(() => parsePluginManifest(manifest({ system: null }))).toThrow('plugin.manifest_invalid_system');
    });

    test('只有内置插件才能锁住启停', () => {
        const declaration = { system: true, enabled: false };
        expect(resolveManifestControlFields(declaration, { builtin: true })).toEqual({
            system: true,
            enabled: false
        });
        // 后装插件声明了同一个字段也不会生效
        expect(resolveManifestControlFields(declaration, { builtin: false })).toBeUndefined();
    });

    test('未声明控制字段时视为未锁定', () => {
        expect(resolveManifestControlFields(manifest(), { builtin: true })).toBeUndefined();
        expect(resolveManifestControlFields(undefined, { builtin: true })).toBeUndefined();
        // 只声明 enabled 而没开 system：不构成固定启停
        expect(resolveManifestControlFields({ enabled: false }, { builtin: true })).toEqual({
            system: false,
            enabled: false
        });
    });

    test('declaresManifestControlFields 只判断是否声明（不看来源）', () => {
        expect(declaresManifestControlFields(parsePluginManifest(manifest({ system: true })))).toBe(true);
        expect(declaresManifestControlFields(parsePluginManifest(manifest({ enabled: false })))).toBe(true);
        expect(declaresManifestControlFields(parsePluginManifest(manifest()))).toBe(false);
        expect(declaresManifestControlFields(undefined)).toBe(false);
    });

    test('readManifestDeclaration 读取目录清单与入口同名清单，损坏/缺失时返回 undefined', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-control-'));
        try {
            const directoryPlugin = path.join(root, 'directory-plugin');
            fs.mkdirSync(directoryPlugin, { recursive: true });
            fs.writeFileSync(
                path.join(directoryPlugin, 'opendesk.plugin.json'),
                JSON.stringify({ id: 'directory-plugin', system: true, enabled: false })
            );
            expect(readManifestDeclaration(directoryPlugin)).toMatchObject({ system: true, enabled: false });

            const sidecarPlugin = path.join(root, 'sidecar-plugin');
            fs.mkdirSync(sidecarPlugin, { recursive: true });
            fs.writeFileSync(path.join(sidecarPlugin, 'index.mjs'), 'export default {};');
            fs.writeFileSync(
                path.join(sidecarPlugin, 'index.opendesk.plugin.json'),
                JSON.stringify({ id: 'sidecar-plugin', system: true })
            );
            expect(readManifestDeclaration(path.join(sidecarPlugin, 'index.mjs'))).toMatchObject({ system: true });

            const brokenPlugin = path.join(root, 'broken-plugin');
            fs.mkdirSync(brokenPlugin, { recursive: true });
            fs.writeFileSync(path.join(brokenPlugin, 'opendesk.plugin.json'), '{ not json');
            expect(readManifestDeclaration(brokenPlugin)).toBeUndefined();

            expect(readManifestDeclaration(path.join(root, 'missing-plugin'))).toBeUndefined();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('readManifestDeclaration 与 readPluginManifest 的查找顺序一致：目录清单优先于入口同名清单', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-declaration-order-'));
        try {
            const plugin = path.join(root, 'dual-manifest');
            fs.mkdirSync(plugin, { recursive: true });
            fs.writeFileSync(path.join(plugin, 'index.mjs'), 'export default {};');
            fs.writeFileSync(
                path.join(plugin, 'index.opendesk.plugin.json'),
                JSON.stringify({ id: 'sidecar-id', system: true })
            );
            fs.writeFileSync(path.join(plugin, 'opendesk.plugin.json'), JSON.stringify({ id: 'directory-id' }));

            expect(readManifestDeclaration(path.join(plugin, 'index.mjs'))).toMatchObject({ id: 'directory-id' });
            expect(readManifestDeclaration(plugin)).toMatchObject({ id: 'directory-id' });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('readManifestDeclaration 无清单文件时回落到 package.json#opendesk 声明', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-declaration-package-'));
        try {
            const plugin = path.join(root, 'packaged-plugin');
            fs.mkdirSync(plugin, { recursive: true });
            fs.writeFileSync(
                path.join(plugin, 'package.json'),
                JSON.stringify({
                    name: 'packaged-plugin',
                    version: '1.0.0',
                    opendesk: { plugin: './index.mjs', apiVersion: 1, capabilities: [], system: true }
                })
            );

            // readPluginManifest 会把 package.json#opendesk 当清单，discovery 侧必须读到同一份声明，
            // 否则 package 声明的内置插件会出现「GUI 显示系统锁定、isPluginEnabledFixed 却返回 false」的分裂
            expect(readManifestDeclaration(plugin)).toMatchObject({ system: true });

            // package.json 无 opendesk 声明或缺失时返回 undefined
            const plainPlugin = path.join(root, 'plain-plugin');
            fs.mkdirSync(plainPlugin, { recursive: true });
            fs.writeFileSync(path.join(plainPlugin, 'package.json'), JSON.stringify({ name: 'plain' }));
            expect(readManifestDeclaration(plainPlugin)).toBeUndefined();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
