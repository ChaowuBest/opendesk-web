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

test('restores the previous install directory before a major upgrade', async () => {
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
    assert.equal((creator.wixTemplate.match(/Key="SOFTWARE\\OpenDesk\\Installer"/g) || []).length, 2);
    assert.deepEqual(creator.getRegistryKeys(), [
        { id: 'RegistryInstallPath', key: 'SOFTWARE\\OpenDesk\\Installer' },
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

test('builds a branded bootstrapper that passes any selected drive to the MSI', () => {
    const theme = fs.readFileSync(path.join(bootstrapperResources, 'theme.xml'), 'utf8');
    const bundle = fs.readFileSync(path.join(bootstrapperResources, 'bundle.wxs'), 'utf8');
    const localization = fs.readFileSync(path.join(bootstrapperResources, 'zh-cn.wxl'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

    assert.match(theme, /<Window Width="920" Height="600"/);
    assert.match(theme, /<Page Name="Install">[\s\S]*?<Image[^>]+ImageFile="feature-rows\.png"/);
    assert.match(theme, /<Editbox Name="FolderEditbox"[^>]+FileSystemAutoComplete="yes"/);
    assert.match(theme, /<Button Name="BrowseButton"/);
    assert.match(localization, /<String Id="InstallLocationPreview">可在“安装选项”中查看或更改安装路径。<\/String>/);
    assert.doesNotMatch(localization, /InstallLocationPreview">[^<]*\[InstallFolder\]/);
    assert.match(bundle, /Variable="InstallFolder"[^>]+Key="SOFTWARE\\OpenDesk\\Installer"/);
    assert.match(bundle, /<MsiProperty Name="APPLICATIONROOTDIRECTORY" Value="\[InstallFolder\]"\s*\/>/);
    assert.match(localization, /<String Id="OptionsLocationLabel">安装位置：<\/String>/);
    assert.equal(packageJson.scripts['make:wix-bootstrapper'], 'node scripts/build-wix-bootstrapper.mjs');
});

test('keeps install-page decoration out of the shared bootstrapper background', async () => {
    const background = await sharp(path.join(bootstrapperResources, 'background.png')).metadata();
    const featureRows = await sharp(path.join(bootstrapperResources, 'feature-rows.png')).metadata();

    assert.deepEqual([background.width, background.height], [920, 600]);
    assert.deepEqual([featureRows.width, featureRows.height], [530, 238]);
});
