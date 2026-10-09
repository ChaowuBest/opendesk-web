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

/**
 * 管理员令牌安全存储：保存到 userData 下的加密文件（Electron safeStorage）。
 * 加密不可用（如 keyring 缺失）时不落盘、仅会话内有效，避免明文残留。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AdminTokenEncryption {
    available(): boolean;
    encrypt(value: string): Buffer;
    decrypt(value: Buffer): string;
}

interface StoredToken {
    /** 令牌对应的服务端地址，切换服务（本地调试/生产）时不串用 */
    server: string;
    token: string;
}

const TOKEN_MAX_LENGTH = 4096;

/**
 * 管理员令牌存储。文件路径由调用方注入（通常为 userData 下），
 * 加密实现注入以便单测脱离 Electron 运行。
 */
export class AdminTokenStore {
    constructor(
        private readonly file: string,
        private readonly encryption: AdminTokenEncryption
    ) {}

    /** 是否可持久化（加密可用）；false 时令牌仅会话内有效 */
    canPersist(): boolean {
        return this.encryption.available();
    }

    private read(): StoredToken | null {
        if (!this.canPersist() || !existsSync(this.file)) return null;
        try {
            const value: unknown = JSON.parse(this.encryption.decrypt(readFileSync(this.file)));
            if (
                !value ||
                typeof value !== 'object' ||
                typeof (value as StoredToken).server !== 'string' ||
                typeof (value as StoredToken).token !== 'string'
            ) {
                return null;
            }
            return value as StoredToken;
        } catch {
            // 解密失败（换机器/后端变更等）视为无历史授权
            return null;
        }
    }

    /** 读取历史令牌；仅当与服务端地址匹配时返回 */
    load(serverUrl: string): string | null {
        const stored = this.read();
        if (!stored) return null;
        return stored.server === this.normalizeServer(serverUrl) ? stored.token : null;
    }

    /** 最近一次持久化授权对应的服务器（无持久化授权时为 null） */
    lastPersistedServer(): string | null {
        return this.read()?.server ?? null;
    }

    /** 最近一次会话授权对应的服务器（无会话授权时为 null） */
    lastSessionServer(): string | null {
        return this.session?.server ?? null;
    }

    /** 会话内令牌（加密不可用时的兜底），随实例存活、不落盘 */
    private session: StoredToken | null = null;

    loadSession(serverUrl: string): string | null {
        if (!this.session) return null;
        return this.session.server === this.normalizeServer(serverUrl) ? this.session.token : null;
    }

    setSession(serverUrl: string, token: string): void {
        this.session = { server: this.normalizeServer(serverUrl), token };
    }

    clearSession(): void {
        this.session = null;
    }

    save(serverUrl: string, token: string): void {
        const trimmed = token.trim();
        if (!trimmed || trimmed.length > TOKEN_MAX_LENGTH) {
            throw new Error('Invalid admin token');
        }
        if (!this.canPersist()) return;
        const encrypted = this.encryption.encrypt(
            JSON.stringify({ server: this.normalizeServer(serverUrl), token: trimmed })
        );
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = this.file + '.tmp';
        try {
            writeFileSync(temporary, encrypted, { mode: 0o600 });
            renameSync(temporary, this.file);
        } finally {
            rmSync(temporary, { force: true });
        }
    }

    /** 清除历史授权（用户主动登出） */
    clear(): void {
        rmSync(this.file, { force: true });
    }

    private normalizeServer(serverUrl: string): string {
        // 去掉协议差异与尾斜杠，统一按主机+路径比较；解析失败按原文比较
        try {
            const parsed = new URL(serverUrl);
            return `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
        } catch {
            return serverUrl.trim();
        }
    }
}
