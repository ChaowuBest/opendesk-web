import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { loadPlugin, resolvePluginEntry } from '../../../main/applications/pluginmgr/discovery/loader.js';
import { loadPluginResources, parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';

describe('插件语言包清单契约', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-locale-pack-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const writePack = (directory: string, files: Record<string, unknown>) => {
        for (const [name, content] of Object.entries(files)) {
            const file = path.join(directory, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
        }
    };

    test('声明 locales 时必须同时声明 locale capability', () => {
        expect(() =>
            parsePluginManifest({
                id: 'pack',
                apiVersion: 1,
                capabilities: ['skill'],
                resources: { locales: ['locales'] }
            })
        ).toThrow('plugin.manifest_resource_capability_missing:locale');
    });

    test('resources.locales 声明解析为路径数组', () => {
        const manifest = parsePluginManifest({
            id: 'pack',
            apiVersion: 1,
            capabilities: ['locale'],
            resources: { locales: ['locales'] }
        });
        expect(manifest.resources?.locales).toEqual(['locales']);
    });

    test('语言包文件从目录装载，tag 由文件名规范化', () => {
        writePack(root, {
            'opendesk.plugin.json': {
                id: 'pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            },
            'locales/tr-tr.json': { '@fallback': 'en-US', 'renderer.sidebar.apps': 'Uygulamalar' },
            'locales/id-ID.json': { 'renderer.sidebar.apps': 'Aplikasi' }
        });
        const manifest = parsePluginManifest(
            JSON.parse(fs.readFileSync(path.join(root, 'opendesk.plugin.json'), 'utf-8'))
        );
        const resources = loadPluginResources(manifest, root);
        expect(resources.locales).toHaveLength(2);
        expect(resources.locales?.[0]).toMatchObject({
            tag: 'id-ID',
            entries: { 'renderer.sidebar.apps': 'Aplikasi' }
        });
        expect(resources.locales?.[1]).toMatchObject({
            tag: 'tr-TR',
            fallback: 'en-US',
            entries: { 'renderer.sidebar.apps': 'Uygulamalar' }
        });
        expect(resources.locales?.[1].sourceFile).toBe('locales/tr-tr.json');
    });

    test('插件根目录含符号链接时 sourceFile 仍是插件内相对路径', () => {
        // 真实路径与传入的根目录路径不一致（macOS 的 /var -> /private/var 就属于这种情况）
        const realRoot = path.join(root, 'real-plugin');
        writePack(realRoot, {
            'opendesk.plugin.json': {
                id: 'pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            },
            'locales/tr-TR.json': { key: 'değer' }
        });
        const linkedRoot = path.join(root, 'linked-plugin');
        fs.symlinkSync(realRoot, linkedRoot, 'dir');
        const manifest = parsePluginManifest(
            JSON.parse(fs.readFileSync(path.join(linkedRoot, 'opendesk.plugin.json'), 'utf-8'))
        );
        const resources = loadPluginResources(manifest, linkedRoot);
        expect(resources.locales?.[0].sourceFile).toBe('locales/tr-TR.json');
    });

    test('@priority 并入语言包定义，未声明时缺省为 1', () => {
        writePack(root, {
            'opendesk.plugin.json': {
                id: 'pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            },
            'locales/tr-TR.json': { '@priority': '7', key: 'v' },
            'locales/de-DE.json': { key: 'v' }
        });
        const manifest = parsePluginManifest(
            JSON.parse(fs.readFileSync(path.join(root, 'opendesk.plugin.json'), 'utf-8'))
        );
        const resources = loadPluginResources(manifest, root);
        expect(resources.locales?.find((pack) => pack.tag === 'tr-TR')?.priority).toBe(7);
        expect(resources.locales?.find((pack) => pack.tag === 'de-DE')?.priority).toBe(1);
    });

    test('非法 @priority 使语言包装载失败并携带来源文件', () => {
        writePack(root, {
            'opendesk.plugin.json': {
                id: 'pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            },
            'locales/tr-TR.json': { '@priority': '1000', key: 'v' }
        });
        const manifest = parsePluginManifest(
            JSON.parse(fs.readFileSync(path.join(root, 'opendesk.plugin.json'), 'utf-8'))
        );
        expect(() => loadPluginResources(manifest, root)).toThrow(/@priority/);
    });

    test('语言包结构非法时报错并携带来源文件', () => {
        writePack(root, {
            'opendesk.plugin.json': {
                id: 'pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            },
            'locales/tr-TR.json': { key: 42 }
        });
        const manifest = parsePluginManifest(
            JSON.parse(fs.readFileSync(path.join(root, 'opendesk.plugin.json'), 'utf-8'))
        );
        expect(() => loadPluginResources(manifest, root)).toThrow(/tr-TR\.json/);
    });

    test('同一插件内重复 tag 视为清单歧义（tr_TR.json 与 tr-TR.json 规范化后同 tag）', () => {
        writePack(root, {
            'opendesk.plugin.json': {
                id: 'pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            },
            'locales/tr-TR.json': { key: 'v' },
            'locales/tr_TR.json': { key: 'v' }
        });
        const manifest = parsePluginManifest(
            JSON.parse(fs.readFileSync(path.join(root, 'opendesk.plugin.json'), 'utf-8'))
        );
        expect(() => loadPluginResources(manifest, root)).toThrow('plugin.manifest_locale_tag_conflict:tr-TR');
    });

    test('超过 2MB 上限的语言包文件被跳过并告警，其余文件正常装载', () => {
        writePack(root, {
            'opendesk.plugin.json': {
                id: 'pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            },
            'locales/id-ID.json': { big: 'x'.repeat(2 * 1024 * 1024 + 1) },
            'locales/tr-TR.json': { key: 'v' }
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const manifest = parsePluginManifest(
                JSON.parse(fs.readFileSync(path.join(root, 'opendesk.plugin.json'), 'utf-8'))
            );
            const resources = loadPluginResources(manifest, root);
            expect(resources.locales).toHaveLength(1);
            expect(resources.locales?.[0]).toMatchObject({ tag: 'tr-TR', entries: { key: 'v' } });
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('locales/id-ID.json'));
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('语言包路径越界被拒绝', () => {
        const manifest = parsePluginManifest({
            id: 'pack',
            apiVersion: 1,
            capabilities: ['locale'],
            resources: { locales: ['../outside'] }
        });
        expect(() => loadPluginResources(manifest, root)).toThrow('plugin.manifest_locale_path_invalid');
    });

    test('空语言包目录报错', () => {
        fs.mkdirSync(path.join(root, 'locales'), { recursive: true });
        const manifest = parsePluginManifest({
            id: 'pack',
            apiVersion: 1,
            capabilities: ['locale'],
            resources: { locales: ['locales'] }
        });
        expect(() => loadPluginResources(manifest, root)).toThrow('plugin.manifest_locale_not_found');
    });
});

describe('纯静态插件（无入口）加载', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-static-plugin-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const writeStaticPlugin = () => {
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'static-pack',
                apiVersion: 1,
                capabilities: ['locale'],
                resources: { locales: ['locales'] }
            })
        );
        fs.mkdirSync(path.join(root, 'locales'), { recursive: true });
        fs.writeFileSync(path.join(root, 'locales', 'tr-TR.json'), JSON.stringify({ key: 'değer' }));
    };

    test('带根级清单且无入口的目录解析为纯静态插件', () => {
        writeStaticPlugin();
        // 内置候选一律带 requireDeclaration，静态语言包必须在此约束下仍然可加载
        expect(resolvePluginEntry(root, root, { requireDeclaration: true })).toBeUndefined();
    });

    test('loadPlugin 跳过动态 import 并由清单合成最小插件对象', async () => {
        writeStaticPlugin();
        const loaded = await loadPlugin({ spec: root, origin: root }, root, { requireDeclaration: true });
        expect(loaded.plugin.id).toBe('static-pack');
        expect(typeof loaded.plugin.setup).toBe('function');
        expect(loaded.entry).toBe('');
        expect(loaded.resources.locales).toHaveLength(1);
        expect(loaded.resources.locales?.[0].entries.key).toBe('değer');
        await expect(loaded.plugin.setup({} as never)).resolves.toBeUndefined();
    });

    test('package.json#opendesk 形态的纯静态插件同样可加载（判定口径一致）', async () => {
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'static-pack-npm',
                opendesk: {
                    id: 'static-pack-npm',
                    apiVersion: 1,
                    capabilities: ['locale'],
                    resources: { locales: ['locales'] }
                }
            })
        );
        fs.mkdirSync(path.join(root, 'locales'), { recursive: true });
        fs.writeFileSync(path.join(root, 'locales', 'tr-TR.json'), JSON.stringify({ key: 'değer' }));
        expect(resolvePluginEntry(root, root, { requireDeclaration: true })).toBeUndefined();
        const loaded = await loadPlugin({ spec: root, origin: root }, root, { requireDeclaration: true });
        expect(loaded.plugin.id).toBe('static-pack-npm');
        expect(loaded.entry).toBe('');
        expect(loaded.resources.locales).toHaveLength(1);
        expect(loaded.resources.locales?.[0].entries.key).toBe('değer');
    });

    test('无清单且无入口的目录仍报 entry_not_found', () => {
        fs.mkdirSync(root, { recursive: true });
        expect(() => resolvePluginEntry(root, root)).toThrow('plugin.entry_not_found');
    });

    test('清单声明了入口但文件缺失仍报 entry_not_found', () => {
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({ id: 'broken', apiVersion: 1, entry: './missing.js' })
        );
        expect(() => resolvePluginEntry(root, root)).toThrow('plugin.entry_not_found');
    });
});
