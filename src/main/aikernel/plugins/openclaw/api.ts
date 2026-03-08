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
 * OpenClaw plugin API implementation.
 * Provides the API object that is passed to plugin registration functions.
 * Also implements the OpenClaw runtime subsystems (channel.reply, channel.routing,
 * etc.) that channel plugins depend on for message processing and error handling.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { getAppDirectory } from '../../../utils/setting.js';
import { logger, addConsoleInterceptHook } from '../../../utils/logger.js';
import type {
    PluginEntry,
    ChannelPlugin,
    PluginLogger,
    OpenClawPluginApi,
    InboundChannelMessage,
} from '../types.js';
import {
    getApprovedUserIds,
    isUserApproved,
    upsertPairingRequest as storageUpsert,
    removePairingRequest as storageRemove,
    getPendingRequests,
    approveUser,
    revokeUser,
} from '../../../applications/channelmgr/pairing.js';

// Winston only uses the first argument as info.message; extra args are dropped.
// Stringify all args into a single string so nothing is lost.
function fmtArgs(...args: any[]): string {
    return args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a, null, 2) ?? String(a); }
        catch { return String(a); }
    }).join(' ');
}

// ── Channel Dispatch Bridge ──────────────────────────────────────────────────
// Maps "channelId:accountId" → OpenDesk dispatch function.
// Registered by ChannelMgrApplication when starting each account;
// consumed by runtime.channel.reply.dispatchReplyFromConfig to bridge
// the OpenClaw plugin message pipeline into OpenDesk's routing system.

const channelDispatchers = new Map<string, (msg: InboundChannelMessage) => Promise<void>>();

export function registerChannelDispatch(
    channelId: string,
    accountId: string,
    dispatch: (msg: InboundChannelMessage) => Promise<void>,
): void {
    channelDispatchers.set(`${channelId}:${accountId}`, dispatch);
}

export function unregisterChannelDispatch(channelId: string, accountId: string): void {
    channelDispatchers.delete(`${channelId}:${accountId}`);
}

// ── Inbound Debouncer ────────────────────────────────────────────────────────

const DEFAULT_INBOUND_DEBOUNCE_MS = 1500;

function createInboundDebouncer<T>(opts: {
    debounceMs: number;
    buildKey: (event: T) => string | null;
    shouldDebounce: (event: T) => boolean;
    onFlush: (entries: T[]) => Promise<void>;
    onError?: (err: unknown) => void;
}) {
    const { debounceMs, buildKey, shouldDebounce, onFlush, onError } = opts;
    const pending = new Map<string, { entries: T[]; timer: ReturnType<typeof setTimeout> }>();

    function flush(key: string) {
        const bucket = pending.get(key);
        if (!bucket) return;
        pending.delete(key);
        onFlush(bucket.entries).catch((err) => onError?.(err));
    }

    return {
        enqueue(event: T) {
            const key = buildKey(event);
            if (!key || debounceMs <= 0 || !shouldDebounce(event)) {
                return onFlush([event]).catch((err) => onError?.(err));
            }
            const bucket = pending.get(key);
            if (bucket) {
                clearTimeout(bucket.timer);
                bucket.entries.push(event);
                bucket.timer = setTimeout(() => flush(key), debounceMs);
            } else {
                const timer = setTimeout(() => flush(key), debounceMs);
                pending.set(key, { entries: [event], timer });
            }
        },
    };
}

// ── Text Utilities ───────────────────────────────────────────────────────────

function chunkText(text: string, limit: number): string[] {
    if (!text || !limit || text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        let splitAt = remaining.lastIndexOf('\n', limit);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
        if (splitAt <= 0) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }
    return chunks;
}

// ── API Error Capture ────────────────────────────────────────────────────────
// Stores recent API errors so dispatchReplyFromConfig can include them
// as system context in messages sent to the agent.

const CAPTURED_ERROR_TTL_MS = 60_000;
const MAX_CAPTURED_ERRORS = 10;

interface CapturedError {
    timestamp: number;
    message: string;
    channelKey?: string;
}

const capturedErrors: CapturedError[] = [];

