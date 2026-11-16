import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { materializeBuiltinPluginZip } from '../../../../scripts/lib/builtin-plugin-zip.js';
import { parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';

// 内置插件的静态元数据（displayName、description、version 等）只允许声明在
// opendesk.plugin.json；入口文件只保留 id 与 setup 等运行时字段。入口导出会
// 静默覆盖 manifest 中的同名字段，两处同时声明会各自演化产生漂移，这里从
// 源头禁止重复声明。
const BUILTIN_PLUGINS_DIRECTORY = path.resolve(process.cwd(), 'resources/plugins');

/** 只能由 manifest 声明的元数据字段；入口若重复声明会覆盖 manifest，造成两处漂移 */
const MANIFEST_METADATA_KEYS = [
    'displayName',
    'description',
    'version',
    'apiVersion',
    'capabilities',
    'platforms',
    'minOpenDeskVersion',
    'maxOpenDeskVersion'
];

const metadataKeyPattern = new RegExp(`\\b(?:${MANIFEST_METADATA_KEYS.join('|')})\\s*:`);

function listBuiltinPluginDirectories(): string[] {
    return fs
        .readdirSync(BUILTIN_PLUGINS_DIRECTORY, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(BUILTIN_PLUGINS_DIRECTORY, entry.name))
        .sort();
}

describe('内置插件元数据声明', () => {
    const pluginDirectories = listBuiltinPluginDirectories();
    const artifactDirectories = pluginDirectories.filter((directory) =>
        fs.existsSync(path.join(directory, 'artifact-manifest.json'))
    );
    const sourceDirectories = pluginDirectories.filter((directory) => !artifactDirectories.includes(directory));

    test('内置插件目录存在且非空', () => {
        expect(pluginDirectories.length).toBeGreaterThan(0);
    });

    // ZIP 是已发布产物；验证哈希及导出值一致性，不对其入口套用源码正则规则。
    // 内置插件里暂时没有 ZIP 形态的产物时跳过这一组（test.each 不接受空表）。
    if (artifactDirectories.length > 0) {
        test.each(artifactDirectories.map((directory) => [path.basename(directory), directory] as const))(
            '%s 的 ZIP manifest 与入口元数据保持一致',
            async (id, directory) => {
                const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-plugin-metadata-'));
                try {
                    const artifact = materializeBuiltinPluginZip(directory, temporary);
                    const manifest = parsePluginManifest(
                        JSON.parse(fs.readFileSync(path.join(temporary, 'opendesk.plugin.json'), 'utf-8'))
                    );
                    expect(manifest.id).toBe(id);
                    expect(manifest.id).toBe(artifact.pluginId);
                    expect(manifest.version).toBe(artifact.pluginVersion);
                    expect(manifest.entry).toBeTruthy();
                    const entryFile = path.resolve(temporary, manifest.entry as string);
                    expect(fs.existsSync(entryFile)).toBe(true);
                    const entry = (await import(pathToFileURL(entryFile).href)).default;
                    expect(entry.id).toBe(manifest.id);
                    for (const key of MANIFEST_METADATA_KEYS) {
                        if (Object.hasOwn(entry, key)) expect(entry[key]).toEqual(manifest[key]);
                    }
                } finally {
                    fs.rmSync(temporary, { recursive: true, force: true });
                }
            }
        );
    }

    test.each(sourceDirectories.map((directory) => [path.basename(directory), directory] as const))(
        '%s 的元数据只声明在 manifest，入口不重复声明',
        (_name, directory) => {
            const manifestFile = path.join(directory, 'opendesk.plugin.json');
            expect(fs.existsSync(manifestFile)).toBe(true);
            const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf-8')));

            // 目录名与插件 id 一致，构建产物目录同样以 id 命名
            expect(manifest.id).toBe(path.basename(directory));

            if (!manifest.entry) {
                // 纯静态插件（语言包等只声明 resources.* 的贡献）：无入口文件，
                // 元数据天然只存在于 manifest；根目录不得偷放可运行的 index 入口
                for (const filename of ['index.js', 'index.mjs', 'index.cjs']) {
                    expect(fs.existsSync(path.join(directory, filename))).toBe(false);
                }
                return;
            }

            expect(manifest.entry).toBeTruthy();
            const entryFile = path.resolve(directory, manifest.entry as string);
            expect(fs.existsSync(entryFile)).toBe(true);

            const entrySource = fs.readFileSync(entryFile, 'utf-8');
            const duplicated = entrySource.match(metadataKeyPattern);
            expect(duplicated?.[0]).toBeUndefined();
        }
    );
});
