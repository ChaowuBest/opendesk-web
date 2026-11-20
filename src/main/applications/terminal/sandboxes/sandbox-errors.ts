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
 * 沙箱组件缺失/不可用的统一错误码。
 *
 * 这类错误只表示"沙箱跑不起来"（二进制未随包、被删除、宿主未实现 Kit），
 * 调用方据此降级为宿主 shell；策略写入、授权端点等故障不带该错误码，
 * 必须继续上抛，避免把故障静默变成以宿主权限运行。
 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE';

export function sandboxUnavailableError(message: string, cause?: unknown): Error {
    return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
        code: SANDBOX_UNAVAILABLE
    });
}

export function isSandboxUnavailableError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === SANDBOX_UNAVAILABLE
    );
}
