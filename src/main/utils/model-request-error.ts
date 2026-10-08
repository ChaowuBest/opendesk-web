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

export type ModelProviderProtocol = 'openai' | 'anthropic';
export type ModelErrorDisposition = 'non_retryable' | 'retryable' | 'unknown';

export interface ModelRequestErrorMetadata {
    provider?: ModelProviderProtocol;
    status?: number;
    code?: string;
    type?: string;
    param?: string;
    detailsCode?: string;
    message: string;
    requestId?: string;
    retryAfterMs?: number;
    shouldRetry?: boolean;
}

export class ModelRequestError extends Error {
    readonly metadata: ModelRequestErrorMetadata;

    constructor(metadata: ModelRequestErrorMetadata, options?: ErrorOptions & { displayMessage?: string }) {
        super(options?.displayMessage ?? metadata.message, options);
        this.name = 'ModelRequestError';
        this.metadata = metadata;
    }
}

export function isModelServiceResponseError(error: unknown): error is ModelRequestError {
    if (!(error instanceof ModelRequestError)) {
        return false;
    }

    const metadata = error.metadata;
    return (
        metadata.status !== undefined ||
        metadata.code !== undefined ||
        metadata.type !== undefined ||
        metadata.detailsCode !== undefined ||
        metadata.requestId !== undefined ||
        metadata.retryAfterMs !== undefined ||
        metadata.shouldRetry !== undefined
    );
}

const NON_RETRYABLE_CODES = new Set([
    'invalid_api_key',
    'model_not_found',
    'context_length_exceeded',
    'prompt_too_long',
    'content_policy_violation',
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded'
]);

const NON_RETRYABLE_TYPES = new Set([
    'invalid_request_error',
    'authentication_error',
    'billing_error',
    'permission_error',
    'not_found_error',
    'request_too_large',
    'insufficient_quota'
]);

const RETRYABLE_CODES = new Set(['slow_down', 'rate_limit_exceeded', 'server_is_overloaded']);
const RETRYABLE_TYPES = new Set(['api_error', 'timeout_error', 'overloaded_error', 'service_unavailable_error']);
const NON_RETRYABLE_DETAILS_CODES = new Set(['enforced_spend_limit_reached']);
const NON_RETRYABLE_ERROR_NAMES = new Set(['APIUserAbortError', 'AbortError']);
const NON_RETRYABLE_NETWORK_ERROR_CODES = new Set([
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED'
]);
const NETWORK_ERROR_NAMES = new Set(['APIConnectionError', 'APIConnectionTimeoutError', 'StreamIdleTimeoutError']);
const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET'
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeIdentifier(value: string | undefined): string | undefined {
    return value?.trim().toLowerCase();
}

function headerValue(headers: Headers | undefined, name: string): string | undefined {
    return headers?.get(name) ?? undefined;
}

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
    const retryAfterMs = headerValue(headers, 'retry-after-ms');
    if (retryAfterMs !== undefined) {
        const milliseconds = Number(retryAfterMs);
        if (Number.isFinite(milliseconds) && milliseconds >= 0) {
            return milliseconds;
        }
    }

    const retryAfter = headerValue(headers, 'retry-after');
    if (retryAfter === undefined) {
        return undefined;
    }

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}

function parseShouldRetry(headers: Headers | undefined): boolean | undefined {
    const value = headerValue(headers, 'x-should-retry')?.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
}

function parseJsonRecord(rawText: string): Record<string, unknown> | undefined {
    try {
        return asRecord(JSON.parse(rawText));
    } catch {
        return undefined;
    }
}

export interface ParseModelErrorResponseOptions {
    provider: ModelProviderProtocol;
    status: number;
    statusText: string;
    headers?: Headers;
    rawText: string;
}

export function parseModelErrorResponse(options: ParseModelErrorResponseOptions): ModelRequestError {
    const body = parseJsonRecord(options.rawText);
    const nestedError = asRecord(body?.error);
    const errorBody = nestedError ?? body;
    const details = asRecord(errorBody?.details);
    const message =
        nonEmptyString(errorBody?.message) ??
        nonEmptyString(body?.message) ??
        (options.rawText.trim() || options.statusText || 'request failed');

    return new ModelRequestError({
        provider: options.provider,
        status: options.status,
        code: nonEmptyString(errorBody?.code),
        type: nonEmptyString(errorBody?.type),
        param: nonEmptyString(errorBody?.param),
        detailsCode: nonEmptyString(details?.error_code),
        message,
        requestId:
            nonEmptyString(body?.request_id) ??
            headerValue(options.headers, 'request-id') ??
            headerValue(options.headers, 'x-request-id'),
        retryAfterMs: parseRetryAfterMs(options.headers),
        shouldRetry: parseShouldRetry(options.headers)
    });
}

