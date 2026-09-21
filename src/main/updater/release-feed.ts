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

import { parseHTML } from 'linkedom';
import type { UpdateRelease } from './types.js';
import { validateUpdateUrl } from './url-policy.js';

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256 = /^[a-f\d]{64}$/i;
type ReleaseTrustMode = 'strict' | 'trusted-source';

function parseVersion(version: string): [number, number, number] {
    const match = STABLE_VERSION.exec(version);
    if (!match) {
        throw new Error(`Expected a stable semantic version, received: ${version}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
    const a = parseVersion(left);
    const b = parseVersion(right);
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

function validateUrl(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Update release does not contain an installer URL');
    return validateUpdateUrl(value, 'Update installer URL').toString();
}

export function parseNewsReleasePage(
    html: string,
    pageUrl: string,
    trustMode: ReleaseTrustMode = 'strict'
): UpdateRelease {
    const { document } = parseHTML(html);
    let latestRelease: UpdateRelease | undefined;

    for (const item of Array.from(document.querySelectorAll('li[data-release-category="stable-release"]'))) {
        const title = item.querySelector('.release-item__title')?.textContent?.trim();
        const version = title?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
        if (!title || !version) continue;
        parseVersion(version);

        const installerLink = Array.from(item.querySelectorAll('.release-downloads a')).find((candidate) => {
            const href = candidate.getAttribute('href') || '';
            const label = candidate.textContent || '';
            return href.toLowerCase().endsWith('.exe') && (/windows\s*x86/i.test(label) || /win[-_]?x86/i.test(href));
        });
        const href = installerLink?.getAttribute('href');
        if (!installerLink || !href) continue;

        const installerUrl = validateUrl(new URL(href, pageUrl).toString());
        const installerName = validateInstallerName(undefined, installerUrl);
        const rawChecksum = installerLink.getAttribute('data-sha256')?.trim().toLowerCase();
        if (rawChecksum && !SHA256.test(rawChecksum) && trustMode === 'strict') {
            throw new Error('Update news page contains an invalid SHA-256 checksum');
        }
        const release: UpdateRelease = {
            version,
            installerUrl,
            installerName,
            sha256: rawChecksum && SHA256.test(rawChecksum) ? rawChecksum : undefined,
            notes: title
        };
        if (!latestRelease || compareVersions(release.version, latestRelease.version) > 0) latestRelease = release;
    }

    if (!latestRelease) throw new Error('Update news page does not contain a stable Windows x86 release');
    return latestRelease;
}

function validateInstallerName(value: unknown, url: string): string {
    const name = typeof value === 'string' ? value : decodeURIComponent(new URL(url).pathname.split('/').at(-1) || '');
    if (!name.toLowerCase().endsWith('.exe') || name.includes('/') || name.includes('\\')) {
        throw new Error('Update release does not contain a Windows EXE installer');
    }
    return name;
}

function optionalPositiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function checksumForAsset(notes: string | undefined, installerName: string): string | undefined {
    if (!notes) return undefined;
    const escapedName = installerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(^|\\n)\\s*([a-f\\d]{64})\\s+\\*?${escapedName}\\s*(?=\\n|$)`, 'i').exec(notes);
    return match?.[2].toLowerCase();
}

export function parseReleaseResponse(input: unknown, trustMode: ReleaseTrustMode = 'strict'): UpdateRelease {
    if (!input || typeof input !== 'object') throw new Error('Update feed returned an invalid response');
    const raw = input as Record<string, unknown>;

    if (typeof raw.version === 'string' && typeof raw.url === 'string') {
        parseVersion(raw.version);
        const installerUrl = validateUrl(raw.url);
        const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.toLowerCase() : undefined;
        if (sha256 && !SHA256.test(sha256) && trustMode === 'strict') {
            throw new Error('Update manifest contains an invalid SHA-256 checksum');
        }
        return {
            version: raw.version,
            installerUrl,
            installerName: validateInstallerName(raw.name, installerUrl),
            size: optionalPositiveNumber(raw.size),
            sha256: sha256 && SHA256.test(sha256) ? sha256 : undefined,
            notes: typeof raw.notes === 'string' ? raw.notes : undefined
        };
    }

    if (raw.prerelease === true) throw new Error('Update feed returned a prerelease');
    if (typeof raw.tag_name !== 'string') throw new Error('GitCode release does not contain a version tag');
    const version = raw.tag_name.startsWith('v') ? raw.tag_name.slice(1) : raw.tag_name;
    parseVersion(version);
    if (!Array.isArray(raw.assets)) throw new Error('GitCode release does not contain assets');
    const asset = raw.assets.find((candidate) => {
        if (!candidate || typeof candidate !== 'object') return false;
        const name = (candidate as Record<string, unknown>).name;
        return typeof name === 'string' && /(?:opendesk|open-desk).*win.*\.exe$/i.test(name);
    }) as Record<string, unknown> | undefined;
    if (!asset) throw new Error('GitCode release does not contain a Windows EXE installer');
    const installerUrl = validateUrl(asset.browser_download_url);
    const installerName = validateInstallerName(asset.name, installerUrl);
    const notes = typeof raw.body === 'string' ? raw.body : undefined;
    return {
        version,
        installerUrl,
        installerName,
        size: optionalPositiveNumber(asset.size),
        sha256: checksumForAsset(notes, installerName),
        notes
    };
}

export async function fetchLatestRelease(
    feedUrl: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs = 30_000,
    trustMode: ReleaseTrustMode = 'strict'
): Promise<UpdateRelease> {
    const url = validateUpdateUrl(feedUrl, 'Update feed URL');
    const response = await fetchImpl(url, {
        headers: { accept: 'text/html, application/json', 'user-agent': 'OpenDesk-Updater' },
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Update feed request failed with HTTP ${response.status}`);
    if (response.url) validateUpdateUrl(response.url, 'Update feed redirect');
    const body = await response.text();
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || /^\s*</.test(body)) {
        return parseNewsReleasePage(body, response.url || url.toString(), trustMode);
    }
    return parseReleaseResponse(JSON.parse(body), trustMode);
}
