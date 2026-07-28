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

import type { LangfuseConfig } from '../../utils/setting.js';

export interface LangfuseRuntimeConfig {
    enabled: true;
    endpoints: LangfuseRuntimeEndpoint[];
    environment?: string;
    maxPayloadChars: number;
}

export interface LangfuseRuntimeEndpoint {
    name: string;
    source: 'file' | 'environment';
    baseUrl: string;
    publicKey: string;
    secretKey: string;
    flushAt: number;
    flushInterval: number;
    exportMode: 'immediate' | 'batched';
}

function nonEmpty(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
    const normalized = nonEmpty(value)?.toLowerCase();
    if (normalized === undefined) {
        return undefined;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') {
        return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
        return false;
    }
    return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
    const normalized = nonEmpty(value);
    if (normalized === undefined) {
        return undefined;
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    return Math.floor(parsed);
}

function parseExportMode(value: unknown): 'immediate' | 'batched' | undefined {
    const normalized = nonEmpty(value)?.toLowerCase();
    return normalized === 'immediate' || normalized === 'batched' ? normalized : undefined;
}

export function resolveLangfuseConfig(
    fileConfig: LangfuseConfig,
    env: NodeJS.ProcessEnv = process.env
): LangfuseRuntimeConfig | undefined {
    const endpoints: LangfuseRuntimeEndpoint[] = [];
    for (const endpoint of fileConfig.endpoints) {
        const publicKey = nonEmpty(endpoint.public_key);
        const secretKey = nonEmpty(endpoint.secret_key);
        if (!endpoint.enabled || !publicKey || !secretKey) {
            continue;
        }
        endpoints.push({
            name: nonEmpty(endpoint.name) ?? nonEmpty(endpoint.base_url) ?? 'Langfuse',
            source: 'file',
            baseUrl: (nonEmpty(endpoint.base_url) ?? 'https://cloud.langfuse.com').replace(/\/+$/, ''),
            publicKey,
            secretKey,
            flushAt: endpoint.flush_at,
            flushInterval: endpoint.flush_interval_seconds,
            exportMode: endpoint.export_mode
        });
    }

    if (parseOptionalBoolean(env.LANGFUSE_ENABLED) === true) {
        const publicKey = nonEmpty(env.LANGFUSE_PUBLIC_KEY);
        const secretKey = nonEmpty(env.LANGFUSE_SECRET_KEY);
        if (publicKey && secretKey) {
            endpoints.push({
                name: 'environment',
                source: 'environment',
                baseUrl: (nonEmpty(env.LANGFUSE_BASE_URL) ?? 'https://cloud.langfuse.com').replace(/\/+$/, ''),
                publicKey,
                secretKey,
                flushAt: parsePositiveInteger(env.LANGFUSE_FLUSH_AT) ?? 50,
                flushInterval: parsePositiveInteger(env.LANGFUSE_FLUSH_INTERVAL) ?? 5,
                exportMode: parseExportMode(env.LANGFUSE_EXPORT_MODE) ?? 'batched'
            });
        }
    }

    const uniqueEndpoints = endpoints.filter(
        (endpoint, index) =>
            endpoints.findIndex(
                (candidate) => candidate.baseUrl === endpoint.baseUrl && candidate.publicKey === endpoint.publicKey
            ) === index
    );
    if (uniqueEndpoints.length === 0) {
        return undefined;
    }

    const environment =
        nonEmpty(env.LANGFUSE_TRACING_ENVIRONMENT) ??
        nonEmpty(env.LANGFUSE_ENVIRONMENT) ??
        nonEmpty(fileConfig.environment);

    return {
        enabled: true,
        endpoints: uniqueEndpoints,
        environment,
        maxPayloadChars: parsePositiveInteger(env.LANGFUSE_MAX_PAYLOAD_CHARS) ?? fileConfig.max_payload_chars
    };
}
