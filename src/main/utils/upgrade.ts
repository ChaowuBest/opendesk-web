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

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import fs from 'fs';

const execAsync = promisify(exec);

const PACKAGE_NAME = '@bitclub.ai/opendesk-cli';

/**
 * 版本信息
 */
export interface VersionInfo {
    current: string | null;
    latest: string | null;
    needsUpdate: boolean;
    isNpmInstalled: boolean;
}

/**
 * 内部函数：获取 npm 全局安装信息（版本和是否安装）
 * 直接读取全局 node_modules 中的 package.json，比 npm list 快很多
 * @returns 版本号和是否通过 npm 安装
 */
async function getNpmInstallInfo(): Promise<{ version: string | null; isInstalled: boolean }> {
    try {
        // 方法1：通过 npm root 获取全局目录，直接读取 package.json
        const { stdout: globalRoot } = await execAsync('npm root -g', {
            timeout: 5000,
        });
        const packageJsonPath = `${globalRoot.trim()}/${PACKAGE_NAME}/package.json`;

        if (fs.existsSync(packageJsonPath)) {
            const content = fs.readFileSync(packageJsonPath, 'utf-8');
            const pkg = JSON.parse(content);
            return {
                version: pkg.version || null,
                isInstalled: true,
            };
        }
        return { version: null, isInstalled: false };
    } catch {
        // 方法2：回退到 npm list（较慢但可靠）
        try {
            const { stdout } = await execAsync(`npm list -g ${PACKAGE_NAME} --depth=0 --json`, {
                timeout: 15000,
            });
            const result = JSON.parse(stdout);
            if (result && result.dependencies && result.dependencies[PACKAGE_NAME]) {
                return {
                    version: result.dependencies[PACKAGE_NAME].version || null,
                    isInstalled: true,
                };
            }
        } catch {
            // 忽略错误
        }
        return { version: null, isInstalled: false };
    }
}

/**
 * 检查是否通过 npm 全局安装
 * @returns 如果是通过 npm 安装返回 true，否则返回 false
 */
export async function isNpmInstalled(): Promise<boolean> {
    const info = await getNpmInstallInfo();
    return info.isInstalled;
}

/**
 * 获取当前 CLI 版本
 * 通过 npm 读取已安装的 @bitclub.ai/opendesk-cli 版本
 * @returns 版本号，如果未通过 npm 安装则返回 null
 */
export async function getCurrentVersion(): Promise<string | null> {
    const info = await getNpmInstallInfo();
    return info.version;
}

/**
 * 使用 HTTPS 直接请求 npm registry
 * @param url 完整的 registry URL
 * @param timeout 超时时间（毫秒）
 * @returns JSON 数据或 null
 */
function fetchNpmRegistry(url: string, timeout: number = 15000): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
        const req = https.get(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'OpenDesk-CLI',
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(timeout, () => {
            req.destroy();
            resolve(null);
        });
    });
}

/**
 * 从 npm registry 获取指定包的最新版本
 * 使用 HTTP 请求直接访问 registry，比 npm view 命令更快
 * @param packageName 包名
 * @param tag npm tag (如 'latest' 或 'nightly')
 * @returns 版本号或 null（如果获取失败）
 */
export async function getNpmVersion(packageName: string, tag: string = 'latest'): Promise<string | null> {
    try {
        // 使用 HTTPS 直接访问 npm registry，比 npm view 命令快很多
        const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
        const data = await fetchNpmRegistry(registryUrl, 15000);

        if (data) {
            // 从 dist-tags 获取指定 tag 的版本
            if (data['dist-tags'] && data['dist-tags'][tag]) {
                return data['dist-tags'][tag];
            }

            // 如果没有找到指定 tag，返回 latest
            if (data['dist-tags'] && data['dist-tags']['latest']) {
                return data['dist-tags']['latest'];
            }
        }

        return null;
    } catch {
        // 回退到 npm view 命令
        try {
            const { stdout } = await execAsync(`npm view ${packageName} version --tag ${tag}`, {
                timeout: 30000,
            });
            return stdout.trim() || null;
        } catch {
            return null;
        }
    }
}

// 缓存版本信息，避免重复查询
let cachedVersionInfo: VersionInfo | null = null;
let cachedVersionInfoTag: 'latest' | 'nightly' | null = null;
let cachedVersionInfoTime: number = 0;
const VERSION_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

/**
 * 从 npm registry 获取指定 tag 的版本（通过 dist-tags）
 * @param tag npm tag ('latest' 或 'nightly')
 * @param forceRefresh 是否强制刷新缓存
 * @returns 版本信息
 */
export async function getVersionInfo(tag: 'latest' | 'nightly' = 'latest', forceRefresh: boolean = false): Promise<VersionInfo> {
    const now = Date.now();

    // 检查缓存是否有效
    if (!forceRefresh && cachedVersionInfo && cachedVersionInfoTag === tag && (now - cachedVersionInfoTime) < VERSION_CACHE_TTL) {
        return cachedVersionInfo;
    }

    // 并行执行所有查询，提升性能
    const [installInfo, latest] = await Promise.all([
        getNpmInstallInfo(),
        getNpmVersion(PACKAGE_NAME, tag),
    ]);

    cachedVersionInfo = {
        current: installInfo.version,
        latest,
        needsUpdate: latest !== null && installInfo.version !== null && installInfo.version !== latest,
        isNpmInstalled: installInfo.isInstalled,
    };
    cachedVersionInfoTag = tag;
    cachedVersionInfoTime = now;

    return cachedVersionInfo;
}

