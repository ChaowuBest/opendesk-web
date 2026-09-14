/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import fs from 'fs';
import path from 'path';

export const TERMINAL_OUTPUT_MAX_CHARS = 256 * 1024;
export const TERMINAL_OUTPUT_HEAD_CHARS = 64 * 1024;
export const TERMINAL_OUTPUT_TAIL_CHARS = TERMINAL_OUTPUT_MAX_CHARS - TERMINAL_OUTPUT_HEAD_CHARS;

function takeHead(text: string, maxChars: number): string {
    const result = text.slice(0, maxChars);
    return result.length > 0 && /[\uD800-\uDBFF]/.test(result[result.length - 1]) ? result.slice(0, -1) : result;
}

function takeTail(text: string, maxChars: number): string {
    const result = text.slice(-maxChars);
    return result.length > 0 && /[\uDC00-\uDFFF]/.test(result[0]) ? result.slice(1) : result;
}

/**
 * Keeps terminal output bounded while preserving the beginning and end of a command's output.
 * Streams are still consumed after the limit is reached, so a noisy child process cannot block
 * on a full pipe merely because its output is no longer retained in memory.
 */
export class BoundedOutputBuffer {
    private head = '';
    private tail = '';
    private totalBytes = 0;
    private truncated = false;
    private readonly truncationMessage: string;
    private readonly artifactPath?: string;
    private readonly artifactMessage: string;
    private artifactFd?: number;
    private artifactWriteFailed = false;

    constructor(
        initialOutput = '',
        truncationMessage = 'Output too large; display truncated',
        artifactPath?: string,
        artifactMessage = 'Complete output saved to'
    ) {
        this.truncationMessage = truncationMessage;
        this.artifactPath = artifactPath;
        this.artifactMessage = artifactMessage;
        this.append(initialOutput);
    }

    append(chunk: string): void {
        if (!chunk) return;

        this.totalBytes += Buffer.byteLength(chunk, 'utf8');
        if (!this.truncated) {
            const combined = this.head + chunk;
            if (combined.length <= TERMINAL_OUTPUT_MAX_CHARS) {
                this.head = combined;
                return;
            }

            this.head = takeHead(combined, TERMINAL_OUTPUT_HEAD_CHARS);
            this.tail = takeTail(combined, TERMINAL_OUTPUT_TAIL_CHARS);
            this.truncated = true;
            this.writeArtifact(combined);
            return;
        }

        this.writeArtifact(chunk);
        if (chunk.length >= TERMINAL_OUTPUT_TAIL_CHARS) {
            this.tail = takeTail(chunk, TERMINAL_OUTPUT_TAIL_CHARS);
        } else {
            this.tail = takeTail(this.tail + chunk, TERMINAL_OUTPUT_TAIL_CHARS);
        }
    }

    getText(): string {
        if (!this.truncated) return this.head;

        const artifactNotice =
            this.artifactPath && !this.artifactWriteFailed ? `\n${this.artifactMessage}: ${this.artifactPath}` : '';
        const marker = `\n\n--- ${this.truncationMessage}${artifactNotice} ---\n\n`;
        return this.head + marker + this.tail;
    }

    closeArtifact(): void {
        if (this.artifactFd === undefined) return;
        try {
            fs.closeSync(this.artifactFd);
        } catch {
            /* best effort */
        }
        this.artifactFd = undefined;
    }

    getTotalBytes(): number {
        return this.totalBytes;
    }

    isTruncated(): boolean {
        return this.truncated;
    }

    private writeArtifact(text: string): void {
        if (!this.artifactPath || !text || this.artifactWriteFailed) return;
        try {
            if (this.artifactFd === undefined) {
                fs.mkdirSync(path.dirname(this.artifactPath), { recursive: true });
                this.artifactFd = fs.openSync(this.artifactPath, 'w');
            }
            fs.writeSync(this.artifactFd, Buffer.from(text, 'utf8'));
        } catch {
            this.artifactWriteFailed = true;
            this.closeArtifact();
        }
    }
}
