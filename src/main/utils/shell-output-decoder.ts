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

import iconv from 'iconv-lite';

/**
 * 将 shell 命令输出的 Buffer 解码为字符串。
 *
 * 在 Windows 上，cmd / PowerShell 默认输出编码为系统代码页（中文系统为 GBK/CP936），
 * 而非 UTF-8。直接使用 Buffer.toString('utf8') 会导致中文乱码。
 *
 * 策略：先尝试 UTF-8 解码，若结果包含替换字符（\uFFFD）则回退到 GBK 解码。
 * 非 Windows 平台直接使用 UTF-8。
 */
export function decodeShellOutput(buffer: Buffer): string {
    if (process.platform !== 'win32') {
        return buffer.toString('utf8');
    }
    const utf8 = buffer.toString('utf8');
    // 包含 Unicode 替换字符说明 UTF-8 解码失败，回退到 GBK
    if (!utf8.includes('\uFFFD')) {
        return utf8;
    }
    try {
        return iconv.decode(buffer, 'gbk');
    } catch {
        return utf8;
    }
}

/**
 * 无换行残片的最大缓存字节数。
 *
 * 解码器按行边界切分以保证多字节字符完整，但「整段无换行」的输出
 * （进度条 \r 重绘、Write-Host -NoNewline、压成一行的 JSON / base64）
 * 会让残片无限增长：旧的 `pending = Buffer.concat([pending, chunk])` 每来一片
 * 都要复制整个 pending，复杂度 O(n²)。实测 6MiB→107ms、13MiB→413ms、
 * 25MiB→1.7s、50MiB→7.4s，且全部发生在主进程 stdout 'data' 回调里，
 * 足以把 GUI 冻住数秒。
 *
 * 因此残片超过该阈值时按 UTF-8 字符边界强制切分解码，把复杂度降回线性。
 */
export const SHELL_OUTPUT_PENDING_MAX_BYTES = 64 * 1024;

/** UTF-8 起始字节 → 该字符长度；非法/续字节返回 1（按单字节处理）。 */
function utf8CharLength(lead: number): number {
    if (lead < 0x80) return 1;
    if ((lead & 0xe0) === 0xc0) return 2;
    if ((lead & 0xf0) === 0xe0) return 3;
    if ((lead & 0xf8) === 0xf0) return 4;
    return 1;
}

/**
 * 在不超过 maxBytes 的位置找到 UTF-8 字符边界，返回可安全解码的前缀长度。
 *
 * 若切点落在字符中间，回退到该字符的起始字节，避免把半个字符解成 U+FFFD
 * 从而误触发 GBK 回退分支（原实现正是靠"整段缓存"规避这个问题）。
 * 非 UTF-8 编码（GBK）下边界判定不适用，此处保证不切断合法 UTF-8；
 * 极端情况下 GBK 无换行巨量输出可能损失一个字符，但不再阻塞主进程。
 */
function findUtf8SafeCut(buffer: Buffer, maxBytes: number): number {
    const cut = Math.min(buffer.length, maxBytes);
    if (cut <= 0) return 0;

    let index = cut - 1;
    let backSteps = 0;
    // 续字节形如 10xxxxxx，最多回退 3 步即可覆盖 4 字节字符
    while (index > 0 && backSteps < 3 && (buffer[index] & 0xc0) === 0x80) {
        index -= 1;
        backSteps += 1;
    }
    const charEnd = index + utf8CharLength(buffer[index]);
    return charEnd <= cut ? cut : index;
}

/**
 * 在不超过 maxBytes 的位置找到「解码干净」的切点，返回切点与该前缀的解码文本。
 *
 * findUtf8SafeCut 只保证不切断合法 UTF-8；Windows 的 GBK 输出无法用 UTF-8
 * 结构推断边界，切在双字节字符中间会让前后两段各损失一个字符（历史事故里
 * 表现为中文乱码）。这里用实际解码结果验证：切点处出现替换符时向前回退
 * 1~3 字节重试，取第一个「解码干净」的切点。验证用的解码文本直接返回，
 * 调用方无需对同一段字节再做一次解码（热路径每 64KiB 只解码一次）。
 */
