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

function materializeWorkspacePackageLinks(buildPath, workspaceRoot = __dirname) {
    const scopedDirectory = path.join(buildPath, 'node_modules', '@bitclub.ai');
    if (!fs.existsSync(scopedDirectory)) return;
    for (const packageName of Object.keys(WORKSPACE_PACKAGE_DIRECTORIES)) {
        const linkPath = path.join(scopedDirectory, packageName);
        let isLink = false;
        try {
            isLink = fs.lstatSync(linkPath).isSymbolicLink();
        } catch {
            continue; // 不存在，跳过
        }
        if (!isLink) continue; // 已是真实目录（如 CI 以 --install-links 安装），无需处理

        const workspaceDirectory = path.join(workspaceRoot, 'packages', WORKSPACE_PACKAGE_DIRECTORIES[packageName]);
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
const electronZipDir = process.env.OPENDESK_ELECTRON_ZIP_DIR;
const forgeOutDir = process.env.OPENDESK_FORGE_OUT_DIR;

function preserveWixInstallDirectory(creator) {
    const installPathProperty = / {4}<Property Id="INSTALLPATH">[\s\S]*? {4}<\/Property>/;
    const startMenuShortcutComponent =
        /<Component Id="ApplicationShortcut" Guid="\{\{ApplicationShortcutGuid\}\}" Win64="\{\{Win64YesNo\}\}">/;
    const desktopShortcutComponent = /<Component Id="DesktopShortcut" Guid="\{\{DesktopShortcutGuid\}\}"\s*>/;
    const recursiveRootCleanup =
        / {4}<DirectoryRef Id="APPLICATIONROOTDIRECTORY">\s*<Component Id="PurgeOnUninstall"[\s\S]*?<\/DirectoryRef>/;
    const recursiveRootCleanupRef = / {8}<ComponentRef Id="PurgeOnUninstall" \/>/;

    if (
        !installPathProperty.test(creator.wixTemplate) ||
        !startMenuShortcutComponent.test(creator.wixTemplate) ||
        !desktopShortcutComponent.test(creator.wixTemplate) ||
        !recursiveRootCleanup.test(creator.wixTemplate) ||
        !recursiveRootCleanupRef.test(creator.wixTemplate) ||
        typeof creator.getRegistryKeys !== 'function' ||
        typeof creator.getRegistryComponent !== 'function'
    ) {
        throw new Error('electron-wix-msi template no longer exposes the expected install path entries');
    }

    creator.wixTemplate = creator.wixTemplate.replace(
        installPathProperty,
        `    <Property Id="APPLICATIONROOTDIRECTORY" Secure="yes" />
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
        );

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
                type: 'integer',
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
        const condition = wixPublicUninstallComponentIds.has(registry.id)
            ? 'OPENDESK_BUNDLE_INSTALL &lt;&gt; "1"'
            : registry.id === 'RegistryBundleInstallMode'
              ? 'OPENDESK_BUNDLE_INSTALL = "1"'
              : null;
        if (!condition) {
            return component;
        }

        component.xml = component.xml
            .replace(new RegExp(`(<Component Id="${registry.id}"[^>]*)(>)`), '$1 Transitive="yes"$2')
            .replace(/(\r?\n)(\s*)<RegistryKey/, `$1$2<Condition>${condition}</Condition>$1$2<RegistryKey`);
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
            unpack: '**/node_modules/{sharp,@img}/**/*'
        },
        ignore: [/^[/\\]out(?:[/\\]|-)/, /^[/\\]dist[/\\]plugins(?:[/\\]|$)/, /^[/\\]resources[/\\]plugins(?:[/\\]|$)/],
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
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true
        })
    ]
};
