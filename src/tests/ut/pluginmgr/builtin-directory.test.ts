import fs from 'fs';
import os from 'os';
import path from 'path';
import { findBuiltinPluginsDirectoryFrom } from '../../../main/applications/pluginmgr/management/paths.js';

describe('内置插件目录的应用根定位', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-builtin-plugins-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const makeDirectory = (...segments: string[]): string => {
        const target = path.join(root, ...segments);
        fs.mkdirSync(target, { recursive: true });
        return target;
    };

    /** 应用根的判定依据是 package.json，测试布局需要显式提供 */
    const markAppRoot = (...segments: string[]): string => {
        const target = makeDirectory(...segments);
        fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'opendesk-fixture' }));
        return target;
    };

    test('electron-vite 布局：从 dist/main/chunks 上溯到 dist/plugins', () => {
        markAppRoot();
        const plugins = makeDirectory('dist', 'plugins');
        const start = makeDirectory('dist', 'main', 'chunks');

        expect(findBuiltinPluginsDirectoryFrom(start)).toBe(plugins);
    });

    test('鸿蒙 HAP 布局：resources/app 下只有源目录 resources/plugins 时也能定位', () => {
        markAppRoot('resources', 'app');
        const plugins = makeDirectory('resources', 'app', 'resources', 'plugins');
        const start = makeDirectory('resources', 'app', 'dist', 'main', 'chunks');

        expect(findBuiltinPluginsDirectoryFrom(start)).toBe(plugins);
    });

    test('同时存在时优先取构建产物 dist/plugins', () => {
        markAppRoot('resources', 'app');
        const built = makeDirectory('resources', 'app', 'dist', 'plugins');
        makeDirectory('resources', 'app', 'resources', 'plugins');
        const start = makeDirectory('resources', 'app', 'dist', 'main', 'chunks');

        expect(findBuiltinPluginsDirectoryFrom(start)).toBe(built);
    });

    test('两种布局都不存在时返回 undefined', () => {
        markAppRoot();
        const start = makeDirectory('dist', 'main', 'chunks');

        expect(findBuiltinPluginsDirectoryFrom(start)).toBeUndefined();
    });

    test('同名文件不会被误判为插件目录', () => {
        markAppRoot();
        makeDirectory('dist');
        fs.writeFileSync(path.join(root, 'dist', 'plugins'), 'not a directory');
        const start = makeDirectory('dist', 'main', 'chunks');

        expect(findBuiltinPluginsDirectoryFrom(start)).toBeUndefined();
    });

    test('缺少 package.json 的层级不被视为应用根', () => {
        const plugins = makeDirectory('dist', 'plugins');
        const start = makeDirectory('dist', 'main', 'chunks');

        expect(plugins).toBeTruthy();
        expect(findBuiltinPluginsDirectoryFrom(start)).toBeUndefined();
    });
});
