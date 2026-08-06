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

import * as https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { asyncShellExec } from './shellExec.js';

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
 * 优先从 CLI 二进制旁的 package.json 读取（不依赖 npm 命令，不受 NPM_CONFIG_PREFIX 干扰）；
 * 回退到 `npm root -g` + `npm list -g`（stripNpmPrefix 避免环境变量干扰）。
 * @returns 版本号和是否通过 npm 安装
 */
async function getNpmInstallInfo(): Promise<{ version: string | null; isInstalled: boolean }> {
    // 方法0：直接从 CLI 二进制所在目录读取 package.json
    // 发布包结构: opendesk + package.json 在同一目录
    try {
        const binDir = path.dirname(fileURLToPath(import.meta.url));
        const pkgJsonPath = path.join(binDir, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
            const content = fs.readFileSync(pkgJsonPath, 'utf-8');
            const pkg = JSON.parse(content);
            if (pkg.name === PACKAGE_NAME && pkg.version) {
                return { version: pkg.version, isInstalled: true };
            }
        }
    } catch {
        // import.meta.url 不可用或文件读取失败，继续回退
    }

    // 方法1：通过 npm root 获取全局目录，直接读取 package.json
    try {
        const { stdout: globalRoot } = await asyncShellExec('npm root -g', {
            timeout: 10000,
            stripNpmPrefix: true
        });
        const packageJsonPath = `${globalRoot.trim()}/${PACKAGE_NAME}/package.json`;

        if (fs.existsSync(packageJsonPath)) {
            const content = fs.readFileSync(packageJsonPath, 'utf-8');
            const pkg = JSON.parse(content);
            return {
                version: pkg.version || null,
                isInstalled: true
            };
        }
        return { version: null, isInstalled: false };
    } catch {
        // 方法2：回退到 npm list（较慢但可靠）
        try {
            const { stdout } = await asyncShellExec(`npm list -g '${PACKAGE_NAME}' --depth=0 --json`, {
                timeout: 15000,
                stripNpmPrefix: true
            });
            const result = JSON.parse(stdout);
            if (result && result.dependencies && result.dependencies[PACKAGE_NAME]) {
                return {
                    version: result.dependencies[PACKAGE_NAME].version || null,
                    isInstalled: true
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
 * 读取用户配置的 npm registry 地址。
 * 优先级：环境变量 npm_config_registry → ~/.npmrc → 默认 registry.npmjs.org
 * @returns registry URL（不含尾部斜杠）
 */
export function getConfiguredRegistry(): string {
    // 1. npm 脚本运行时注入的环境变量
    if (process.env.npm_config_registry) {
        return process.env.npm_config_registry.replace(/\/+$/, '');
    }
    // 2. 读取用户 ~/.npmrc
    try {
        const npmrcPath = path.join(os.homedir(), '.npmrc');
        if (fs.existsSync(npmrcPath)) {
            const content = fs.readFileSync(npmrcPath, 'utf-8');
            for (const line of content.split('\n')) {
                const m = line.match(/^\s*registry\s*=\s*["']?([^"'\s]+)["']?\s*$/);
                if (m) return m[1].replace(/\/+$/, '');
            }
        }
    } catch {
        // 忽略读取错误
    }
    return 'https://registry.npmjs.org';
}

/**
 * 使用 HTTPS 直接请求 npm registry
 * @param url 完整的 registry URL
 * @param timeout 超时时间（毫秒）
 * @returns JSON 数据或 null
 */
function fetchNpmRegistry(url: string, timeout: number = 15000): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
        const req = https.get(
            url,
            {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'OpenDesk-CLI'
                }
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(null);
                    }
                });
            }
        );

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
 * @param tag npm tag
 * @returns 版本号或 null（如果获取失败）
 */
export async function getNpmVersion(packageName: string, tag: string = 'latest'): Promise<string | null> {
    try {
        // 使用 HTTPS 直接访问用户配置的 registry，比 npm view 命令快很多
        const registry = getConfiguredRegistry();
        const registryUrl = `${registry}/${encodeURIComponent(packageName)}`;
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
            const { stdout } = await asyncShellExec(`npm view '${packageName}' version --tag ${tag}`, {
                timeout: 30000,
                stripNpmPrefix: true
            });
            return stdout.trim() || null;
        } catch {
            return null;
        }
    }
}

// 缓存版本信息，避免重复查询
let cachedVersionInfo: VersionInfo | null = null;
let cachedVersionInfoTime: number = 0;
const VERSION_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

/**
 * 从 npm registry 获取最新版本（通过 dist-tags）
 * @param forceRefresh 是否强制刷新缓存
 * @returns 版本信息
 */
