/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DARWIN_PRUNED_NATIVE_PATHS = [
    'native/openharmony',
    'node_modules/classic-level/prebuilds/android-arm',
    'node_modules/classic-level/prebuilds/android-arm64',
    'node_modules/classic-level/prebuilds/linux-arm',
    'node_modules/classic-level/prebuilds/linux-arm64',
    'node_modules/classic-level/prebuilds/linux-x64',
    'node_modules/classic-level/prebuilds/win32-ia32',
    'node_modules/classic-level/prebuilds/win32-x64',
    'node_modules/koffi/build/koffi/freebsd_arm64',
    'node_modules/koffi/build/koffi/freebsd_ia32',
    'node_modules/koffi/build/koffi/freebsd_x64',
    'node_modules/koffi/build/koffi/linux_arm64',
    'node_modules/koffi/build/koffi/linux_armhf',
    'node_modules/koffi/build/koffi/linux_ia32',
    'node_modules/koffi/build/koffi/linux_loong64',
    'node_modules/koffi/build/koffi/linux_riscv64d',
    'node_modules/koffi/build/koffi/linux_x64',
    'node_modules/koffi/build/koffi/musl_arm64',
    'node_modules/koffi/build/koffi/musl_x64',
    'node_modules/koffi/build/koffi/openbsd_ia32',
    'node_modules/koffi/build/koffi/openbsd_x64',
    'node_modules/koffi/build/koffi/win32_arm64',
    'node_modules/koffi/build/koffi/win32_ia32',
    'node_modules/koffi/build/koffi/win32_x64'
];

