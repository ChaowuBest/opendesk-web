import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '../../../../..');
const forgeConfig = require(path.join(projectRoot, 'forge.config.cjs'));
const installerResources = path.join(projectRoot, 'resources', 'package', 'installer');
const bootstrapperResources = path.join(projectRoot, 'resources', 'package', 'bootstrapper');

function getWixConfig() {
    const maker = forgeConfig.makers.find((entry) => entry.name === '@electron-forge/maker-wix');
    assert.ok(maker, 'Windows WiX maker must be configured');
    return maker.config;
}

test('excludes top-level build output directories from packaged application files', () => {
    const ignorePatterns = forgeConfig.packagerConfig.ignore;

    assert.ok(Array.isArray(ignorePatterns));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/out/opendesk-win32-x64/opendesk.exe')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/out-wix-preview/opendesk-win32-x64/opendesk.exe')));
    assert.ok(ignorePatterns.every((pattern) => !pattern.test('/resources/package/installer/ui.xml')));

    // 开发期垃圾不应进 asar，否则会膨胀体积并拖慢 WiX light 的压缩耗时
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/temp/x.log')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/docs/appguide.md')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/benchmarks/run.py')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/scripts/setup-native-modules.cjs')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/.opendesk/memory/memory.json')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/.husky/pre-commit')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/node_modules/.vite/deps/x.js')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/AGENTS.md')));
    assert.ok(ignorePatterns.some((pattern) => pattern.test('/package-lock.json')));
});

test('afterPrune workspace-link hook always invokes its callback so packaging does not hang', () => {
    const hook = forgeConfig.materializeWorkspacePackageLinks;
    assert.equal(typeof hook, 'function');

    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('materializeWorkspacePackageLinks never called its callback (packager would hang)')),
            5000
        );
        // electron-packager invokes afterPrune hooks through util.promisify with
        // (buildPath, electronVersion, platform, arch, callback). The path does not
        // exist here, but the hook must still signal completion.
        hook(path.join(projectRoot, 'temp', '__nonexistent_packaging_dir__'), '39.8.10', 'win32', 'x64', (err) => {
            clearTimeout(timer);
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });
});

test('keeps the MSI upgrade identity while enabling the branded Chinese x64 installer', async () => {
    const config = getWixConfig();

    assert.equal(config.upgradeCode, '017f8634-a16c-4194-8c94-d9a3f1319d13');
    assert.equal(config.language, 2052);
    assert.equal(config.cultures, 'zh-cn');
    assert.equal(config.arch, 'x64');
    assert.equal(config.ui.chooseDirectory, true);

    const background = await sharp(config.ui.images.background).metadata();
    const banner = await sharp(config.ui.images.banner).metadata();

    assert.deepEqual([background.width, background.height], [493, 312]);
    assert.deepEqual([banner.width, banner.height], [493, 58]);
});

