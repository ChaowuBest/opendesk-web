import { describe, expect, jest, test } from '@jest/globals';
import iconv from 'iconv-lite';
import {
    createShellOutputDecoder,
    decodeShellOutput,
    SHELL_OUTPUT_PENDING_MAX_BYTES
} from '../../../main/utils/shell-output-decoder.js';

/**
 * 终端输出流式解码器的回归测试。
 *
 * 回归背景：解码器为规避「UTF-8 多字节字符被 chunk 边界切断 → 误判 GBK」，
 * 会把未遇到 \n 的分片全部缓存到 pending，而缓存实现是
 * `pending = Buffer.concat([pending, chunk])`。遇到不带换行的长输出
 * （进度条 \r 重绘、Write-Host -NoNewline、压成一行的 JSON / base64）时，
 * 每来一个分片都要复制整个 pending，复杂度 O(n²)：
 *   实测 6MiB→107ms、13MiB→413ms、25MiB→1.7s、50MiB→7.4s，
 * 且全部发生在主进程 stdout 'data' 回调里，直接冻结整个 GUI。
 */
describe('createShellOutputDecoder 无换行输出', () => {
    test('pending 长度有上限：不会随着无换行输出无限增长', () => {
        const decoder = createShellOutputDecoder();
        const chunk = Buffer.alloc(64 * 1024, 0x61);

        for (let i = 0; i < 40; i++) {
            decoder.push(chunk);
            // 每轮 push 之后 pending 都必须被限制在阈值内，否则 O(n²) 会复现
            expect(decoder.pendingBytes()).toBeLessThanOrEqual(SHELL_OUTPUT_PENDING_MAX_BYTES);
        }
    });

    test('单个超大无换行分片也不会突破 pending 上限', () => {
        const decoder = createShellOutputDecoder();
        const huge = Buffer.alloc(1024 * 1024, 0x61);

        const out = decoder.push(huge);

        expect(decoder.pendingBytes()).toBeLessThanOrEqual(SHELL_OUTPUT_PENDING_MAX_BYTES);
        expect(out.length + decoder.pendingBytes()).toBe(huge.length);
        expect(decoder.flush().length + out.length).toBe(huge.length);
    });

    test('只带行首 \\n 的超大分片，其残片同样受限（否则仍会 O(n²) 累积）', () => {
        const decoder = createShellOutputDecoder();
        const huge = Buffer.concat([Buffer.from('\n'), Buffer.alloc(1024 * 1024, 0x61)]);

        const out = decoder.push(huge);

        expect(decoder.pendingBytes()).toBeLessThanOrEqual(SHELL_OUTPUT_PENDING_MAX_BYTES);
        expect(out.length + decoder.pendingBytes()).toBe(huge.length);
    });

    test('无换行长输出的内容完整：不丢字节、不产生替换符', () => {
        const decoder = createShellOutputDecoder();
        const parts = ['a'.repeat(64 * 1024), 'b'.repeat(64 * 1024), 'c'.repeat(1024)];
        let decoded = '';
        for (const part of parts) decoded += decoder.push(Buffer.from(part, 'utf8'));
        decoded += decoder.flush();

        expect(decoded).toBe(parts.join(''));
        expect(decoded).not.toContain('\uFFFD');
    });

    test('超长无换行多字节文本不被切断（中文/emoji 无乱码）', () => {
        const decoder = createShellOutputDecoder();
        const text = ('中文输出😀' as string).repeat(30_000); // ~570KiB，全程无 \n
        const bytes = Buffer.from(text, 'utf8');
        let decoded = '';
        for (let offset = 0; offset < bytes.length; offset += 4096) {
            decoded += decoder.push(bytes.subarray(offset, offset + 4096));
        }
        decoded += decoder.flush();

        expect(decoded).toBe(text);
        expect(decoded).not.toContain('\uFFFD');
    });

    /**
     * 统计一次解码流程中实际被复制的字节数。
     *
     * O(n²) 放大的是「复制量」而不是「解码量」：旧实现每来一个分片都要
     * `pending = Buffer.concat([pending, chunk])`，复制量随输入字节数平方增长。
     * 这里直接对 Buffer.concat 计数，得到与机器快慢、GC 时机、CI 并行负载
     * 全都无关的确定性指标；用耗时比值来断言时，同一份线性实现实测会在
     * 4x~39x 之间抖动，必然误报。
     */
    const measureCopiedBytes = (chunks: number): { copied: number; input: number } => {
        const decoder = createShellOutputDecoder();
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        // 捕获原始实现，避免 mock 内部递归调用到自己
        const originalConcat = Buffer.concat;
        let copied = 0;
        const spy = jest.spyOn(Buffer, 'concat').mockImplementation((list, totalLength) => {
            for (const item of list) copied += item.length;
            return originalConcat(list, totalLength);
        });
        try {
            for (let i = 0; i < chunks; i++) decoder.push(chunk);
            decoder.flush();
        } finally {
            spy.mockRestore();
        }
        return { copied, input: chunks * chunk.length };
    };

    test('无换行输出的复制量随输入线性增长，不再出现 O(n²) 放大', () => {
        const small = measureCopiedBytes(200); // 13MiB
        const large = measureCopiedBytes(800); // 50MiB

        // 线性实现每片最多复制「残片 + 新分片」两个分片大小，复制量 ≈ 输入量 × 常数
        expect(small.copied / small.input).toBeLessThan(3);
        expect(large.copied / large.input).toBeLessThan(3);
        // 输入扩大 4 倍，复制量也应只扩大 4 倍左右；
        // 旧实现对同样的 4 倍输入会放大到约 16 倍，阈值取中间值留出余量
        expect(large.copied / Math.max(small.copied, 1)).toBeLessThan(6);
    });
});

