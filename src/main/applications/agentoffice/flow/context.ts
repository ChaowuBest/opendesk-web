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

import type { AgentFlowDetail, AgentFlowMessage } from './common.js';
import { t } from '../locale/index.js';
import type { HistoryQuery } from '../common.js';

export interface FlowHistorySnapshot {
    flow: AgentFlowDetail;
    messages: AgentFlowMessage[];
    messageRefs: Record<string, string>;
}

export interface FlowProjectedMessage {
    message: string;
    sender?: string | { name: string; title?: string };
    text?: string;
    createdAt?: string;
    replyTo?: string;
    addressedTo?: string[];
    attachments?: { name: string; mediaType: string; mimeType: string; path: string }[];
    deleted?: true;
}

export function projectFlowConversationContext(snapshot: FlowHistorySnapshot, unreadMessageIds: readonly string[]) {
    const visible = new Set(snapshot.messages.map((message) => message.id));
    const deletedReferences = new Set<string>();
    const messages: FlowProjectedMessage[] = snapshot.messages.map((message) => {
        const member = snapshot.flow.members.find((candidate) => candidate.staffId === message.sender.id);
        const sender =
            message.sender.type === 'staff'
                ? {
                      name: message.sender.name ?? member?.name ?? t('agentoffice.flow.sender.left'),
                      ...((message.sender.title ?? member?.title)
                          ? { title: message.sender.title ?? member?.title }
                          : {})
                  }
                : t(message.sender.type === 'user' ? 'agentoffice.flow.sender.user' : 'agentoffice.flow.sender.system');
        const attachments = message.content
            .filter((part) => part.type === 'resource')
            .map((part) => ({
                name: part.name,
                mediaType: part.mediaType,
                mimeType: part.mimeType,
                path: part.path
            }));
        const addressedTo = message.mentions
            .map((id) => snapshot.flow.members.find((entry) => entry.staffId === id)?.name)
            .filter((name): name is string => Boolean(name));
        const replyTo = message.replyToMessageId ? snapshot.messageRefs[message.replyToMessageId] : undefined;
        if (replyTo && message.replyToMessageId && !visible.has(message.replyToMessageId))
            deletedReferences.add(replyTo);
        return {
            message: snapshot.messageRefs[message.id],
            sender,
            text: message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n'),
            createdAt: message.createdAt,
            ...(replyTo ? { replyTo } : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(addressedTo.length ? { addressedTo: [...new Set(addressedTo)] } : {})
        };
    });
    for (const reference of deletedReferences) messages.push({ message: reference, deleted: true });
    messages.sort((a, b) => Number(a.message.slice(1)) - Number(b.message.slice(1)));
    return {
        messages,
        unreadMessageRefs: unreadMessageIds.filter((id) => visible.has(id)).map((id) => snapshot.messageRefs[id])
    };
}

export function queryFlowHistory(snapshot: FlowHistorySnapshot, query: HistoryQuery) {
    const projected = projectFlowConversationContext(snapshot, []);
    let messages = projected.messages;
    if (query.mode === 'time_range') {
        const start = Date.parse(query.start_time);
        const end = Date.parse(query.end_time);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
            throw new Error(t('agentoffice.error.invalidHistoryRange'));
        messages = messages.filter(
            (message) =>
                message.createdAt && Date.parse(message.createdAt) >= start && Date.parse(message.createdAt) <= end
        );
    }
    if (query.cursor) {
        if (
            !/^m[1-9][0-9]*$/.test(query.cursor) ||
            !projected.messages.some((message) => message.message === query.cursor)
        ) {
            throw new Error(t('agentoffice.error.invalidHistoryCursor'));
        }
        messages = messages.filter((message) => Number(message.message.slice(1)) < Number(query.cursor!.slice(1)));
    }
    const limit = query.limit ?? 50;
    const page = messages.slice(-limit);
    const hasMore = messages.length > page.length;
    return { messages: page, hasMore, ...(hasMore ? { nextCursor: page[0].message } : {}) };
}