test('keeps versioned application directories without recursively purging the selected root', async () => {
    const config = getWixConfig();
    const creator = {
        semanticVersion: '0.3.3',
        exe: 'opendesk',
        wixTemplate: fs.readFileSync(
            path.join(projectRoot, 'node_modules', 'electron-wix-msi', 'static', 'wix.xml'),
            'utf8'
        ),
        getSpecialFiles: async () => [
            { name: 'opendesk.exe', path: 'temporary-launcher.exe' },
            { name: '.installInfo.json', path: 'temporary-install-info.json' }
        ],
        getTree: async () => ({
            __ELECTRON_WIX_MSI_FILES__: [
                { name: 'opendesk.exe', path: 'temporary-launcher.exe' },
                { name: '.installInfo.json', path: 'temporary-install-info.json' }
            ],
            __ELECTRON_WIX_MSI_REGISTRY__: [],
            'app-0.3.3': {
                __ELECTRON_WIX_MSI_FILES__: [{ name: 'opendesk.exe', path: 'packaged-opendesk.exe' }],
                __ELECTRON_WIX_MSI_REGISTRY__: [],
                locales: { __ELECTRON_WIX_MSI_FILES__: [], __ELECTRON_WIX_MSI_REGISTRY__: [] }
            }
        }),
        getRegistryKeys: () => [
            { id: 'RegistryInstallPath', key: 'product-specific-key' },
            { id: 'UninstallDisplayName', key: 'product-specific-key' }
        ],
        getRegistryComponent: (registry) => ({
            guid: 'test-guid',
            componentId: registry.id,
            xml: `<Component Id="${registry.id}" Guid="test-guid" Win64="yes">\n  <RegistryKey Root="HKLM" Key="test-key" />\n</Component>`,
            featureAffinity: 'main'
        })
    };

    assert.equal(typeof config.beforeCreate, 'function');
    await config.beforeCreate(creator);

    assert.match(creator.wixTemplate, /<Property Id="APPLICATIONROOTDIRECTORY" Secure="yes"\s*\/>/);
    assert.match(
        creator.wixTemplate,
        /<SetProperty[^>]+Id="APPLICATIONROOTDIRECTORY"[^>]+Sequence="first"[^>]+Value="\[INSTALLPATH\]"/
    );
    assert.match(creator.wixTemplate, /INSTALLPATH AND NOT APPLICATIONROOTDIRECTORY/);
    assert.match(creator.wixTemplate, /<Property Id="CREATE_DESKTOP_SHORTCUT"[^>]+Value="1"/);
    assert.match(creator.wixTemplate, /<Property Id="CREATE_START_MENU_SHORTCUT"[^>]+Value="1"/);
    assert.match(creator.wixTemplate, /<Property Id="INSTALL_PATH_CUSTOMIZED"[^>]+Value="1"/);
    assert.match(
        creator.wixTemplate,
        /<Property Id="OPENDESK_BUNDLE_INSTALL" Secure="yes">[\s\S]*?RegistrySearch[\s\S]*?Type="raw"[\s\S]*?Name="BundleInstall"[\s\S]*?<\/Property>/
    );
    assert.match(
        creator.wixTemplate,
        /RegistrySearch Key="SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\{834BCECA-F10C-41E6-9ECF-CB3877565C04\}\.msq"[\s\S]*?Root="HKLM"[\s\S]*?Name="InstallPath"[\s\S]*?Win64="no"/
    );
    assert.match(
        creator.wixTemplate,
        /<Component Id="DesktopShortcut"[^>]+Transitive="yes">\s*<Condition>CREATE_DESKTOP_SHORTCUT = "1"<\/Condition>/
    );
    assert.match(
        creator.wixTemplate,
        /<Component Id="ApplicationShortcut"[^>]+Transitive="yes">\s*<Condition>CREATE_START_MENU_SHORTCUT = "1"<\/Condition>/
    );
    assert.equal((creator.wixTemplate.match(/Key="SOFTWARE\\OpenDesk\\Installer"/g) || []).length, 3);
    assert.doesNotMatch(creator.wixTemplate, /RemoveFolderEx/);
    assert.doesNotMatch(creator.wixTemplate, /<Component Id="PurgeOnUninstall"/);
    assert.doesNotMatch(creator.wixTemplate, /<ComponentRef Id="PurgeOnUninstall"/);
    assert.match(creator.wixTemplate, /<MajorUpgrade AllowDowngrades="yes"\s*\/>/);
    assert.doesNotMatch(creator.wixTemplate, /DowngradeErrorMessage|AllowDowngrades="no"|AllowSameVersionUpgrades/);
    assert.doesNotMatch(creator.wixTemplate, /<Property Id="ALLUSERS"[^>]*\/>/); // InstallScope=perMachine 会隐式声明 ALLUSERS，显式声明会 LGHT0091 重复
    assert.match(
        creator.wixTemplate,
        /<Condition Message="!\(loc\.AdminRequiredMessage\)">Installed OR Privileged<\/Condition>/
    );
    assert.match(creator.wixTemplate, /<Property Id="MSIINSTALLPERUSER" Secure="yes" Value="0"\s*\/>/);
    assert.match(
        creator.wixTemplate,
        /<Media Id="1" Cabinet="product\.cab" EmbedCab="yes" CompressionLevel="low"\s*\/>/
    );
    assert.deepEqual(await creator.getSpecialFiles(), [
        { name: 'opendesk.exe', path: 'temporary-launcher.exe' },
        { name: '.installInfo.json', path: 'temporary-install-info.json' }
    ]);
    assert.deepEqual(await creator.getTree(), {
        __ELECTRON_WIX_MSI_FILES__: [
            { name: 'opendesk.exe', path: 'temporary-launcher.exe' },
            { name: '.installInfo.json', path: 'temporary-install-info.json' }
        ],
        __ELECTRON_WIX_MSI_REGISTRY__: [],
        'app-0.3.3': {
            __ELECTRON_WIX_MSI_FILES__: [{ name: 'opendesk.exe', path: 'packaged-opendesk.exe' }],
            __ELECTRON_WIX_MSI_REGISTRY__: [],
            locales: { __ELECTRON_WIX_MSI_FILES__: [], __ELECTRON_WIX_MSI_REGISTRY__: [] }
        }
    });
    assert.deepEqual(creator.getRegistryKeys(), [
        { id: 'RegistryInstallPath', key: 'SOFTWARE\\OpenDesk\\Installer' },
        {
            id: 'RegistryInstallLayoutVersion',
            root: 'HKLM',
            key: 'SOFTWARE\\OpenDesk\\Installer',
            name: 'LayoutVersion',
            type: 'integer',
            value: '2',
            forceDeleteOnUninstall: 'yes'
        },
        {
            id: 'RegistryBundleInstallMode',
            root: 'HKLM',
            key: 'SOFTWARE\\OpenDesk\\Installer',
            name: 'BundleInstall',
            type: 'integer',
            value: '1',
            forceDeleteOnUninstall: 'yes'
        },
        {
            id: 'RegistryInstallPathCustomized',
            root: 'HKLM',
            key: 'SOFTWARE\\OpenDesk\\Installer',
            name: 'InstallPathCustomized',
            type: 'integer',
            value: '[INSTALL_PATH_CUSTOMIZED]',
            forceDeleteOnUninstall: 'yes'
        },
        {
            id: 'RegistryDesktopShortcutPreference',
            root: 'HKLM',
            key: 'SOFTWARE\\OpenDesk\\Installer',
            name: 'CreateDesktopShortcut',
            type: 'integer',
            value: '[CREATE_DESKTOP_SHORTCUT]',
            forceDeleteOnUninstall: 'yes'
        },
        {
            id: 'RegistryStartMenuShortcutPreference',
            root: 'HKLM',
            key: 'SOFTWARE\\OpenDesk\\Installer',
            name: 'CreateStartMenuShortcut',
            type: 'integer',
            value: '[CREATE_START_MENU_SHORTCUT]',
            forceDeleteOnUninstall: 'yes'
        },
        { id: 'UninstallDisplayName', key: 'product-specific-key' }
    ]);
    assert.match(
        creator.getRegistryComponent({ id: 'UninstallDisplayName' }, 0).xml,
        /<Component Id="UninstallDisplayName"[^>]+Transitive="yes">\s*<Condition>OPENDESK_BUNDLE_INSTALL &lt;&gt; "1"<\/Condition>/
    );
    assert.doesNotMatch(
        creator.getRegistryComponent({ id: 'RegistryInstallPath' }, 0).xml,
        /Transitive="yes"|OPENDESK_BUNDLE_INSTALL/
    );
    assert.match(
        creator.getRegistryComponent({ id: 'RegistryBundleInstallMode' }, 0).xml,
        /Transitive="yes">\s*<Condition>OPENDESK_BUNDLE_INSTALL = "1"<\/Condition>/
    );
});

