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
import { getOpendeskDirectory } from '../../../../main/utils/setting.js';
import type { StoredSession, UserSession } from './types';

const SESSION_FILE = 'huawei-session.json';

function getSessionFilePath(): string {
    return path.join(getOpendeskDirectory(), 'identity', SESSION_FILE);
}

/** 从磁盘加载会话信息 */
export function loadSession(): UserSession | null {
    const filePath = getSessionFilePath();
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as StoredSession;
        if (parsed?.version === 1 && typeof parsed.accessToken === 'string') {
            return {
                accessToken: parsed.accessToken,
                refreshToken: parsed.refreshToken,
                expiresAt: parsed.expiresAt,
                unionId: parsed.unionId,
                openId: parsed.openId,
                anonymousPhone: parsed.anonymousPhone
            };
        }
        return null;
    } catch {
        return null;
    }
}

/** 保存会话信息到磁盘 */
export function saveSession(session: UserSession): void {
    const filePath = getSessionFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stored: StoredSession = {
        version: 1,
        createdAtMs: Date.now(),
        ...session
    };
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
}

/** 删除会话文件 */
export function deleteSession(): void {
    const filePath = getSessionFilePath();
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        /* ignore */
    }
}
