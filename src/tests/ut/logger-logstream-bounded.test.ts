import { describe, expect, test } from '@jest/globals';
import { LogStream } from '../../main/utils/logger.js';

/**
 * LogStream 内存安全测试。
 *
 * 主进程每条日志都会写入 LogStream 的 content/entries 内存缓冲区（供设置页日志查看器
 * 与导出使用）。若不做上限，长跑场景（LLM Raw 响应等高频日志）会无界累积直至 V8 堆
 * 耗尽（参见 2026-10-23 OOM 事故：480MB 堆全被日志缓冲区吃掉）。
 *
 * 通过 getStream() 直灌 write()（绕过 winston），与日志级别过滤无关。
 */
describe('LogStream bounded memory', () => {
    const stream = LogStream.getStream();

    test('entries 有界：超过上限后丢弃最旧日志', () => {
        const TOTAL = LogStream.maxEntries + 50;
        for (let i = 0; i < TOTAL; i++) {
            stream.write(`bounded-entries-${i}\n`);
        }
        const { entries } = stream.getEntries({ offset: 0, limit: TOTAL });
        expect(entries.length).toBeLessThanOrEqual(LogStream.maxEntries);
        // 最旧的被丢弃，保留的是最近的日志
        expect(entries.at(-1)?.message).toContain(`bounded-entries-${TOTAL - 1}`);
        expect(entries.some((e) => e.message.includes('bounded-entries-0'))).toBe(false);
    });

    test('content 有界：超过字节上限后淘汰最旧日志', () => {
        // 每行 ~1KB，写入 1.2 倍 content 容量的字节量，强制触发按字节淘汰
        const lineSize = 1000;
        const TOTAL = Math.ceil((LogStream.maxContentBytes * 1.2) / (lineSize + 1));
        for (let i = 0; i < TOTAL; i++) {
            stream.write(`bounded-content-${i}-` + 'z'.repeat(lineSize) + '\n');
        }
        const content = stream.getContent();
        expect(content.length).toBeLessThanOrEqual(LogStream.maxContentBytes);
        expect(content).toContain(`bounded-content-${TOTAL - 1}`);
        expect(content).not.toContain('bounded-content-0');
    });

    test('单条超长日志被截断，不会撑大缓冲区', () => {
        stream.write('x'.repeat(600_000) + '\n');
        const lines = stream.getContent().split('\n');
        const last = lines[lines.length - 2] ?? '';
        expect(last.length).toBeLessThanOrEqual(LogStream.maxLineLength);
    });

    test('超长日志截断保留头部，截断标记计入行预算', () => {
        stream.write('head-marker' + 'y'.repeat(600_000) + '\n');
        const { entries } = stream.getEntries({ offset: 0, limit: 10, filter: 'head-marker' });
        expect(entries.length).toBeGreaterThan(0);
        // 截断保留头部（含时间戳等前缀），尾部丢弃，整行不超预算
        expect(entries.at(-1)?.message).toContain('head-marker');
        expect(entries.at(-1)?.message.length).toBeLessThanOrEqual(LogStream.maxLineLength);
    });
});