test('uses an editable MSI install directory page instead of the feature tree', () => {
    const ui = fs.readFileSync(path.join(installerResources, 'ui.xml'), 'utf8');
    const localization = fs.readFileSync(path.join(installerResources, 'zh-cn.wxl'), 'utf8');

    assert.match(ui, /<Property Id="WIXUI_INSTALLDIR" Value="APPLICATIONROOTDIRECTORY"\s*\/>/);
    assert.match(ui, /<TextStyle Id="WixUI_Font_Normal" FaceName="Microsoft YaHei UI" Size="8"\s*\/>/);
    assert.match(ui, /Dialog="InstallDirDlg"/);
    assert.match(ui, /Event="SetTargetPath"/);
    assert.match(
        ui,
        /<Publish Dialog="BrowseDlg"\s+Control="OK"[\s\S]*?Property="APPLICATIONROOTDIRECTORY"[\s\S]*?Value="\[APPLICATIONROOTDIRECTORY\]opendesk\\"[\s\S]*?Order="2"[\s\S]*?NOT Installed AND NOT WIX_UPGRADE_DETECTED AND NOT APPLICATIONROOTDIRECTORY ~>> "\\opendesk\\"/
    );
    assert.doesNotMatch(ui, /<Publish Dialog="InstallDirDlg"[^>]+Property="APPLICATIONROOTDIRECTORY"[^>]+opendesk/);
    assert.doesNotMatch(ui, /Dialog="CustomizeDlg"/);
    assert.match(ui, /<Dialog Id="UpgradeReadyDlg"/);
    assert.match(
        ui,
        /Publish Dialog="WelcomeDlg"[\s\S]*?Property="WixUI_InstallMode"[\s\S]*?Value="Update"[\s\S]*?WIX_UPGRADE_DETECTED/
    );
    assert.match(
        ui,
        /Publish Dialog="WelcomeDlg"[\s\S]*?Event="NewDialog" Value="UpgradeReadyDlg"[\s\S]*?WIX_UPGRADE_DETECTED/
    );
    assert.doesNotMatch(ui, /Dialog="InstallDirDlg"[^\n]+Value="UpgradeReadyDlg"/);
    assert.match(
        ui,
        /<Dialog Id="UpgradeReadyDlg"[\s\S]*?<Control Id="Folder"[\s\S]*?Type="PathEdit"[\s\S]*?Property="WIXUI_INSTALLDIR"/
    );
    assert.match(
        ui,
        /Dialog="UpgradeReadyDlg" Control="ChangeFolder"[\s\S]*?Property="_BrowseProperty"[\s\S]*?Event="SpawnDialog" Value="BrowseDlg"/
    );
    assert.match(
        ui,
        /Dialog="UpgradeReadyDlg" Control="Update" Event="SetTargetPath"[\s\S]*?Event="DoAction" Value="WixUIValidatePath"[\s\S]*?Event="SpawnDialog" Value="InvalidDirDlg"[\s\S]*?Event="EndDialog" Value="Return"/
    );
    assert.match(
        localization,
        /<String Id="UpgradeReadyDlgTitle">\{\\WixUI_Font_Title\}已准备好更新 OpenDesk<\/String>/
    );
    assert.match(localization, /<String Id="UpgradeReadyDlgUpdate">更新\(&amp;U\)<\/String>/);
});

