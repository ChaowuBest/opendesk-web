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

test('restores install preferences and gates shortcut components', async () => {
    const config = getWixConfig();
    const creator = {
        wixTemplate: fs.readFileSync(
            path.join(projectRoot, 'node_modules', 'electron-wix-msi', 'static', 'wix.xml'),
            'utf8'
        ),
        getRegistryKeys: () => [
            { id: 'RegistryInstallPath', key: 'product-specific-key' },
            { id: 'UninstallDisplayName', key: 'product-specific-key' }
        ]
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
    assert.match(
        creator.wixTemplate,
        /<Component Id="DesktopShortcut"[^>]+Transitive="yes">\s*<Condition>CREATE_DESKTOP_SHORTCUT = "1"<\/Condition>/
    );
    assert.match(
        creator.wixTemplate,
        /<Component Id="ApplicationShortcut"[^>]+Transitive="yes">\s*<Condition>CREATE_START_MENU_SHORTCUT = "1"<\/Condition>/
    );
    assert.equal((creator.wixTemplate.match(/Key="SOFTWARE\\OpenDesk\\Installer"/g) || []).length, 2);
    assert.deepEqual(creator.getRegistryKeys(), [
        { id: 'RegistryInstallPath', key: 'SOFTWARE\\OpenDesk\\Installer' },
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
});

test('uses an editable MSI install directory page instead of the feature tree', () => {
    const ui = fs.readFileSync(path.join(installerResources, 'ui.xml'), 'utf8');

    assert.match(ui, /<Property Id="WIXUI_INSTALLDIR" Value="APPLICATIONROOTDIRECTORY"\s*\/>/);
    assert.match(ui, /Dialog="InstallDirDlg"/);
    assert.match(ui, /Event="SetTargetPath"/);
    assert.doesNotMatch(ui, /Dialog="CustomizeDlg"/);
});

test('builds a custom bootstrapper that passes location and shortcut choices to the MSI', () => {
    const bundle = fs.readFileSync(path.join(bootstrapperResources, 'bundle.wxs'), 'utf8');
    const bootstrapper = fs.readFileSync(path.join(bootstrapperResources, 'OpenDeskBootstrapper.cs'), 'utf8');
    const localization = fs.readFileSync(path.join(bootstrapperResources, 'zh-cn.wxl'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

    assert.match(bundle, /BootstrapperApplicationRef Id="ManagedBootstrapperApplicationHost"/);
    assert.match(bundle, /Payload[^>]+Name="OpenDesk\.Bootstrapper\.dll"/);
    assert.match(bundle, /Variable="InstallFolder"[^>]+Key="SOFTWARE\\OpenDesk\\Installer"/);
    assert.match(bundle, /<MsiProperty Name="APPLICATIONROOTDIRECTORY" Value="\[InstallFolder\]"\s*\/>/);
    assert.match(bundle, /<MsiProperty Name="CREATE_DESKTOP_SHORTCUT" Value="\[CreateDesktopShortcut\]"\s*\/>/);
    assert.match(bundle, /<MsiProperty Name="CREATE_START_MENU_SHORTCUT" Value="\[CreateStartMenuShortcut\]"\s*\/>/);
    assert.match(bootstrapper, /CreateDesktopShortcutCheckBox/);
    assert.match(bootstrapper, /CreateStartMenuShortcutCheckBox/);
    assert.match(bootstrapper, /Engine\.FormatString\(Engine\.StringVariables\["InstallFolder"\]\)/);
    assert.doesNotMatch(bootstrapper, /OverallProgressPackageText/);
    assert.match(localization, /<String Id="CreateDesktopShortcut">创建桌面快捷方式<\/String>/);
    assert.equal(packageJson.scripts['make:wix-bootstrapper'], 'node scripts/build-wix-bootstrapper.mjs');
});

test('renders every bootstrapper page transition atomically', () => {
    const bootstrapper = fs.readFileSync(path.join(bootstrapperResources, 'OpenDeskBootstrapper.cs'), 'utf8');

    assert.match(bootstrapper, /class BufferedPanel : Panel/);
    assert.match(bootstrapper, /OptimizedDoubleBuffer/);
    assert.match(bootstrapper, /WM_SETREDRAW/);
    assert.equal((bootstrapper.match(/RenderPage\(delegate/g) || []).length, 6);
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