function removePathIfExists(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function pruneDarwinNativePrebuilds(rootPath) {
    for (const relativePath of DARWIN_PRUNED_NATIVE_PATHS) {
        removePathIfExists(path.join(rootPath, relativePath));
    }
}

function pruneDarwinAppNativePrebuilds(buildPath, electronVersion, platform, arch, callback) {
    try {
        if (platform === 'darwin') {
            pruneDarwinNativePrebuilds(buildPath);
        }
        callback();
    } catch (error) {
        callback(error);
    }
}

function pruneDarwinExtraResources(buildPath, electronVersion, platform, arch, callback) {
    try {
        if (platform === 'darwin') {
            removePathIfExists(path.join(buildPath, 'Contents', 'Resources', 'native', 'openharmony'));
        }
        callback();
    } catch (error) {
        callback(error);
    }
}

/**
 * 纵深防御：把 workspace 包链接物化为真实目录。
 *
 * Windows 下 npm 会把 `file:packages/*` 依赖在 node_modules 下建成 junction
 * （绝对路径目标）。packagerConfig.derefSymlinks 已让复制阶段直接解引用链接，
 * 产物里对应位置是真实目录；但保留该 hook 兜底 —— 若未来 derefSymlinks 被移除
 * 或个别环境仍以链接形态进入 staged 目录，asar 打包时 junction 会被记录为指向
 * 构建机绝对路径的损坏链接，导致打包版插件加载失败：
 * `ENOENT, node_modules\@bitclub.ai\D:\... not found in app.asar`。
 * 该 hook 在 prune 之后、打包 asar 之前执行（幂等），把这些链接替换为仓库内的
 * 真实目录（排除子包自带的 node_modules / .git）。
 */
const WORKSPACE_PACKAGE_DIRECTORIES = {
    'opendesk-app-sdk': 'app-sdk',
    'opendesk-plugin-sdk': 'plugin-sdk'
};

function materializeWorkspacePackageLinks(buildPath, electronVersion, platform, arch, callback) {
    // electron-packager 通过 util.promisify 逐个调用 afterPrune hooks，同步函数若
    // 不调用 callback，promisify 生成的 promise 永不 resolve，打包会永久挂在
    // afterPrune 阶段（asar 打包、move 到 out 都不再执行）。因此这里以 callback
    // 风格收尾。workspaceRoot 固定为仓库根，避免被 promisify 传入的 electronVersion
    // 当作第二个参数覆盖。
    const workspaceRoot = __dirname;
    try {
        const scopedDirectory = path.join(buildPath, 'node_modules', '@bitclub.ai');
        if (fs.existsSync(scopedDirectory)) {
            for (const packageName of Object.keys(WORKSPACE_PACKAGE_DIRECTORIES)) {
                const linkPath = path.join(scopedDirectory, packageName);
                let isLink = false;
                try {
                    isLink = fs.lstatSync(linkPath).isSymbolicLink();
                } catch {
                    continue; // 不存在，跳过
                }
                if (!isLink) continue; // 已是真实目录（如 CI 以 --install-links 安装），无需处理

                const workspaceDirectory = path.join(
                    workspaceRoot,
                    'packages',
                    WORKSPACE_PACKAGE_DIRECTORIES[packageName]
                );
                fs.rmSync(linkPath, { recursive: true, force: true });
                if (!fs.existsSync(workspaceDirectory)) continue; // 异常场景：仓库内无对应 workspace
                fs.cpSync(workspaceDirectory, linkPath, {
                    recursive: true,
                    filter(source) {
                        const relative = path.relative(workspaceDirectory, source);
                        if (!relative) return true;
                        const first = relative.split(path.sep)[0];
                        return first !== 'node_modules' && first !== '.git';
                    }
                });
            }
        }
        if (typeof callback === 'function') {
            callback();
        }
    } catch (error) {
        if (typeof callback === 'function') {
            callback(error);
        }
    }
}

const extraResources = [
    path.join(__dirname, 'dist', 'plugins'),
    ...(process.platform === 'darwin' ? [] : [path.join(__dirname, 'native')])
];

// Default: produce an unsigned .app so the same packaging step works on any
// developer machine, then sign via scripts/remote-sign/ on a host that holds
// the Developer ID private key. Set OPENDESK_SIGN_LOCAL=1 to sign and notarize
// in-place during electron-forge package (requires the cert + keychain profile
// configured locally).
const SIGN_LOCALLY = process.env.OPENDESK_SIGN_LOCAL === '1';
const wixInstallerAssets = path.join(__dirname, 'resources', 'package', 'installer');
const wixInstallPathRegistryKey = 'SOFTWARE\\OpenDesk\\Installer';
const wixLegacyInstallPathRegistryKey =
    'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{834BCECA-F10C-41E6-9ECF-CB3877565C04}.msq';
const wixPublicUninstallComponentIds = new Set([
    'UninstallDisplayName',
    'UninstallPublisher',
    'UninstallDisplayVersion',
    'UninstallModifyString',
    'UninstallString',
    'UninstallDisplayIcon'
]);

/**
 * 从 @electron/get 的本地缓存目录复用 Electron zip，避免每次打包都重新走网络下载。
 *
 * @electron/get 会把下载的 zip 缓存在 `%LOCALAPPDATA%\electron\Cache\<hash>\electron-v<ver>-<platform>-<arch>.zip`。
 * electron-packager 只有在显式设置 `electronZipDir` 时才会用本地 zip，否则每次 package 都会调用
 * downloadArtifact（缓存命中也要重新校验、网络波动即失败）。这里在未显式指定 OPENDESK_ELECTRON_ZIP_DIR
 * 时自动找缓存 zip；找不到则返回 undefined，回落到 @electron/get 的默认下载（下载一次后即可复用）。
 */
function resolveCachedElectronZipDir() {
    const electronPkgPath = path.join(__dirname, 'node_modules', 'electron', 'package.json');
    if (!fs.existsSync(electronPkgPath)) return undefined;
    const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8')).version;
    const cacheRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const cacheDir = path.join(cacheRoot, 'electron', 'Cache');
    if (!fs.existsSync(cacheDir)) return undefined;
    const zipName = `electron-v${electronVersion}-${process.platform}-x64.zip`;
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(cacheDir, entry.name, zipName))) {
            return path.join(cacheDir, entry.name);
        }
    }
    return undefined;
}

