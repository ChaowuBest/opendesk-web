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
import type { AccountSessionFile, AccountSessionStore } from './types.js';

const SESSION_FILE_NAME = 'account-session.json';
const SESSION_VERSION = 1 as const;

/**
 * 账号会话持久化存储。
 *
 * 会话文件保存在 <opendesk-dir>/identity/account-session.json，权限 0o600。
 * 读取采用容错策略：文件不存在、损坏或版本不匹配时返回 null，不抛出异常。
 */
export class AccountTokenStore implements AccountSessionStore {
    private sessionFilePath: string | undefined;

    /** 会话文件绝对路径（按需解析，便于测试替换 opendesk 目录）。 */
    get filePath(): string {
        if (!this.sessionFilePath) {
            this.sessionFilePath = path.join(getOpendeskDirectory(), 'identity', SESSION_FILE_NAME);
        }
        return this.sessionFilePath;
    }

    /** 读取会话文件，失败或损坏时返回 null。 */
    load(): AccountSessionFile | null {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as AccountSessionFile;
            if (parsed.version !== SESSION_VERSION) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    /** 写入会话文件，创建父目录并设置 0o600 权限。 */
    save(session: AccountSessionFile): void {
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
}
