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

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

const require = createRequire(import.meta.url);
const { load: loadResedit } = require('resedit/cjs');

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const wixDirectory = process.env.WIX_BIN_DIR || 'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin';
const wixSdkDirectory = process.env.WIX_SDK_DIR || 'C:\\Program Files (x86)\\WiX Toolset v3.14\\SDK';
const csharpCompiler = process.env.CSC_PATH || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const bootstrapperResourcesDirectory = path.join(projectRoot, 'resources', 'package', 'bootstrapper');
const iconPath = path.join(projectRoot, 'resources', 'package', 'icons', 'icon_round.ico');
const serviceBuilderPath = path.join(projectRoot, 'scripts', 'windows-update-service', 'build-service.mjs');
// The current WiX v3 MSI templates remain x64; use the requested target only
// to select the matching Dokan payload in the bootstrapper chain.
const targetWindowsArch = process.env.OPENDESK_WIX_ARCH || 'x64';
if (targetWindowsArch !== 'x64' && targetWindowsArch !== 'arm64') {
    throw new Error(`Unsupported OPENDESK_WIX_ARCH: ${targetWindowsArch}`);
}
const targetWindowsRid = targetWindowsArch === 'arm64' ? 'win-arm64' : 'win-x64';
const dokanMsiPath = path.resolve(
    process.env.OPENDESK_DOKAN_MSI_PATH ||
        path.join(projectRoot, 'native', 'windows', 'sandbox', 'dist', targetWindowsRid, 'bin', 'DokanSetup.msi')
);

function readArgument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    return value;
}

function requiredArgument(name) {
    const value = readArgument(name);
    if (!value) throw new Error(`Missing required --${name} argument`);
    return value;
}

function assertVersion(version, name) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`${name} must be a three-part stable version`);
    }
    return version;
}

function run(executable, args, cwd) {
    const result = spawnSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error) throw new Error(`Failed to start ${executable}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${path.basename(executable)} failed:\n${result.stdout}${result.stderr}`);
}