function pruneOldErrors() {
    const cutoff = Date.now() - CAPTURED_ERROR_TTL_MS;
    while (capturedErrors.length > 0 && capturedErrors[0].timestamp < cutoff) {
        capturedErrors.shift();
    }
}

const API_ERROR_PATTERNS = [
    /\b99991672\b/,
    /permission.{0,10}error/i,
    /permission.{0,10}violation/i,
    /access.{0,10}denied/i,
    /scope.{0,10}required/i,
    /open\.feishu\.cn\/app\/.+\/auth/,
];

function detectAndCaptureApiError(text: string, channelKey?: string) {
    if (!text) return;
    for (const pattern of API_ERROR_PATTERNS) {
        if (pattern.test(text)) {
            pruneOldErrors();
            if (capturedErrors.length >= MAX_CAPTURED_ERRORS) capturedErrors.shift();
            capturedErrors.push({ timestamp: Date.now(), message: text, channelKey });
            return;
        }
    }
}

function drainCapturedErrors(channelKey?: string): CapturedError[] {
    pruneOldErrors();
    if (capturedErrors.length === 0) return [];
    const matching = channelKey
        ? capturedErrors.filter(e => !e.channelKey || e.channelKey === channelKey)
        : [...capturedErrors];
    for (const e of matching) {
        const idx = capturedErrors.indexOf(e);
        if (idx >= 0) capturedErrors.splice(idx, 1);
    }
    return matching;
}

// Register console intercept hook so Lark SDK errors (output via console.log)
// are captured into the same error buffer.
addConsoleInterceptHook((_level, message) => {
    detectAndCaptureApiError(message);
});

// ── Plugin Runtime ───────────────────────────────────────────────────────────