/**
 * 比较两个语义化版本号
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
    const parseVersion = (v: string): number[] => {
        // 移除 nightly 后缀等
        const cleanV = v.split('-')[0];
        return cleanV.split('.').map(n => parseInt(n, 10) || 0);
    };

    const partsA = parseVersion(a);
    const partsB = parseVersion(b);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }

    // 如果基础版本相同，nightly 版本比 stable 版本新
    const aIsNightly = a.includes('-nightly-');
    const bIsNightly = b.includes('-nightly-');

    if (aIsNightly && !bIsNightly) return 1;
    if (!aIsNightly && bIsNightly) return -1;

    // 如果都是 nightly，比较日期后缀
    if (aIsNightly && bIsNightly) {
        const dateA = a.split('-nightly-')[1] || '';
        const dateB = b.split('-nightly-')[1] || '';
        if (dateA > dateB) return 1;
        if (dateA < dateB) return -1;
    }

    return 0;
}

/**
 * 执行 npm install -g 安装指定版本
 * @param tag npm tag ('latest' 或 'nightly')
 * @returns 是否安装成功
 */
export async function installVersion(tag: 'latest' | 'nightly' = 'latest'): Promise<{ success: boolean; message: string }> {
    try {
        const versionInfo = await getVersionInfo(tag);

        if (!versionInfo.isNpmInstalled || versionInfo.current === null) {
            return { success: false, message: '当前 OpenDesk 未通过 npm 全局安装，无法使用自动升级功能。\n请使用 npm install -g @bitclub.ai/opendesk-cli 安装。' };
        }

        if (!versionInfo.latest) {
            return { success: false, message: `无法从 npm 获取 ${tag} 版本信息，请检查网络连接` };
        }

        if (!versionInfo.needsUpdate) {
            return { success: false, message: `当前已是最新 ${tag} 版本 (${versionInfo.current})` };
        }

        // 执行全局安装
        const installCmd = `npm install -g ${PACKAGE_NAME}@${tag}`;
        await execAsync(installCmd, {
            timeout: 120000, // 2 分钟超时
        });

        // 检查安装是否成功
        const newVersion = await getCurrentVersion();
        if (newVersion === versionInfo.latest) {
            return {
                success: true,
                message: `升级成功: ${versionInfo.current} -> ${versionInfo.latest}`
            };
        }

        return {
            success: true,
            message: `安装完成，请重启 OpenDesk 以使用新版本 (${versionInfo.latest})`
        };
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `安装失败: ${errorMessage}` };
    }
}

/**
 * 升级命令处理器
 */
export interface UpgradeResult {
    success: boolean;
    message: string;
    currentVersion?: string | null;
    latestVersion?: string | null;
    needsUpdate?: boolean;
    isNpmInstalled?: boolean;
}

/**
 * 检查并执行升级
 * @param tag npm tag ('latest' 或 'nightly')
 */
export async function performUpgrade(tag: 'latest' | 'nightly'): Promise<UpgradeResult> {
    const versionInfo = await getVersionInfo(tag);

    if (!versionInfo.isNpmInstalled || versionInfo.current === null) {
        return {
            success: false,
            message: '当前 OpenDesk 未通过 npm 全局安装，无法使用自动升级功能。\n请使用 npm install -g @bitclub.ai/opendesk-cli 安装。',
            currentVersion: versionInfo.current,
            latestVersion: versionInfo.latest,
            isNpmInstalled: false,
        };
    }

    if (!versionInfo.latest) {
        return {
            success: false,
            message: `无法从 npm 获取 ${tag} 版本信息，请检查网络连接`,
            currentVersion: versionInfo.current,
            latestVersion: versionInfo.latest,
        };
    }

    if (!versionInfo.needsUpdate) {
        return {
            success: true,
            message: `当前已是最新 ${tag} 版本`,
            currentVersion: versionInfo.current,
            latestVersion: versionInfo.latest,
            needsUpdate: false,
        };
    }

    // 执行升级
    const result = await installVersion(tag);
    return {
        success: result.success,
        message: result.message,
        currentVersion: versionInfo.current,
        latestVersion: versionInfo.latest,
        needsUpdate: true,
    };
}

/**
 * 仅检查版本更新（不执行升级）
 */
export async function checkForUpdate(tag: 'latest' | 'nightly'): Promise<UpgradeResult> {
    const versionInfo = await getVersionInfo(tag);

    return {
        success: true,
        message: versionInfo.needsUpdate
            ? `发现新版本: ${versionInfo.current} -> ${versionInfo.latest}`
            : `当前已是最新版本`,
        currentVersion: versionInfo.current,
        latestVersion: versionInfo.latest,
        needsUpdate: versionInfo.needsUpdate,
        isNpmInstalled: versionInfo.isNpmInstalled,
    };
}