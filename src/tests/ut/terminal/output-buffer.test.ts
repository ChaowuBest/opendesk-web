import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    BoundedOutputBuffer,
    TERMINAL_OUTPUT_HEAD_CHARS,
    TERMINAL_OUTPUT_MAX_CHARS,
    TERMINAL_OUTPUT_TAIL_CHARS
} from '../../../main/applications/terminal/output-buffer.js';

describe('BoundedOutputBuffer', () => {
    test('retains output below the limit', () => {
        const buffer = new BoundedOutputBuffer();
        buffer.append('hello');

        expect(buffer.getText()).toBe('hello');
        expect(buffer.isTruncated()).toBe(false);
        expect(buffer.getTotalBytes()).toBe(5);
    });

    test('keeps a bounded head and tail for oversized output', () => {
        const buffer = new BoundedOutputBuffer();
        buffer.append('a'.repeat(TERMINAL_OUTPUT_MAX_CHARS));
        buffer.append('tail');

        const text = buffer.getText();
        expect(buffer.isTruncated()).toBe(true);
        expect(text).toMatch(/display truncated|截断显示/);
        expect(text.endsWith('tail')).toBe(true);
        expect(buffer.getTotalBytes()).toBe(TERMINAL_OUTPUT_MAX_CHARS + 4);
        expect(buffer.getText().length).toBeLessThan(TERMINAL_OUTPUT_HEAD_CHARS + TERMINAL_OUTPUT_TAIL_CHARS + 100);
    });

    test('does not grow the retained tail when a single chunk is very large', () => {
        const buffer = new BoundedOutputBuffer('x'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 1));
        buffer.append('y'.repeat(TERMINAL_OUTPUT_TAIL_CHARS * 2));

        expect(buffer.getText().endsWith('y'.repeat(TERMINAL_OUTPUT_TAIL_CHARS))).toBe(true);
        expect(buffer.getText().length).toBeLessThan(TERMINAL_OUTPUT_HEAD_CHARS + TERMINAL_OUTPUT_TAIL_CHARS + 100);
    });

    test('does not split a surrogate pair at the preview boundary', () => {
        const buffer = new BoundedOutputBuffer();
        buffer.append('a'.repeat(TERMINAL_OUTPUT_HEAD_CHARS - 1) + '😀' + 'b'.repeat(TERMINAL_OUTPUT_MAX_CHARS));
        buffer.append('😀');

        const text = buffer.getText();
        expect(text).not.toContain('\uD83D\n');
        expect(text.endsWith('😀')).toBe(true);
    });

    test('writes the complete output to an artifact after truncation', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-output-buffer-'));
        const artifactPath = path.join(directory, 'terminal.log');
        try {
            const buffer = new BoundedOutputBuffer('', 'truncated', artifactPath, 'saved');
            const first = 'a'.repeat(TERMINAL_OUTPUT_MAX_CHARS);
            const second = '\ncomplete tail';
            buffer.append(first);
            buffer.append(second);
            buffer.closeArtifact();

            expect(fs.readFileSync(artifactPath, 'utf8')).toBe(first + second);
            expect(buffer.getText()).toContain(`saved: ${artifactPath}`);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