const electronZipDir = process.env.OPENDESK_ELECTRON_ZIP_DIR || resolveCachedElectronZipDir();
const forgeOutDir = process.env.OPENDESK_FORGE_OUT_DIR;

function preserveWixInstallDirectory(creator) {
    const installPathProperty = / {4}<Property Id="INSTALLPATH">[\s\S]*? {4}<\/Property>/;
    const startMenuShortcutComponent =
        /<Component Id="ApplicationShortcut" Guid="\{\{ApplicationShortcutGuid\}\}" Win64="\{\{Win64YesNo\}\}">/;
    const desktopShortcutComponent = /<Component Id="DesktopShortcut" Guid="\{\{DesktopShortcutGuid\}\}"\s*>/;
    const recursiveRootCleanup =
        / {4}<DirectoryRef Id="APPLICATIONROOTDIRECTORY">\s*<Component Id="PurgeOnUninstall"[\s\S]*?<\/DirectoryRef>/;
    const recursiveRootCleanupRef = / {8}<ComponentRef Id="PurgeOnUninstall" \/>/;
    const majorUpgradeTemplate =
        / {4}<MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A later version of this product is already installed\. Setup will now exit\."\s*\/>/;
    const installPerUserProperty =
        / {4}<Property Id="MSIINSTALLPERUSER" Secure="yes" Value="\{\{InstallPerUser\}\}" \/>/;
    const mediaTemplate = / {4}<Media Id="1" Cabinet="product\.cab" EmbedCab="yes"\s*\/>/;

    if (
        !installPathProperty.test(creator.wixTemplate) ||
        !startMenuShortcutComponent.test(creator.wixTemplate) ||
        !desktopShortcutComponent.test(creator.wixTemplate) ||
        !recursiveRootCleanup.test(creator.wixTemplate) ||
        !recursiveRootCleanupRef.test(creator.wixTemplate) ||
        !majorUpgradeTemplate.test(creator.wixTemplate) ||
        !installPerUserProperty.test(creator.wixTemplate) ||
        !mediaTemplate.test(creator.wixTemplate) ||
        typeof creator.getRegistryKeys !== 'function' ||
        typeof creator.getRegistryComponent !== 'function'
    ) {
        throw new Error('electron-wix-msi template no longer exposes the expected install path entries');
    }

    creator.wixTemplate = creator.wixTemplate.replace(
        installPathProperty,
        `    <Condition Message="!(loc.AdminRequiredMessage)">Installed OR Privileged</Condition>
    <Property Id="APPLICATIONROOTDIRECTORY" Secure="yes" />
    <Property Id="CREATE_DESKTOP_SHORTCUT" Secure="yes" Value="1" />
    <Property Id="CREATE_START_MENU_SHORTCUT" Secure="yes" Value="1" />
    <Property Id="INSTALL_PATH_CUSTOMIZED" Secure="yes" Value="1" />
    <Property Id="OPENDESK_BUNDLE_INSTALL" Secure="yes">
      <RegistrySearch Key="${wixInstallPathRegistryKey}"
                      Root="HKLM"
                      Type="raw"
                      Id="BUNDLE_INSTALL_REGSEARCH_HKLM"
                      Name="BundleInstall"
                      Win64="{{Win64YesNo}}"/>
    </Property>
    <Property Id="INSTALLPATH">
      <RegistrySearch Key="${wixInstallPathRegistryKey}"
                      Root="HKCU"
                      Type="raw"
                      Id="INSTALLPATH_REGSEARCH_HKCU"
                      Name="InstallPath"
                      Win64="{{Win64YesNo}}"/>
      <RegistrySearch Key="${wixInstallPathRegistryKey}"
                      Root="HKLM"
                      Type="raw"
                      Id="INSTALLPATH_REGSEARCH_HKLM"
                      Name="InstallPath"
                      Win64="{{Win64YesNo}}"/>
      <RegistrySearch Key="${wixLegacyInstallPathRegistryKey}"
                      Root="HKCU"
                      Type="raw"
                      Id="INSTALLPATH_LEGACY_033_REGSEARCH_HKCU"
                      Name="InstallPath"
                      Win64="no"/>
      <RegistrySearch Key="${wixLegacyInstallPathRegistryKey}"
                      Root="HKLM"
                      Type="raw"
                      Id="INSTALLPATH_LEGACY_033_REGSEARCH_HKLM"
                      Name="InstallPath"
                      Win64="no"/>
    </Property>
    <SetProperty Action="RestoreInstallDirectory"
                 Id="APPLICATIONROOTDIRECTORY"
                 Sequence="first"
                 Before="CostFinalize"
                 Value="[INSTALLPATH]">
      <![CDATA[INSTALLPATH AND NOT APPLICATIONROOTDIRECTORY]]>
    </SetProperty>`
    );
    creator.wixTemplate = creator.wixTemplate
        .replace(
            startMenuShortcutComponent,
            '<Component Id="ApplicationShortcut" Guid="{{ApplicationShortcutGuid}}" Win64="{{Win64YesNo}}" Transitive="yes">\n        <Condition>CREATE_START_MENU_SHORTCUT = "1"</Condition>'
        )
        .replace(
            desktopShortcutComponent,
            '<Component Id="DesktopShortcut" Guid="{{DesktopShortcutGuid}}" Transitive="yes">\n          <Condition>CREATE_DESKTOP_SHORTCUT = "1"</Condition>'
        )
        .replace(
            recursiveRootCleanup,
            '    <!-- Recursive cleanup of the selected install root is intentionally disabled. -->'
        )
        .replace(
            recursiveRootCleanupRef,
            '        <!-- Untracked files in the selected install root are preserved. -->'
        )
        .replace(
            majorUpgradeTemplate,
            // AllowDowngrades 的检测范围是"不低于当前版本"的全部产品（含同版本不同
            // ProductCode，日志可见同版本 MSI 以 operation=MajorUpgrade 被检测替换），
            // 因此无需也不能再加 AllowSameVersionUpgrades（WiX CNDL0035 互斥校验），
            // 任意版本的旧 MSI 都会被 RemoveExistingProducts 替换，MSI 层只保留一份。
            '    <MajorUpgrade AllowDowngrades="yes" />'
        )
        .replace(installPerUserProperty, '    <Property Id="MSIINSTALLPERUSER" Secure="yes" Value="0" />')
        .replace(mediaTemplate, '    <Media Id="1" Cabinet="product.cab" EmbedCab="yes" CompressionLevel="low"/>');

    const getRegistryKeys = creator.getRegistryKeys.bind(creator);
    creator.getRegistryKeys = () => {
        const registryKeys = getRegistryKeys().map((entry) =>
            entry.id === 'RegistryInstallPath' ? { ...entry, key: wixInstallPathRegistryKey } : entry
        );
        const installPathIndex = registryKeys.findIndex((entry) => entry.id === 'RegistryInstallPath');
        registryKeys.splice(
            installPathIndex + 1,
            0,
            {
                id: 'RegistryInstallLayoutVersion',
                root: 'HKLM',
                key: wixInstallPathRegistryKey,
                name: 'LayoutVersion',
                type: 'integer',
                value: '2',
                forceDeleteOnUninstall: 'yes'
            },
            {
                id: 'RegistryBundleInstallMode',
                root: 'HKLM',
                key: wixInstallPathRegistryKey,
                name: 'BundleInstall',
                // 必须写 REG_SZ（字符串）。若写 REG_DWORD，MSI 的 RegistrySearch(raw) 读到的属性值是
                // "#1"（带整数前缀），在修复（Repair）场景下条件 `<> "1"` 会被判定为 true，导致
                // UninstallDisplayName 等 .msq 人工 ARP 组件被重新安装，控制面板出现多余的 MSI 条目。
                type: 'string',
                value: '1',
                forceDeleteOnUninstall: 'yes'
            },
            {
                id: 'RegistryInstallPathCustomized',
                root: 'HKLM',
                key: wixInstallPathRegistryKey,
                name: 'InstallPathCustomized',
                type: 'integer',
                value: '[INSTALL_PATH_CUSTOMIZED]',
                forceDeleteOnUninstall: 'yes'
            },
            {
                id: 'RegistryDesktopShortcutPreference',
                root: 'HKLM',
                key: wixInstallPathRegistryKey,
                name: 'CreateDesktopShortcut',
                type: 'integer',
                value: '[CREATE_DESKTOP_SHORTCUT]',
                forceDeleteOnUninstall: 'yes'
            },
            {
                id: 'RegistryStartMenuShortcutPreference',
                root: 'HKLM',
                key: wixInstallPathRegistryKey,
                name: 'CreateStartMenuShortcut',
                type: 'integer',
                value: '[CREATE_START_MENU_SHORTCUT]',
                forceDeleteOnUninstall: 'yes'
            }
        );
        return registryKeys;
    };

    const getRegistryComponent = creator.getRegistryComponent.bind(creator);
    creator.getRegistryComponent = (registry, indent) => {
        const component = getRegistryComponent(registry, indent);
        // 条件必须同时认可 "1" 与 "#1"：机器上残留旧版本写入的 REG_DWORD BundleInstall 时，
        // MSI 的 AppSearch 会用 RegistrySearch(raw) 读到的 "#1" 覆盖 burn 命令行传入的 "1"，
        // 条件若只认 "1"，bundle 升级安装中就会把 UninstallDisplayName 等 .msq ARP 展示组件
        // 装出来，控制面板出现第二个 OpenDesk 条目（仅版本号、无体积）。
        const condition = wixPublicUninstallComponentIds.has(registry.id)
            ? 'OPENDESK_BUNDLE_INSTALL &lt;&gt; "1" AND OPENDESK_BUNDLE_INSTALL &lt;&gt; "#1"'
            : registry.id === 'RegistryBundleInstallMode'
              ? 'OPENDESK_BUNDLE_INSTALL = "1" OR OPENDESK_BUNDLE_INSTALL = "#1"'
              : null;
        if (!condition) {
            return component;
        }

        // 注意：不能给这些组件加 Transitive="yes"。MSI 在修复（Repair / REINSTALL）时会重新评估
        // Transitive 组件的 Condition，而修复时 OPENDESK_BUNDLE_INSTALL 可能取到非法整数值
        // （RegistrySearch 读到旧 REG_DWORD 时的 "#1"），导致 `<> "1"` 被判定为 true，使
        // UninstallDisplayName 等 .msq ARP 组件被补装，控制面板里出现多余条目。不加 Transitive
        // 后组件状态在安装时固化，修复/维护不再重新评估。
        component.xml = component.xml.replace(
            /(\r?\n)(\s*)<RegistryKey/,
            `$1$2<Condition>${condition}</Condition>$1$2<RegistryKey`
        );
        return component;
    };
}