export function normalizeModelRequestError(
    error: unknown,
    provider?: ModelProviderProtocol,
    displayMessage?: string
): ModelRequestError {
    if (error instanceof ModelRequestError) {
        return displayMessage === undefined
            ? error
            : new ModelRequestError(error.metadata, { cause: error, displayMessage });
    }

    const candidate = asRecord(error);
    const errorBody = asRecord(candidate?.error);
    const details = asRecord(errorBody?.details);
    const headers = candidate?.headers instanceof Headers ? candidate.headers : undefined;
    const message = error instanceof Error ? error.message : String(error);

    return new ModelRequestError(
        {
            provider,
            status: typeof candidate?.status === 'number' ? candidate.status : undefined,
            code: nonEmptyString(candidate?.code) ?? nonEmptyString(errorBody?.code),
            type: nonEmptyString(candidate?.type) ?? nonEmptyString(errorBody?.type),
            param: nonEmptyString(candidate?.param) ?? nonEmptyString(errorBody?.param),
            detailsCode: nonEmptyString(details?.error_code),
            message,
            requestId:
                nonEmptyString(candidate?.requestID) ??
                nonEmptyString(candidate?.request_id) ??
                headerValue(headers, 'request-id') ??
                headerValue(headers, 'x-request-id'),
            retryAfterMs: parseRetryAfterMs(headers),
            shouldRetry: parseShouldRetry(headers)
        },
        error instanceof Error || displayMessage !== undefined
            ? { ...(error instanceof Error ? { cause: error } : {}), displayMessage }
            : undefined
    );
}

export function getModelRequestRetryAfterMs(error: unknown): number | undefined {
    return error instanceof ModelRequestError ? error.metadata.retryAfterMs : undefined;
}

function hasKnownNonRetryableMessage(message: string): boolean {
    return [
        /context length exceeded/i,
        /maximum context length/i,
        /credit balance (is )?(depleted|exhausted)/i,
        /you have reached your specified (workspace )?api usage limits/i
    ].some((pattern) => pattern.test(message));
}

function errorChainSome(error: unknown, predicate: (candidate: unknown) => boolean): boolean {
    const seen = new Set<unknown>();
    let current: unknown = error;

    for (let depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
        if (seen.has(current)) break;
        seen.add(current);

        if (predicate(current)) return true;
        current = asRecord(current)?.cause;
    }

    return false;
}

function hasErrorName(error: unknown, names: ReadonlySet<string>): boolean {
    return errorChainSome(error, (current) => {
        const candidate = asRecord(current);
        const name = current instanceof Error ? current.name : nonEmptyString(candidate?.name);
        return name !== undefined && names.has(name);
    });
}

function hasErrorCode(error: unknown, codes: ReadonlySet<string>): boolean {
    return errorChainSome(error, (current) => {
        const code = nonEmptyString(asRecord(current)?.code)?.toUpperCase();
        return code !== undefined && codes.has(code);
    });
}

export function isNetworkConnectionError(error: unknown): boolean {
    return errorChainSome(error, (current) => {
        const candidate = asRecord(current);

        const name = current instanceof Error ? current.name : nonEmptyString(candidate?.name);
        const code = nonEmptyString(candidate?.code)?.toUpperCase();
        const message =
            current instanceof Error
                ? current.message
                : typeof current === 'string'
                  ? current
                  : (nonEmptyString(candidate?.message) ?? '');

        return (
            (name !== undefined && NETWORK_ERROR_NAMES.has(name)) ||
            (code !== undefined &&
                (NETWORK_ERROR_CODES.has(code) ||
                    NON_RETRYABLE_NETWORK_ERROR_CODES.has(code) ||
                    code.startsWith('ERR_TLS_'))) ||
            /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE)\b/i.test(
                message
            ) ||
            /\b(?:fetch failed|socket hang up|getaddrinfo|network (?:connection )?error|connection (?:error|refused|reset|timed out)|stream idle timeout)\b/i.test(
                message
            )
        );
    });
}

export function classifyModelRequestError(error: unknown): ModelErrorDisposition {
    const normalized = normalizeModelRequestError(error);
    const metadata = normalized.metadata;
    const code = normalizeIdentifier(metadata.code);
    const type = normalizeIdentifier(metadata.type);
    const detailsCode = normalizeIdentifier(metadata.detailsCode);

    if (
        (code !== undefined && NON_RETRYABLE_CODES.has(code)) ||
        (detailsCode !== undefined && NON_RETRYABLE_DETAILS_CODES.has(detailsCode)) ||
        hasKnownNonRetryableMessage(metadata.message) ||
        hasErrorCode(error, NON_RETRYABLE_NETWORK_ERROR_CODES)
    ) {
        return 'non_retryable';
    }

    if (metadata.shouldRetry === false || hasErrorName(error, NON_RETRYABLE_ERROR_NAMES)) {
        return 'non_retryable';
    }

    if (code !== undefined && RETRYABLE_CODES.has(code)) {
        return 'retryable';
    }
    if (metadata.shouldRetry === true) {
        return 'retryable';
    }
    if (type !== undefined && NON_RETRYABLE_TYPES.has(type)) {
        return 'non_retryable';
    }
    if (type !== undefined && RETRYABLE_TYPES.has(type)) {
        return 'retryable';
    }

    const status = metadata.status;
    if (status === 408 || status === 409) {
        return 'retryable';
    }
    if (status === 429) {
        if (metadata.retryAfterMs !== undefined) {
            return 'retryable';
        }
        if (metadata.provider === 'openai' && type === 'rate_limit_error') {
            return 'retryable';
        }
        return 'unknown';
    }
    if (status !== undefined && status >= 400 && status < 500) {
        return 'non_retryable';
    }
    if (status !== undefined && status >= 500) {
        return 'retryable';
    }
    if (isNetworkConnectionError(error)) {
        return 'retryable';
    }
    return 'unknown';
}

export function isNonRetryableModelRequestError(error: unknown): boolean {
    return classifyModelRequestError(error) === 'non_retryable';
}
