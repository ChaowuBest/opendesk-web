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
 * 检查是否通过 npm 全局安装
 * @returns 如果是通过 npm 安装返回 true，否则返回 false
 */
export async function isNpmInstalled(): Promise<boolean> {
    try {
        const { stdout } = await execAsync(`npm list -g ${PACKAGE_NAME} --depth=0 --json`, {
            timeout: 10000,
        });
        const result = JSON.parse(stdout);
        return result && result.dependencies && result.dependencies[PACKAGE_NAME];
    } catch {
        return false;
    }
}

/**
 * 获取当前 CLI 版本
 * 通过 npm 读取已安装的 @bitclub.ai/opendesk-cli 版本
 * @returns 版本号，如果未通过 npm 安装则返回 null
 */
export async function getCurrentVersion(): Promise<string | null> {
    try {
        // 使用 npm list 获取已安装的版本
        const { stdout } = await execAsync(`npm list -g ${PACKAGE_NAME} --depth=0 --json`, {
            timeout: 10000,
        });
        const result = JSON.parse(stdout);
        if (result && result.dependencies && result.dependencies[PACKAGE_NAME]) {
            return result.dependencies[PACKAGE_NAME].version || null;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 从 npm registry 获取指定包的最新版本
 * @param packageName 包名
 * @param tag npm tag (如 'latest' 或 'nightly')
 * @returns 版本号或 null（如果获取失败）
 */
export async function getNpmVersion(packageName: string, tag: string = 'latest'): Promise<string | null> {
    try {
        const { stdout } = await execAsync(`npm view ${packageName} version --tag ${tag}`, {
            timeout: 30000,
        });
        return stdout.trim() || null;
    } catch (err) {
        // 如果指定 tag 不存在，尝试获取 dist-tags
        try {
            const { stdout } = await execAsync(`npm view ${packageName} dist-tags --json`, {
                timeout: 30000,
            });
            const distTags = JSON.parse(stdout);
            return distTags[tag] || null;
        } catch {
            return null;
        }
    }
}

/**
 * 从 npm registry 获取指定 tag 的版本（通过 dist-tags）
 * @param tag npm tag ('latest' 或 'nightly')
 * @returns 版本信息
 */
export async function getVersionInfo(tag: 'latest' | 'nightly' = 'latest'): Promise<VersionInfo> {
    const current = await getCurrentVersion();
    const latest = await getNpmVersion(PACKAGE_NAME, tag);
    const installed = await isNpmInstalled();

    return {
        current,
        latest,
        needsUpdate: latest !== null && current !== null && current !== latest,
        isNpmInstalled: installed,
    };
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