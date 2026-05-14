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
}

/**
 * Resolve a key name (like "Enter", "a", "ArrowDown") to a CDP key descriptor.
 */
export function resolveKey(keyName: string): KeyDescriptor {
    const mapped = KEY_MAP[keyName.toLowerCase()];
    if (mapped) return mapped;

    // Single printable character
    if (keyName.length === 1) {
        const charCode = keyName.charCodeAt(0);
        const upper = keyName.toUpperCase();
        return {
            key: keyName,
            code:
                (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)
                    ? `Key${upper}`
                    : `Digit${keyName}`,
            keyCode: upper.charCodeAt(0),
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
