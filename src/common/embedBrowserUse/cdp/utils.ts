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
 * embedBrowserUse — CDP utility functions.
 *
 * Key mapping, modifier bitmask computation, sleep, and retry helpers
 * used by BrowserController and CDP-based automation.
 */

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with configurable delays.
 * Only retries when `shouldRetry` returns true for the caught error.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        delays?: number[];
        shouldRetry?: (err: Error) => boolean;
    } = {}
): Promise<T> {
    const { delays = [0, 500, 2000], shouldRetry = () => true } = options;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < delays.length && shouldRetry(lastError)) {
                const delay = delays[attempt];
                if (delay > 0) await sleep(delay);
            } else {
                throw lastError;
            }
        }
    }
    throw lastError;
}

/**
 * Map common key names to CDP key descriptors.
 * CDP Input.dispatchKeyEvent expects specific key/code/keyCode values.
 */
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    f1: { key: 'F1', code: 'F1', keyCode: 112 },
    f2: { key: 'F2', code: 'F2', keyCode: 113 },
    f3: { key: 'F3', code: 'F3', keyCode: 114 },
    f4: { key: 'F4', code: 'F4', keyCode: 115 },
    f5: { key: 'F5', code: 'F5', keyCode: 116 },
    f6: { key: 'F6', code: 'F6', keyCode: 117 },
    f7: { key: 'F7', code: 'F7', keyCode: 118 },
    f8: { key: 'F8', code: 'F8', keyCode: 119 },
    f9: { key: 'F9', code: 'F9', keyCode: 120 },
    f10: { key: 'F10', code: 'F10', keyCode: 121 },
    f11: { key: 'F11', code: 'F11', keyCode: 122 },
    f12: { key: 'F12', code: 'F12', keyCode: 123 }
};

export interface KeyDescriptor {
    key: string;
    code: string;
    keyCode: number;
    text?: string;
    /** Whether the Shift modifier is needed to produce this character on a US QWERTY keyboard */
    shiftKey?: boolean;
}

/**
 * Map symbol characters to their physical key on a US QWERTY keyboard.
 * Each entry provides the base physical key's code and virtual key code.
 * Characters that require Shift have shiftKey: true.
 */
const SYMBOL_KEY_MAP: Record<string, { code: string; keyCode: number; shiftKey: boolean }> = {
    '!': { code: 'Digit1', keyCode: 49, shiftKey: true },
    '@': { code: 'Digit2', keyCode: 50, shiftKey: true },
    '#': { code: 'Digit3', keyCode: 51, shiftKey: true },
    $: { code: 'Digit4', keyCode: 52, shiftKey: true },
    '%': { code: 'Digit5', keyCode: 53, shiftKey: true },
    '^': { code: 'Digit6', keyCode: 54, shiftKey: true },
    '&': { code: 'Digit7', keyCode: 55, shiftKey: true },
    '*': { code: 'Digit8', keyCode: 56, shiftKey: true },
    '(': { code: 'Digit9', keyCode: 57, shiftKey: true },
    ')': { code: 'Digit0', keyCode: 48, shiftKey: true },
    _: { code: 'Minus', keyCode: 189, shiftKey: true },
    '+': { code: 'Equal', keyCode: 187, shiftKey: true },
    '{': { code: 'BracketLeft', keyCode: 219, shiftKey: true },
    '}': { code: 'BracketRight', keyCode: 221, shiftKey: true },
    '|': { code: 'Backslash', keyCode: 220, shiftKey: true },
    ':': { code: 'Semicolon', keyCode: 186, shiftKey: true },
    '"': { code: 'Quote', keyCode: 222, shiftKey: true },
    '<': { code: 'Comma', keyCode: 188, shiftKey: true },
    '>': { code: 'Period', keyCode: 190, shiftKey: true },
    '?': { code: 'Slash', keyCode: 191, shiftKey: true },
    '~': { code: 'Backquote', keyCode: 192, shiftKey: true },

    '-': { code: 'Minus', keyCode: 189, shiftKey: false },
    '=': { code: 'Equal', keyCode: 187, shiftKey: false },
    '[': { code: 'BracketLeft', keyCode: 219, shiftKey: false },
    ']': { code: 'BracketRight', keyCode: 221, shiftKey: false },
    '\\': { code: 'Backslash', keyCode: 220, shiftKey: false },
    ';': { code: 'Semicolon', keyCode: 186, shiftKey: false },
    "'": { code: 'Quote', keyCode: 222, shiftKey: false },
    ',': { code: 'Comma', keyCode: 188, shiftKey: false },
    '.': { code: 'Period', keyCode: 190, shiftKey: false },
    '/': { code: 'Slash', keyCode: 191, shiftKey: false },
    '`': { code: 'Backquote', keyCode: 192, shiftKey: false }
};

/**
 * Resolve a key name (like "Enter", "a", "ArrowDown") to a CDP key descriptor.
 */
export function resolveKey(keyName: string): KeyDescriptor {
    const mapped = KEY_MAP[keyName.toLowerCase()];
    if (mapped) return mapped;

    // Single printable character
    if (keyName.length === 1) {
        const charCode = keyName.charCodeAt(0);

        // Check symbol map first (for characters like $, @, etc.)
        const symMapped = SYMBOL_KEY_MAP[keyName];
        if (symMapped) {
            return {
                key: keyName,
                code: symMapped.code,
                keyCode: symMapped.keyCode,
                text: keyName,
                shiftKey: symMapped.shiftKey
            };
        }

        // Digit 0-9
        if (charCode >= 48 && charCode <= 57) {
            return {
                key: keyName,
                code: `Digit${keyName}`,
                keyCode: charCode,
                text: keyName
            };
        }

        // Letter A-Z, a-z
        if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
            const upper = keyName.toUpperCase();
            return {
                key: keyName,
                code: `Key${upper}`,
                keyCode: upper.charCodeAt(0),
                text: keyName
            };
        }

        // Fallback for other single chars (non-ASCII, etc.)
        return {
            key: keyName,
            code: keyName,
            keyCode: charCode,
            text: keyName
        };
    }

    // Fallback: use as-is
    return { key: keyName, code: keyName, keyCode: 0 };
}

/**
 * Parse modifier strings like "Control", "Shift", "Alt", "Meta"
 * into the CDP bitmask used by Input.dispatchMouseEvent / Input.dispatchKeyEvent.
 */
export function modifiersBitmask(modifiers?: string[]): number {
    if (!modifiers?.length) return 0;
    let mask = 0;
    for (const m of modifiers) {
        switch (m.toLowerCase()) {
            case 'alt':
                mask |= 1;
                break;
            case 'control':
            case 'ctrl':
                mask |= 2;
                break;
            case 'meta':
            case 'command':
            case 'cmd':
                mask |= 4;
                break;
            case 'shift':
                mask |= 8;
                break;
        }
    }
    return mask;
}