function buildPluginRuntime() {
    return {
        platform: 'opendesk' as const,
        log: (...args: any[]) => {
            const msg = fmtArgs(...args);
            detectAndCaptureApiError(msg);
            logger.info(msg);
        },
        error: (...args: any[]) => {
            const msg = fmtArgs(...args);
            detectAndCaptureApiError(msg);
            logger.error(msg);
        },
        warn: (...args: any[]) => {
            const msg = fmtArgs(...args);
            detectAndCaptureApiError(msg);
            logger.warn(msg);
        },

        channel: {
            // ── debounce ─────────────────────────────────────────────────
            debounce: {
                resolveInboundDebounceMs: (params: { cfg?: any; channel?: string }) => {
                    const channelId = params.channel;
                    const channelCfg = channelId
                        ? params.cfg?.channels?.[channelId]
                        : undefined;
                    return channelCfg?.debounceMs ?? DEFAULT_INBOUND_DEBOUNCE_MS;
                },
                createInboundDebouncer,
            },

            // ── text ─────────────────────────────────────────────────────
            text: {
                hasControlCommand: (text: string, _cfg?: any) => {
                    if (!text) return false;
                    const trimmed = text.trim();
                    return trimmed.startsWith('/') || trimmed === '!stop' || trimmed === '!reset';
                },
                resolveMarkdownTableMode: (_opts?: any) => 'native' as const,
                convertMarkdownTables: (text: string, _mode?: string) => text,
                chunkMarkdownText: (text: string, limit?: number) =>
                    chunkText(text, limit || 4000),
                chunkTextWithMode: (text: string, limit?: number, _mode?: string) =>
                    chunkText(text, limit || 4000),
                resolveTextChunkLimit: (
                    _cfg?: any, _channel?: string, _accountId?: string,
                    opts?: { fallbackLimit?: number },
                ) => opts?.fallbackLimit ?? 4000,
                resolveChunkMode: () => 'text' as const,
            },

            // ── commands ─────────────────────────────────────────────────
            commands: {
                shouldComputeCommandAuthorized: (text: string, _cfg?: any) => {
                    if (!text) return false;
                    const trimmed = text.trim();
                    return trimmed.startsWith('/') || trimmed.startsWith('!');
                },
                resolveCommandAuthorizedFromAuthorizers: (_params?: any) => true,
            },

            // ── routing ──────────────────────────────────────────────────
            routing: {
                resolveAgentRoute: (params: any) => ({
                    sessionKey: `${params.channel || 'unknown'}:${params.accountId || 'default'}:${params.peer?.id || 'default'}`,
                    agentId: params.accountId || 'default',
                    accountId: params.accountId || 'default',
                    matchedBy: 'default',
                }),
            },

            // ── pairing (delegates to persistent storage) ────────────────
            pairing: {
                buildPairingReply: (params: any) =>
                    `Your account requires pairing approval.\n${params.idLine || ''}\nPairing code: ${params.code || ''}`,
                readAllowFromStore: (channel: string, accountId: string) =>
                    getApprovedUserIds(channel, accountId),
                isUserApproved: (channel: string, accountId: string, userId: string) =>
                    isUserApproved(channel, accountId, userId),
                upsertPairingRequest: (channel: string, accountId: string, userId: string, meta?: any) =>
                    storageUpsert(channel, accountId, userId, meta),
                removePairingRequest: (channel: string, accountId: string, userId: string) =>
                    storageRemove(channel, accountId, userId),
                listPairingRequests: (channel?: string, accountId?: string) =>
                    getPendingRequests(channel, accountId),
                approveUser: (channel: string, accountId: string, userId: string, meta?: any) =>
                    approveUser(channel, accountId, userId, meta),
                revokeUser: (channel: string, accountId: string, userId: string) =>
                    revokeUser(channel, accountId, userId),
            },

            // ── reply (bridges to OpenDesk dispatch) ─────────────────────
            reply: {
                resolveEnvelopeFormatOptions: (_cfg?: any) => ({
                    includeTimestamp: false,
                    includeChannel: false,
                }),

                formatAgentEnvelope: (params: any) => params.body || '',

                finalizeInboundContext: (params: any) => ({ ...params }),

                resolveHumanDelayConfig: (_cfg?: any, _agentId?: string) => ({
                    enabled: false,
                    minMs: 0,
                    maxMs: 0,
                }),

                createReplyDispatcherWithTyping: (params: any) => {
                    const deliver = params.deliver || (async () => {});
                    return {
                        dispatcher: {
                            deliver,
                            onIdle: params.onIdle,
                            onCleanup: params.onCleanup,
                        },
                        replyOptions: {},
                        markDispatchIdle: () => {
                            params.onIdle?.();
                            params.onCleanup?.();
                        },
                    };
                },

                withReplyDispatcher: async (params: any) => {
                    try {
                        await params.run();
                    } finally {
                        params.onSettled?.();
                    }
                    return { queuedFinal: true, counts: { final: 1 } };
                },

                dispatchReplyFromConfig: async (params: any) => {
                    const ctx = params.ctx;
                    if (!ctx) return;

                    const channelId = ctx.Provider || ctx.OriginatingChannel || 'unknown';
                    const accountId = ctx.AccountId || 'default';
                    const key = `${channelId}:${accountId}`;
                    const dispatch = channelDispatchers.get(key);

                    if (!dispatch) {
                        logger.warn(`[runtime] no dispatch registered for ${key}, message dropped`);
                        return;
                    }

                    let body: string = ctx.Body || ctx.RawBody || '';

                    const recentErrors = drainCapturedErrors(key);
                    if (recentErrors.length > 0) {
                        const errorSummary = recentErrors
                            .map(e => e.message)
                            .join('\n');
                        body += `\n\n[System: The channel plugin encountered API errors that may affect functionality. Please inform the user and suggest corrective actions.\n${errorSummary}]`;
                    }

                    const isGroup = ctx.ChatType === 'group';
                    const message: InboundChannelMessage = {
                        channelId,
                        accountId,
                        senderId: ctx.SenderId || ctx.From || '',
                        senderName: ctx.SenderName,
                        text: body,
                        chatType: isGroup ? 'group' : 'direct',
                        groupId: isGroup ? ctx.GroupSubject : undefined,
                        threadId: ctx.RootMessageId,
                        messageId: ctx.MessageSid,
                        replyToMessageId: ctx.ReplyToId,
                        raw: ctx,
                    };

                    await dispatch(message);
                },
            },

            // ── media ────────────────────────────────────────────────────
            media: {
                saveMediaBuffer: async (
                    buffer: Buffer, contentType: string,
                    _dir?: string, _maxBytes?: number, fileName?: string,
                ) => {
                    const ext = contentType?.split('/')[1]?.split(';')[0] || 'bin';
                    const name = fileName || `media-${Date.now()}.${ext}`;
                    const mediaDir = path.join(os.tmpdir(), 'opendesk-media');
                    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
                    const filePath = path.join(mediaDir, name);
                    fs.writeFileSync(filePath, buffer);
                    return { path: filePath, contentType: contentType || 'application/octet-stream' };
                },
            },
        },

        // ── top-level media utilities ────────────────────────────────────
        media: {
            detectMime: async (params: any) => {
                const buffer = params?.buffer;
                if (!buffer || buffer.length < 4) return 'application/octet-stream';
                if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
                if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
                if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
                if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
                if (buffer[0] === 0x25 && buffer[1] === 0x50) return 'application/pdf';
                return 'application/octet-stream';
            },
            loadWebMedia: async () => null,
        },

        // ── logging ──────────────────────────────────────────────────────
        logging: {
            shouldLogVerbose: () => false,
        },

        // ── config ───────────────────────────────────────────────────────
        config: {
            writeConfigFile: async () => {},
        },
    };
}

