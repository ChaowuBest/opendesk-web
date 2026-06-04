const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

module.exports = {
    packagerConfig: {
        platforms: ['win32', 'darwin'],
        arch: ['x64', 'arm64'],
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
        extraResource: [path.join(__dirname, 'native')]
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
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true
        })
    ]
};
