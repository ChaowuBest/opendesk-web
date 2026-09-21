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
 * 模型 API 错误 body 的收敛。
 *
 * 改动前，非 2xx 的错误响应只有两种下场：要么丢掉上游给出的详细信息，只剩
 * `403 status code (no body)` 这样的状态码；要么把网关返回的整页 HTML 原样抛给用户。
 * 这里的处理分别对应这两种情况：上游给了详细信息的保存其中一部分（JSON 取
 * error.message 或 message，其余字段如 code 不取）；返回 HTML 页面的对 401/403
 * 包装成一句提示，其它状态码按原文返回。
 */

/** HTML 拦截页提示：仅 401/403 归因于网关拦截 */
const GATEWAY_BLOCKED_401 =
    'request was blocked by a gateway or proxy. Your API key may be missing or expired — check the provider settings.';
const GATEWAY_BLOCKED_403 =
    'request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings.';

function isHtmlBody(text: string): boolean {
    return /^<(!doctype|html)/i.test(text);
}

export function extractErrorMessage(status: number, statusText: string, rawText: string): string {
    const text = (rawText || '').trim();

    if (isHtmlBody(text)) {
        if (status === 401) return GATEWAY_BLOCKED_401;
        if (status === 403) return GATEWAY_BLOCKED_403;
        // 其它状态码的 HTML 页面成因不明，按原文返回（状态码由调用方前缀）
        return text;
    }

    try {
        const body = JSON.parse(text) as Record<string, unknown>;
        const error = body.error;
        const nestedMessage =
            error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
        const message =
            (typeof nestedMessage === 'string' ? nestedMessage : undefined) ??
            (typeof body.message === 'string' ? body.message : undefined);

        if (message?.trim()) {
            return message;
        }
    } catch {
        // 非合法 JSON，按纯文本处理
    }

    return text || statusText || 'request failed';
}
