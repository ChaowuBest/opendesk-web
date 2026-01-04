const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');


module.exports = {
  packagerConfig: {
    asar: true,
    platforms: ['win32', 'darwin'],
    arch: ['x64', 'arm64'],
    icon: path.join(
      __dirname, 'src', 'assets', 'images',
      process.platform === 'darwin' ? 'icon_round.icns' : 'icon_round.ico'
    ),
    "asar": {
      "unpack": "**/node_modules/{sharp,@img}/**/*"
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-wix',
      platforms: ['win32'],
      config: {
        name: "FillipDesk",
        setupExe: 'FillipDesk-${version}-Setup.exe',
        manufacturer: 'OS Kernel Lab, Huawei.',
        description: 'An All-in-One AI Office Suite for Productivity Scenarios',
        shortcutFolderName: 'FillipDesk',
        language: 1033,
        upgradeCode: '017f8634-a16c-4194-8c94-d9a3f1319d13',
        icon: path.join(__dirname, 'src', 'assets', 'images', 'icon_round.ico'),
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: "FillipDesk",
        productName: "Fillip Desk"
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
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
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ]
};
