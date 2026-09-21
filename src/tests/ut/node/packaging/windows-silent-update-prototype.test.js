import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '../../../../..');

test('builds current-version-only update installers while preserving the released Bundle identity', () => {
    const builderPath = path.join(projectRoot, 'scripts', 'windows-silent-update-prototype', 'build-prototype.mjs');
    const builder = fs.readFileSync(builderPath, 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

    assert.equal(
        packageJson.scripts['prototype:windows-silent-update'],
        'node scripts/windows-silent-update-prototype/build-prototype.mjs'
    );
    assert.equal(packageJson.scripts['make:win32:update'], 'node scripts/build-windows-update-installer.mjs');
    assert.equal(packageJson.scripts['make:win32'], 'node scripts/build-windows-update-installer.mjs');
    const releaseBuilder = fs.readFileSync(
        path.join(projectRoot, 'scripts', 'build-windows-update-installer.mjs'),
        'utf8'
    );
    assert.match(releaseBuilder, /windows-silent-update-prototype/);
    assert.match(releaseBuilder, /packageJson\.version/);
    assert.match(releaseBuilder, /npm run build/);
    assert.match(releaseBuilder, /electron-forge/);
    assert.match(releaseBuilder, /'package', '--platform=win32', '--arch=x64'/);
    assert.match(releaseBuilder, /'--version',\s*version/);
    assert.match(releaseBuilder, /'--app-dir',\s*packagedAppDirectory/);
    assert.match(releaseBuilder, /opendesk-win-x86-\$\{version\}\.exe/);
    assert.match(releaseBuilder, /OPENDESK_SIGNING_CERTIFICATE_THUMBPRINT/);
    assert.doesNotMatch(builder, /<MajorUpgrade/);
    assert.match(builder, /ARPSYSTEMCOMPONENT/);
    assert.doesNotMatch(builder, /Permanent="yes"/);
    assert.match(builder, /ManagedBootstrapperApplicationHost/);
    assert.match(builder, /OpenDesk\.Bootstrapper\.dll/);
    assert.match(builder, /background\.png/);
    assert.match(builder, /opendesk\.ico/);
    assert.match(builder, /OpenDeskDisplayVersion/);
    assert.match(builder, /OPENDESK_DISPLAY_VERSION/);
    assert.match(builder, /Name="BundleVersion" Value="\[OPENDESK_DISPLAY_VERSION\]"/);
    assert.match(builder, /Name="active-version\.txt"[\s\S]*Value="\$\{version\}"/);
    assert.match(builder, /\/win32icon:\$\{iconPath\}/);
    assert.match(builder, /Icon="OpenDeskIcon"/);
    assert.match(builder, /productCode\('platform:4'\)/);
    assert.match(builder, /productCode\('platform:4:launcher'\)/);
    assert.match(builder, /productCode\('platform:4:shortcut'\)/);
    assert.match(builder, /productCode\('platform:4:legacy-shortcut-cleanup'\)/);
    assert.match(builder, /productCode\(`active:3:\$\{version\}`\)/);
    assert.match(builder, /productCode\(`version:3:\$\{version\}`\)/);
    assert.match(builder, /Directory Id="ProgramMenuFolder"/);
    assert.match(builder, /Root="HKCU"[\s\S]*Name="ShortcutInstalled"/);
    assert.match(builder, /RemoveMisplacedShortcut/);
    assert.match(builder, /RemoveMisplacedActiveVersionFile/);
    assert.match(builder, /Directory="APPLICATIONROOTDIRECTORY"/);
    assert.match(builder, /<Bundle Name="OpenDesk" Version="\$\{version\}"/);
    assert.doesNotMatch(builder, /<Bundle Name="OpenDesk" Version="\$\{version\}\.0"/);
    assert.match(builder, /UpgradeCode="\{E7B412C3-02CC-4ED8-9FCB-5D33FE3390E4\}"/i);
    assert.doesNotMatch(builder, /6853E597-44D1-4A76-91C7-7B413C6B23A7/i);
    assert.match(builder, /SILENT_UPDATE_PROTOTYPE/);
    assert.match(builder, /OpenDeskPlatform/);
    assert.doesNotMatch(builder, /OpenDeskBaselineMsi/);
    assert.match(builder, /OpenDeskMsi/);
    assert.match(builder, /CleanupPrototypeInstallations/);
    assert.match(builder, /CleanupRelatedBundles/);
    assert.match(builder, /CleanupRelatedBundles\.cs/);
    assert.match(builder, /LegacyBundleCleanupDetect/);
    assert.doesNotMatch(builder, /BaselineProductState|baselineMsi:/);
    assert.match(builder, /Name="ProductCode" Value="\[ProductCode\]"/);
    assert.match(builder, /Name="OPENDESK_TARGET_VERSION" Value="\[OpenDeskDisplayVersion\]"/);
    assert.match(builder, /Variable Name="CleanupOldVersions" Type="numeric" Value="0" bal:Overridable="yes"/);
    assert.match(builder, /PreviousPrototypeInstallFolder/);
    assert.match(builder, /Condition="PreviousPrototypeInstallFolder"/);
    assert.match(builder, /PreviousLegacyInstallFolder/);
    assert.match(builder, /SOFTWARE\\\\OpenDesk\\\\Installer/);
    assert.match(builder, /Condition="PreviousLegacyInstallFolder AND NOT PreviousPrototypeInstallFolder"/);
    assert.match(builder, /<Media Id="1" Cabinet="product\.cab" EmbedCab="yes"/);
    assert.doesNotMatch(builder, /ThemeFile=/);
    assert.match(builder, /app-\$\{version\}/);
    assert.match(builder, /SilentUpdatePrototype/);
    assert.match(builder, /requiredArgument\('baseline-version'\)/);
    assert.match(builder, /requiredArgument\('candidate-version'\)/);
    assert.match(builder, /readArgument\('version'\)/);
    assert.match(builder, /readArgument\('app-dir'\)/);
    assert.match(builder, /singleVersionMode/);
    assert.match(builder, /additional-version/);
    assert.match(builder, /additional-app-dir/);
    assert.doesNotMatch(builder, /OPENDESK_TEST_TRUSTED_VERSION|TestTrustedVersion|TestTrustedSha256/);
    assert.match(builder, /TrustedSignerThumbprints/);
    assert.doesNotMatch(builder, /StoreName="trustedPeople"|CertificateTrust/);
    assert.match(builder, /signing-certificate-thumbprint/);
    assert.match(builder, /insignia\.exe/);
    assert.match(builder, /\['-nologo', '-ib', setupPath, '-o', enginePath\]/);
    assert.match(builder, /\['-nologo', '-ab', enginePath, setupPath, '-o', signedBundlePath\]/);
    assert.match(builder, /signAuthenticodeFile\(enginePath\)/);
    assert.match(builder, /signAuthenticodeFile\(signedBundlePath\)/);
    assert.match(builder, /verifyPackagedAppDirectory/);
    assert.match(builder, /embedded ASAR integrity/);
    assert.match(builder, /packed native modules/);
});

test('keeps silent service updates running while manual Setup upgrades close and remove the old version', () => {
    const bootstrapperPath = path.join(projectRoot, 'resources', 'package', 'bootstrapper', 'OpenDeskBootstrapper.cs');
    const bootstrapper = fs.readFileSync(bootstrapperPath, 'utf8');

    assert.match(
        bootstrapper,
        /GetSavedPrototypeInstallRoot\(\)[\s\S]*SilentUpdatePrototype[\s\S]*GetValue\("InstallRoot"\)/
    );
    assert.match(
        bootstrapper,
        /public string GetInstallFolder\(\)[\s\S]*GetSavedPrototypeInstallRoot\(\)[\s\S]*InstallerPath\.Normalize\(savedPrototypeInstallRoot\)[\s\S]*ResolveInitialDirectory/
    );

    assert.match(bootstrapper, /#if !SILENT_UPDATE_PROTOTYPE[\s\S]*EnsureOpenDeskIsNotRunning\(\)[\s\S]*#endif/);
    assert.match(
        bootstrapper,
        /#else[\s\S]*action == LaunchAction\.Uninstall[\s\S]*Command\.Relation == RelationType\.None[\s\S]*EnsureOpenDeskIsNotRunning\(\)/
    );
    assert.match(bootstrapper, /#else[\s\S]*IsManualInteractiveInstall\(action\)[\s\S]*EnsureOpenDeskIsNotRunning\(\)/);
    assert.match(
        bootstrapper,
        /IsManualInteractiveInstall\(LaunchAction action\)[\s\S]*action == LaunchAction\.Install[\s\S]*Command\.Display == Display\.Full[\s\S]*Command\.Relation == RelationType\.None/
    );
    assert.match(bootstrapper, /if \(closingFromEngine \|\| application\.RunsWithoutUserInteraction\)/);
    assert.match(
        bootstrapper,
        /#if SILENT_UPDATE_PROTOTYPE[\s\S]*installed = IsCurrentBundleRegistered\(\);[\s\S]*#endif/
    );
    assert.match(
        bootstrapper,
        /IsCurrentBundleRegistered\(\)[\s\S]*GetCurrentBundleId\(\)[\s\S]*CurrentVersion\\Uninstall/
    );
    assert.match(bootstrapper, /PlanPackageBegin \+= OnPlanPackageBegin/);
    assert.match(bootstrapper, /CleanupPrototypeInstallationsPackageId = "CleanupPrototypeInstallations"/);
    assert.match(bootstrapper, /CleanupRelatedBundlesPackageId = "CleanupRelatedBundles"/);
    assert.match(
        bootstrapper,
        /OnPlanPackageBegin[\s\S]*e\.PackageId == CleanupPrototypeInstallationsPackageId[\s\S]*Command\.Relation != RelationType\.None[\s\S]*RequestState\.None/
    );
    assert.doesNotMatch(bootstrapper, /BaselinePackageId|OpenDeskBaselineMsi/);
    assert.match(
        bootstrapper,
        /CleanupOldVersions\(\)[\s\S]*Environment\.GetCommandLineArgs\(\)[\s\S]*CleanupOldVersions=1/
    );
    assert.match(bootstrapper, /PackageId = "OpenDeskMsi"/);
    assert.match(bootstrapper, /PlatformPackageId = "OpenDeskPlatform"/);
    assert.match(
        bootstrapper,
        /OnPlanPackageBegin[\s\S]*activeAction == LaunchAction\.Install && e\.PackageId == PlatformPackageId[\s\S]*RequestState\.Repair/
    );
    assert.match(
        bootstrapper,
        /OnPlanPackageBegin[\s\S]*activeAction == LaunchAction\.Repair && !cleanupOldVersions[\s\S]*RequestState\.Repair/
    );
    assert.match(
        bootstrapper,
        /OnPlanPackageBegin[\s\S]*cleanupOldVersions[\s\S]*state == PackageState\.Present[\s\S]*RequestState\.Present/
    );
    assert.match(
        bootstrapper,
        /OnPlanRelatedBundle[\s\S]*CleanupOldVersions\(\)[\s\S]*IsManualInteractiveInstall\(activeAction\)[\s\S]*RequestState\.Absent[\s\S]*RequestState\.None/
    );
    assert.match(
        bootstrapper,
        /OnPlanPackageBegin[\s\S]*e\.PackageId == CleanupRelatedBundlesPackageId[\s\S]*!IsManualInteractiveInstall\(activeAction\)[\s\S]*RequestState\.None/
    );
    assert.match(bootstrapper, /IsManualInteractiveInstall\(action\)[\s\S]*EnsureOpenDeskIsNotRunning\(\)/);
    assert.match(bootstrapper, /FindLegacyMsiProductCode\(\)[\s\S]*MsiEnumRelatedProducts[\s\S]*LegacyMsiUpgradeCode/);
    assert.match(
        bootstrapper,
        /OnDetectComplete[\s\S]*string legacyProductCode = FindLegacyMsiProductCode\(\)[\s\S]*relatedMsiUpgradeDetected = true[\s\S]*RestoreRelatedMsiInstallFolder\(legacyProductCode\)[\s\S]*ShowDetected/
    );
    assert.match(
        bootstrapper,
        /FindRelatedMsiInstallFolder[\s\S]*productCode \+ "\.msq"[\s\S]*RegistryView\.Registry32[\s\S]*key\.GetValue\("InstallPath"\)/
    );
});

test('bundle cleanup only accepts the declared OpenDesk Bundle family', () => {
    const cleanupPath = path.join(projectRoot, 'resources', 'package', 'bootstrapper', 'CleanupRelatedBundles.cs');
    const cleanup = fs.readFileSync(cleanupPath, 'utf8');

    assert.match(cleanup, /BundleUpgradeCode = "e7b412c3-02cc-4ed8-9fcb-5d33fe3390e4"/);
    assert.match(cleanup, /LegacyMsiUpgradeCode = "\{017F8634-A16C-4194-8C94-D9A3F1319D13\}"/);
    assert.match(cleanup, /MsiEnumRelatedProducts/);
    assert.match(cleanup, /CleanupOldMsiProducts\(currentVersion\)/);
    assert.match(cleanup, /msiexec\.exe/);
    assert.match(cleanup, /\/x /);
    assert.match(cleanup, /\/qn \/norestart/);
    assert.match(cleanup, /if \(upgradeCodes != null\)[\s\S]*BundleUpgradeCode[\s\S]*return false;[\s\S]*DisplayName/);
});

test('runs quiet bundles without creating a Windows Forms UI in the service session', () => {
    const bootstrapperPath = path.join(projectRoot, 'resources', 'package', 'bootstrapper', 'OpenDeskBootstrapper.cs');
    const bootstrapper = fs.readFileSync(bootstrapperPath, 'utf8');

    assert.match(
        bootstrapper,
        /Run\(\)[\s\S]*?if \(RunsWithoutUserInteraction\)[\s\S]*?RunHeadless\(\);[\s\S]*?return;/
    );
    assert.match(
        bootstrapper,
        /RunHeadless\(\)[\s\S]*?Engine\.Detect\(IntPtr\.Zero\);[\s\S]*?headlessCompletion\.WaitOne\(\)/
    );
    assert.match(bootstrapper, /OnDetectComplete[\s\S]*?RunsWithoutUserInteraction[\s\S]*?StartAction\(action\)/);
    assert.match(bootstrapper, /OnPlanComplete[\s\S]*?RunsWithoutUserInteraction[\s\S]*?Engine\.Apply\(IntPtr\.Zero\)/);
    assert.match(bootstrapper, /OnApplyComplete[\s\S]*?CompleteHeadless\(\)/);
});

test('formal uninstall cleanup only removes registered prototype MSI products through Windows Installer', () => {
    const cleanupPath = path.join(
        projectRoot,
        'scripts',
        'windows-silent-update-prototype',
        'CleanupPrototypeInstallations.cs'
    );
    const cleanup = fs.readFileSync(cleanupPath, 'utf8');

    assert.match(cleanup, /DisplayName/);
    assert.match(cleanup, /\(silent-update prototype\)/);
    assert.match(cleanup, /msiexec\.exe/);
    assert.match(cleanup, /\/x/);
    assert.match(cleanup, /\/qn/);
    assert.match(cleanup, /RegistryView\.Registry64/);
    assert.match(cleanup, /CleanupAgentV2/);
    assert.match(cleanup, /LegacyMarkerKey/);
    assert.match(cleanup, /RegistryView\.Registry32/);
    assert.doesNotMatch(cleanup, /Directory\.Delete\([^,]+,\s*true\)/);
});

test('uses a stable launcher state record instead of selecting the largest app directory', () => {
    const launcherPath = path.join(projectRoot, 'scripts', 'windows-silent-update-prototype', 'OpenDeskLauncher.cs');
    const launcher = fs.readFileSync(launcherPath, 'utf8');

    assert.match(launcher, /SilentUpdatePrototype/);
    assert.match(launcher, /ActiveVersion/);
    assert.match(launcher, /app-" \+ activeVersion/);
    assert.match(launcher, /QuoteArgument/);
    assert.match(launcher, /WaitForPreviousProcess\(args\)/);
    assert.match(launcher, /--wait-for-pid/);
    assert.match(launcher, /String\.Join\(" ", Array\.ConvertAll\(forwardedArguments, QuoteArgument\)\)/);
    assert.doesNotMatch(launcher, /Directory\.GetDirectories|OrderByDescending|\bnew Version\(/);
});
