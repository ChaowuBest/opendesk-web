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
import { parseStringPromise } from 'xml2js';
import { compareBlockMaps, parseBlockMapXml } from './lib/msix-blockmap.mjs';

function readRequiredArgument(name) {
    const index = process.argv.indexOf(`--${name}`);
    const value = index < 0 ? undefined : process.argv[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing required --${name} argument`);
    }
    return path.resolve(value);
}

function readOptionalArgument(name) {
    const index = process.argv.indexOf(`--${name}`);
    const value = index < 0 ? undefined : process.argv[index + 1];
    if (!value || value.startsWith('--')) return undefined;
    return path.resolve(value);
}

function findMakeAppx() {
    const root = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
    const versions = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
        const executable = path.join(root, version, 'x64', 'makeappx.exe');
        if (fs.existsSync(executable)) return executable;
    }
    throw new Error('Windows SDK makeappx.exe was not found');
}

function unpack(makeAppx, artifact, targetDirectory) {
    const result = spawnSync(makeAppx, ['unpack', '/p', artifact, '/d', targetDirectory, '/o'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0) {
        throw new Error(`makeappx unpack failed for ${artifact}:\n${result.stdout}${result.stderr}`);
    }
}

async function readManifest(layoutDirectory) {
    const xml = await fs.promises.readFile(path.join(layoutDirectory, 'AppxManifest.xml'), 'utf8');
    const parsed = await parseStringPromise(xml);
    const packageNode = parsed.Package;
    const identity = packageNode.Identity?.[0]?.$ ?? {};
    const application = packageNode.Applications?.[0]?.Application?.[0]?.$ ?? {};
    const capabilities = packageNode.Capabilities?.[0] ?? {};
    return {
        identity,
        application,
        hasRunFullTrust: (capabilities['rescap:Capability'] ?? []).some(
            (capability) => capability.$?.Name === 'runFullTrust'
        ),
        hasInternetClient: (capabilities.Capability ?? []).some((capability) => capability.$?.Name === 'internetClient')
    };
}

function inspectLayout(layoutDirectory) {
    const appRoot = path.join(layoutDirectory, 'app');
    const requiredPaths = [
        'opendesk.exe',
        'resources/app.asar',
        'resources/app.asar.unpacked',
        'resources/native',
        'locales'
    ];
    const requiredPathStatus = Object.fromEntries(
        requiredPaths.map((relativePath) => [
            relativePath,
            fs.existsSync(path.join(appRoot, ...relativePath.split('/')))
        ])
    );
    const files = fs.readdirSync(appRoot, { recursive: true, withFileTypes: true });
    return {
        requiredPathStatus,
        nativeNodeFileCount: files.filter((entry) => entry.isFile() && entry.name.endsWith('.node')).length,
        executableFileCount: files.filter((entry) => entry.isFile() && entry.name.endsWith('.exe')).length,
        dllFileCount: files.filter((entry) => entry.isFile() && entry.name.endsWith('.dll')).length
    };
}

const baselineArtifact = readRequiredArgument('baseline');
const candidateArtifact = readRequiredArgument('candidate');
const outputPath = readOptionalArgument('output');
for (const artifact of [baselineArtifact, candidateArtifact]) {
    if (!fs.existsSync(artifact)) throw new Error(`MSIX artifact was not found: ${artifact}`);
}

const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opendesk-phase0-msix-'));
const baselineLayout = path.join(temporaryRoot, 'baseline');
const candidateLayout = path.join(temporaryRoot, 'candidate');
try {
    const makeAppx = findMakeAppx();
    unpack(makeAppx, baselineArtifact, baselineLayout);
    unpack(makeAppx, candidateArtifact, candidateLayout);

    const [baselineXml, candidateXml, baselineManifest, candidateManifest] = await Promise.all([
        fs.promises.readFile(path.join(baselineLayout, 'AppxBlockMap.xml'), 'utf8'),
        fs.promises.readFile(path.join(candidateLayout, 'AppxBlockMap.xml'), 'utf8'),
        readManifest(baselineLayout),
        readManifest(candidateLayout)
    ]);
    const comparison = compareBlockMaps(await parseBlockMapXml(baselineXml), await parseBlockMapXml(candidateXml));
    const report = {
        generatedAt: new Date().toISOString(),
        baseline: {
            artifact: baselineArtifact,
            artifactBytes: fs.statSync(baselineArtifact).size,
            manifest: baselineManifest
        },
        candidate: {
            artifact: candidateArtifact,
            artifactBytes: fs.statSync(candidateArtifact).size,
            manifest: candidateManifest,
            layout: inspectLayout(candidateLayout)
        },
        comparison: {
            ...comparison,
            changedFiles: comparison.changedFiles.slice(0, 50)
        },
        limitations: [
            'The reuse percentages are calculated from AppxBlockMap.xml and are estimates, not captured network traffic.',
            'Packages are unsigned and were not installed during this comparison.'
        ]
    };
    const json = JSON.stringify(report, null, 2);
    if (outputPath) {
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.promises.writeFile(outputPath, `${json}\n`, 'utf8');
    }
    console.log(json);
} finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const resolvedOsTemporaryRoot = path.resolve(os.tmpdir());
    if (resolvedTemporaryRoot.startsWith(`${resolvedOsTemporaryRoot}${path.sep}opendesk-phase0-msix-`)) {
        await fs.promises.rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
}
