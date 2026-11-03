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

    test('writes the complete output to an artifact after truncation', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-output-buffer-'));
        const artifactPath = path.join(directory, 'terminal.log');
        try {
            const buffer = new BoundedOutputBuffer('', 'truncated', artifactPath, 'saved');
            const first = 'a'.repeat(TERMINAL_OUTPUT_MAX_CHARS);
            const second = '\ncomplete tail';
            buffer.append(first);
            buffer.append(second);
            await buffer.closeArtifact();

            expect(fs.readFileSync(artifactPath, 'utf8')).toBe(first + second);
            expect(buffer.getText()).toContain(`saved: ${artifactPath}`);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    /**
     * 回归：artifact 写入不能阻塞主进程事件循环。
     *
     * 背景：截断后每个 stdout 分片都走 fs.writeSync 同步写盘。命令产生海量输出时，
     * 这些同步写会把主进程事件循环切碎（窗口消息、IPC、弹窗全部排队）。
     * 修复后写入走异步流，closeArtifact() 返回可等待的 Promise 以保证落盘完整。
     */
    test('artifact 写入是异步的：追加期间不阻塞事件循环', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-output-buffer-async-'));
        const artifactPath = path.join(directory, 'terminal.log');
        try {
            const buffer = new BoundedOutputBuffer('', 'truncated', artifactPath, 'saved');
            buffer.append('a'.repeat(TERMINAL_OUTPUT_MAX_CHARS));

            // 大分片连续追加期间，宏任务必须仍能得到调度机会
            let macrotaskRan = false;
            const scheduled = new Promise<void>((resolve) => {
                setTimeout(() => {
                    macrotaskRan = true;
                    resolve();
                }, 0);
            });
            const chunk = 'b'.repeat(256 * 1024);
            for (let i = 0; i < 8; i++) buffer.append(chunk);
            await scheduled;

            expect(macrotaskRan).toBe(true);

            await buffer.closeArtifact();
            expect(fs.statSync(artifactPath).size).toBe(TERMINAL_OUTPUT_MAX_CHARS + 8 * chunk.length);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('写入积压时通过 onBackpressure 通知调用方暂停子进程输出', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-output-buffer-bp-'));
        const artifactPath = path.join(directory, 'terminal.log');
        try {
            const events: boolean[] = [];
            const buffer = new BoundedOutputBuffer('', 'truncated', artifactPath, 'saved', {
                onBackpressure: (paused) => events.push(paused)
            });
            buffer.append('a'.repeat(TERMINAL_OUTPUT_MAX_CHARS));
            // 远大于 writeStream 的 highWaterMark，必然触发一次背压
            buffer.append('b'.repeat(4 * 1024 * 1024));
            await buffer.closeArtifact();

            expect(events).toContain(true);
            // 排空后必须恢复，不能把子进程永久挂住
            expect(events[events.length - 1]).toBe(false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
