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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json version must be a three-part stable version, got ${version}`);
}

function run(executable, args, options = {}) {
    const result = spawnSync(executable, args, {
        cwd: projectRoot,
        env: options.env || process.env,
        encoding: 'utf8',
        stdio: 'inherit'
    });
    if (result.error) {
        throw new Error(`Failed to start ${options.label || executable}: ${result.error.message}`, {
            cause: result.error
        });
    }
    if (result.status !== 0) {
        throw new Error(`${options.label || path.basename(executable)} failed with exit code ${result.status}`);
    }
}

function resolveSigningCertificateThumbprint() {
    const configured = process.env.OPENDESK_SIGNING_CERTIFICATE_THUMBPRINT?.replaceAll(' ', '').toUpperCase();
    if (configured) {
        if (!/^[0-9A-F]{40}$/.test(configured)) {
            throw new Error('OPENDESK_SIGNING_CERTIFICATE_THUMBPRINT must be a SHA-1 certificate thumbprint');
        }
        return configured;
    }

    const certificateQuery = [
        'Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert',
        'Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) }',
        'Select-Object -ExpandProperty Thumbprint'
    ].join(' | ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', certificateQuery], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error || result.status !== 0) {
        throw new Error(
            'Unable to inspect the current-user code-signing certificates. Set OPENDESK_SIGNING_CERTIFICATE_THUMBPRINT explicitly.'
        );
    }
    const thumbprints = result.stdout
        .split(/\r?\n/)
        .map((value) => value.trim().replaceAll(' ', '').toUpperCase())
        .filter((value) => /^[0-9A-F]{40}$/.test(value));
    if (thumbprints.length !== 1) {
        throw new Error(
            `Expected exactly one valid code-signing certificate in Cert:\\CurrentUser\\My, found ${thumbprints.length}. ` +
                'Set OPENDESK_SIGNING_CERTIFICATE_THUMBPRINT to select one.'
        );
    }
    return thumbprints[0];
}

function sha256(filePath) {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const signingCertificateThumbprint = resolveSigningCertificateThumbprint();
const forgeOutDirectory = path.join(projectRoot, 'out', 'windows-release-package');
const packagedAppDirectory = path.join(forgeOutDirectory, 'opendesk-win32-x64');
const outputDirectory = path.join(projectRoot, 'out', 'make', 'wix', 'x64');
const buildEnvironment = {
    ...process.env,
    OPENDESK_PACKAGE_VERSION: version,
    OPENDESK_FORGE_OUT_DIR: forgeOutDirectory
};

console.log(`Building OpenDesk ${version} with signing certificate ${signingCertificateThumbprint}...`);

// npm run build
if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
        env: buildEnvironment,
        label: 'npm run build'
    });
} else {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        env: buildEnvironment,
        label: 'npm run build'
    });
}

const forgeCli = path.join(projectRoot, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
run(process.execPath, [forgeCli, 'package', '--platform=win32', '--arch=x64'], {
    env: buildEnvironment,
    label: 'electron-forge package --platform=win32 --arch=x64'
});

const installerBuilder = path.join(scriptDirectory, 'windows-silent-update-prototype', 'build-prototype.mjs');
run(
    process.execPath,
    [
        installerBuilder,
        '--version',
        version,
        '--app-dir',
        packagedAppDirectory,
        '--output-dir',
        outputDirectory,
        '--signing-certificate-thumbprint',
        signingCertificateThumbprint
    ],
    { env: buildEnvironment, label: 'OpenDesk Windows installer build' }
);

const setupPath = path.join(outputDirectory, `OpenDesk-${version}-Setup.exe`);
if (!fs.existsSync(setupPath)) {
    throw new Error(`Expected Setup was not created: ${setupPath}`);
}
const releasePath = path.join(outputDirectory, `opendesk-win-x86-${version}.exe`);
fs.copyFileSync(setupPath, releasePath);

console.log(`Created Setup: ${setupPath}`);
console.log(`Created release artifact: ${releasePath}`);
console.log(`SHA-256: ${sha256(releasePath)}`);