test('builds a custom bootstrapper that passes location and shortcut choices to the MSI', () => {
    const bundle = fs.readFileSync(path.join(bootstrapperResources, 'bundle.wxs'), 'utf8');
    const bootstrapper = fs.readFileSync(path.join(bootstrapperResources, 'OpenDeskBootstrapper.cs'), 'utf8');
    const localization = fs.readFileSync(path.join(bootstrapperResources, 'zh-cn.wxl'), 'utf8');
    const buildScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'build-wix-bootstrapper.mjs'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

    assert.match(bundle, /BootstrapperApplicationRef Id="ManagedBootstrapperApplicationHost"/);
    assert.match(bundle, /Payload[^>]+Name="OpenDesk\.Bootstrapper\.dll"/);
    assert.match(bundle, /Variable="InstallFolder"[^>]+Key="SOFTWARE\\OpenDesk\\Installer"/);
    assert.match(bundle, /<MsiProperty Name="APPLICATIONROOTDIRECTORY" Value="\[InstallFolder\]"\s*\/>/);
    assert.match(bundle, /<MsiProperty Name="CREATE_DESKTOP_SHORTCUT" Value="\[CreateDesktopShortcut\]"\s*\/>/);
    assert.match(bundle, /<MsiProperty Name="CREATE_START_MENU_SHORTCUT" Value="\[CreateStartMenuShortcut\]"\s*\/>/);
    assert.match(bundle, /<MsiProperty Name="INSTALL_PATH_CUSTOMIZED" Value="\[InstallPathCustomized\]"\s*\/>/);
    assert.match(bundle, /<MsiProperty Name="OPENDESK_BUNDLE_INSTALL" Value="1"\s*\/>/);
    assert.match(bootstrapper, /CreateDesktopShortcutCheckBox/);
    assert.match(bootstrapper, /CreateStartMenuShortcutCheckBox/);
    assert.match(bootstrapper, /Engine\.FormatString\(Engine\.StringVariables\["InstallFolder"\]\)/);
    assert.match(bootstrapper, /InstallerPath\.Normalize/);
    assert.match(
        bootstrapper,
        /public string GetInstallFolder\(\)[\s\S]*?InstallerPath\.ResolveInitialDirectory\([\s\S]*?GetSavedInstallPathCustomized\(\)/
    );
    assert.match(
        bootstrapper,
        /ResolveInitialDirectory\(string folder, bool pathCustomized\)[\s\S]*?pathCustomized[\s\S]*?AppendDefaultDirectory\(folder\)/
    );
    assert.match(bootstrapper, /folderTextBox\.Text = InstallerPath\.AppendDefaultDirectory\(dialog\.SelectedPath\)/);
    assert.match(bootstrapper, /private void SaveOptions\(\)[\s\S]*?InstallerPath\.Normalize\(folderTextBox\.Text\)/);
    assert.match(bootstrapper, /AppendDefaultDirectory[\s\S]*?Path\.Combine\(normalized, "opendesk"\)/);
    assert.match(bootstrapper, /DetectRelatedMsiPackage \+= OnDetectRelatedMsiPackage/);
    assert.match(
        bootstrapper,
        /OnDetectRelatedMsiPackage[\s\S]*?e\.PackageId == PackageId[\s\S]*?RelatedOperation\.MajorUpgrade[\s\S]*?RelatedOperation\.MinorUpdate[\s\S]*?relatedMsiUpgradeDetected = true/
    );
    assert.match(
        bootstrapper,
        /OnDetectRelatedMsiPackage[\s\S]*?RelatedOperation\.MajorUpgrade[\s\S]*?RelatedOperation\.MinorUpdate[\s\S]*?RelatedOperation\.Downgrade[\s\S]*?relatedMsiUpgradeDetected = true/
    );
    assert.match(bootstrapper, /OnDetectRelatedMsiPackage[\s\S]*?RestoreRelatedMsiInstallFolder\(e\.ProductCode\)/);
    assert.match(bootstrapper, /FindRelatedMsiInstallFolder\(string productCode\)[\s\S]*?productCode \+ "\.msq"/);
    assert.match(bootstrapper, /RegistryView\[\] views = \{ RegistryView\.Registry32, RegistryView\.Registry64 \}/);
    assert.match(bootstrapper, /key\.GetValue\("InstallPath"\)/);
    assert.match(
        bootstrapper,
        /RestoreRelatedMsiInstallFolder\(string productCode\)[\s\S]*?activeInstallFolder = InstallerPath\.Normalize\(folder\)[\s\S]*?Engine\.StringVariables\["InstallFolder"\] = activeInstallFolder/
    );
    assert.match(
        bootstrapper,
        /OnDetectComplete[\s\S]*?ShowDetected\([\s\S]*?packageState == PackageState\.Present[\s\S]*?relatedMsiUpgradeDetected/
    );
    assert.match(
        bootstrapper,
        /OnDetectComplete[\s\S]*?maintenanceRequested[\s\S]*?LaunchAction\.Uninstall[\s\S]*?LaunchAction\.Repair[\s\S]*?packageState == PackageState\.Present \|\| maintenanceRequested/
    );
    assert.match(
        bootstrapper,
        /ShowWelcome\(bool enabled\)[\s\S]*?upgradeDetected[\s\S]*?UpgradeHeader[\s\S]*?UpgradeInstallButton/
    );
    assert.match(
        bootstrapper,
        /StartAction\(LaunchAction action\)[\s\S]*?EnsureOpenDeskIsNotRunning\(\)[\s\S]*?Engine\.Plan\(action\)/
    );
    assert.doesNotMatch(bootstrapper, /UnsafeLegacy|GetSavedLayoutVersion|ShowLegacyInstallBlocked/);
    assert.match(
        bootstrapper,
        /EnsureOpenDeskIsNotRunning\(\)[\s\S]*?HasRunningOpenDeskProcess\([^)]+\)[\s\S]*?MessageBoxButtons\.RetryCancel/
    );
    assert.match(
        bootstrapper,
        /HasRunningOpenDeskProcess\(string installFolder\)[\s\S]*?Process\.GetProcessesByName\("opendesk"\)[\s\S]*?GetProcessExecutablePath\(process\)[\s\S]*?IsExecutableInsideInstallFolder/
    );
    assert.match(
        bootstrapper,
        /IsExecutableInsideInstallFolder\(string executablePath, string installFolder\)[\s\S]*?Path\.GetFileName\(normalizedExecutablePath\)[\s\S]*?"opendesk\.exe"[\s\S]*?StartsWith\(normalizedInstallFolder/
    );
    assert.match(bootstrapper, /QueryFullProcessImageName/);
    assert.doesNotMatch(bootstrapper, /CloseMainWindow\(\)|\.Kill\(\)|WaitForExit\(/);
    assert.match(bootstrapper, /OnApplyComplete[\s\S]*?e\.Restart != ApplyRestart\.None[\s\S]*?ShowRestartRequired/);
    assert.match(bootstrapper, /OnDetectComplete[\s\S]*?ErrorFailNoActionReboot[\s\S]*?ShowRestartRequired/);
    assert.match(bootstrapper, /ErrorFailNoActionReboot[\s\S]*?ShowRestartRequired/);
    assert.match(localization, /<String Id="RestartRequiredHeader">需要重新启动 Windows<\/String>/);
    assert.match(localization, /<String Id="RestartRequiredPendingMessage">[^<]+<\/String>/);
    assert.match(
        bootstrapper,
        /SetProgressStatus\(\s*string installLocalizationId,\s*string repairLocalizationId,\s*string uninstallLocalizationId\s*\)/
    );
    assert.doesNotMatch(bootstrapper, /SetProgressStatus\("ProgressInstalling"\)/);
    assert.match(bootstrapper, /Engine\.NumericVariables\["InstallPathCustomized"\]/);
    assert.doesNotMatch(bootstrapper, /OverallProgressPackageText/);
    assert.match(localization, /<String Id="CreateDesktopShortcut">创建桌面快捷方式<\/String>/);
    assert.match(localization, /<String Id="ProgressUninstalling">正在移除应用文件\.\.\.<\/String>/);
    assert.match(localization, /<String Id="ProgressRepairing">正在修复应用文件\.\.\.<\/String>/);
    assert.match(localization, /<String Id="ProgressUninstallCancelButton">取消卸载<\/String>/);
    assert.match(localization, /<String Id="OpenDeskRunningTitle">OpenDesk 正在运行<\/String>/);
    assert.match(localization, /<String Id="OpenDeskRunningMessage">[^<]+<\/String>/);
    assert.match(localization, /<String Id="UpgradeHeader">更新 OpenDesk<\/String>/);
    assert.match(localization, /<String Id="UpgradeInstallButton">开始更新<\/String>/);
    assert.doesNotMatch(localization, /LegacyInstall|检测到旧版安装目录|旧版 OpenDesk/);
    assert.equal(packageJson.scripts['make:win32'], 'electron-forge make --platform=win32');
    assert.equal(packageJson.scripts['make:wix-bootstrapper'], 'node scripts/build-wix-bootstrapper.mjs');
    assert.equal(packageJson.scripts['make:win32:setup'], 'npm run make:win32 && npm run make:wix-bootstrapper');
    assert.doesNotMatch(buildScript, /npmExecutable|npmCliPath|make:win32|spawnSync\(['"]npm\.cmd['"]/);
    assert.match(buildScript, /if \(!fs\.existsSync\(msiPath\)\)/);
});

test('renders every bootstrapper page transition atomically', () => {
    const bootstrapper = fs.readFileSync(path.join(bootstrapperResources, 'OpenDeskBootstrapper.cs'), 'utf8');

    assert.match(bootstrapper, /class BufferedPanel : Panel/);
    assert.match(bootstrapper, /OptimizedDoubleBuffer/);
    assert.match(bootstrapper, /WM_SETREDRAW/);
    assert.equal((bootstrapper.match(/RenderPage\(delegate/g) || []).length, 7);
    assert.match(bootstrapper, /Opacity = 0D/);
    assert.match(bootstrapper, /ShowDetected[\s\S]*?Opacity = 1D/);
    assert.doesNotMatch(bootstrapper, /rightBody\.BackColor = Color\.Transparent/);
});

test('compiles a 32-bit managed bootstrapper with a valid .NET configuration', () => {
    const buildScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'build-wix-bootstrapper.mjs'), 'utf8');
    const config = fs.readFileSync(path.join(bootstrapperResources, 'BootstrapperCore.config'), 'utf8');

    assert.match(buildScript, /'\/platform:x86'/);
    assert.match(buildScript, /BootstrapperCore\.dll/);
    assert.ok(
        config.indexOf('<configSections>') < config.indexOf('<startup '),
        'configSections must be the first .NET configuration child'
    );
});

test('keeps install-page decoration out of the shared bootstrapper background', async () => {
    const background = await sharp(path.join(bootstrapperResources, 'background.png')).metadata();
    const featureRows = await sharp(path.join(bootstrapperResources, 'feature-rows.png')).metadata();

    assert.deepEqual([background.width, background.height], [920, 600]);
    assert.deepEqual([featureRows.width, featureRows.height], [530, 238]);
});

test('keeps the compact MSI background free of the decorative ring', () => {
    const assetScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'generate-wix-installer-assets.mjs'), 'utf8');
    const dialogBackground = assetScript.match(/async function createDialogBackground\(\) \{[\s\S]*?\n\}/)[0];
    const bootstrapperBackground = assetScript.match(
        /async function createBootstrapperBackground\(\) \{[\s\S]*?\n\}/
    )[0];

    assert.doesNotMatch(dialogBackground, /drawRing\(/);
    assert.match(bootstrapperBackground, /drawRing\(/);
});
