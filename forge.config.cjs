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

module.exports = {
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
                language: 1033,
                upgradeCode: '017f8634-a16c-4194-8c94-d9a3f1319d13',
                icon: path.join(__dirname, 'resources', 'package', 'icons', 'icon_round.ico'),
                // electron-wix-msi defaults ui to false (no wizard). Enable WixUI with directory picker,
                // progress dialog, and finish screen (ExitDialog).
                ui: {
                    chooseDirectory: true
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
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
            [FuseV1Options.OnlyLoadAppFromAsar]: true
        })
    ]
};
