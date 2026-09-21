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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const packagedAppDirectory = path.resolve(
    process.env.OPENDESK_STAGED_APP_DIR || path.join(projectRoot, 'out', 'opendesk-win32-x64')
);
const outputDirectory = path.resolve(
    process.env.OPENDESK_SETUP_OUT_DIR || path.join(projectRoot, 'out', 'make', 'wix', 'x64')
);
const installerBuilder = path.join(scriptDirectory, 'windows-installer', 'build-installer.mjs');

if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json version must be a three-part stable version, got ${version}`);
}
if (!fs.existsSync(path.join(packagedAppDirectory, 'opendesk.exe'))) {
    throw new Error(
        `Packaged application not found: ${packagedAppDirectory}\n` +
            'Run "electron-forge make --platform=win32" before building the bootstrapper.'
    );
}

const result = spawnSync(
    process.execPath,
    [installerBuilder, '--version', version, '--app-dir', packagedAppDirectory, '--output-dir', outputDirectory],
    {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'inherit'
    }
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const setupPath = path.join(outputDirectory, `OpenDesk-${version}-Setup.exe`);
const releasePath = path.join(outputDirectory, `opendesk-win-x86-${version}.exe`);
if (!fs.existsSync(setupPath)) throw new Error(`Expected Setup was not created: ${setupPath}`);
fs.copyFileSync(setupPath, releasePath);

console.log(`Created branded OpenDesk setup: ${setupPath}`);
console.log(`Created release artifact: ${releasePath}`);
