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

/**
 * 动态沙箱策略体积守卫。
 *
 * dynobox 原生层把序列化后的策略注入 DYNOBOX_CFG 环境变量，子进程以固定 64KB
 * 缓冲读取（native/openharmony/sandbox/src/preload.c 的 g_cfg_b64）；launcher 在
 * 编码结果 >= 65536 字节时 fail-closed 拒绝启动（exit 2）。此时命令完全不执行，
 * 模型只能看到一段 dynobox 报错——看起来像"终端输出被异常内容干扰"，且没有可
 * 行动的恢复路径（实测 task_mv5ln9r2_4j1q：运行期权限规则膨胀 + PATH 展开把
 * 策略推到 71912 字节，任务全程终端不可用）。
 *
 * 序列化格式为双层 base64（cfgio.c：每个字段先 base64，整体再 base64），体积
 * 约为明文的 16/9。本守卫在宿主侧写入策略文件前做同口径估算：
 *  1. 未超限 → 原样返回；
 *  2. 超限 → 去重完全相同的规则块，并按牺牲顺序裁剪 read allow 类块（write/
 *     ask/deny/execute 与 [ask] 段全部保留；被裁剪的读规则仍由权限引擎承载，
 *     沙箱经 /decide 端点询问引擎即可放行，语义不回退、最多多一次端点往返）；
 *  3. 无可裁剪块仍超限 → 抛出可行动的本地化错误。
 */

import { t } from '../locale/index.js';
import { logger } from '../../../utils/logger.js';

/** dynobox 原生层 DYNOBOX_CFG 固定缓冲上限（preload.c g_cfg_b64；launcher 同值拒绝）。 */
export const DYNOBOX_POLICY_SERIALIZED_LIMIT = 65536;

/**
 * 序列化体积估算的安全系数。
 *
 * native 编码（cfgio.c：每条规则 path 单独 base64，acc/perm 用短数字，最后整体
 * base64）的实测膨胀率随内容在 0.75x～1.17x 明文之间波动（path 越长占比越高，
 * 最坏 ≈1.17x；校准样例：明文 161KB → 编码 133KB）。取 1.25 覆盖最坏情形：
 * 估算 < 65536 ⇒ 真实编码必然 < 65536（宁可提前裁剪，不可漏判超限）。
 */
const SERIALIZED_SIZE_SAFETY_FACTOR = 1.25;

/**
 * 估算策略文本经 native 序列化（DYNOBOX_CFG）后的字节数。
 * 以明文字节数乘安全系数近似（见 SERIALIZED_SIZE_SAFETY_FACTOR 注释的校准依据）。
 */
export function estimateDynoboxPolicySerializedSize(policyText: string): number {
    return Math.ceil(Buffer.byteLength(policyText, 'utf8') * SERIALIZED_SIZE_SAFETY_FACTOR);
}

interface PolicyRuleBlock {
    /** 规则块完整文本（不含尾部换行） */
    text: string;
    /** path 字段的 JSON 字符串值（含引号） */
    pathJson: string;
    access: string;
    perm: string;
}

// 与三个 policy 生成器产出的规则块形态严格对齐（path 为 JSON 字符串字段）
const RULE_BLOCK_RE =
    /\[\[rules\]\]\npath = ("(?:[^"\\]|\\.)*")\naccess = "(?:[^"\\]|\\.)*"\nperm = "(?:[^"\\]|\\.)*"/g;

function parseRuleBlocks(policyText: string): PolicyRuleBlock[] {
    const blocks: PolicyRuleBlock[] = [];
    for (const match of policyText.matchAll(RULE_BLOCK_RE)) {
        const text = match[0];
        // 逐字段提取 access/perm（path 见捕获组 1）
        const lines = text.split('\n');
        const access = lines[2]?.slice('access = "'.length, -1) ?? '';
        const perm = lines[3]?.slice('perm = "'.length, -1) ?? '';
        blocks.push({ text, pathJson: match[1], access, perm });
    }
    return blocks;
}