function xml(value) {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function productCode(seed) {
    const hash = createHash('sha256').update(seed).digest('hex');
    return `{${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}}`;
}

function collectPackedNativeModules(node, currentPath = '') {
    const packed = [];
    for (const [name, entry] of Object.entries(node.files || {})) {
        const entryPath = `${currentPath}/${name}`;
        if (entryPath.endsWith('.node') && !entry.unpacked) {
            packed.push(entryPath);
        }
        packed.push(...collectPackedNativeModules(entry, entryPath));
    }
    return packed;
}

async function verifyPackagedAppDirectory(appDirectory, expectedVersion) {
    const asarPath = path.join(appDirectory, 'resources', 'app.asar');
    const executablePath = path.join(appDirectory, 'opendesk.exe');
    const rawHeader = asar.getRawHeader(asarPath);
    const actualIntegrity = createHash('sha256').update(rawHeader.headerString).digest('hex');
    const packageJson = JSON.parse(asar.extractFile(asarPath, 'package.json').toString());
    if (packageJson.version !== expectedVersion) {
        throw new Error(`Packaged version mismatch: expected ${expectedVersion}, got ${packageJson.version}`);
    }

    const resedit = await loadResedit();
    const executable = resedit.NtExecutable.from(fs.readFileSync(executablePath));
    const resources = resedit.NtExecutableResource.from(executable);
    const integrityResource = resources.entries.find(
        (entry) => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR'
    );
    if (!integrityResource) {
        throw new Error(`Missing embedded ASAR integrity in ${executablePath}`);
    }
    const integrityRecords = JSON.parse(Buffer.from(integrityResource.bin).toString('utf8'));
    const appIntegrity = integrityRecords.find((entry) => entry.file.toLowerCase() === 'resources\\app.asar');
    if (!appIntegrity || appIntegrity.alg !== 'SHA256' || appIntegrity.value !== actualIntegrity) {
        throw new Error(`Invalid embedded ASAR integrity in ${executablePath}`);
    }

    const packedNativeModules = collectPackedNativeModules(rawHeader.header);
    if (packedNativeModules.length > 0) {
        throw new Error(`Packaged ASAR contains packed native modules: ${packedNativeModules.join(', ')}`);
    }
}

function wixProduct({ id, name, version, body, featureRefs, packageCode }) {
    return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi" xmlns:util="http://schemas.microsoft.com/wix/UtilExtension">
  <Product Id="${id}" UpgradeCode="{0E0C2E6A-34E1-4DA7-919D-A5BE5EF4C045}" Name="${name}" Version="${version}" Manufacturer="OpenDesk Team, Openharmony" Language="1033" Codepage="65001">
    <Package${packageCode ? ` Id="${packageCode}"` : ''} InstallerVersion="405" Compressed="yes" InstallScope="perMachine" Platform="x64" />
    <Media Id="1" Cabinet="product.cab" EmbedCab="yes" CompressionLevel="high" />
    <Property Id="ARPSYSTEMCOMPONENT" Value="1" />
    <Property Id="APPLICATIONROOTDIRECTORY" Secure="yes" />
    <Property Id="OPENDESK_BUNDLE_PROVIDER_KEY" Secure="yes" />
    <Property Id="OPENDESK_DISPLAY_VERSION" Secure="yes" />
    <Property Id="OPENDESK_TARGET_VERSION" Secure="yes" />
    <Property Id="REBOOT" Value="ReallySuppress" />
${body}
    <Feature Id="Complete" Title="OpenDesk silent-update prototype" Level="1">
${featureRefs}
    </Feature>
  </Product>
</Wix>
`;
}

function platformSource({ launcherPath, servicePath }) {
    const body = `    <Icon Id="OpenDeskIcon" SourceFile="${xml(iconPath)}" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="APPLICATIONROOTDIRECTORY" Name="opendesk">
          <Component Id="StableLauncher" Guid="${productCode('platform:4:launcher')}" Win64="yes">
            <File Id="OpenDeskLauncher" Source="${xml(launcherPath)}" Name="opendesk.exe" KeyPath="yes" />
            <RegistryValue Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype" Name="InstallRoot" Value="[APPLICATIONROOTDIRECTORY]" Type="string" />
            <RegistryValue Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype" Name="ActiveVersion" Value="[OPENDESK_TARGET_VERSION]" Type="string" />
            <RemoveFile Id="RemoveMisplacedActiveVersionFile" Directory="WindowsFolder" Name="active-version.txt" On="install" />
            <IniFile Id="ActiveVersionText" Name="active-version.txt" Directory="APPLICATIONROOTDIRECTORY" Section="OpenDesk" Key="ActiveVersion" Value="[OPENDESK_TARGET_VERSION]" Action="addLine" />
          </Component>
          <Directory Id="OpenDeskUpdateServiceDirectory" Name="update-service" />
        </Directory>
      </Directory>
      <Directory Id="CommonAppDataFolder">
        <Directory Id="OpenDeskProgramDataDirectory" Name="OpenDesk">
          <Directory Id="OpenDeskUpdateDataDirectory" Name="UpdateService" />
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder"><Directory Id="OpenDeskPrograms" Name="OpenDesk" /></Directory>
      <Directory Id="LegacyShortcutFolder" Name="OpenDesk" />
      <Directory Id="WindowsFolder" Name="." />
    </Directory>
    <DirectoryRef Id="OpenDeskPrograms">
      <Component Id="OpenDeskShortcut" Guid="${productCode('platform:4:shortcut')}" Win64="yes">
        <Shortcut Id="OpenDeskStartMenuShortcut" Name="OpenDesk" Target="[APPLICATIONROOTDIRECTORY]opendesk.exe" WorkingDirectory="APPLICATIONROOTDIRECTORY" Icon="OpenDeskIcon" />
        <RemoveFolder Id="OpenDeskPrograms" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\\OpenDesk\\SilentUpdatePrototype" Name="ShortcutInstalled" Value="1" Type="integer" KeyPath="yes" />
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="OpenDeskUpdateServiceDirectory">
      <Component Id="OpenDeskUpdateServiceComponent" Guid="${productCode('platform:4:update-service')}" Win64="yes" NeverOverwrite="yes">
        <File Id="OpenDeskUpdateServiceExecutable" Source="${xml(servicePath)}" Name="OpenDeskUpdateService.exe" KeyPath="yes" />
        <ServiceInstall Id="InstallOpenDeskUpdateService" Name="OpenDeskUpdateService" DisplayName="OpenDesk Update Service" Description="Installs trusted OpenDesk updates in the background." Type="ownProcess" Start="auto" ErrorControl="normal" Account="LocalSystem" Vital="yes" />
        <ServiceControl Id="ControlOpenDeskUpdateService" Name="OpenDeskUpdateService" Start="install" Stop="uninstall" Remove="uninstall" Wait="yes" />
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="OpenDeskUpdateDataDirectory">
      <Component Id="OpenDeskUpdateDataDirectoryComponent" Guid="${productCode('platform:4:update-data')}" Win64="yes">
        <CreateFolder>
          <util:PermissionEx User="SYSTEM" GenericAll="yes" />
          <util:PermissionEx User="Administrators" GenericAll="yes" />
        </CreateFolder>
        <RegistryValue Root="HKLM" Key="SOFTWARE\\OpenDesk\\UpdateService" Name="DataDirectoryInstalled" Value="1" Type="integer" KeyPath="yes" />
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="LegacyShortcutFolder">
      <Component Id="LegacyShortcutCleanup" Guid="${productCode('platform:4:legacy-shortcut-cleanup')}" Win64="yes">
        <RemoveFile Id="RemoveMisplacedShortcut" Name="OpenDesk.lnk" On="install" />
        <RemoveFolder Id="RemoveMisplacedShortcutFolder" On="install" />
        <RegistryValue Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype" Name="PlatformRevision" Value="4" Type="integer" KeyPath="yes" />
      </Component>
    </DirectoryRef>`;
    return wixProduct({
        id: productCode('platform:4'),
        name: 'OpenDesk Platform (silent-update prototype)',
        version: '4.0.0',
        packageCode: productCode('platform-package:4'),
        body,
        featureRefs:
            '      <ComponentRef Id="StableLauncher" />\n      <ComponentRef Id="OpenDeskShortcut" />\n      <ComponentRef Id="OpenDeskUpdateServiceComponent" />\n      <ComponentRef Id="OpenDeskUpdateDataDirectoryComponent" />\n      <ComponentRef Id="LegacyShortcutCleanup" />'
    });
}

function versionSource(version) {
    const directoryId = `APP_${version.replaceAll('.', '_')}`;
    const body = `    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder"><Directory Id="APPLICATIONROOTDIRECTORY" Name="opendesk"><Directory Id="${directoryId}" Name="app-${version}" /></Directory></Directory>
    </Directory>
    <DirectoryRef Id="APPLICATIONROOTDIRECTORY">
      <Component Id="BundleRegistration" Guid="${productCode(`active:3:${version}`)}" Win64="yes">
        <RegistryValue Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype\\Versions\\${version}" Name="Installed" Value="1" Type="integer" KeyPath="yes" />
        <RegistryValue Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype\\Versions\\${version}" Name="ProductCode" Value="[ProductCode]" Type="string" />
        <RegistryValue Root="HKLM" Key="SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[OPENDESK_BUNDLE_PROVIDER_KEY]" Name="DisplayVersion" Value="[OPENDESK_DISPLAY_VERSION]" Type="string" />
        <RegistryValue Root="HKLM" Key="SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[OPENDESK_BUNDLE_PROVIDER_KEY]" Name="BundleVersion" Value="[OPENDESK_DISPLAY_VERSION]" Type="string" />
      </Component>
    </DirectoryRef>`;
    return {
        directoryId,
        source: wixProduct({
            id: productCode(`version:3:${version}`),
            name: `OpenDesk ${version} (silent-update prototype)`,
            version,
            body,
            featureRefs: '      <ComponentRef Id="BundleRegistration" />\n      <ComponentGroupRef Id="AppPayload" />'
        })
    };
}

function bundleSource({
    version,
    platformMsi,
    versionMsi,
    cleanupExecutable,
    legacyBundleCleanupExecutable,
    dokanMsi
}) {
    return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi" xmlns:bal="http://schemas.microsoft.com/wix/BalExtension" xmlns:util="http://schemas.microsoft.com/wix/UtilExtension">
  <Bundle Name="OpenDesk" Version="${version}" Manufacturer="OpenDesk Team, Openharmony" UpgradeCode="{E7B412C3-02CC-4ED8-9FCB-5D33FE3390E4}" IconSourceFile="${xml(iconPath)}" Compressed="yes">
    <WixVariable Id="WixMbaPrereqPackageId" Value="" />
    <WixVariable Id="WixMbaPrereqLicenseUrl" Value="" />
    <BootstrapperApplicationRef Id="ManagedBootstrapperApplicationHost">
      <Payload SourceFile="${xml(path.join(outputDirectory, 'OpenDesk.Bootstrapper.dll'))}" Name="OpenDesk.Bootstrapper.dll" />
      <Payload SourceFile="${xml(path.join(bootstrapperResourcesDirectory, 'BootstrapperCore.config'))}" Name="BootstrapperCore.config" />
      <Payload SourceFile="${xml(path.join(bootstrapperResourcesDirectory, 'background.png'))}" Name="background.png" />
      <Payload SourceFile="${xml(iconPath)}" Name="opendesk.ico" />
      <Payload SourceFile="${xml(path.join(bootstrapperResourcesDirectory, 'zh-cn.wxl'))}" Name="zh-cn.wxl" />
    </BootstrapperApplicationRef>
    <Variable Name="OpenDeskDisplayVersion" Type="string" Value="${version}" />
    <Variable Name="InstallFolder" Type="string" Value="[ProgramFiles64Folder]opendesk" bal:Overridable="yes" />
    <Variable Name="RequiredInstallSize" Type="numeric" Value="0" bal:Overridable="no" />
    <Variable Name="CreateDesktopShortcut" Type="numeric" Value="1" bal:Overridable="yes" />
    <Variable Name="CreateStartMenuShortcut" Type="numeric" Value="1" bal:Overridable="yes" />
    <Variable Name="InstallPathCustomized" Type="numeric" Value="0" bal:Overridable="yes" />
    <Variable Name="CleanupOldVersions" Type="numeric" Value="0" bal:Overridable="yes" />
    <Variable Name="IGNOREDEPENDENCIES" Type="string" Value="" Hidden="yes" />
    <Variable Name="LegacyBundleCleanupDetect" Type="numeric" Value="0" Hidden="yes" />
    <util:RegistrySearch Id="FindCleanupAgent" Variable="CleanupAgentInstalled" Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype\\CleanupAgentV2" Value="Installed" Result="value" Format="raw" Win64="yes" />
    <util:RegistrySearch Id="FindLegacyInstallFolder" Variable="PreviousLegacyInstallFolder" Root="HKLM" Key="SOFTWARE\\OpenDesk\\Installer" Value="InstallPath" Result="value" Format="raw" Win64="yes" />
    <util:RegistrySearch Id="FindPrototypeInstallFolder" Variable="PreviousPrototypeInstallFolder" Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype" Value="InstallRoot" Result="value" Format="raw" Win64="yes" />
    <util:RegistrySearch Id="RestoreLegacyInstallFolder" Variable="InstallFolder" Condition="PreviousLegacyInstallFolder AND NOT PreviousPrototypeInstallFolder" After="FindPrototypeInstallFolder" Root="HKLM" Key="SOFTWARE\\OpenDesk\\Installer" Value="InstallPath" Result="value" Format="raw" Win64="yes" />
    <util:RegistrySearch Id="RestorePrototypeInstallFolder" Variable="InstallFolder" Condition="PreviousPrototypeInstallFolder" After="RestoreLegacyInstallFolder" Root="HKLM" Key="SOFTWARE\\OpenDesk\\SilentUpdatePrototype" Value="InstallRoot" Result="value" Format="raw" Win64="yes" />
    <util:FileSearch Id="FindDokanVersion" Variable="DokanVersion" Path="[SystemFolder]dokan2.dll" Result="version" />
    <Chain>
      <MsiPackage Id="DokanMsi" SourceFile="${xml(dokanMsi)}" InstallCondition="NOT DokanVersion OR DokanVersion &lt; v2.3.1.1000" ForcePerMachine="yes" DisplayInternalUI="no" Visible="no" Vital="yes" Permanent="yes" />
      <ExePackage Id="CleanupPrototypeInstallations" SourceFile="${xml(cleanupExecutable)}" PerMachine="yes" Vital="yes" Compressed="yes" DetectCondition="CleanupAgentInstalled" InstallCommand="--register" RepairCommand="--register" UninstallCommand="--uninstall-all" />
      <ExePackage Id="CleanupRelatedBundles" SourceFile="${xml(legacyBundleCleanupExecutable)}" PerMachine="yes" Vital="yes" Compressed="yes" DetectCondition="LegacyBundleCleanupDetect" InstallCommand="[WixBundleVersion] [WixBundleProviderKey]" RepairCommand="[WixBundleVersion] [WixBundleProviderKey]" UninstallCommand="/noop" />
      <MsiPackage Id="OpenDeskPlatform" SourceFile="${xml(platformMsi)}" ForcePerMachine="yes" Visible="no">
        <MsiProperty Name="APPLICATIONROOTDIRECTORY" Value="[InstallFolder]" />
        <MsiProperty Name="OPENDESK_TARGET_VERSION" Value="[OpenDeskDisplayVersion]" />
        <MsiProperty Name="IGNOREDEPENDENCIES" Value="[IGNOREDEPENDENCIES]" />
      </MsiPackage>
      <MsiPackage Id="OpenDeskMsi" SourceFile="${xml(versionMsi)}" ForcePerMachine="yes" Visible="no">
        <MsiProperty Name="APPLICATIONROOTDIRECTORY" Value="[InstallFolder]" />
        <MsiProperty Name="OPENDESK_BUNDLE_PROVIDER_KEY" Value="[WixBundleProviderKey]" />
        <MsiProperty Name="OPENDESK_DISPLAY_VERSION" Value="[OpenDeskDisplayVersion]" />
        <MsiProperty Name="IGNOREDEPENDENCIES" Value="[IGNOREDEPENDENCIES]" />
      </MsiPackage>
    </Chain>
  </Bundle>
</Wix>
`;
}

function compileMsi(sourcePath, harvestPath, outputPath, sourceDirectory) {
    const candle = path.join(wixDirectory, 'candle.exe');
    const light = path.join(wixDirectory, 'light.exe');
    run(
        candle,
        ['-nologo', '-arch', 'x64', '-ext', 'WixUtilExtension', '-out', `${sourcePath}.wixobj`, sourcePath],
        projectRoot
    );
    run(
        candle,
        [
            '-nologo',
            '-arch',
            'x64',
            '-ext',
            'WixUtilExtension',
            `-dSourceDir=${sourceDirectory}`,
            '-out',
            `${harvestPath}.wixobj`,
            harvestPath
        ],
        projectRoot
    );
    run(
        light,
        ['-nologo', '-ext', 'WixUtilExtension', '-out', outputPath, `${sourcePath}.wixobj`, `${harvestPath}.wixobj`],
        projectRoot
    );
}

function compileBundle(sourcePath, outputPath) {
    const candle = path.join(wixDirectory, 'candle.exe');
    const light = path.join(wixDirectory, 'light.exe');
    run(
        candle,
        ['-nologo', '-ext', 'WixBalExtension', '-ext', 'WixUtilExtension', '-out', `${sourcePath}.wixobj`, sourcePath],
        projectRoot
    );
    run(
        light,
        ['-nologo', '-ext', 'WixBalExtension', '-ext', 'WixUtilExtension', '-out', outputPath, `${sourcePath}.wixobj`],
        projectRoot
    );
}

function buildVersionMsi({ version, appDirectory, outputDirectory }) {
    const { directoryId, source } = versionSource(version);
    const sourcePath = path.join(outputDirectory, `opendesk-${version}.wxs`);
    const harvestPath = path.join(outputDirectory, `opendesk-${version}-payload.wxs`);
    const msiPath = path.join(outputDirectory, `OpenDesk-${version}-version.msi`);
    fs.writeFileSync(sourcePath, source);
    run(
        path.join(wixDirectory, 'heat.exe'),
        [
            'dir',
            '.',
            '-cg',
            'AppPayload',
            '-dr',
            directoryId,
            '-srd',
            '-sreg',
            '-gg',
            '-var',
            'var.SourceDir',
            '-out',
            harvestPath
        ],
        appDirectory
    );
    compileMsi(sourcePath, harvestPath, msiPath, appDirectory);
    return msiPath;
}

const version = assertVersion(requiredArgument('version'), 'version');
const appDirectory = path.resolve(requiredArgument('app-dir'));
const outputDirectory = path.resolve(readArgument('output-dir', path.join(projectRoot, 'out', 'make', 'wix', 'x64')));
if (!fs.existsSync(path.join(appDirectory, 'opendesk.exe')))
    throw new Error(`Packaged OpenDesk executable not found in ${appDirectory}`);
if (!fs.existsSync(dokanMsiPath)) {
    throw new Error(`Dokan MSI not found: ${dokanMsiPath}. Run npm run build:sandbox first.`);
}
await verifyPackagedAppDirectory(appDirectory, version);
fs.mkdirSync(outputDirectory, { recursive: true });

run(process.execPath, [serviceBuilderPath, '--output-dir', outputDirectory], projectRoot);
const servicePath = path.join(outputDirectory, 'OpenDeskUpdateService.exe');

const launcherPath = path.join(outputDirectory, 'opendesk.exe');
run(
    csharpCompiler,
    [
        '/nologo',
        '/target:winexe',
        '/optimize+',
        '/platform:x64',
        `/win32icon:${iconPath}`,
        `/out:${launcherPath}`,
        path.join(projectRoot, 'resources', 'package', 'windows-installer', 'OpenDeskLauncher.cs')
    ],
    projectRoot
);
const cleanupExecutable = path.join(outputDirectory, 'CleanupPrototypeInstallations.exe');
run(
    csharpCompiler,
    [
        '/nologo',
        '/target:exe',
        '/optimize+',
        '/platform:x64',
        `/out:${cleanupExecutable}`,
        path.join(projectRoot, 'resources', 'package', 'windows-installer', 'CleanupOpenDeskInstallations.cs')
    ],
    projectRoot
);
const legacyBundleCleanupExecutable = path.join(outputDirectory, 'CleanupRelatedBundles.exe');
run(
    csharpCompiler,
    [
        '/nologo',
        '/target:exe',
        '/optimize+',
        '/platform:x64',
        `/out:${legacyBundleCleanupExecutable}`,
        path.join(bootstrapperResourcesDirectory, 'CleanupRelatedBundles.cs')
    ],
    projectRoot
);
const bootstrapperAssemblyPath = path.join(outputDirectory, 'OpenDesk.Bootstrapper.dll');
run(
    csharpCompiler,
    [
        '/nologo',
        '/target:library',
        '/optimize+',
        '/platform:x86',
        '/define:SILENT_UPDATE_PROTOTYPE',
        `/out:${bootstrapperAssemblyPath}`,
        `/reference:${path.join(wixSdkDirectory, 'BootstrapperCore.dll')}`,
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Xml.Linq.dll',
        path.join(bootstrapperResourcesDirectory, 'OpenDeskBootstrapper.cs')
    ],
    projectRoot
);
const platformSourcePath = path.join(outputDirectory, 'opendesk-platform.wxs');
const platformMsiPath = path.join(outputDirectory, 'OpenDesk-platform.msi');
fs.writeFileSync(platformSourcePath, platformSource({ launcherPath, servicePath }));
run(
    path.join(wixDirectory, 'candle.exe'),
    ['-nologo', '-arch', 'x64', '-ext', 'WixUtilExtension', '-out', `${platformSourcePath}.wixobj`, platformSourcePath],
    projectRoot
);
run(
    path.join(wixDirectory, 'light.exe'),
    ['-nologo', '-ext', 'WixUtilExtension', '-out', platformMsiPath, `${platformSourcePath}.wixobj`],
    projectRoot
);

function buildBundle({ version, versionMsiPath }) {
    const sourcePath = path.join(outputDirectory, `OpenDesk-${version}-Setup.wxs`);
    const setupPath = path.join(outputDirectory, `OpenDesk-${version}-Setup.exe`);
    fs.writeFileSync(
        sourcePath,
        bundleSource({
            version,
            platformMsi: platformMsiPath,
            versionMsi: versionMsiPath,
            cleanupExecutable,
            legacyBundleCleanupExecutable,
            dokanMsi: dokanMsiPath
        })
    );
    compileBundle(sourcePath, setupPath);
    return { version, setupPath, versionMsiPath };
}

const versionMsiPath = buildVersionMsi({ version, appDirectory, outputDirectory });
const bundle = buildBundle({ version, versionMsiPath });
const bundles = [bundle];

console.log(JSON.stringify({ outputDirectory, platformMsiPath, bundles }, null, 2));
