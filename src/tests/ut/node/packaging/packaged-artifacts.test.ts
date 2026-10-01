import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

const helper: any = require('../../../../../scripts/packaging/prune-packaged-artifacts.cjs');

const forgeConfig: any = require('../../../../../forge.config.cjs');
const { populateIgnoredPaths, userPathFilter } = require('@electron/packager/dist/copy-filter.js');
const asar = require('@electron/asar');

function writeFile(filePath: string, content = 'x'): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function exists(filePath: string): boolean {
    return fs.existsSync(filePath);
}

test('PACKAGING_IGNORE_PATTERNS 命中 CLI 产物 / 源码 / workspace 嵌套依赖，且不误伤运行时目录', () => {
    const [cliPattern, srcPattern, sandboxPattern, packagesPattern] = helper.PACKAGING_IGNORE_PATTERNS;

    assert.match('/dist/cli/opendesk-debug', cliPattern);
    assert.match('\\dist\\cli-release\\bundle.js', cliPattern);
    assert.match('/dist/cli', cliPattern);
    assert.doesNotMatch('/dist/main/main.js', cliPattern);
    assert.doesNotMatch('/dist/renderer/index.html', cliPattern);
    assert.doesNotMatch('/dist/cli2/keep.js', cliPattern);

    assert.match('/src/main/main.ts', srcPattern);
    assert.match('/src', srcPattern);
    assert.doesNotMatch('/srcdist/keep.js', srcPattern);

    assert.match('/native/windows/sandbox/src/Dynobox/bin/Release/runtime.dll', sandboxPattern);
    assert.match('\\native\\windows\\sandbox\\dist\\win-arm64\\bin\\sandbox.exe', sandboxPattern);
    assert.match('/native/windows/sandbox', sandboxPattern);
    assert.doesNotMatch('/native/windows/sandbox-other/keep.exe', sandboxPattern);

    // 第六个模式为 darwin 沙箱构建树：整树不进 asar，发布态 dylib 由
    // stageDarwinSandboxResource 校验 slice 后放入 resources/sandbox
    const darwinSandboxPattern = helper.PACKAGING_IGNORE_PATTERNS[5];
    assert.match('/native/darwin/sandbox/src/boxdylib.c', darwinSandboxPattern);
    assert.match('\\native\\darwin\\sandbox\\runtime\\dynobox-darwin.dylib', darwinSandboxPattern);
    assert.match('/native/darwin/sandbox', darwinSandboxPattern);
    assert.doesNotMatch('/native/darwin/speech-helper/helper', darwinSandboxPattern);

    assert.match('/packages/plugin-sdk/node_modules/typescript/lib.js', packagesPattern);
    assert.match('\\packages\\app-sdk\\node_modules\\x', packagesPattern);
    assert.doesNotMatch('/packages/plugin-sdk/dist/index.js', packagesPattern);
    assert.doesNotMatch('/node_modules/@bitclub.ai/opendesk-plugin-sdk/dist/index.js', packagesPattern);
});

test('forge.config.cjs 的 ignore 列表必须包含全部剪裁模式（防止后续改动遗漏）', () => {
    const ignoreList = forgeConfig.packagerConfig.ignore;
    for (const pattern of helper.PACKAGING_IGNORE_PATTERNS) {
        assert.ok(ignoreList.includes(pattern), `missing ignore pattern: ${pattern}`);
    }
    assert.equal(typeof forgeConfig.preserveWixInstallDirectory, 'function');
});

