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
import { DEFAULT_UPDATE_FEED_URL } from '../src/main/updater/config.js';
import { downloadInstaller } from '../src/main/updater/download.js';
import { compareVersions, fetchLatestRelease } from '../src/main/updater/release-feed.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

function readArgument(name: string, fallback?: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    return value;
}

function formatBytes(value: number): string {
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

async function run(): Promise<void> {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
        version: string;
    };
    const currentVersion = readArgument('current-version', packageJson.version) as string;
    const outputDirectory = path.resolve(
        readArgument('output-dir', path.join(projectRoot, 'temp', 'windows-update-feed-test')) as string
    );
    const deleteAfterCheck = process.argv.includes('--delete-after-check');

    console.log(`Update feed: ${DEFAULT_UPDATE_FEED_URL}`);
    console.log(`Current version for comparison: ${currentVersion}`);

    const release = await fetchLatestRelease(DEFAULT_UPDATE_FEED_URL, fetch, 30_000, 'trusted-source');
    console.log(`Latest stable version: ${release.version}`);
    console.log(`Installer URL: ${release.installerUrl}`);

    if (compareVersions(release.version, currentVersion) <= 0) {
        console.log('No newer stable version was detected; no installer was downloaded.');
        return;
    }

    const destination = path.join(outputDirectory, release.installerName);
    let lastReportedPercent = -1;
    await downloadInstaller({
        url: release.installerUrl,
        destination,
        expectedSize: release.size,
        onProgress: (receivedBytes, totalBytes) => {
            if (!totalBytes) return;
            const percent = Math.floor((receivedBytes / totalBytes) * 100);
            if (percent < 100 && percent - lastReportedPercent < 10) return;
            lastReportedPercent = percent;
            console.log(`Downloaded ${percent}% (${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)})`);
        }
    });

    const downloadedSize = fs.statSync(destination).size;
    console.log(`Download completed: ${destination}`);
    console.log(`Downloaded size: ${downloadedSize} bytes`);
    console.log('Smoke test completed without starting the installer.');
    if (deleteAfterCheck) {
        fs.rmSync(destination, { force: true });
        console.log('Deleted the downloaded smoke-test file.');
    }
}

run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
