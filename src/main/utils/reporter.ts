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

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getOpendeskDirectory } from './setting.js';
import { getPlatform } from '../../platforms/base.js';
import { logger } from './logger.js';

// 服务端上报接口根地址：设备心跳等客户端上报统一汇入该服务。
// 当前上报内容为 /api/heartbeat（必填 os / device_type / device_id / client_type，
// body JSON 或 query 均可）。
export const REPORTER_SERVER_URL = 'https://opendesk.matrix.openharmony.cn';

// 心跳上报周期：5 小时
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 60 * 1000;

// 单次上报超时：网络异常（DNS 挂起、代理无响应等）时主动放弃，避免占用连接或阻塞进程退出
export const HEARTBEAT_TIMEOUT_MS = 10 * 1000;

const HEARTBEAT_ENDPOINT = `${REPORTER_SERVER_URL}/api/heartbeat`;

export type ClientType = 'desktop' | 'cli';

export interface HeartbeatPayload {
    os: string;
    device_type: string;
    device_id: string;
    client_type: ClientType;
}

export interface ReporterOptions {
    /** 设备标识存储目录（默认 getOpendeskDirectory()），供测试注入临时目录 */
    baseDir?: string;
    /** 服务端地址，默认 HEARTBEAT_ENDPOINT */
    serverUrl?: string;
    /** 单次上报超时，默认 HEARTBEAT_TIMEOUT_MS；供测试注入短超时 */
    timeoutMs?: number;
    /** fetch 实现，默认使用 Platform 统一 fetch（共享代理配置）；供测试注入 mock */
    fetchImpl?: typeof fetch;
}

/**
 * 读取既有身份，首次创建通过完整临时文件的不覆盖原子发布收敛并发调用。
 */
export function getOrCreateDeviceId(baseDir: string = getOpendeskDirectory()): string {
    const identityDir = path.join(baseDir, 'identity');
    const deviceIdFile = path.join(identityDir, 'deviceid.txt');
    const readIdentity = () => fs.readFileSync(deviceIdFile, 'utf8').trim();
    let missing = false;
    try {
        const existing = readIdentity();
        if (existing) return existing;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing = true;
    }
    const deviceId = randomUUID();
    fs.mkdirSync(identityDir, { recursive: true });
    const temporary = path.join(identityDir, `.deviceid-${randomUUID()}.data`);
    let retainedPayload = false;
    try {
        fs.writeFileSync(temporary, deviceId, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        try {
            // hard link publishes a fully closed file without replacing another winner.
            try {
                if (missing) fs.linkSync(temporary, deviceIdFile);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '')) throw error;
                // HiShell's document mount rejects hard links. A relative symbolic link
                // also publishes without replacing a winner; its complete payload must stay.
                try {
                    fs.symlinkSync(path.basename(temporary), deviceIdFile, 'file');
                    retainedPayload = true;
                } catch (publicationError) {
                    try {
                        retainedPayload = fs.readlinkSync(deviceIdFile) === path.basename(temporary);
                    } catch (readlinkError) {
                        // An uncertain readback must not remove a potentially published payload.
                        const readlinkCode = (readlinkError as NodeJS.ErrnoException).code;
                        retainedPayload = !['ENOENT', 'EINVAL'].includes(readlinkCode ?? '');
                    }
                    throw publicationError;
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const published = readIdentity();
        if (published) return published;
        // 以 O_APPEND 记录候选值。所有修复者都使用第一条完整记录，即使写回前被暂停也相同。
        const proposals = deviceIdFile + '.repair';
        fs.appendFileSync(proposals, `\n${deviceId}\n`, { mode: 0o600 });
        let records = '';
        try {
            records = fs.readFileSync(proposals, 'utf8');
        } catch (error) {
            // 其他进程只会在有效 ID 已经落盘后清除记录。
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // 必须先读候选记录，再检查正式文件：晚到进程可能是在上一轮记录清除后才追加的。
        let restored = readIdentity();
        if (!restored) {
            const winner = records.match(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/m)?.[0];
            if (!winner) throw new Error('device_identity_invalid');
            fs.writeFileSync(temporary, winner);
            fs.renameSync(temporary, fs.realpathSync(deviceIdFile));
            restored = winner;
        }
        fs.rmSync(proposals, { force: true });
        return restored;
    } finally {
        if (!retainedPayload) fs.rmSync(temporary, { force: true });
    }
}

/**
 * 构造心跳上报 payload：os / device_type 直接使用 process.platform。
 */
export function buildHeartbeatPayload(clientType: ClientType, deviceId: string): HeartbeatPayload {
    return {
        os: process.platform,
        device_type: process.platform,
        device_id: deviceId,
        client_type: clientType
    };
}

/**
 * 默认 fetch 实现：走 Platform 统一 fetch 以继承系统代理配置。
 * 平台 fetch 只接受 string | URL，这里把 Request 输入按其 url 转发，
 * 使实现签名与 `typeof fetch` 兼容（ReporterOptions.fetchImpl 的类型）。
 */
const platformProxyFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input;
    return getPlatform().fetch(url, init);
};

/**
 * 上送一次心跳。走 Platform 统一 fetch 以继承系统代理配置。
 * 失败仅记录日志，不抛出异常，避免影响主流程。
 */
export async function sendHeartbeat(clientType: ClientType, options: ReporterOptions = {}): Promise<boolean> {
    try {
        const deviceId = getOrCreateDeviceId(options.baseDir);
        const payload = buildHeartbeatPayload(clientType, deviceId);
        const fetchImpl = options.fetchImpl ?? platformProxyFetch;
        const response = await fetchImpl(options.serverUrl ?? HEARTBEAT_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            // 超时后主动放弃（AbortSignal.timeout），避免网络异常长期挂起
            signal: AbortSignal.timeout(options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS)
        });
        if (!response.ok) {
            logger.warn(`[reporter] ${clientType} 心跳上报失败: HTTP ${response.status}`);
            return false;
        }
        logger.info(`[reporter] ${clientType} 心跳已上报 (device_id=${deviceId})`);
        return true;
    } catch (error: unknown) {
        logger.warn(`[reporter] ${clientType} 心跳上报异常: ${String(error)}`);
        return false;
    }
}

/**
 * 启动上报调度：立即上报一次，之后每 5 小时上报一次。
 * 定时器 unref 不阻止进程退出；返回清理函数用于停止调度。
 */
export function startReporter(clientType: ClientType, options: ReporterOptions = {}): () => void {
    void sendHeartbeat(clientType, options);
    const timer = setInterval(() => {
        void sendHeartbeat(clientType, options);
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}