test('应用复制阶段排除整个 Windows 沙箱构建树，且不误伤其他 native 资源', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-sandbox-copy-'));
    try {
        const source = path.join(root, 'source');
        const destination = path.join(root, 'app');
        const sandboxDirectory = 'native/windows/sandbox';
        const sandboxFiles = [
            'src/Makefile',
            'src/build-native.cjs',
            'dist/win-x64/bin/sandbox.exe',
            'dist/win-arm64/bin/sandbox.exe',
            'dist/win-x64/bin/sandbox_hook.dll',
            'runtime/sandbox.exe',
            'runtime/sandbox_hook.dll',
            'tests/fixture.txt'
        ];
        for (const relative of ['', ...sandboxFiles]) {
            const relativePath = `/${sandboxDirectory}${relative ? `/${relative}` : ''}`;
            for (const candidate of [relativePath, relativePath.replaceAll('/', '\\')]) {
                assert.ok(
                    forgeConfig.packagerConfig.ignore.some((pattern: RegExp) => pattern.test(candidate)),
                    `should exclude ${candidate}`
                );
            }
        }
        for (const relative of sandboxFiles) {
            writeFile(path.join(source, sandboxDirectory, relative));
        }
        const keptFiles = [
            'dist/main/main.js',
            'native/openharmony/sandbox/bin/helper',
            'native/darwin/speech-helper/helper',
            'native/windows/sandbox-other/keep.txt',
            'native/darwin/speech-other/keep.txt'
        ];
        for (const relative of keptFiles) {
            writeFile(path.join(source, relative));
        }
        const options = { ...forgeConfig.packagerConfig, dir: source, out: destination, prune: true };
        populateIgnoredPaths(options);
        // 使用 packager 的实际复制过滤器，避免只检查正则而遗漏复制阶段的路径语义。
        await fs.promises.cp(source, destination, { recursive: true, filter: userPathFilter(options) });
        assert.equal(exists(path.join(destination, sandboxDirectory)), false);
        const archivePath = path.join(root, 'app.asar');
        await asar.createPackage(destination, archivePath);
        const entries = asar.listPackage(archivePath).map((entry: string) => entry.replaceAll('\\', '/'));
        assert.equal(
            entries.some((entry: string) => /^\/native\/windows\/sandbox(?:\/|$)/.test(entry)),
            false
        );
        for (const relative of keptFiles) {
            assert.ok(entries.includes(`/${relative}`), `should keep ${relative}`);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('extraResources 不携带 native/，沙箱由 stage 钩子按平台落位而非复制后裁剪', () => {
    const extraResourceEntries = forgeConfig.packagerConfig.extraResource;
    assert.ok(Array.isArray(extraResourceEntries));
    assert.ok(extraResourceEntries.length > 0);
    // 运行时零引用 resourcesPath/native/**，携带整棵 native/ 源码树只会导致
    // 复制后再裁剪（且曾因非 ASCII 夹具名触发 WiX LGHT0311），不允许回归
    assert.ok(extraResourceEntries.every((entry: string) => path.basename(path.normalize(entry)) !== 'native'));
    // 事后裁剪钩子应保持移除状态；沙箱落位钩子仍按 (platform, arch) 精确触发
    assert.equal(forgeConfig.pruneLinuxSandboxResources, undefined);
    assert.equal(typeof forgeConfig.stageWindowsSandboxResource, 'function');
    assert.equal(typeof forgeConfig.stageLinuxSandboxResource, 'function');
});

test('keepNativePrebuildDirectory 按目标平台架构保留 prebuilds', () => {
    assert.equal(helper.keepNativePrebuildDirectory('win32-x64', 'win32', 'x64'), true);
    assert.equal(helper.keepNativePrebuildDirectory('win32-arm64', 'win32', 'x64'), false);
    assert.equal(helper.keepNativePrebuildDirectory('darwin-arm64', 'darwin', 'arm64'), true);
    // classic-level 在 darwin 使用合并目录名
    assert.equal(helper.keepNativePrebuildDirectory('darwin-x64+arm64', 'darwin', 'arm64'), true);
    assert.equal(helper.keepNativePrebuildDirectory('darwin-x64+arm64', 'win32', 'x64'), false);
    assert.equal(helper.keepNativePrebuildDirectory('linux-x64', 'win32', 'x64'), false);
});

function makeNativeTree(root: string): void {
    writeFile(path.join(root, 'node_modules/classic-level/deps/leveldb/db.c'), 'src');
    writeFile(path.join(root, 'node_modules/classic-level/src/builder.cc'), 'src');
    writeFile(path.join(root, 'node_modules/classic-level/build/binding.sln'), 'sln');
    writeFile(path.join(root, 'node_modules/classic-level/build/classic_level.vcxproj'), 'proj');
    writeFile(path.join(root, 'node_modules/classic-level/build/config.gypi'), 'gypi');
    writeFile(path.join(root, 'node_modules/classic-level/build/Release/classic_level.node'), 'bin');
    writeFile(path.join(root, 'node_modules/classic-level/build/Release/classic_level.pdb'), 'pdb');
    writeFile(path.join(root, 'node_modules/classic-level/build/Release/leveldb.lib'), 'lib');
    writeFile(path.join(root, 'node_modules/classic-level/build/Release/obj/leveldb.obj'), 'obj');
    for (const prebuild of ['win32-x64', 'win32-arm64', 'darwin-x64+arm64', 'linux-x64', 'android-arm']) {
        writeFile(path.join(root, `node_modules/classic-level/prebuilds/${prebuild}/classic_level.node`), 'bin');
    }

    writeFile(path.join(root, 'node_modules/node-pty/build/deps/winpty/src.cc'), 'src');
    writeFile(path.join(root, 'node_modules/node-pty/build/pty.vcxproj'), 'proj');
    writeFile(path.join(root, 'node_modules/node-pty/build/Release/pty.node'), 'bin');
    writeFile(path.join(root, 'node_modules/node-pty/build/Release/conpty.node'), 'bin');
    writeFile(path.join(root, 'node_modules/node-pty/build/Release/winpty.dll'), 'bin');
    writeFile(path.join(root, 'node_modules/node-pty/build/Release/winpty-agent.exe'), 'bin');
    writeFile(path.join(root, 'node_modules/node-pty/build/Release/pty.pdb'), 'pdb');
    writeFile(path.join(root, 'node_modules/node-pty/build/Release/winpty.lib'), 'lib');
    writeFile(path.join(root, 'node_modules/node-pty/build/Release/obj/pty.obj'), 'obj');
    for (const prebuild of ['win32-x64', 'win32-arm64', 'darwin-arm64']) {
        writeFile(path.join(root, `node_modules/node-pty/prebuilds/${prebuild}/pty.node`), 'bin');
    }

    writeFile(path.join(root, 'node_modules/better-sqlite3/deps/sqlite3.c'), 'src');
    writeFile(path.join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'bin');
    writeFile(path.join(root, 'node_modules/better-sqlite3/prebuilds/win32-x64/ignore.node'), 'bin');
}

test('prunePackagedNativeArtifacts(win32, x64) 保留运行时二进制与目标平台 prebuilds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-prune-win-'));
    try {
        makeNativeTree(root);
        const removed = helper.prunePackagedNativeArtifacts(root, 'win32', 'x64');
        assert.ok(removed > 0);

        const keptPaths = [
            'node_modules/classic-level/build/Release/classic_level.node',
            'node_modules/classic-level/prebuilds/win32-x64/classic_level.node',
            'node_modules/node-pty/build/Release/pty.node',
            'node_modules/node-pty/build/Release/conpty.node',
            'node_modules/node-pty/build/Release/winpty.dll',
            'node_modules/node-pty/build/Release/winpty-agent.exe',
            'node_modules/node-pty/prebuilds/win32-x64/pty.node',
            'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
        ];
        const removedPaths = [
            'node_modules/classic-level/deps/leveldb/db.c',
            'node_modules/classic-level/src/builder.cc',
            'node_modules/classic-level/build/binding.sln',
            'node_modules/classic-level/build/classic_level.vcxproj',
            'node_modules/classic-level/build/config.gypi',
            'node_modules/classic-level/build/Release/classic_level.pdb',
            'node_modules/classic-level/build/Release/leveldb.lib',
            'node_modules/classic-level/build/Release/obj/leveldb.obj',
            'node_modules/classic-level/prebuilds/win32-arm64/classic_level.node',
            'node_modules/classic-level/prebuilds/darwin-x64+arm64/classic_level.node',
            'node_modules/classic-level/prebuilds/linux-x64/classic_level.node',
            'node_modules/classic-level/prebuilds/android-arm/classic_level.node',
            'node_modules/node-pty/build/deps/winpty/src.cc',
            'node_modules/node-pty/build/pty.vcxproj',
            'node_modules/node-pty/build/Release/pty.pdb',
            'node_modules/node-pty/build/Release/winpty.lib',
            'node_modules/node-pty/build/Release/obj/pty.obj',
            'node_modules/node-pty/prebuilds/win32-arm64/pty.node',
            'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
            'node_modules/better-sqlite3/deps/sqlite3.c'
        ];
        for (const relative of keptPaths) {
            assert.ok(exists(path.join(root, relative)), `should keep ${relative}`);
        }
        for (const relative of removedPaths) {
            assert.equal(exists(path.join(root, relative)), false, `should remove ${relative}`);
        }
        // better-sqlite3 不做 prebuilds 剪裁（加载器自行解析）
        assert.ok(exists(path.join(root, 'node_modules/better-sqlite3/prebuilds/win32-x64/ignore.node')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('prunePackagedNativeArtifacts(darwin, arm64) 保留 darwin prebuilds 与合并目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-prune-dar-'));
    try {
        makeNativeTree(root);
        helper.prunePackagedNativeArtifacts(root, 'darwin', 'arm64');

        assert.ok(exists(path.join(root, 'node_modules/classic-level/prebuilds/darwin-x64+arm64/classic_level.node')));
        assert.ok(exists(path.join(root, 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node')));
        assert.ok(exists(path.join(root, 'node_modules/classic-level/build/Release/classic_level.node')));
        assert.equal(
            exists(path.join(root, 'node_modules/classic-level/prebuilds/win32-x64/classic_level.node')),
            false
        );
        assert.equal(exists(path.join(root, 'node_modules/node-pty/prebuilds/win32-x64/pty.node')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('prunePackagedShellArtifacts 仅保留白名单 locale 并删除 Chromium 许可证清单', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-prune-shell-'));
    try {
        writeFile(path.join(root, 'locales/en-US.pak'), 'pak');
        writeFile(path.join(root, 'locales/zh-CN.pak'), 'pak');
        writeFile(path.join(root, 'locales/fr.pak'), 'pak');
        writeFile(path.join(root, 'locales/de.pak'), 'pak');
        fs.mkdirSync(path.join(root, 'locales/extra'), { recursive: true });
        writeFile(path.join(root, 'LICENSES.chromium.html'), '<html/>');

        const removed = helper.prunePackagedShellArtifacts(root);
        assert.ok(removed > 0);
        assert.ok(exists(path.join(root, 'locales/en-US.pak')));
        assert.ok(exists(path.join(root, 'locales/zh-CN.pak')));
        assert.equal(exists(path.join(root, 'locales/fr.pak')), false);
        assert.equal(exists(path.join(root, 'locales/de.pak')), false);
        assert.ok(exists(path.join(root, 'locales/extra')));
        assert.equal(exists(path.join(root, 'LICENSES.chromium.html')), false);

        // 目录缺失时幂等不抛错
        assert.doesNotThrow(() => helper.prunePackagedShellArtifacts(path.join(root, 'not-exist')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function makeWixCreator(template: string) {
    return {
        wixTemplate: template,
        getRegistryKeys() {
            return [
                {
                    id: 'RegistryInstallPath',
                    root: 'HKLM',
                    key: 'SOFTWARE\\OpenDesk\\Installer',
                    name: 'InstallPath',
                    type: 'string',
                    value: 'C:\\Program Files\\opendesk'
                }
            ];
        },
        getRegistryComponent(registry: { id: string }, indent: string) {
            return {
                xml: `${indent}<Component>\n${indent}  <RegistryKey Id="${registry.id}" Root="HKLM"/>\n${indent}</Component>`
            };
        }
    };
}

const WIX_TEMPLATE_FIXTURE = [
    '    <Product Id="*" Name="OpenDesk">',
    '    <Property Id="INSTALLPATH">',
    '      <RegistrySearch Key="K" Root="HKLM" Type="raw" Id="A" Name="InstallPath"/>',
    '    </Property>',
    '<Component Id="ApplicationShortcut" Guid="{{ApplicationShortcutGuid}}" Win64="{{Win64YesNo}}">',
    '<Component Id="DesktopShortcut" Guid="{{DesktopShortcutGuid}}">',
    '    <DirectoryRef Id="APPLICATIONROOTDIRECTORY">',
    '        <Component Id="PurgeOnUninstall" Guid="{G}">',
    '            <RemoveFile Id="R" On="uninstall"/>',
    '        </Component>',
    '    </DirectoryRef>',
    '        <ComponentRef Id="PurgeOnUninstall" />',
    '    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A later version of this product is already installed. Setup will now exit." />',
    '    <Property Id="MSIINSTALLPERUSER" Secure="yes" Value="{{InstallPerUser}}" />',
    '    <Media Id="1" Cabinet="product.cab" EmbedCab="yes" />',
    '</Product>'
].join('\n');

test('preserveWixInstallDirectory 注入高压缩等级并保留注册表条件注入行为', () => {
    const creator = makeWixCreator(WIX_TEMPLATE_FIXTURE);
    forgeConfig.preserveWixInstallDirectory(creator);

    assert.ok(creator.wixTemplate.includes('CompressionLevel="high"'));
    assert.equal(creator.wixTemplate.includes('CompressionLevel="low"'), false);

    // ARP 展示组件需要 BUNDLE_INSTALL 条件
    const arpComponent = creator.getRegistryComponent({ id: 'UninstallDisplayName' }, '  ');
    assert.ok(arpComponent.xml.includes('OPENDESK_BUNDLE_INSTALL'));

    const plainComponent = creator.getRegistryComponent({ id: 'SomeOtherRegistry' }, '  ');
    assert.equal(plainComponent.xml.includes('OPENDESK_BUNDLE_INSTALL'), false);
});

test('preserveWixInstallDirectory 在模板锚点缺失时抛错（上游模板漂移守卫）', () => {
    const driftedTemplate = WIX_TEMPLATE_FIXTURE.replace(
        '    <Media Id="1" Cabinet="product.cab" EmbedCab="yes" />',
        ''
    );
    const creator = makeWixCreator(driftedTemplate);
    assert.throws(() => forgeConfig.preserveWixInstallDirectory(creator), /template no longer exposes/);
});

test('locale 白名单只含应用支持的语言', () => {
    assert.deepEqual([...helper.PRUNE_LOCALE_ALLOWLIST].sort(), ['en-US.pak', 'zh-CN.pak']);
});

test('prunePackagedShellArtifactsHook 从暂存应用目录推导 Electron 平铺根目录', async () => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-shell-hook-'));
    try {
        const appDir = path.join(stagingRoot, 'resources', 'app');
        writeFile(path.join(appDir, 'package.json'), '{}');
        writeFile(path.join(stagingRoot, 'locales/en-US.pak'), 'pak');
        writeFile(path.join(stagingRoot, 'locales/zh-CN.pak'), 'pak');
        writeFile(path.join(stagingRoot, 'locales/fr.pak'), 'pak');
        writeFile(path.join(stagingRoot, 'LICENSES.chromium.html'), '<html/>');

        const error = await new Promise<Error | undefined>((resolve) => {
            forgeConfig.prunePackagedShellArtifactsHook(appDir, '0.0.0', 'win32', 'x64', resolve);
        });
        assert.equal(error, undefined);
        assert.ok(exists(path.join(stagingRoot, 'locales/en-US.pak')));
        assert.ok(exists(path.join(stagingRoot, 'locales/zh-CN.pak')));
        assert.equal(exists(path.join(stagingRoot, 'locales/fr.pak')), false);
        assert.equal(exists(path.join(stagingRoot, 'LICENSES.chromium.html')), false);
        assert.ok(exists(path.join(appDir, 'package.json')));
    } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
});

test('prunePackagedShellArtifactsHook 在 darwin 上跳过剪裁', async () => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-shell-hook-dar-'));
    try {
        const appDir = path.join(stagingRoot, 'resources', 'app');
        writeFile(path.join(stagingRoot, 'locales/fr.pak'), 'pak');
        const error = await new Promise<Error | undefined>((resolve) => {
            forgeConfig.prunePackagedShellArtifactsHook(appDir, '0.0.0', 'darwin', 'arm64', resolve);
        });
        assert.equal(error, undefined);
        assert.ok(exists(path.join(stagingRoot, 'locales/fr.pak')));
    } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
});

test('prunePackagedShellArtifactsHook 在暂存布局漂移（无 locales/LICENSES）时告警且不失败', async () => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-shell-hook-drift-'));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
        const appDir = path.join(stagingRoot, 'resources', 'app');
        writeFile(path.join(appDir, 'package.json'), '{}');
        const error = await new Promise<Error | undefined>((resolve) => {
            forgeConfig.prunePackagedShellArtifactsHook(appDir, '0.0.0', 'win32', 'x64', resolve);
        });
        assert.equal(error, undefined);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /暂存布局/);
    } finally {
        console.warn = originalWarn;
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
});
