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
 */

import path from 'path';
import { getAppDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import type {
    PluginEntry,
    ChannelPlugin,
    PluginLogger,
    OpenClawPluginApi,
} from '../types.js';

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

function buildPluginRuntime() {
    return {
        platform: 'opendesk' as const,
        log: (...args: any[]) => logger.info(...args),
        error: (...args: any[]) => logger.error(...args),
        warn: (...args: any[]) => logger.warn(...args),
        channel: {
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
            text: {
                hasControlCommand: (text: string, _cfg?: any) => {
                    if (!text) return false;
                    const trimmed = text.trim();
                    return trimmed.startsWith('/') || trimmed === '!stop' || trimmed === '!reset';
                },
            },
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
        info: (...args: any[]) => logger.info(`[plugin:${entry.id}]`, ...args),
        warn: (...args: any[]) => logger.warn(`[plugin:${entry.id}]`, ...args),
        error: (...args: any[]) => logger.error(`[plugin:${entry.id}]`, ...args),
        debug: (...args: any[]) => logger.info(`[plugin:${entry.id}][debug]`, ...args),
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