module.exports = {
    ...(forgeOutDir ? { outDir: path.resolve(forgeOutDir) } : {}),
    materializeWorkspacePackageLinks,
    packagerConfig: {
        platforms: ['win32', 'darwin'],
        arch: ['x64', 'arm64'],
        appBundleId: 'com.intellios.opendesk',
        ...(SIGN_LOCALLY && {
            osxSign: {
                identity: 'Developer ID Application: Yutao Liu (Q294TCVCTA)',
                hardenedRuntime: true,
                gatekeeperAssess: false,
                continueOnError: false
            },
            osxNotarize: {
                keychainProfile: 'opendesk-notary'
            }
        }),
        icon: path.join(
            __dirname,
            'resources',
            'package',
            'icons',
            process.platform === 'darwin' ? 'icon_round.icns' : 'icon_round.ico'
        ),
        // Windows 上 npm 把 file:packages/* 依赖建成 junction（绝对路径目标）。
        // electron-packager 默认不 dereference 符号链接：复制时在目标创建 symlink
        // 需要管理员/开发者模式（否则 EPERM），且 @electron/asar 会把 junction 的
        // 绝对目标写成损坏链接，导致打包版插件加载 SDK 报 ENOENT。开启 derefSymlinks
        // 让 workspace 依赖以真实目录进入产物，路径与安装位置无关。
        derefSymlinks: true,
        extendInfo: {
            NSMicrophoneUsageDescription: 'OpenDesk uses the microphone to convert your speech into text.',
            NSSpeechRecognitionUsageDescription:
                'OpenDesk uses macOS speech recognition to convert your speech into text.'
        },
        asar: {
            unpack: '**/node_modules/{sharp,@img,sqlite-vec-*}/**/*'
        },
        // 排除打包时不需带入的目录/文件。asar 里若混入开发期垃圾（vite 缓存、
        // 文档、日志等），会膨胀体积并显著拖慢 WiX light 的压缩耗时。
        ignore: [
            /^[/\\]out(?:[/\\]|-)/,
            /^[/\\]dist[/\\]plugins(?:[/\\]|$)/,
            /^[/\\]resources[/\\]plugins(?:[/\\]|$)/,
            /^[/\\](docs|benchmarks|scripts|temp)(?:[/\\]|$)/,
            /^[/\\]\.(opendesk|husky|git|github)(?:[/\\]|$)/,
            /^[/\\](AGENTS\.md|NOTICE|README.*|\.gitignore|\.prettier.*|\.nvmrc|postcss\.config\.js|eslint\.config\.mjs|jest\.config\.ts|electron\.vite\.config\.ts|esbuild\.config\.ts|tsconfig.*|package-lock\.json)$/,
            /^[/\\]node_modules[/\\]\.(vite|cache|bin)(?:[/\\]|$)/
        ],
        ...(electronZipDir ? { electronZipDir: path.resolve(electronZipDir) } : {}),
        extraResource: extraResources,
        afterPrune: [pruneDarwinAppNativePrebuilds, materializeWorkspacePackageLinks],
        afterCopyExtraResources: [pruneDarwinExtraResources]
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-wix',
            platforms: ['win32'],
            config: {
                name: 'OpenDesk',
                setupExe: 'OpenDesk-${version}-Setup.exe',
                manufacturer: 'OpenDesk Team, Openharmony',
                description: 'An All-in-One AI Office Suite for Productivity Scenarios',
                shortcutFolderName: 'OpenDesk',
                programFilesFolderName: 'opendesk',
                language: 2052,
                cultures: 'zh-cn',
                arch: 'x64',
                upgradeCode: '017f8634-a16c-4194-8c94-d9a3f1319d13',
                beforeCreate: preserveWixInstallDirectory,
                icon: path.join(__dirname, 'resources', 'package', 'icons', 'icon_round.ico'),
                ui: {
                    chooseDirectory: true,
                    template: fs.readFileSync(path.join(wixInstallerAssets, 'ui.xml'), 'utf8'),
                    localizations: [path.join(wixInstallerAssets, 'zh-cn.wxl')],
                    images: {
                        background: path.join(wixInstallerAssets, 'dialog.jpg'),
                        banner: path.join(wixInstallerAssets, 'banner.jpg')
                    }
                }
            }
        },
        {
            name: '@electron-forge/maker-dmg',
            platforms: ['darwin'],
            config: {
                name: 'OpenDesk',
                productName: 'OpenDesk'
            }
        },
        {
            name: '@electron-forge/maker-deb',
            config: {}
        },
        {
            name: '@electron-forge/maker-rpm',
            config: {}
        }
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {}
        },
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: true,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true
        })
    ]
};