describe('createShellOutputDecoder 换行输出', () => {
    test('完整行立即输出，残片留待下一分片', () => {
        const decoder = createShellOutputDecoder();
        expect(decoder.push(Buffer.from('line1\nline2'))).toBe('line1\n');
        expect(decoder.pendingBytes()).toBe(Buffer.byteLength('line2'));
        expect(decoder.push(Buffer.from('\nline3\n'))).toBe('line2\nline3\n');
        expect(decoder.flush()).toBe('');
    });

    test('跨分片的多字节字符不会被误判成 GBK', () => {
        const decoder = createShellOutputDecoder();
        const bytes = Buffer.from('中文\n', 'utf8');
        let out = decoder.push(bytes.subarray(0, 4)); // 切断在中文 3 字节字符中间
        out += decoder.push(bytes.subarray(4));
        out += decoder.flush();
        expect(out).toBe('中文\n');
    });
});

describe('createShellOutputDecoder 非 UTF-8 输出', () => {
    const maybeWindows = process.platform === 'win32' ? test : test.skip;

    maybeWindows('无换行的 GBK 巨量中文输出不被切坏（Windows 代码页场景）', () => {
        // 强制切分路径（远超 pending 上限），验证切点会回退到干净的解码边界
        const text = '中文输出测试'.repeat(20_000); // 无换行
        const bytes = iconv.encode(text, 'gbk');
        const decoder = createShellOutputDecoder();

        let decoded = '';
        for (let offset = 0; offset < bytes.length; offset += 4096) {
            decoded += decoder.push(bytes.subarray(offset, offset + 4096));
        }
        decoded += decoder.flush();

        expect(decoded).toBe(text);
        expect(decoded).not.toContain('\uFFFD');
    });
});

describe('decodeShellOutput', () => {
    const maybeWindows = process.platform === 'win32' ? test : test.skip;

    maybeWindows('Windows 下 GBK 字节回退解码', () => {
        // "中文" 的 GBK 编码，UTF-8 解码必然产生替换符
        const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
        expect(decodeShellOutput(gbk)).toBe('中文');
    });

    test('合法 UTF-8 原样解码', () => {
        expect(decodeShellOutput(Buffer.from('中文 abc', 'utf8'))).toBe('中文 abc');
    });
});
