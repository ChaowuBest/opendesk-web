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
 * 节点配对持久化存储。
 * pending.json 存放待审批请求（TTL 5 分钟），paired.json 存放已配对节点。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generatePairingToken, safeEqual } from './device-identity.js';
import type { PairedNode, PairingList, PendingPairingRequest } from './common.js';
import { PENDING_PAIRING_TTL_MS } from './common.js';

type PairingState = {
    pendingById: Record<string, PendingPairingRequest>;
    pairedByNodeId: Record<string, PairedNode>;
};

export class PairingStore {
    private dataDir: string;
    private pendingPath: string;
    private pairedPath: string;

    constructor(dataDir: string) {
        this.dataDir = path.join(dataDir, 'nodes');
        this.pendingPath = path.join(this.dataDir, 'pending.json');
        this.pairedPath = path.join(this.dataDir, 'paired.json');
        fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // ── State I/O ───────────────────────────────────────────────────────

    private loadState(): PairingState {
        const pending = this.readJson<Record<string, PendingPairingRequest>>(this.pendingPath) ?? {};
        const paired = this.readJson<Record<string, PairedNode>>(this.pairedPath) ?? {};
        this.pruneExpired(pending);
        return { pendingById: pending, pairedByNodeId: paired };
    }

    private persistState(state: PairingState): void {
        this.writeJson(this.pendingPath, state.pendingById);
        this.writeJson(this.pairedPath, state.pairedByNodeId);
    }

    private readJson<T>(filePath: string): T | null {
        try {
            if (!fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return null;
        }
    }

    private writeJson(filePath: string, data: unknown): void {
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmpPath, filePath);
    }

    private pruneExpired(pending: Record<string, PendingPairingRequest>): void {
        const now = Date.now();
        for (const [id, req] of Object.entries(pending)) {
            if (now - req.ts > PENDING_PAIRING_TTL_MS) {
                delete pending[id];
            }
        }
    }

    // ── Public API ──────────────────────────────────────────────────────

    list(): PairingList {
        const state = this.loadState();
        const pending = Object.values(state.pendingById).sort((a, b) => b.ts - a.ts);
        const paired = Object.values(state.pairedByNodeId).sort((a, b) => b.approvedAtMs - a.approvedAtMs);
        return { pending, paired };
    }

    /**
     * 创建或复用一个配对请求。同一个 nodeId 的请求是幂等的。
     */
    requestPairing(req: Omit<PendingPairingRequest, 'requestId' | 'ts' | 'isRepair'>): {
        status: 'pending';
        request: PendingPairingRequest;
        created: boolean;
    } {
        const state = this.loadState();
        const nodeId = req.nodeId.trim();
        if (!nodeId) throw new Error('nodeId required');

        const existing = Object.values(state.pendingById).find(p => p.nodeId === nodeId);
        if (existing) {
            return { status: 'pending', request: existing, created: false };
        }

        const isRepair = Boolean(state.pairedByNodeId[nodeId]);
        const request: PendingPairingRequest = {
            requestId: crypto.randomUUID(),
            nodeId,
            displayName: req.displayName,
            platform: req.platform,
            version: req.version,
            deviceFamily: req.deviceFamily,
            modelIdentifier: req.modelIdentifier,
            caps: req.caps,
            commands: req.commands,
            remoteIp: req.remoteIp,
            silent: req.silent,
            isRepair,
            ts: Date.now(),
        };

        state.pendingById[request.requestId] = request;
        this.persistState(state);
        return { status: 'pending', request, created: true };
    }

    /**
     * 审批配对请求，生成 token。
     */
    approve(requestId: string): { requestId: string; node: PairedNode } | null {
        const state = this.loadState();
        const pending = state.pendingById[requestId];
        if (!pending) return null;

        const now = Date.now();
        const existing = state.pairedByNodeId[pending.nodeId];
        const node: PairedNode = {
            nodeId: pending.nodeId,
            token: generatePairingToken(),
            displayName: pending.displayName,
            platform: pending.platform,
            version: pending.version,
            deviceFamily: pending.deviceFamily,
            modelIdentifier: pending.modelIdentifier,
            caps: pending.caps,
            commands: pending.commands,
            remoteIp: pending.remoteIp,
            createdAtMs: existing?.createdAtMs ?? now,
            approvedAtMs: now,
        };

        delete state.pendingById[requestId];
        state.pairedByNodeId[pending.nodeId] = node;
        this.persistState(state);
        return { requestId, node };
    }

    /**
     * 拒绝配对请求。
     */
    reject(requestId: string): { requestId: string; nodeId: string } | null {
        const state = this.loadState();
        const pending = state.pendingById[requestId];
        if (!pending) return null;

        delete state.pendingById[requestId];
        this.persistState(state);
        return { requestId, nodeId: pending.nodeId };
    }

    /**
     * 验证节点的 pairing token。
     */
    verifyToken(nodeId: string, token: string): { ok: boolean; node?: PairedNode } {
        const state = this.loadState();
        const node = state.pairedByNodeId[nodeId.trim()];
        if (!node) return { ok: false };
        return safeEqual(token, node.token) ? { ok: true, node } : { ok: false };
    }

    /**
     * 获取指定已配对节点。
     */
    getPaired(nodeId: string): PairedNode | null {
        const state = this.loadState();
        return state.pairedByNodeId[nodeId.trim()] ?? null;
    }

    /**
     * 重命名已配对节点。
     */
    rename(nodeId: string, displayName: string): PairedNode | null {
        const state = this.loadState();
        const node = state.pairedByNodeId[nodeId.trim()];
        if (!node) return null;
        node.displayName = displayName.trim();
        this.persistState(state);
        return node;
    }

    /**
     * 更新已配对节点的最后连接时间及元数据。
     */
    updateLastConnected(nodeId: string, patch?: Partial<Pick<PairedNode, 'version' | 'platform' | 'deviceFamily' | 'caps' | 'commands' | 'remoteIp'>>): void {
        const state = this.loadState();
        const node = state.pairedByNodeId[nodeId.trim()];
        if (!node) return;
        node.lastConnectedAtMs = Date.now();
        if (patch) {
            if (patch.version !== undefined) node.version = patch.version;
            if (patch.platform !== undefined) node.platform = patch.platform;
            if (patch.deviceFamily !== undefined) node.deviceFamily = patch.deviceFamily;
            if (patch.caps !== undefined) node.caps = patch.caps;
            if (patch.commands !== undefined) node.commands = patch.commands;
            if (patch.remoteIp !== undefined) node.remoteIp = patch.remoteIp;
        }
        this.persistState(state);
    }
}
