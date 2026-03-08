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

import { BaseTool } from '../../aikernel/tool.js';
import { z } from 'zod';
import {
    getPendingRequests,
    getApprovedUsers,
    approveUser,
    revokeUser,
    removePairingRequest,
} from './pairing.js';
import type { ChannelMgrApplication } from './app.js';

// ── List Pairing Requests ───────────────────────────────────────────────────

const ListPairingRequestsSchema = z.object({
    channel: z.string().optional().describe('Filter by channel name, e.g. "feishu". Omit to show all channels.'),
});

export class ListPairingRequestsTool extends BaseTool<typeof ListPairingRequestsSchema> {
    constructor() {
        super(
            'listPairingRequests',
            'List all pending pairing requests from external users. Shows user ID, display name, channel, and pairing code.',
            ListPairingRequestsSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ListPairingRequestsSchema>): Promise<string> {
        const requests = getPendingRequests(args.channel);
        if (requests.length === 0) {
            return '当前没有待审批的配对请求。';
        }
        const lines = requests.map((r, i) =>
            `${i + 1}. 用户ID: ${r.id}\n   名称: ${r.meta?.name || '未知'}\n   渠道: ${r.channel}\n   账户: ${r.accountId}\n   配对码: ${r.code}\n   请求时间: ${r.createdAt}`,
        );
        return `共 ${requests.length} 个待审批的配对请求：\n\n${lines.join('\n\n')}`;
    }
}

// ── Approve Pairing ─────────────────────────────────────────────────────────

const ApprovePairingSchema = z.object({
    userId: z.string().describe('The user ID to approve (shown in pairing request list)'),
    channel: z.string().describe('The channel name, e.g. "feishu"'),
    accountId: z.string().default('default').describe('The account ID, defaults to "default"'),
});

export class ApprovePairingTool extends BaseTool<typeof ApprovePairingSchema> {
    constructor() {
        super(
            'approvePairing',
            'Approve a pending pairing request. The user will then be able to send messages that are routed to the agent.',
            ApprovePairingSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ApprovePairingSchema>): Promise<string> {
        const pending = getPendingRequests(args.channel, args.accountId);
        const match = pending.find(r => r.id === args.userId);
        if (!match) {
            const approved = getApprovedUsers(args.channel, args.accountId);
            if (approved.some(u => u.id === args.userId)) {
                return `用户 ${args.userId} 已经是已配对状态，无需重复审批。`;
            }
        }
        approveUser(args.channel, args.accountId, args.userId, match?.meta);
        const name = match?.meta?.name || args.userId;
        return `已批准用户 ${name} (${args.userId}) 在 ${args.channel}:${args.accountId} 上的配对请求。该用户后续的消息将正常路由到 Agent。`;
    }
}

// ── Revoke Pairing ──────────────────────────────────────────────────────────

const RevokePairingSchema = z.object({
    userId: z.string().describe('The user ID to revoke or reject'),
    channel: z.string().describe('The channel name, e.g. "feishu"'),
    accountId: z.string().default('default').describe('The account ID, defaults to "default"'),
});

export class RevokePairingTool extends BaseTool<typeof RevokePairingSchema> {
    constructor() {
        super(
            'revokePairing',
            'Revoke an approved user or reject a pending pairing request. The user will no longer be able to send messages.',
            RevokePairingSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof RevokePairingSchema>): Promise<string> {
        const revokedApproved = revokeUser(args.channel, args.accountId, args.userId);
        const removedPending = removePairingRequest(args.channel, args.accountId, args.userId);

        if (revokedApproved) {
            return `已撤销用户 ${args.userId} 在 ${args.channel}:${args.accountId} 上的配对权限。该用户后续消息将不再被路由。`;
        }
        if (removedPending) {
            return `已拒绝用户 ${args.userId} 在 ${args.channel}:${args.accountId} 上的配对请求。`;
        }
        return `未找到用户 ${args.userId} 在 ${args.channel}:${args.accountId} 上的配对记录。`;
    }
}

// ── List Approved Users ─────────────────────────────────────────────────────

const ListApprovedUsersSchema = z.object({
    channel: z.string().optional().describe('Filter by channel name. Omit to show all channels.'),
});

export class ListApprovedUsersTool extends BaseTool<typeof ListApprovedUsersSchema> {
    constructor() {
        super(
            'listApprovedUsers',
            'List all approved/paired users across all channels.',
            ListApprovedUsersSchema,
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.infer<typeof ListApprovedUsersSchema>): Promise<string> {
        const users = getApprovedUsers(args.channel);
        if (users.length === 0) {
            return '当前没有已配对的用户。';
        }
        const lines = users.map((u, i) =>
            `${i + 1}. 用户ID: ${u.id}\n   名称: ${u.meta?.name || '未知'}\n   渠道: ${u.channel}\n   账户: ${u.accountId}\n   批准时间: ${u.approvedAt}`,
        );
        return `共 ${users.length} 个已配对用户：\n\n${lines.join('\n\n')}`;
    }
}

// ── List Channel Status ─────────────────────────────────────────────────────

const ListChannelStatusSchema = z.object({});

export class ListChannelStatusTool extends BaseTool<typeof ListChannelStatusSchema> {
    private app: ChannelMgrApplication;

    constructor(app: ChannelMgrApplication) {
        super(
            'listChannelStatus',
            'List all channel plugins and their current connection status.',
            ListChannelStatusSchema,
        );
        this.app = app;
        this.setExecutor(this.run.bind(this));
    }

    private async run(): Promise<string> {
        const states = this.app.getChannelStates();
        if (states.length === 0) {
            return '当前没有运行中的消息渠道插件。';
        }
        const lines = states.map((s, i) => {
            const icon = s.status.online ? '🟢' : '🔴';
            const statusText = s.status.statusText || (s.status.online ? '在线' : '离线');
            const err = s.status.error ? `\n   错误: ${s.status.error}` : '';
            return `${i + 1}. ${icon} ${s.label} (${s.channelId}:${s.accountId})\n   状态: ${statusText}${err}`;
        });
        return `共 ${states.length} 个渠道插件：\n\n${lines.join('\n\n')}`;
    }
}
