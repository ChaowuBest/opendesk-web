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
 * Channel pairing state persistence.
 * Stores approved users and pending pairing requests in a JSON file
 * so that pairing survives across restarts.
 */

import fs from 'fs';
import path from 'path';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';

export interface PairingRequest {
    id: string;
    channel: string;
    accountId: string;
    code: string;
    meta?: { name?: string; [key: string]: any };
    createdAt: string;
}

export interface ApprovedUser {
    id: string;
    channel: string;
    accountId: string;
    meta?: { name?: string; [key: string]: any };
    approvedAt: string;
}

interface PairingData {
    approvedUsers: ApprovedUser[];
    pendingRequests: PairingRequest[];
}

const PAIRING_FILE = 'channel-pairing.json';

function getPairingFilePath(): string {
    return path.join(getOpendeskDirectory(), PAIRING_FILE);
}

function loadData(): PairingData {
    try {
        const filePath = getPairingFilePath();
        if (!fs.existsSync(filePath)) {
            return { approvedUsers: [], pendingRequests: [] };
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as PairingData;
        return {
            approvedUsers: data.approvedUsers || [],
            pendingRequests: data.pendingRequests || []
        };
    } catch (err: any) {
        logger.warn(`Failed to load pairing data: ${err?.message || err}`);
        return { approvedUsers: [], pendingRequests: [] };
    }
}

function saveData(data: PairingData): void {
    try {
        const filePath = getPairingFilePath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
        logger.error(`Failed to save pairing data: ${err?.message || err}`);
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getApprovedUsers(channel?: string, accountId?: string): ApprovedUser[] {
    const data = loadData();
    return data.approvedUsers.filter(
        (u) => (!channel || u.channel === channel) && (!accountId || u.accountId === accountId)
    );
}

export function getApprovedUserIds(channel: string, accountId: string): string[] {
    return getApprovedUsers(channel, accountId).map((u) => u.id);
}

export function isUserApproved(channel: string, accountId: string, userId: string): boolean {
    return getApprovedUsers(channel, accountId).some((u) => u.id === userId);
}

export function approveUser(
    channel: string,
    accountId: string,
    userId: string,
    meta?: { name?: string; [key: string]: any }
): void {
    const data = loadData();
    const exists = data.approvedUsers.some(
        (u) => u.channel === channel && u.accountId === accountId && u.id === userId
    );
    if (!exists) {
        data.approvedUsers.push({
            id: userId,
            channel,
            accountId,
            meta,
            approvedAt: new Date().toISOString()
        });
    }
    data.pendingRequests = data.pendingRequests.filter(
        (r) => !(r.channel === channel && r.accountId === accountId && r.id === userId)
    );
    saveData(data);
}

export function revokeUser(channel: string, accountId: string, userId: string): boolean {
    const data = loadData();
    const before = data.approvedUsers.length;
    data.approvedUsers = data.approvedUsers.filter(
        (u) => !(u.channel === channel && u.accountId === accountId && u.id === userId)
    );
    if (data.approvedUsers.length < before) {
        saveData(data);
        return true;
    }
    return false;
}

export function getPendingRequests(channel?: string, accountId?: string): PairingRequest[] {
    const data = loadData();
    return data.pendingRequests.filter(
        (r) => (!channel || r.channel === channel) && (!accountId || r.accountId === accountId)
    );
}

export function upsertPairingRequest(
    channel: string,
    accountId: string,
    userId: string,
    meta?: { name?: string; [key: string]: any }
): { code: string; created: boolean } {
    if (isUserApproved(channel, accountId, userId)) {
        return { code: '', created: false };
    }

    const data = loadData();
    const existing = data.pendingRequests.find(
        (r) => r.channel === channel && r.accountId === accountId && r.id === userId
    );
    if (existing) {
        return { code: existing.code, created: false };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    data.pendingRequests.push({
        id: userId,
        channel,
        accountId,
        code,
        meta,
        createdAt: new Date().toISOString()
    });
    saveData(data);
    return { code, created: true };
}

export function removePairingRequest(channel: string, accountId: string, userId: string): boolean {
    const data = loadData();
    const before = data.pendingRequests.length;
    data.pendingRequests = data.pendingRequests.filter(
        (r) => !(r.channel === channel && r.accountId === accountId && r.id === userId)
    );
    if (data.pendingRequests.length < before) {
        saveData(data);
        return true;
    }
    return false;
}
