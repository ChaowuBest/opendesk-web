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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const resourcesDir = path.join(projectRoot, 'resources', 'package', 'bootstrapper');
const wixBinDir = process.env.WIX_BIN_DIR || 'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin';
const msiPath = path.resolve(
    process.env.OPENDESK_MSI_PATH || path.join(projectRoot, 'out', 'make', 'wix', 'x64', 'opendesk.msi')
);
const outputDir = path.resolve(
    process.env.OPENDESK_SETUP_OUT_DIR || path.join(projectRoot, 'out', 'make', 'wix', 'x64')
);
const bundleVersion = packageJson.version.split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
const sourcePath = path.join(resourcesDir, 'bundle.wxs');
const objectPath = path.join(outputDir, 'opendesk-bootstrapper.wixobj');
const setupPath = path.join(outputDir, `OpenDesk-${packageJson.version}-Setup.exe`);

function runWix(executable, args) {
    const result = spawnSync(path.join(wixBinDir, executable), args, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });

    if (result.status !== 0) {
        throw new Error(
            `${executable} failed with exit code ${result.status}\n${result.stdout || ''}${result.stderr || ''}`
        );
    }

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
}

if (!fs.existsSync(msiPath)) {
    throw new Error(`MSI not found: ${msiPath}`);
}

fs.mkdirSync(outputDir, { recursive: true });

runWix('candle.exe', [
    '-nologo',
    '-arch',
    'x64',
    '-ext',
    'WixBalExtension',
    '-ext',
    'WixUtilExtension',
    `-dBundleVersion=${bundleVersion}`,
    `-dMsiPath=${msiPath}`,
    `-dIconPath=${path.join(projectRoot, 'resources', 'package', 'icons', 'icon_round.ico')}`,
    `-dThemePath=${path.join(resourcesDir, 'theme.xml')}`,
    `-dLocalizationPath=${path.join(resourcesDir, 'zh-cn.wxl')}`,
    `-dBackgroundPath=${path.join(resourcesDir, 'background.png')}`,
    `-dFeatureRowsPath=${path.join(resourcesDir, 'feature-rows.png')}`,
    `-dProgressPath=${path.join(resourcesDir, 'progress.png')}`,
    '-out',
    objectPath,
    sourcePath
]);

runWix('light.exe', ['-nologo', '-ext', 'WixBalExtension', '-ext', 'WixUtilExtension', '-out', setupPath, objectPath]);

console.log(`Created branded OpenDesk setup: ${setupPath}`);