/**
 * Create the plugin API object that is passed to the plugin's register function.
 * This API provides hooks for plugins to register channels, tools, commands, etc.
 */
export function createPluginApi(
    entry: PluginEntry,
    onChannelRegistered: (cp: ChannelPlugin) => void,
): OpenClawPluginApi {
    const pluginLogger: PluginLogger = {
        info: (...args: any[]) => logger.info(`[plugin:${entry.id}] ${fmtArgs(...args)}`),
        warn: (...args: any[]) => logger.warn(`[plugin:${entry.id}] ${fmtArgs(...args)}`),
        error: (...args: any[]) => logger.error(`[plugin:${entry.id}] ${fmtArgs(...args)}`),
        debug: (...args: any[]) => logger.info(`[plugin:${entry.id}][debug] ${fmtArgs(...args)}`),
    };

    return {
        id: entry.id,
        name: entry.manifest.name || entry.id,
        version: entry.manifest.version,
        description: entry.manifest.description,
        source: 'opendesk',
        config: {},
        pluginConfig: {},
        runtime: buildPluginRuntime(),
        logger: pluginLogger,

        registerTool: (_tool: any, _opts?: any) => {
            pluginLogger.debug('registerTool (skipped in OpenDesk)');
        },

        registerHook: (_events: any, _handler: any, _opts?: any) => {
            pluginLogger.debug('registerHook (skipped in OpenDesk)');
        },

        registerHttpHandler: (_handler: any) => {
            pluginLogger.debug('registerHttpHandler (skipped in OpenDesk)');
        },

        registerHttpRoute: (_params: any) => {
            pluginLogger.debug('registerHttpRoute (skipped in OpenDesk)');
        },

        registerChannel: (registration: any) => {
            pluginLogger.info('registerChannel called');
            const plugin = registration?.plugin || registration;
            if (plugin && plugin.id) {
                onChannelRegistered(plugin as ChannelPlugin);
            }
        },

        registerGatewayMethod: (_method: string, _handler: any) => {
            pluginLogger.debug('registerGatewayMethod (skipped in OpenDesk)');
        },

        registerCli: (_registrar: any, _opts?: any) => {
            pluginLogger.debug('registerCli (skipped in OpenDesk)');
        },

        registerService: (_service: any) => {
            pluginLogger.debug('registerService (skipped in OpenDesk)');
        },

        registerProvider: (_provider: any) => {
            pluginLogger.debug('registerProvider (skipped in OpenDesk)');
        },

        registerCommand: (_command: any) => {
            pluginLogger.debug('registerCommand (skipped in OpenDesk)');
        },

        resolvePath: (input: string) => path.resolve(getAppDirectory(), input),

        on: (_hookName: string, _handler: any, _opts?: any) => {
            pluginLogger.debug(`on(${_hookName}) (skipped in OpenDesk)`);
        },
    };
}