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
import { getOpendeskDirectory } from '../../utils/setting.js';

const SECRETS_DIRECTORY_NAME = 'secrets';
const SESSION_VERSION = 1 as const;

/**
 * 插件作用域的账号凭据持久化存储。
 *
 * 会话文件保存在 <opendesk-dir>/identity/secrets/<scope>.json，权限 0o600。
 * scope 为插件 id，保证多个账号插件的凭据互不可见。
 * 读取采用容错策略：文件不存在、损坏或版本不匹配时返回 null，不抛出异常。
 */
export class AccountTokenStore {
    private readonly scope: string;
    private sessionFilePath: string | undefined;

    constructor(scope: string) {
        this.scope = AccountTokenStore.sanitizeScope(scope);
    }

    /** 会话文件绝对路径（按需解析，便于测试替换 opendesk 目录）。 */
    get filePath(): string {
        if (!this.sessionFilePath) {
            this.sessionFilePath = path.join(
                getOpendeskDirectory(),
                'identity',
                SECRETS_DIRECTORY_NAME,
                `${this.scope}.json`
            );
        }
        return this.sessionFilePath;
    }

    /** 读取会话文件，失败或损坏时返回 null。 */
    load(): unknown {
        return this.readFile(this.filePath);
    }

    /** 写入会话文件，创建父目录并设置 0o600 权限（Windows 忽略 mode，沿用 NTFS 默认 ACL）。 */
    save(session: unknown): void {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(session, null, 4), { mode: 0o600 });
    }

    /** 删除会话文件（不存在时静默忽略）。 */
    clear(): void {
        try {
            fs.rmSync(this.filePath, { force: true });
        } catch {
            // 忽略删除失败
        }
    }

    private readFile(filePath: string): unknown {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw) as { version?: unknown };
            if (parsed.version !== SESSION_VERSION) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    /** scope 来自插件 id，已由宿主校验过合法性；这里再做一次防御性清洗以保证路径安全。 */
    private static sanitizeScope(scope: string): string {
        const sanitized = scope.replace(/[^a-zA-Z0-9._-]+/g, '-');
        if (!sanitized || sanitized.startsWith('.')) {
            throw new Error(`account:secrets_scope_invalid:${scope}`);
        }
        return sanitized;
    }
}
