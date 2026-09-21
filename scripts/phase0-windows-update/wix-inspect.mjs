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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStringPromise } from 'xml2js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const darkExecutable = 'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin\\dark.exe';

function readArgument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    return value;
}

function decompileMsi(sourcePath, outputPath, extractionDirectory) {
    const result = spawnSync(darkExecutable, ['-nologo', '-x', extractionDirectory, '-o', outputPath, sourcePath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0) {
        throw new Error(`dark.exe failed for ${sourcePath}:\n${result.stdout}${result.stderr}`);
    }
}

function extractBundle(sourcePath, extractionDirectory) {
    const result = spawnSync(darkExecutable, ['-nologo', '-x', extractionDirectory, sourcePath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0) {
        throw new Error(`dark.exe failed for ${sourcePath}:\n${result.stdout}${result.stderr}`);
    }
}

function asArray(value) {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

async function inspectMsi(wxsPath) {
    const xml = await fs.promises.readFile(wxsPath, 'utf8');
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const product = parsed.Wix?.Product;
    if (!product) throw new Error('Decompiled MSI does not contain a WiX Product');
    const properties = asArray(product.Property);
    const propertyValues = Object.fromEntries(
        properties.filter((entry) => entry.$?.Id).map((entry) => [entry.$.Id, entry.$?.Value])
    );
    return {
        productCode: product.$?.Id,
        upgradeCode: product.$?.UpgradeCode,
        version: product.$?.Version,
        manufacturer: product.$?.Manufacturer,
        package: product.Package?.$ ?? {},
        hasMajorUpgrade: product.MajorUpgrade !== undefined,
        allowsSameVersionUpgrade: product.MajorUpgrade?.$?.AllowSameVersionUpgrades === 'yes',
        allUsers: propertyValues.ALLUSERS,
        msiInstallPerUser: propertyValues.MSIINSTALLPERUSER,
        rebootPolicy: propertyValues.REBOOT,
        hasInstallPathProperty: properties.some((entry) => entry.$?.Id === 'INSTALLPATH'),
        hasApplicationRootDirectoryProperty: properties.some((entry) => entry.$?.Id === 'APPLICATIONROOTDIRECTORY'),
        hasBundleInstallProperty: properties.some((entry) => entry.$?.Id === 'OPENDESK_BUNDLE_INSTALL')
    };
}

async function inspectBundle(manifestPath) {
    const xml = await fs.promises.readFile(manifestPath, 'utf8');
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const manifest = parsed.BurnManifest;
    if (!manifest) throw new Error('Extracted setup does not contain a Burn manifest');
    const variables = asArray(manifest.Variable);
    const registration = manifest.Registration?.$ ?? {};
    const relatedBundle = asArray(manifest.RelatedBundle).find((entry) => entry.$?.Action === 'Upgrade');
    return {
        registrationId: registration.Id,
        version: registration.Version,
        executableName: registration.ExecutableName,
        perMachine: registration.PerMachine,
        upgradeCode: relatedBundle?.$?.Id,
        embeddedMsiBytes: Number(manifest.Payload?.$?.FileSize ?? 0),
        variables: variables.map((entry) => entry.$?.Id).filter(Boolean)
    };
}

if (!fs.existsSync(darkExecutable)) throw new Error(`WiX dark.exe was not found: ${darkExecutable}`);
const msiPath = path.resolve(readArgument('msi', path.join(projectRoot, 'out', 'make', 'wix', 'x64', 'opendesk.msi')));
const bundlePath = path.resolve(readArgument('bundle', path.join(path.dirname(msiPath), `OpenDesk-0.3.4-Setup.exe`)));
const outputPath = path.resolve(
    readArgument('output', path.join(projectRoot, 'out', 'phase0-update', 'wix-inspection.json'))
);
for (const artifact of [msiPath, bundlePath]) {
    if (!fs.existsSync(artifact)) throw new Error(`WiX artifact was not found: ${artifact}`);
}

const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opendesk-phase0-wix-'));
try {
    const msiWxs = path.join(temporaryRoot, 'msi.wxs');
    const bundleExtraction = path.join(temporaryRoot, 'bundle-files');
    decompileMsi(msiPath, msiWxs, path.join(temporaryRoot, 'msi-files'));
    extractBundle(bundlePath, bundleExtraction);
    const report = {
        generatedAt: new Date().toISOString(),
        msiPath,
        bundlePath,
        msi: await inspectMsi(msiWxs),
        bundle: await inspectBundle(path.join(bundleExtraction, 'UX', 'manifest.xml')),
        systemInstallAttempted: false,
        note: 'This command only decompiles and inspects artifacts. It does not execute MSI or Burn installation.'
    };
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
} finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const resolvedOsTemporaryRoot = path.resolve(os.tmpdir());
    if (resolvedTemporaryRoot.startsWith(`${resolvedOsTemporaryRoot}${path.sep}opendesk-phase0-wix-`)) {
        await fs.promises.rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
}
