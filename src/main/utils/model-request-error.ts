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

    constructor(metadata: ModelRequestErrorMetadata, options?: ErrorOptions) {
        super(metadata.message, options);
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

export function normalizeModelRequestError(error: unknown, provider?: ModelProviderProtocol): ModelRequestError {
    if (error instanceof ModelRequestError) {
        return error;
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
        error instanceof Error ? { cause: error } : undefined
    );
}

function hasKnownNonRetryableMessage(message: string): boolean {
    return [
        /context length exceeded/i,
        /maximum context length/i,
        /credit balance (is )?(depleted|exhausted)/i,
        /you have reached your specified (workspace )?api usage limits/i
    ].some((pattern) => pattern.test(message));
}

function isNetworkOrTimeoutError(error: unknown, message: string): boolean {
    const name = error instanceof Error ? error.name : '';
    if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' || name === 'StreamIdleTimeoutError') {
        return true;
    }
    return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b/i.test(message);
}

export function classifyModelRequestError(error: unknown): ModelErrorDisposition {
    const normalized = normalizeModelRequestError(error);
    const metadata = normalized.metadata;
    const originalName = error instanceof Error ? error.name : '';
    const code = normalizeIdentifier(metadata.code);
    const type = normalizeIdentifier(metadata.type);
    const detailsCode = normalizeIdentifier(metadata.detailsCode);

    if (
        (code !== undefined && NON_RETRYABLE_CODES.has(code)) ||
        (detailsCode !== undefined && NON_RETRYABLE_DETAILS_CODES.has(detailsCode)) ||
        hasKnownNonRetryableMessage(metadata.message)
    ) {
        return 'non_retryable';
    }

    if (metadata.shouldRetry === false || originalName === 'APIUserAbortError' || originalName === 'AbortError') {
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
    if (isNetworkOrTimeoutError(error, metadata.message)) {
        return 'retryable';
    }
    return 'unknown';
}

export function isNonRetryableModelRequestError(error: unknown): boolean {
    return classifyModelRequestError(error) === 'non_retryable';
}
