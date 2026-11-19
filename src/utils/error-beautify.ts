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
 * 底层错误文本的归类（纯函数，供 GUI / TUI 等展示层共用）。
 *
 * 展示层拿到原始错误明细（fetch/IPC 抛出的 message、结果对象回传的 error 字段等）后，
 * 据此选择本地化的标题与建议文案：网络类底层错误（DNS / 连接拒绝 / 断网等）归为
 * network，主动超时 / 中止归为 timeout，其余按 generic 处理。
 */

export type ErrorKind = 'network' | 'timeout' | 'generic';

/** 网络类底层错误特征：OS connect 错误码、undici/浏览器 fetch 失败、Electron net 错误 */
const NETWORK_ERROR_PATTERN =
    /getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|fetch failed|Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED/i;

/** 主动超时 / 中止的特征（AbortSignal.timeout、各处超时 race 与本地化超时文案都会落到这里） */
const TIMEOUT_ERROR_PATTERN = /TimeoutError|AbortError|operation was aborted|timed?\s?out|超时/i;

export function classifyErrorText(text: string): ErrorKind {
    const raw = String(text || '');
    // ETIMEDOUT 等连接层超时属于网络故障，先按网络归类，其余明确的超时/中止再单列
    if (NETWORK_ERROR_PATTERN.test(raw)) return 'network';
    if (TIMEOUT_ERROR_PATTERN.test(raw)) return 'timeout';
    return 'generic';
}
