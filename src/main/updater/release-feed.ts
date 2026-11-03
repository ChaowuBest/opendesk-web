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
import { isValidVersion, isNewerVersion } from '../utils/version.js';

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256 = /^[a-f\d]{64}$/i;
type ReleaseTrustMode = 'strict' | 'trusted-source';

/** 更新包目标架构：process.arch 在 Windows 上只有 x64 / arm64 两种发布形态 */
export type UpdaterTargetArch = 'x64' | 'arm64';

/**
 * 更新器只接受 `x.y.z` 形式的稳定版本：预发布、构建元数据、`v` 前缀都不走发布流程。
 * 版本号还要能被 SemVer 解析（如超大段号），否则后续比较没有意义。
 *
 * 注意这只约束**远端发布版本**；本地版本可能是预发布/开发构建，
 * 两者谁更新由 utils/version.ts 的 isNewerVersion 按 SemVer 优先级判断。
 */
function assertStableVersion(version: string): void {
    if (!STABLE_VERSION.test(version) || !isValidVersion(version)) {
        throw new Error(`Expected a stable semantic version, received: ${version}`);
    }
}

function validateUrl(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Update release does not contain an installer URL');
    return validateUpdateUrl(value, 'Update installer URL').toString();
}

/**
 * 官网 news 页安装包链接识别。x64 目标同时接受 x86 与 x64 标记
 * （官网 win-x86 包实际内嵌 x64 MSI），arm64 目标只接受 arm64 标记。
 */
function isNativeInstallerLink(href: string, label: string, targetArch: UpdaterTargetArch): boolean {
    if (targetArch === 'arm64') {
        return /windows\s*arm64/i.test(label) || /win[-_]?arm64/i.test(href);
    }
    return /windows\s*x(86|64)/i.test(label) || /win[-_]?x(86|64)/i.test(href);
}

/** arm64 目标在 feed 未发布原生包时（如 0.3.6 及更早）回退 x86 包，保持可更新 */
function isLegacyX86InstallerLink(href: string, label: string): boolean {
    return /windows\s*x86/i.test(label) || /win[-_]?x86/i.test(href);
}

function selectNewsInstallerLink(
    candidates: { href: string; label: string; checksum?: string }[],
    targetArch: UpdaterTargetArch
): { href: string; label: string; checksum?: string } | undefined {
    const native = candidates.find((candidate) => isNativeInstallerLink(candidate.href, candidate.label, targetArch));
    if (native) return native;
    if (targetArch === 'arm64') {
        return candidates.find((candidate) => isLegacyX86InstallerLink(candidate.href, candidate.label));
    }
    return undefined;
}

export function parseNewsReleasePage(
    html: string,
    pageUrl: string,
    trustMode: ReleaseTrustMode = 'strict',
    targetArch: UpdaterTargetArch = 'x64'
): UpdateRelease {
    const { document } = parseHTML(html);
    let latestRelease: UpdateRelease | undefined;

    for (const item of Array.from(document.querySelectorAll('li[data-release-category="stable-release"]'))) {
        const title = item.querySelector('.release-item__title')?.textContent?.trim();
        const version = title?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
        if (!title || !version) continue;
        assertStableVersion(version);

        const exeLinks = Array.from(item.querySelectorAll('.release-downloads a'))
            .map((candidate) => ({
                href: candidate.getAttribute('href') || '',
                label: candidate.textContent || '',
                checksum: candidate.getAttribute('data-sha256')?.trim().toLowerCase()
            }))
            .filter((candidate) => candidate.href.toLowerCase().endsWith('.exe'));
        const installerLink = selectNewsInstallerLink(exeLinks, targetArch);
        const href = installerLink?.href;
        if (!installerLink || !href) continue;

        const installerUrl = validateUrl(new URL(href, pageUrl).toString());
        const installerName = validateInstallerName(undefined, installerUrl);
        const rawChecksum = installerLink.checksum;
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
        // 页面上可能有多条稳定版：取版本号最高的那一条
        if (!latestRelease || isNewerVersion(release.version, latestRelease.version)) latestRelease = release;
    }

    if (!latestRelease) throw new Error(`Update news page does not contain a stable Windows ${targetArch} release`);
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

export function parseReleaseResponse(
    input: unknown,
    trustMode: ReleaseTrustMode = 'strict',
    targetArch: UpdaterTargetArch = 'x64'
): UpdateRelease {
    if (!input || typeof input !== 'object') throw new Error('Update feed returned an invalid response');
    const raw = input as Record<string, unknown>;

    if (typeof raw.version === 'string' && typeof raw.url === 'string') {
        assertStableVersion(raw.version);
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
    assertStableVersion(version);
    if (!Array.isArray(raw.assets)) throw new Error('GitCode release does not contain assets');
    const winAssets = raw.assets.filter((candidate) => {
        if (!candidate || typeof candidate !== 'object') return false;
        const name = (candidate as Record<string, unknown>).name;
        return typeof name === 'string' && /(?:opendesk|open-desk).*win.*\.exe$/i.test(name);
    }) as Record<string, unknown>[];
    // 优先当前架构原生包；arm64 在老版本 feed（仅 x86 包）时回退 x86，保持可更新
    const isArm64 = (asset: Record<string, unknown>) => /arm64/i.test(String(asset.name));
    const asset =
        targetArch === 'arm64'
            ? (winAssets.find(isArm64) ?? winAssets.find((candidate) => !isArm64(candidate)))
            : winAssets.find((candidate) => !isArm64(candidate));
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
    trustMode: ReleaseTrustMode = 'strict',
    targetArch: UpdaterTargetArch = 'x64'
): Promise<UpdateRelease> {
    const url = validateUpdateUrl(feedUrl, 'Update feed URL');
    const response = await raceWithForceTimeout(
        fetchImpl(url, {
            headers: { accept: 'text/html, application/json', 'user-agent': 'OpenDesk-Updater' },
            signal: AbortSignal.timeout(timeoutMs)
        }),
        timeoutMs
    );
    if (!response.ok) throw new Error(`Update feed request failed with HTTP ${response.status}`);
    if (response.url) validateUpdateUrl(response.url, 'Update feed redirect');
    const body = await response.text();
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || /^\s*</.test(body)) {
        return parseNewsReleasePage(body, response.url || url.toString(), trustMode, targetArch);
    }
    return parseReleaseResponse(JSON.parse(body), trustMode, targetArch);
}

/**
 * 独立超时兜底：不依赖 fetch 实现尊重 AbortSignal。
 * 部分 Electron 适配层（如鸿蒙）的 session.fetch 可能忽略 signal，此时
 * 请求永不 settle，而更新协调器的单次操作锁只有 promise settle 才会释放，
 * 一次挂起即让更新功能静默死亡。signal 生效时走正常 AbortError 路径，
 * signal 被忽略时由本兜底在 timeoutMs 后强制 reject。
 */
async function raceWithForceTimeout(pending: Promise<Response>, timeoutMs: number): Promise<Response> {
    let forceReject: ((error: Error) => void) | undefined;
    const forced = new Promise<never>((_, reject) => {
        forceReject = reject;
    });
    const timer = setTimeout(() => forceReject?.(new Error('Update feed request timed out')), timeoutMs);
    timer.unref?.();
    try {
        return await Promise.race([pending, forced]);
    } finally {
        clearTimeout(timer);
        // 兜底胜出时底层请求仍在途，挂一个空 catch 防止 unhandled rejection
        pending.catch(() => {});
    }
}
