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

const extraResources = process.platform === 'darwin' ? undefined : [path.join(__dirname, 'native')];

// Default: produce an unsigned .app so the same packaging step works on any
// developer machine, then sign via scripts/remote-sign/ on a host that holds
// the Developer ID private key. Set OPENDESK_SIGN_LOCAL=1 to sign and notarize
// in-place during electron-forge package (requires the cert + keychain profile
// configured locally).
const SIGN_LOCALLY = process.env.OPENDESK_SIGN_LOCAL === '1';
const wixInstallerAssets = path.join(__dirname, 'resources', 'package', 'installer');
const wixInstallPathRegistryKey = 'SOFTWARE\\OpenDesk\\Installer';
const wixLauncherFiles = new Set(['opendesk.exe', '.installinfo.json']);
const electronZipDir = process.env.OPENDESK_ELECTRON_ZIP_DIR;
const forgeOutDir = process.env.OPENDESK_FORGE_OUT_DIR;

function preserveWixInstallDirectory(creator) {
    const installPathProperty = / {4}<Property Id="INSTALLPATH">[\s\S]*? {4}<\/Property>/;
    const startMenuShortcutComponent =
        /<Component Id="ApplicationShortcut" Guid="\{\{ApplicationShortcutGuid\}\}" Win64="\{\{Win64YesNo\}\}">/;
    const desktopShortcutComponent = /<Component Id="DesktopShortcut" Guid="\{\{DesktopShortcutGuid\}\}"\s*>/;

    if (
        !installPathProperty.test(creator.wixTemplate) ||
        !startMenuShortcutComponent.test(creator.wixTemplate) ||
        !desktopShortcutComponent.test(creator.wixTemplate) ||
        typeof creator.getTree !== 'function' ||
        typeof creator.getSpecialFiles !== 'function' ||
        typeof creator.getRegistryKeys !== 'function'
    ) {
        throw new Error('electron-wix-msi template no longer exposes the expected install path entries');
    }

    creator.wixTemplate = creator.wixTemplate.replace(
        installPathProperty,
        `    <Property Id="APPLICATIONROOTDIRECTORY" Secure="yes" />
    <Property Id="CREATE_DESKTOP_SHORTCUT" Secure="yes" Value="1" />
    <Property Id="CREATE_START_MENU_SHORTCUT" Secure="yes" Value="1" />
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
        );

    const getSpecialFiles = creator.getSpecialFiles.bind(creator);
    creator.getSpecialFiles = async () =>
        (await getSpecialFiles()).filter((entry) => !wixLauncherFiles.has(entry.name.toLowerCase()));

    const getTree = creator.getTree.bind(creator);
    creator.getTree = async () => {
        const tree = await getTree();
        const versionDirectory = `app-${creator.semanticVersion}`;
        const applicationTree = tree[versionDirectory];
        if (!applicationTree) {
            throw new Error(`electron-wix-msi did not create the expected ${versionDirectory} directory`);
        }

        tree.__ELECTRON_WIX_MSI_FILES__ = applicationTree.__ELECTRON_WIX_MSI_FILES__;
        for (const [name, child] of Object.entries(applicationTree)) {
            if (!name.startsWith('__ELECTRON_WIX_MSI_')) {
                tree[name] = child;
            }
        }
        delete tree[versionDirectory];
        return tree;
    };

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
}

module.exports = {
    ...(forgeOutDir ? { outDir: path.resolve(forgeOutDir) } : {}),
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
        extendInfo: {
            NSMicrophoneUsageDescription: 'OpenDesk uses the microphone to convert your speech into text.',
            NSSpeechRecognitionUsageDescription:
                'OpenDesk uses macOS speech recognition to convert your speech into text.'
        },
        asar: {
            unpack: '**/node_modules/{sharp,@img}/**/*'
        },
        ...(electronZipDir ? { electronZipDir: path.resolve(electronZipDir) } : {}),
        ...(extraResources ? { extraResource: extraResources } : {}),
        afterPrune: [pruneDarwinAppNativePrebuilds],
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
