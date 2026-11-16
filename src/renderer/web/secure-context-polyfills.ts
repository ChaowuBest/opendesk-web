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
 * 非安全上下文（http + 非 localhost，例如 http://10.x.x.x:31854）下浏览器不提供
 * crypto.randomUUID 与 navigator.clipboard。桌面版 renderer 直接调用它们，
 * 缺失时会在组件构造中抛错（侧边栏底部工具栏、任务视图等整段初始化中断）。
 * web preload 在每个页面最先执行这里的补丁，只补缺失的接口，不覆盖原生实现。
 */

function randomUUIDFallback(): `${string}-${string}-${string}-${string}-${string}` {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    // RFC 4122 v4：版本位 0100，变体位 10
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function copyWithExecCommand(doc: Document | undefined, text: string): boolean {
    if (!doc?.body) return false;
    const textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    doc.body.appendChild(textarea);
    textarea.select();
    try {
        return doc.execCommand('copy');
    } catch {
        return false;
    } finally {
        textarea.remove();
    }
}

export function installSecureContextPolyfills(target: typeof globalThis = globalThis): void {
    const cryptoObject = target.crypto as (Crypto & { randomUUID?: unknown }) | undefined;
    if (
        cryptoObject &&
        typeof cryptoObject.getRandomValues === 'function' &&
        typeof cryptoObject.randomUUID !== 'function'
    ) {
        Object.defineProperty(cryptoObject, 'randomUUID', {
            value: randomUUIDFallback,
            configurable: true,
            writable: true
        });
    }

    const navigatorObject = target.navigator as (Navigator & { clipboard?: unknown }) | undefined;
    if (navigatorObject && !navigatorObject.clipboard) {
        // 系统剪贴板读不到；页面内复制过的内容仍可读回，保证应用内复制粘贴可用
        let lastCopied = '';
        const clipboard = {
            async writeText(text: string): Promise<void> {
                lastCopied = String(text);
                if (!copyWithExecCommand(target.document, lastCopied)) {
                    throw new DOMException('Clipboard is unavailable outside a secure context', 'NotAllowedError');
                }
            },
            async readText(): Promise<string> {
                return lastCopied;
            }
        };
        Object.defineProperty(navigatorObject, 'clipboard', { value: clipboard, configurable: true });
    }
}

installSecureContextPolyfills();
