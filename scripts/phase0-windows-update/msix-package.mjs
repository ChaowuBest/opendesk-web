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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronWindowsMsix from 'electron-windows-msix';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

function readArgument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for --${name}`);
    }
    return value;
}

function toWindowsVersion(version) {
    const numeric = version.split('-')[0].split('.');
    if (numeric.some((part) => !/^\d+$/.test(part))) {
        throw new Error(`Invalid package version: ${version}`);
    }
    return numeric.concat(['0', '0', '0', '0']).slice(0, 4).join('.');
}

function findWindowsKitPath() {
    const root = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
    const versions = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
        const candidate = path.join(root, version, 'x64');
        if (fs.existsSync(path.join(candidate, 'makeappx.exe'))) {
            return candidate;
        }
    }
    throw new Error('Windows SDK makeappx.exe was not found');
}

const appDir = path.resolve(readArgument('app-dir', path.join(projectRoot, 'out', 'opendesk-win32-x64')));
const outputDir = path.resolve(readArgument('output-dir', path.join(projectRoot, 'out', 'phase0-update', 'msix')));
const packageVersion = toWindowsVersion(readArgument('version', packageJson.version));
const packageName = readArgument('package-name', `OpenDesk-${packageVersion}-unsigned.msix`);
const executablePath = path.join(appDir, 'opendesk.exe');

if (!fs.existsSync(executablePath)) {
    throw new Error(`Packaged OpenDesk executable was not found: ${executablePath}`);
}

fs.mkdirSync(outputDir, { recursive: true });

const { packageMSIX } = electronWindowsMsix;
const result = await packageMSIX({
    appDir,
    outputDir,
    packageName,
    windowsKitPath: findWindowsKitPath(),
    createPri: false,
    sign: false,
    logLevel: 'warn',
    manifestVariables: {
        publisher: 'CN=OpenDesk Phase0',
        publisherDisplayName: 'OpenDesk Phase 0',
        packageIdentity: 'OpenDesk.Phase0',
        packageVersion,
        packageDisplayName: 'OpenDesk Phase 0',
        packageDescription: 'OpenDesk MSIX compatibility package for Phase 0 testing',
        packageBackgroundColor: '#ffffff',
        appExecutable: 'opendesk.exe',
        appDisplayName: 'OpenDesk Phase 0',
        targetArch: 'x64',
        packageMinOSVersion: '10.0.19041.0',
        packageMaxOSVersionTested: '10.0.26100.0'
    }
});

const artifact = path.resolve(result.msixPackage);
const summary = {
    artifact,
    artifactBytes: fs.statSync(artifact).size,
    appDir,
    packageVersion,
    signed: false,
    installAttempted: false
};
console.log(JSON.stringify(summary, null, 2));