function findDecodableCut(buffer: Buffer, maxBytes: number): { cut: number; text: string } {
    const base = findUtf8SafeCut(buffer, maxBytes);
    if (base <= 0) return { cut: base, text: '' };
    // text 始终对应 [0, cut) 前缀的解码结果，即使 cut 已覆盖整个 buffer，
    // 保证调用方只依赖返回值即可，不会丢数据
    let cut = base;
    let text = decodeShellOutput(buffer.subarray(0, base));
    if (text.includes('\uFFFD')) {
        for (let delta = 1; delta <= 3; delta++) {
            const candidate = base - delta;
            if (candidate <= 0) break;
            const candidateText = decodeShellOutput(buffer.subarray(0, candidate));
            if (!candidateText.includes('\uFFFD')) {
                cut = candidate;
                text = candidateText;
                break;
            }
        }
    }
    return { cut, text };
}

/**
 * 跨数据分片的 shell 输出流式解码器。
 *
 * 管道以任意大小分片到达 data 事件（尤其沙箱经中继转发时），UTF-8 多字节字符
 * （中文 3 字节、emoji 4 字节）可能被切断在 chunk 边界。逐 chunk 调用
 * decodeShellOutput 时，被切断的半个字符会解码出 U+FFFD 替换符，误触发"回退
 * GBK"分支，把本应完好的 UTF-8 中文变成 GBK 乱码（"锟斤拷"），且错误不可逆。
 *
 * 解法：优先缓冲到完整行（\n 结尾）再解码。\n（0x0A）在 UTF-8 与 GBK 双字节编码中
 * 都只会作为独立的 ASCII 字节出现，绝不会成为多字节序列的内部字节，因此行边界
 * 是安全的解码切分点；行内字符必然完整，不会被误判编码。
 *
 * 无换行残片超过 SHELL_OUTPUT_PENDING_MAX_BYTES 时按 UTF-8 字符边界强制切分
 * （见该常量的说明），既保住字符完整性又避免 O(n²) 累积。未到行尾的残片缓存到
 * 下一分片；流结束时 flush 吐出剩余内容。
 */
export function createShellOutputDecoder() {
    let pending: Buffer = Buffer.alloc(0);

    const decode = (buf: Buffer): string => decodeShellOutput(buf);

    return {
        /** 喂入一分片，返回可安全解码的完整文本（可能为空字符串）。 */
        push(chunk: Buffer): string {
            if (chunk.length === 0) return '';
            const combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
            let decoded = '';
            // 找最后一个 \n：其前（含 \n）都是完整行，可立即解码
            const lastNl = combined.lastIndexOf(0x0a);
            pending = lastNl >= 0 ? combined.subarray(lastNl + 1) : combined;
            if (lastNl >= 0) {
                decoded = decode(combined.subarray(0, lastNl + 1));
            }
            // 残留超过上限时按「解码干净」的边界强制切分，把复制量与缓存降回线性。
            // 行尾残片同样要检查：单个超大分片可能整段无换行，或只在开头带一个 \n，
            // 只对「整段无换行」分支限量会让这种残片继续按 O(n²) 累积。
            while (pending.length > SHELL_OUTPUT_PENDING_MAX_BYTES) {
                const { cut, text } = findDecodableCut(pending, SHELL_OUTPUT_PENDING_MAX_BYTES);
                if (cut <= 0) break;
                decoded += text;
                pending = pending.subarray(cut);
            }
            return decoded;
        },
        /** 流结束：把剩余残片（可能是不带换行的完整最后一行）解码吐出。 */
        flush(): string {
            if (pending.length === 0) return '';
            const out = decode(pending);
            pending = Buffer.alloc(0);
            return out;
        },
        /** 当前缓存的无换行残片字节数（诊断/测试用）。 */
        pendingBytes(): number {
            return pending.length;
        }
    };
}
