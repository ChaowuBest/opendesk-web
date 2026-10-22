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

import { Setting } from './setting.js';
import type { HarmonyOSSystemProxy } from '../../platforms/bridges/harmonyos/proxy.js';

export interface ProxyEnvVars {
    HTTP_PROXY?: string;
    HTTPS_PROXY?: string;
    http_proxy?: string;
    https_proxy?: string;
    NO_PROXY?: string;
    no_proxy?: string;
}

interface EffectiveSystemProxy {
    url: string;
    bypassList?: string;
}

/**
 * 在 OpenHarmony 上通过 ArkTS 桥接获取系统代理；
 * Windows 通过注册表读取，macOS 通过 scutil --proxy 读取；
 * Linux 等无系统代理 API 的平台透传环境变量。
 * 鸿蒙 Chromium 不读取 OS 代理，必须走 getDefaultHttpProxy() 桥接。
 *
 * 动态 import 避免在非鸿蒙平台拖入 electron 依赖链（arkts.ts 顶层 import
 * systemPreferences from 'electron'），shellExec 静态 import 本模块时不受影响。
 *
 * 导出给需要自行建连的模块（邮件隧道）在 use_proxy=system 时复用。
 */
export async function getEffectiveSystemProxy(): Promise<EffectiveSystemProxy | null> {
    if ((process.platform as string) === 'openharmony') {
        return getHarmonySystemProxy();
    }
    if (process.platform === 'win32') {
        return getWindowsSystemProxy();
    }
    if (process.platform === 'darwin') {
        return getMacOSSystemProxy();
    }
    return getEnvSystemProxy();
}

async function getHarmonySystemProxy(): Promise<EffectiveSystemProxy | null> {
    const { getHarmonyOSSystemProxy } = await import('../../platforms/bridges/harmonyos/proxy.js');
    const sys: HarmonyOSSystemProxy | null = await getHarmonyOSSystemProxy();
    if (!sys || !sys.host || sys.port <= 0) return null;
    // 鸿蒙 host 可能带协议前缀（如 "http://1.2.3.4"），剥离后拼标准格式
    const cleanHost = sys.host.replace(/^https?:\/\//, '');
    const result: EffectiveSystemProxy = { url: `http://${cleanHost}:${sys.port}` };
    if (sys.exclusionList && sys.exclusionList.length > 0) {
        result.bypassList = sys.exclusionList.join(',');
    }
    return result;
}

/**
 * Windows：读注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 * - ProxyEnable=1 时启用，ProxyServer 格式 "host:port" 或 "http=host:port;https=..."
 * - ProxyOverride 用分号分隔，转逗号以符合 env 约定
 */
async function getWindowsSystemProxy(): Promise<EffectiveSystemProxy | null> {
    const { execFile } = await import('child_process');
    const stdout = await new Promise<string>((resolve) => {
        execFile(
            'reg',
            ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
            { windowsHide: true },
            (err, out) => resolve(err ? '' : (out ?? '').toString())
        );
        // 第一次查询 ProxyEnable；若为 0 直接返回，省去后续查询
    });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) return null;

    // 查 ProxyServer 与 ProxyOverride
    const all = await new Promise<string>((resolve) => {
        execFile(
            'reg',
            ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
            { windowsHide: true },
            (err, out) => resolve(err ? '' : (out ?? '').toString())
        );
    });

    const proxyServerMatch = all.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (!proxyServerMatch) return null;
    let proxyRaw = proxyServerMatch[1].trim();
    // ProxyServer 可能是 "host:port" 或 "http=host:port;https=host:port"
    // 取 https 优先，否则取整体
    const httpsPart = proxyRaw.split(';').find((p) => p.trim().startsWith('https='));
    if (httpsPart) {
        proxyRaw = httpsPart.replace(/^https=/, '').trim();
    } else {
        proxyRaw = proxyRaw.split(';')[0].trim();
    }
    // 规范化为 http:// 前缀（reg 里的 ProxyServer 不带协议）
    const proxyUrl = /^https?:\/\//.test(proxyRaw) ? proxyRaw : `http://${proxyRaw}`;

    const result: EffectiveSystemProxy = { url: proxyUrl };
    const overrideMatch = all.match(/ProxyOverride\s+REG_SZ\s+(.+)/);
    if (overrideMatch) {
        const bypass = overrideMatch[1].trim();
        if (bypass) {
            // Windows 用分号分隔，转逗号
            result.bypassList = bypass.replace(/[;]/g, ',');
        }
    }
    return result;
}

/**
 * macOS：执行 scutil --proxy，解析键值对。
 * - HTTPEnable/HTTPSEnable=1 时启用
 * - HTTPProxy/HTTPSProxy + HTTPPort/HTTPSPort 组成 URL
 * - ExceptionsList 为多行数组，转逗号分隔
 */
