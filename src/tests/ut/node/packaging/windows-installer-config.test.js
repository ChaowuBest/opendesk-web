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
            // 写 REG_SZ（字符串），避免 RegistrySearch(raw) 读 REG_DWORD 得到 "#1" 导致修复时条件误判
            type: 'string',
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
    // 条件必须同时认可 "1" 与 "#1"：机器上残留旧版本写入的 REG_DWORD BundleInstall 时，
    // MSI 的 AppSearch 会用 RegistrySearch(raw) 读到的 "#1"（整数前缀）覆盖 burn 命令行
    // 传入的 "1"，条件若只认 "1" 就会误判为独立 MSI 安装，把 UninstallDisplayName 等
    // .msq 展示组件装出来，控制面板出现第二个 OpenDesk 条目（版本 0.3.6、无体积）。
    assert.match(
        creator.getRegistryComponent({ id: 'UninstallDisplayName' }, 0).xml,
        /<Component Id="UninstallDisplayName"[^>]*>\s*<Condition>OPENDESK_BUNDLE_INSTALL &lt;&gt; "1" AND OPENDESK_BUNDLE_INSTALL &lt;&gt; "#1"<\/Condition>/
    );
    assert.match(
        creator.getRegistryComponent({ id: 'UninstallString' }, 0).xml,
        /<Condition>OPENDESK_BUNDLE_INSTALL &lt;&gt; "1" AND OPENDESK_BUNDLE_INSTALL &lt;&gt; "#1"<\/Condition>/
    );
    assert.doesNotMatch(creator.getRegistryComponent({ id: 'UninstallDisplayName' }, 0).xml, /Transitive="yes"/);
    assert.doesNotMatch(
        creator.getRegistryComponent({ id: 'RegistryInstallPath' }, 0).xml,
        /Transitive="yes"|OPENDESK_BUNDLE_INSTALL/
    );
    // 命中 "#1"（旧 REG_DWORD 残留）时同样视为 bundle 安装模式：本组件会把 REG_DWORD
    // 重写为 REG_SZ "1"，让机器在下一次会话起自愈。
    assert.match(
        creator.getRegistryComponent({ id: 'RegistryBundleInstallMode' }, 0).xml,
        /<Component Id="RegistryBundleInstallMode"[^>]*>\s*<Condition>OPENDESK_BUNDLE_INSTALL = "1" OR OPENDESK_BUNDLE_INSTALL = "#1"<\/Condition>/
    );
    assert.doesNotMatch(creator.getRegistryComponent({ id: 'RegistryBundleInstallMode' }, 0).xml, /Transitive="yes"/);
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

    assert.match(
        bundle,
        /<util:FileSearch Id="FindDokanVersion"[\s\S]*?Variable="DokanVersion"[\s\S]*?Result="version"/
    );
    assert.match(
        bundle,
        /<MsiPackage Id="DokanMsi"[\s\S]*?SourceFile="\$\(var\.DokanMsiPath\)"[\s\S]*?InstallCondition="NOT DokanVersion/
    );
    assert.match(bundle, /<MsiPackage Id="DokanMsi"[\s\S]*?Permanent="yes"/);
    assert.match(buildScript, /DokanMsiPath/);

    assert.match(bundle, /BootstrapperApplicationRef Id="ManagedBootstrapperApplicationHost"/);
    // WiX v3 无 Bundle/@PerMachine（v4+ 语法）；per-machine 通过 MsiPackage/@ForcePerMachine 声明
    assert.match(bundle, /ForcePerMachine="yes"/);
    // WiX v3 的 <Bundle> 不支持 Id 属性（candle CNDL0004），同版本重复安装的重复条目
    // 由 BA 在 Plan 阶段把 related bundle 改写为 Absent 来清理
    assert.match(bundle, /OnPlanRelatedBundle/);
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
    assert.match(bootstrapper, /DetectRelatedBundle \+= OnDetectRelatedBundle/);
    // 历史 bundle 统一交给 Burn 引擎卸载：Plan 阶段把 related bundle 改写为 Absent。
    // 引擎默认只卸载版本更低的（RelationType=Upgrade），同版本重装默认 None 会留下重复条目。
    assert.match(bootstrapper, /PlanRelatedBundle \+= OnPlanRelatedBundle/);
    assert.match(
        bootstrapper,
        /OnPlanRelatedBundle\(object sender, PlanRelatedBundleEventArgs e\)[\s\S]*?activeAction != LaunchAction\.Install[\s\S]*?FindBundleCachePath\(e\.BundleId\)[\s\S]*?RequestState\.None\s*:\s*RequestState\.Absent/
    );
    assert.match(
        bootstrapper,
        /OnDetectRelatedBundle\(object sender, DetectRelatedBundleEventArgs e\)[\s\S]*?NormalizeBundleId\(e\.ProductCode\)[\s\S]*?relatedBundleVersions\[bundleId\] = e\.Version/
    );
    assert.match(
        bootstrapper,
        /OnPlanRelatedBundle\(object sender, PlanRelatedBundleEventArgs e\)[\s\S]*?IsProtectedRelatedBundle\(e\.BundleId\)[\s\S]*?e\.State = RequestState\.None/
    );
    assert.match(
        bootstrapper,
        /IsProtectedRelatedBundle\(string bundleId\)[\s\S]*?GetCurrentBundleId\(\)[\s\S]*?relatedBundleVersions\.TryGetValue[\s\S]*?relatedVersion > currentVersion/
    );
    // 缓存丢失的 bundle 无法卸载，只清孤儿注册键；不能计划 Absent（会让安装整体失败）
    assert.match(bootstrapper, /private static string FindBundleCachePath\(string bundleId\)/);
    // 作为 related bundle 被调起（升级时旧版被自动卸载）必须全程静默：
    // Burn 会把主安装程序的显示级别传给旧版 Setup.exe，旧版若按 Display.Full 弹维护页，
    // 窗口会落在主程序后面，用户只看到进度条不动。
    assert.match(
        bootstrapper,
        /public bool RunsWithoutUserInteraction[\s\S]*?Command\.Display == Display\.None[\s\S]*?Command\.Display == Display\.Embedded[\s\S]*?Command\.Relation != RelationType\.None/
    );
    assert.doesNotMatch(bootstrapper, /if \(Command\.Display == Display\.None\)/);
    // 提权交给 Burn 引擎在 Apply 阶段完成（bundle 保持 asInvoker）。
    // 不能在 BA 里调 Engine.Elevate：UAC 请求是同步的，会阻塞 BA 消息循环，
    // 界面卡在"正在准备安装"且无法取消。
    assert.doesNotMatch(bootstrapper, /Engine\.Elevate/);
    // 也不要改写 bundle 引擎的清单为 requireAdministrator：insignia 往返会破坏 bundle 结构
    assert.doesNotMatch(buildScript, /insignia|-outputresource|requireAdministrator/);
    // 清理 stale 注册键发生在 Install 与 Repair 两条路径上（修复同样要求应用列表只剩当前实例）；
    // 仅用户直接发起的卸载（RelationType.None）才忽略依赖登记，related bundle 卸载不能忽略
    assert.match(
        bootstrapper,
        /form\.ShowProgress\(action\);[\s\S]*?if \(action == LaunchAction\.Install \|\| action == LaunchAction\.Repair\)\s*\{\s*CleanupStaleInstallations\(\);\s*\}[\s\S]*?if \(action == LaunchAction\.Uninstall && Command\.Relation == RelationType\.None\)\s*\{\s*IgnorePackageDependencies\(\);\s*\}[\s\S]*?Engine\.Plan\(action\);/
    );
    // 卸载时忽略 MSI 的 dependency provider：历史重复安装的 bundle 会在 provider 下残留
    // dependent，引擎因此跳过 MSI 卸载（日志 w327 found dependents + execute: None），
    // 表现为"卸载秒成功但应用还在"。OpenDesk 的 MSI 只被自身 bundle 引用，忽略登记是安全的。
    assert.match(bootstrapper, /Engine\.StringVariables\["IGNOREDEPENDENCIES"\] = "ALL";/);
    // 清理旧版本的 ExePackage 没有内部进度可跟踪，升级/修复时可能静默运行一两分钟。
    // BA 必须在它开始执行时把进度页文案切到"正在清理旧版本"，结束后恢复常规文案，
    // 避免用户误以为安装卡死；仅在 detect 阶段发现过历史 bundle 时才展示。
    assert.match(bundle, /<ExePackage Id="CleanupRelatedBundles"/);
    assert.match(bundle, /InstallCommand="\[WixBundleVersion\] \[WixBundleProviderKey\]"/);
    const cleanup = fs.readFileSync(path.join(bootstrapperResources, 'CleanupRelatedBundles.cs'), 'utf8');
    assert.match(cleanup, /args\.Length < 2/);
    assert.match(cleanup, /CleanupOldBundles\(currentVersion, currentBundleId\)/);
    assert.match(
        cleanup,
        /LaunchCachedUninstall\(string cachePath, string currentBundleId\)[\s\S]*?\/uninstall \/quiet -burn\.related\.upgrade -burn\.ancestors=" \+ currentBundleId/
    );
    assert.match(bootstrapper, /CleanupRelatedBundlesPackageId = "CleanupRelatedBundles"/);
    assert.match(
        bootstrapper,
        /ExecutePackageBegin \+= OnExecutePackageBegin;\s*ExecutePackageComplete \+= OnExecutePackageComplete;/
    );
    assert.match(
        bootstrapper,
        /OnExecutePackageBegin\(object sender, ExecutePackageBeginEventArgs e\)[\s\S]*?e\.PackageId == CleanupRelatedBundlesPackageId[\s\S]*?relatedMsiUpgradeDetected[\s\S]*?SetProgressStatus\(\s*"ProgressCleaningOldBundles"/
    );
    assert.match(
        bootstrapper,
        /OnExecutePackageComplete\(object sender, ExecutePackageCompleteEventArgs e\)[\s\S]*?e\.PackageId != CleanupRelatedBundlesPackageId[\s\S]*?SetProgressStatus\("ProgressInstalling", "ProgressRepairing", "ProgressUninstalling"\)/
    );
    assert.match(localization, /<String Id="ProgressCleaningOldBundles">[^<]*正在清理旧版本安装/);
    assert.match(
        bootstrapper,
        /OnPlanRelatedBundle\(object sender, PlanRelatedBundleEventArgs e\)[\s\S]*?activeAction != LaunchAction\.Install\s*&&\s*activeAction != LaunchAction\.Repair\s*&&\s*activeAction != LaunchAction\.Uninstall/
    );
    // 静默模式/被父 bundle 调起时，apply 完成后必须能真正关闭窗体退出；
    // 若走 busy 守卫会弹隐藏的确认框，/quiet 下永远没人点，进程不退出
    assert.match(
        bootstrapper,
        /OnFormClosing[\s\S]*?if \(application\.RunsWithoutUserInteraction\)\s*\{[\s\S]*?return;[\s\S]*?\}/
    );
    // BA 进程未提权（Burn 只提升 Apply 阶段的独立进程），清理必须"先只读枚举、有目标才申请写权限"，
    // 否则首次安装（无残留）就会因以写权限打开 HKLM 抛 SecurityException 而崩溃
    assert.match(
        bootstrapper,
        /List<string> staleKeyNames = new List<string>\(\);\s*using \(RegistryKey uninstallKey = baseKey\.OpenSubKey\(uninstallKeyPath\)\)/
    );
    assert.match(
        bootstrapper,
        /if \(staleKeyNames\.Count == 0\) continue;\s*using \(RegistryKey writableKey = baseKey\.OpenSubKey\(uninstallKeyPath, true\)\)/
    );
    assert.doesNotMatch(bootstrapper, /WindowsPrincipal|WindowsBuiltInRole|IsProcessElevated/);
    // UAC 提权后 Windows 会把发起提权的窗口压到别的窗口后面（有时还最小化），
    // 用户授权完看不到安装界面。从 ApplyBegin 开始轮询观察，失去前台后抢回来。
    assert.match(bootstrapper, /ApplyBegin \+= delegate[\s\S]*?KeepVisibleThroughElevation\(\)/);
    assert.match(bootstrapper, /Elevate \+= delegate[\s\S]*?elevationRequested = true/);
    assert.match(
        bootstrapper,
        /public void KeepVisibleThroughElevation\(\)[\s\S]*?elevationVisibilityTimer = new Timer\(\)[\s\S]*?BringBackToForegroundIfDisplaced\(\)/
    );
    // 关键：不能用"是否最小化"提前退出——UAC 之后窗口通常没被最小化，只是被压在后面
    assert.doesNotMatch(bootstrapper, /WindowState != FormWindowState\.Minimized[\s\S]{0,80}return false/);
    // 只在提权已发起、且前台不属于本进程时才抢（否则会盖掉自己的 MessageBox / 打扰用户主动切窗）
    assert.match(
        bootstrapper,
        /BringBackToForegroundIfDisplaced\(\)[\s\S]*?application\.ElevationRequested[\s\S]*?IsForegroundWindowInCurrentProcess\(\)[\s\S]*?NativeMethods\.ForceForeground\(this\)/
    );
    assert.match(bootstrapper, /private volatile bool elevationRequested;/);
    assert.match(bootstrapper, /if \(restored \|\| elapsedMilliseconds >= ElevationVisibilityWatchDuration\)/);
    // SetForegroundWindow 在前台归属他进程时会被忽略，必须借 AttachThreadInput 拿前台权限；
    // 且返回值不可信，要以 GetForegroundWindow 的实际结果判定是否成功
    assert.match(
        bootstrapper,
        /ForceForeground\(Control control\)[\s\S]*?AttachThreadInput\(currentThreadId, foregroundThreadId, true\)[\s\S]*?SetForegroundWindow\(handle\)[\s\S]*?AttachThreadInput\(currentThreadId, foregroundThreadId, false\)[\s\S]*?return GetForegroundWindow\(\) == handle;/
    );
    // 定时器必须在关闭时释放，避免残留后台开销
    assert.match(bootstrapper, /OnFormClosing[\s\S]*?StopElevationVisibilityWatch\(\)/);
    assert.match(
        bootstrapper,
        /StopElevationVisibilityWatch\(\)[\s\S]*?elevationVisibilityTimer\.Dispose\(\)[\s\S]*?elevationVisibilityTimer = null/
    );
    assert.match(
        bootstrapper,
        /private void CleanupStaleInstallations\(\)[\s\S]*?catch \(Exception exception\)[\s\S]*?Engine\.Log\(LogLevel\.Error/
    );
    assert.match(bootstrapper, /private void CleanupStaleInstallations\(\)/);
    assert.match(bootstrapper, /keyName\.EndsWith\("\.msq", StringComparison\.OrdinalIgnoreCase\)\) return true;/);
    assert.match(bootstrapper, /subKey\.GetValue\("BundleCachePath"\) as string/);
    // 当前 bundle Id 运行时从引擎变量获取（WiX v3 bundle PackageId 每次编译随机）
    assert.match(bootstrapper, /Engine\.FormatString\("\[WixBundleProviderKey\]"\)/);
    assert.match(bootstrapper, /DeleteStaleRegistryEntries\(GetCurrentBundleId\(\)\)/);
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
    // 禁止强杀用户进程或等待用户进程退出；检测到 OpenDesk 在跑时提示用户自己关闭
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
    assert.equal(
        packageJson.scripts['make:win32'],
        'npm run build && electron-forge make --platform=win32 && npm run make:wix-bootstrapper'
    );
    assert.equal(packageJson.scripts['make:wix-bootstrapper'], 'node scripts/build-wix-bootstrapper.mjs');
    assert.ok(!packageJson.scripts['make:win32:setup'], 'make:win32:setup 已并入 make:win32，不应再单独存在');
    assert.doesNotMatch(buildScript, /npmExecutable|npmCliPath|make:win32|spawnSync\(['"]npm\.cmd['"]/);
    assert.match(buildScript, /if \(!fs\.existsSync\(msiPath\)\)/);
});

test('renders every bootstrapper page transition atomically', () => {
    const bootstrapper = fs.readFileSync(path.join(bootstrapperResources, 'OpenDeskBootstrapper.cs'), 'utf8');

    assert.match(bootstrapper, /class BufferedPanel : Panel/);
    assert.match(bootstrapper, /OptimizedDoubleBuffer/);
    assert.match(bootstrapper, /WM_SETREDRAW/);
    assert.equal((bootstrapper.match(/RenderPage\(delegate/g) || []).length, 8);
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
