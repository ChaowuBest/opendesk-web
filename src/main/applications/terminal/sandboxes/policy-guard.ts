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
 * 序列化格式为双层 base64（cfgio.c：每条规则的 path 字段单独 base64，整块再
 * base64）。它既可能比明文小——`[[rules]]`、`access = "read"` 这类固定串不进
 * 编码，典型策略实测 0.58～0.88x；也可能比明文大——长路径按 4/3 膨胀两次，实测
 * 最坏 1.15x。所以体积按 native 的编码格式逐段复刻（见
 * estimateDynoboxPolicySerializedSize），而不是乘一个固定系数。守卫在宿主侧
 * 写入策略文件前做该估算：
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
 * 估算策略文本经 native 序列化（DYNOBOX_CFG）后的字节数。
 *
 * 逐段复刻 native 的编码格式（cfgio.c `dbox_cfg_encode`），而不是"明文字节数 ×
 * 系数"：native 只把每条规则的 path 单独 base64（acc/perm 是短数字），最后把整块
 * 再 base64；明文里的 `[[rules]]`、`access = "read"`、`perm = "allow"` 等固定串
 * **不进编码**，而长路径会按 base64 膨胀两次（4/3 × 4/3）。因此固定系数在 path
 * 占比高的最坏情形会偏乐观：实测深目录策略的 native/明文已达 1.15，把 1.25 系数
 * 的余量吃到只剩 8%；平均 path 超过约 230 字符时更会翻转成漏判超限——命令被送到
 * native 侧 fail-closed 拒绝启动（正是本守卫要防的故障）。
 *
 * 各段按 native 的实际格式累加，控制行取位数上界，保证估算 ≥ 真实编码值
 * （实测对拍：典型策略与长路径策略的估算/native 均在 1.000～1.006）。
 *
 * 代价：每次调用都要扫一遍规则块（旧实现是一次 byteLength），而裁剪循环每删一组
 * 都要重算一次，最坏情形（超限且需删数百块）约 1 秒。属罕见路径且一次性开销，
 * 换取"不漏判超限"——若要优化，应改成增量累加，且必须与这里的公式保持同步。
 *
 * 前提：规则块格式由策略生成器产出（`[[rules]]` 后依次 path/access/perm），
 * 与 RULE_BLOCK_RE 一致；解析不到的块不计入（native 侧同样不会编码）。
 */
export function estimateDynoboxPolicySerializedSize(policyText: string): number {
    /** 单次 base64 后的字节数（cfgio.c：4 字节/3 字节向上取整） */
    const base64 = (raw: number) => Math.ceil(raw / 3) * 4;

    let blob = 'V 1\n'.length;
    // P 行（default/net/system_read/timeout/cache/grant）：位数随配置变化，
    // 按 6 位上界保守取值（真实值只会更短）
    blob += 'P 2 0 1 999999 999999 999999\n'.length;
    const endpoint = /^endpoint = "(.*)"$/m.exec(policyText)?.[1];
    if (endpoint) blob += 2 + base64(Buffer.byteLength(endpoint, 'utf8')) + 1;
    const token = /^token = "(.*)"$/m.exec(policyText)?.[1];
    if (token) blob += 2 + base64(Buffer.byteLength(token, 'utf8')) + 1;
    // 每条规则一行 `L <b64(path)> <acc> <perm>\n`：field(path) + 2 + 1 + 1 + 1 + 1 + 1
    for (const block of parseRuleBlocks(policyText)) {
        let path: string;
        try {
            path = JSON.parse(block.pathJson) as string;
        } catch {
            continue; // 非法块 native 也不会编码（TOML 解析先 fail-loud）
        }
        blob += base64(Buffer.byteLength(path, 'utf8')) + 7;
    }
    return base64(blob); // 整块再 base64
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
 * 裁剪分组键：`X` 与 `X/**`（同 access/perm）必须同生共死。
 *
 * 策略生成侧对 `perm = "allow"` 的 `X/**` 会自动补一条 `X`（native 侧尾部 `**`
 * 只覆盖子树、不匹配目录自身），两条合起来才构成"这棵子树可读"的完整语义。
 * 只删其中一条会留下半截规则：目录自身可读但内容不可读（或反之）——readonly
 * 模式下落到全盘 read deny，命令会**直接失败**，而不是模块注释所说的"多一次
 * ask 往返"。
 */
function trimGroupKey(block: PolicyRuleBlock): string {
    let path: string;
    try {
        path = JSON.parse(block.pathJson) as string;
    } catch {
        return block.text;
    }
    const base = path.endsWith('/**') ? path.slice(0, -3) : path;
    return `${block.access}\u0000${block.perm}\u0000${base}`;
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

    // 按组（X 与 X/**）聚合，裁剪时整组丢弃：见 trimGroupKey 注释。
    // 组键含 access/perm，而 rank=== 只由 access/perm 决定，因此同组块要么
    // 全部可裁剪、要么全部不可裁剪，不会误删非 read-allow 块。
    const groupMembers = new Map<string, string[]>();
    for (const block of blocks) {
        const key = trimGroupKey(block);
        const members = groupMembers.get(key);
        if (members) members.push(block.text);
        else groupMembers.set(key, [block.text]);
    }

    const removed = new Set<string>();
    const removedGroups = new Set<string>();
    let current = deduped;
    for (const { block, rank } of trimmable) {
        const group = trimGroupKey(block);
        if (removedGroups.has(group)) continue;
        removedGroups.add(group);
        for (const text of groupMembers.get(group) ?? [block.text]) removed.add(text);
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