export async function getVersionInfo(forceRefresh: boolean = false): Promise<VersionInfo> {
    const now = Date.now();

    // 检查缓存是否有效
    if (!forceRefresh && cachedVersionInfo && now - cachedVersionInfoTime < VERSION_CACHE_TTL) {
        return cachedVersionInfo;
    }

    // 并行执行所有查询，提升性能
    const [installInfo, latest] = await Promise.all([getNpmInstallInfo(), getNpmVersion(PACKAGE_NAME)]);

    cachedVersionInfo = {
        current: installInfo.version,
        latest,
        needsUpdate: latest !== null && installInfo.version !== null && installInfo.version !== latest,
        isNpmInstalled: installInfo.isInstalled
    };
    cachedVersionInfoTime = now;

    return cachedVersionInfo;
}

/**
 * 比较两个语义化版本号
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
    const parseVersion = (v: string): number[] => {
        const cleanV = v.split('-')[0];
        return cleanV.split('.').map((n) => parseInt(n, 10) || 0);
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

    return 0;
}

/**
 * 执行 npm install -g 安装指定版本。
 * 前置检查（isNpmInstalled、latest 可用性、needsUpdate）应由调用方完成。
 * @param versionInfo 调用方已验证的版本信息
 * @returns 是否安装成功
 */
export async function installVersion(versionInfo: VersionInfo): Promise<{ success: boolean; message: string }> {
    // 防御性检查（安全网，调用方 performUpgrade 已做完整前置检查）
    if (!versionInfo.isNpmInstalled || versionInfo.current === null) {
        return {
            success: false,
            message:
                '当前 OpenDesk 未通过 npm 全局安装，无法使用自动升级功能。\n请使用 npm install -g @bitclub.ai/opendesk-cli 安装。'
        };
    }

    if (!versionInfo.latest) {
        return { success: false, message: '无法从 npm 获取最新版本信息，请检查网络连接' };
    }

    // 执行全局安装
    const installCmd = `npm install -g '${PACKAGE_NAME}@latest'`;
    await asyncShellExec(installCmd, {
        timeout: 120000,
        stripNpmPrefix: true
    });

    // 检查安装是否成功
    const newVersion = await getCurrentVersion();
    if (newVersion === null) {
        return { success: false, message: '安装后无法验证版本，请检查是否安装成功' };
    }
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
 */
export async function performUpgrade(): Promise<UpgradeResult> {
    const versionInfo = await getVersionInfo();

    if (!versionInfo.isNpmInstalled || versionInfo.current === null) {
        return {
            success: false,
            message:
                '当前 OpenDesk 未通过 npm 全局安装，无法使用自动升级功能。\n请使用 npm install -g @bitclub.ai/opendesk-cli 安装。',
            currentVersion: versionInfo.current,
            latestVersion: versionInfo.latest,
            isNpmInstalled: false
        };
    }

    if (!versionInfo.latest) {
        return {
            success: false,
            message: '无法从 npm 获取最新版本信息，请检查网络连接',
            currentVersion: versionInfo.current,
            latestVersion: versionInfo.latest
        };
    }

    if (!versionInfo.needsUpdate) {
        return {
            success: true,
            message: '当前已是最新版本',
            currentVersion: versionInfo.current,
            latestVersion: versionInfo.latest,
            needsUpdate: false
        };
    }

    // 执行升级
    try {
        const result = await installVersion(versionInfo);

        // 安装成功后重新获取当前版本，确保返回最新版本号
        let currentVersion = versionInfo.current;
        if (result.success) {
            const newVersion = await getCurrentVersion();
            if (newVersion !== null) {
                currentVersion = newVersion;
            }
        }

        return {
            success: result.success,
            message: result.message,
            currentVersion,
            latestVersion: versionInfo.latest,
            needsUpdate: true
        };
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            message: `安装失败: ${errorMessage}`,
            currentVersion: versionInfo.current,
            latestVersion: versionInfo.latest,
            needsUpdate: true
        };
    }
}

/**
 * 仅检查版本更新（不执行升级）
 */
export async function checkForUpdate(): Promise<UpgradeResult> {
    const versionInfo = await getVersionInfo();

    return {
        success: true,
        message: versionInfo.needsUpdate
            ? `发现新版本: ${versionInfo.current} -> ${versionInfo.latest}`
            : `当前已是最新版本`,
        currentVersion: versionInfo.current,
        latestVersion: versionInfo.latest,
        needsUpdate: versionInfo.needsUpdate,
        isNpmInstalled: versionInfo.isNpmInstalled
    };
}
