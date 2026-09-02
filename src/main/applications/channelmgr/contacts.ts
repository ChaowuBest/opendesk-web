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
 * 渠道联系人持久化。
 * 当收到渠道消息时自动记录发件人信息，使得自动化任务等场景可以选择投递目标。
 */

import fs from 'fs';
import path from 'path';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';

export interface ChannelContact {
    /** 联系人/群组 ID（senderId 或 groupId） */
    recipientId: string;
    /** 显示名称 */
    displayName: string;
    /** 渠道 ID（如 weixin, feishu） */
    channelId: string;
    /** 账号 ID */
    accountId: string;
    /** 会话类型 */
    chatType: 'direct' | 'group';
    /** 最近一次消息时间 */
    lastMessageAt: string;
}

interface ContactsData {
    contacts: ChannelContact[];
}

const CONTACTS_FILE = 'channel-contacts.json';

function getContactsFilePath(): string {
    return path.join(getOpendeskDirectory(), CONTACTS_FILE);
}

let cachedData: ContactsData | null = null;

function loadData(): ContactsData {
    if (cachedData) return cachedData;
    try {
        const filePath = getContactsFilePath();
        if (!fs.existsSync(filePath)) {
            cachedData = { contacts: [] };
            return cachedData;
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as ContactsData;
        cachedData = { contacts: data.contacts || [] };
        return cachedData;
    } catch (err) {
        logger.warn(`[contacts] 加载联系人数据失败: ${err}`);
        cachedData = { contacts: [] };
        return cachedData;
    }
}

function saveData(data: ContactsData): void {
    try {
        const filePath = getContactsFilePath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        cachedData = data;
    } catch (err) {
        logger.warn(`[contacts] 保存联系人数据失败: ${err}`);
    }
}

/**
 * 记录或更新一个渠道联系人。
 * 每次收到消息时调用，自动去重并更新最近消息时间。
 */
export function recordContact(
    channelId: string,
    accountId: string,
    recipientId: string,
    displayName: string,
    chatType: 'direct' | 'group'
): void {
    if (!recipientId) return;

    const data = loadData();
    const existing = data.contacts.find(
        (c) => c.channelId === channelId && c.accountId === accountId && c.recipientId === recipientId
    );

    if (existing) {
        if (displayName) existing.displayName = displayName;
        existing.lastMessageAt = new Date().toISOString();
    } else {
        data.contacts.push({
            recipientId,
            displayName: displayName || recipientId,
            channelId,
            accountId,
            chatType,
            lastMessageAt: new Date().toISOString()
        });
    }

    saveData(data);
}

/**
 * 获取指定渠道/账号的所有已知联系人，按最近消息时间倒序。
 */
export function getContacts(channelId: string, accountId: string): ChannelContact[] {
    const data = loadData();
    return data.contacts
        .filter((c) => c.channelId === channelId && c.accountId === accountId)
        .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
}

/**
 * 获取所有渠道的所有已知联系人。
 */
export function getAllContacts(): ChannelContact[] {
    const data = loadData();
    return [...data.contacts].sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
}