/**
 * 规则块的裁剪牺牲顺序（越小越先丢弃）。只有 read + allow 的块可裁剪：
 * - 3：用户目录下的读放行（PATH 工具链展开、shell rc 等——数量最多，且多被
 *      内建 system_read 或引擎规则覆盖）
 * - 2：系统目录读放行（/usr、/bin 等——native 内建 system_read 已覆盖）
 * - 1：工作区读放行（最后丢弃：工作区读是任务基本盘）
 * 其余（write/ask/deny/execute）一律返回 null：涉及安全与交互语义，不裁剪。
 */
function trimRankOf(block: PolicyRuleBlock, keepPrefixes: string[]): number | null {
    if (block.access !== 'read' || block.perm !== 'allow') return null;
    let path: string;
    try {
        path = JSON.parse(block.pathJson) as string;
    } catch {
        return null;
    }
    if (keepPrefixes.some((prefix) => path.startsWith(prefix))) return 1;
    if (path.startsWith('/home/') || path.startsWith('/Users/') || path.startsWith('/root/')) return 3;
    return 2;
}

export interface SerializePolicyOptions {
    /**
     * 优先保留的前缀（规则 path 形态，如任务工作区根）。命中任一前缀的读规则
     * 排在最后裁剪；Windows 虚路径由调用方自行映射（/C/...）。
     */
    keepPrefixes?: string[];
}

/**
 * 守卫入口：确保策略文本序列化后不超过原生 64KB 上限。
 * 超限时去重并裁剪（见模块注释），返回调整后的策略文本；无可裁剪空间时抛错。
 */
export function serializePolicyForSandbox(policyText: string, options: SerializePolicyOptions = {}): string {
    const keepPrefixes = options.keepPrefixes ?? [];
    if (estimateDynoboxPolicySerializedSize(policyText) < DYNOBOX_POLICY_SERIALIZED_LIMIT) {
        return policyText;
    }

    // 先无损去重：完全相同的规则块只保留一份（PATH 重复项等）
    const seen = new Set<string>();
    let deduped = policyText.replace(RULE_BLOCK_RE, (block) => {
        if (seen.has(block)) return '';
        seen.add(block);
        return block;
    });
    deduped = deduped.replace(/\n{3,}/g, '\n\n');

    if (estimateDynoboxPolicySerializedSize(deduped) < DYNOBOX_POLICY_SERIALIZED_LIMIT) {
        logger.warn(
            `sandbox policy exceeded ${DYNOBOX_POLICY_SERIALIZED_LIMIT} bytes after serialization; ` +
                'deduplicated duplicate rule blocks'
        );
        return deduped;
    }

    // 仍超限：按牺牲顺序逐块丢弃 read allow
    const blocks = parseRuleBlocks(deduped);
    const trimmable = blocks
        .map((block) => ({ block, rank: trimRankOf(block, keepPrefixes) }))
        .filter((entry): entry is { block: PolicyRuleBlock; rank: number } => entry.rank !== null)
        .sort((left, right) => right.rank - left.rank || right.block.text.localeCompare(left.block.text));

    const removed = new Set<string>();
    let current = deduped;
    for (const { block, rank } of trimmable) {
        removed.add(block.text);
        current = deduped.replace(RULE_BLOCK_RE, (text) => (removed.has(text) ? '' : text)).replace(/\n{3,}/g, '\n\n');
        if (estimateDynoboxPolicySerializedSize(current) < DYNOBOX_POLICY_SERIALIZED_LIMIT) {
            logger.warn(
                `sandbox policy exceeded ${DYNOBOX_POLICY_SERIALIZED_LIMIT} bytes after serialization; ` +
                    `trimmed ${removed.size} read-allow rule blocks (rank ${rank} was last); ` +
                    'trimmed reads fall back to sandbox /decide endpoint (engine rules still apply)'
            );
            return current;
        }
    }

    throw new Error(
        t('sandbox.policyTooLarge', {
            bytes: String(estimateDynoboxPolicySerializedSize(current)),
            limit: String(DYNOBOX_POLICY_SERIALIZED_LIMIT)
        })
    );
}
