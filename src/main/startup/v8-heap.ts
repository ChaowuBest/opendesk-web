/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export const OPENDESK_V8_HEAP_SIZE_MB = 4096;
export const OPENDESK_V8_HEAP_FLAG = `--max-old-space-size=${OPENDESK_V8_HEAP_SIZE_MB}`;
export const OPENDESK_V8_HEAP_CONFIGURED_ENV = 'OPENDESK_V8_HEAP_CONFIGURED';

function hasHeapSizeFlag(args: readonly string[]): boolean {
    return args.some((arg) => /--max[-_]old[-_]space[-_]size(?:=|\b)/i.test(arg));
}

export function shouldConfigureV8Heap(
    argv: readonly string[],
    execArgv: readonly string[],
    environment: Readonly<Record<string, string | undefined>>
): boolean {
    if (environment[OPENDESK_V8_HEAP_CONFIGURED_ENV] === '1') {
        return false;
    }

    return !hasHeapSizeFlag([...argv, ...execArgv]);
}

export function buildV8HeapRestartArgs(argv: readonly string[]): string[] {
    return [`--js-flags=${OPENDESK_V8_HEAP_FLAG}`, ...argv.slice(1)];
}