async function getMacOSSystemProxy(): Promise<EffectiveSystemProxy | null> {
    const { execFile } = await import('child_process');
    const stdout = await new Promise<string>((resolve) => {
        execFile('scutil', ['--proxy'], {}, (err, out) => resolve(err ? '' : (out ?? '').toString()));
    });
    if (!stdout) return null;

    const lines = stdout.split('\n');
    const map: Record<string, string | string[]> = {};
    let currentArrayKey: string | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 数组项："  0 : value"
        const arrMatch = trimmed.match(/^(\d+)\s*:\s*(.+)$/);
        if (arrMatch && currentArrayKey) {
            const arr = map[currentArrayKey];
            if (Array.isArray(arr)) arr.push(arrMatch[2]);
            continue;
        }
        // 键值："Key : Value"
        const kvMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
        if (kvMatch) {
            currentArrayKey = null;
            const key = kvMatch[1];
            const val = kvMatch[2];
            if (val === '') {
                map[key] = [];
                currentArrayKey = key;
            } else {
                map[key] = val;
            }
        }
    }

    const httpsEnabled = map.HTTPSEnable === '1';
    const httpEnabled = map.HTTPEnable === '1';
    if (!httpsEnabled && !httpEnabled) return null;

    // 优先 HTTPS，回退 HTTP
    const host = (httpsEnabled ? map.HTTPSProxy : map.HTTPProxy) as string | undefined;
    const port = (httpsEnabled ? map.HTTPSPort : map.HTTPPort) as string | undefined;
    if (!host || !port) return null;

    const result: EffectiveSystemProxy = { url: `http://${host}:${port}` };
    const exceptions = map.ExceptionsList;
    if (Array.isArray(exceptions) && exceptions.length > 0) {
        result.bypassList = exceptions.join(',');
    }
    return result;
}

/**
 * Linux 等无系统代理 API 的平台：透传环境变量。
 */
function getEnvSystemProxy(): Promise<EffectiveSystemProxy | null> {
    const proxyUrl =
        process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (!proxyUrl) return Promise.resolve(null);

    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    const result: EffectiveSystemProxy = { url: proxyUrl };
    if (noProxy) result.bypassList = noProxy;
    return Promise.resolve(result);
}

/**
 * 从 network_config 解析出标准代理环境变量三元组。
 *
 * 行为矩阵：
 *   - none   → {}（由注入层负责 delete 已有代理变量）
 *   - custom → HTTP_PROXY/HTTPS_PROXY 来自 custom_proxy_addr，NO_PROXY 来自 no_proxy
 *   - system → 鸿蒙走 ArkTS 桥接，Windows 读注册表，macOS 读 scutil，Linux 透传 env
 *
 * 大小写双写：curl 读小写，wget/Node fetch 读大写。
 * NO_PROXY 格式为逗号分隔（标准 env 约定，与 Chromium 分号分隔不同）。
 */
export async function resolveProxyEnvVars(): Promise<ProxyEnvVars> {
    const nc = Setting.getInstance().getData().network_config;
    const useProxy = nc.use_proxy ?? 'system';

    if (useProxy === 'none') return {};

    let proxyUrl: string | null = null;
    let noProxy: string | undefined;

    if (useProxy === 'custom') {
        proxyUrl = nc.custom_proxy_addr.trim() || null;
        noProxy = nc.no_proxy || undefined;
    } else if (useProxy === 'system') {
        const sys = await getEffectiveSystemProxy();
        if (sys) {
            proxyUrl = sys.url;
            noProxy = sys.bypassList;
        }
    }

    if (!proxyUrl) return {};

    const result: ProxyEnvVars = {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl
    };
    if (noProxy) {
        result.NO_PROXY = noProxy;
        result.no_proxy = noProxy;
    }
    return result;
}

// ── 代理 env 缓存 ─────────────────────────────────────────────────────────
// buildChildProcessEnv 是同步函数，无法直接 await resolveProxyEnvVars()。
// 由 refreshProxyEnvCache() 在启动、配置变更、定时器触发时预热，
// getCachedProxyEnvVars() 同步读取，过期返回 null 不阻塞 spawn。
const PROXY_ENV_TTL_MS = 30_000;

let cachedProxyEnv: ProxyEnvVars | null = null;
let cachedAt = 0;

/**
 * 同步读取缓存的代理 env 变量。缓存未就绪或过期时返回 null，不阻塞。
 * buildChildProcessEnv 在每次 spawn 时调用此函数。
 */
export function getCachedProxyEnvVars(): ProxyEnvVars | null {
    if (cachedProxyEnv === null) return null;
    if (Date.now() - cachedAt > PROXY_ENV_TTL_MS) return null;
    return cachedProxyEnv;
}

/**
 * 异步预热代理 env 缓存。在启动、网络配置变更、定时器触发时调用。
 * 失败时将缓存置为 null，不影响后续重试。
 */
export async function refreshProxyEnvCache(): Promise<void> {
    try {
        cachedProxyEnv = await resolveProxyEnvVars();
        cachedAt = Date.now();
    } catch {
        cachedProxyEnv = null;
        cachedAt = 0;
    }
}

/**
 * 网络配置变更后立即刷新缓存。供设置保存入口（IPC handler）调用，
 * 使新的 network_config 即时作用到命令行子进程，无需等待 30s 定时器。
 * 失败静默，不向调用方抛异常。
 */
export async function onNetworkConfigChanged(): Promise<void> {
    await refreshProxyEnvCache();
}

const PROXY_ENV_REFRESH_INTERVAL_MS = 30_000;

/**
 * 启动代理 env 缓存定时刷新调度器。立即执行一次预热，之后每 30s 刷新。
 * 在 Electron / CLI 启动阶段（AgentRegistry.initBuiltinAgents 之后）调用。
 *
 * @returns 停止函数，调用后取消定时器（用于测试或进程退出清理）
 */
export function startProxyEnvRefreshScheduler(): () => void {
    void refreshProxyEnvCache();
    const timer = setInterval(() => void refreshProxyEnvCache(), PROXY_ENV_REFRESH_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}
