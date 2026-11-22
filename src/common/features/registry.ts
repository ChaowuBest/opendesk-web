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
 * OpenDesk 内置特性注册表。
 *
 * 特性（Feature）是 OpenDesk 自身的可禁用能力单元，插件通过 `ctx.features.disableFeature(featureId)`
 * 禁用。列表集中维护在此处：id 是协议字段，displayName/description 是展示文案
 * （`string | Record<locale, string>`，Record 键为 BCP 47 语言标签）。
 * 文案不走 locale 文件 key，由 `resolveFeatureLocalizedText` 在展示边界按语言解析。
 */

/** 特性展示文案：字符串形式所有语言一致；对象形式按语言标签提供多语言文案 */
export type FeatureLocalizedText = string | Record<string, string>;

export interface FeatureDefinition {
    id: string;
    displayName: FeatureLocalizedText;
    description: FeatureLocalizedText;
}

/**
 * 当前支持禁用的 OpenDesk 内置特性：
 * - memory：长期记忆与用户画像（记忆图标、任务回顾钩子、记忆工具与提示词段落）
 * - filesystem：AI 文件系统（索引/语义搜索相关；纯文件读写、grep 与 @ 添加文件不受影响）
 * - telemetry：全部远程遥测（OTLP / Langfuse 上报与设备心跳）；用户主动提交的反馈不受影响
 */
export const OPENDESK_FEATURES: readonly FeatureDefinition[] = [
    {
        id: 'memory',
        displayName: { 'zh-CN': '记忆', 'en-US': 'Memory' },
        description: {
            'zh-CN': '长期记忆与用户画像：任务回顾时自动维护记忆，并为对话提供记忆工具。',
            'en-US': 'Long-term memory and user portrait: maintains memories on task review and exposes memory tools.'
        }
    },
    {
        id: 'filesystem',
        displayName: { 'zh-CN': '智能文件系统', 'en-US': 'Smart File System' },
        description: {
            'zh-CN': 'AI 文件系统的索引与语义搜索；普通文件读写、grep 与 @ 添加文件不受影响。',
            'en-US':
                'Indexing and semantic search of the AI file system; plain file read/write, grep and @-file attach keep working.'
        }
    },
    {
        id: 'telemetry',
        displayName: { 'zh-CN': '远程遥测', 'en-US': 'Remote Telemetry' },
        description: {
            'zh-CN': '向远程服务上报的遥测数据与设备心跳；用户主动提交的反馈不受影响，本地用量统计照常记录。',
            'en-US':
                'Telemetry exported to remote services and the device heartbeat; user-submitted feedback keeps working and local usage stats are still recorded.'
        }
    }
];

export function getFeatureDefinition(id: string): FeatureDefinition | undefined {
    return OPENDESK_FEATURES.find((feature) => feature.id === id);
}

/** 取语言标签的主子标签（如 zh-CN -> zh），用于本地化文本匹配 */
export function localePrimaryTag(value: string): string {
    return value.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
}

/**
 * 按目标语言解析特性本地化文本（displayName / description 通用）。
 * 字符串形式原样返回；对象形式优先匹配与目标语言同主语言的条目，
 * 无匹配时回退 zh-CN、en-US，最后回退第一个可用翻译。
 * 与 BaseTool.getResolvedDisplayName 的回退顺序保持一致。
 */
export function resolveFeatureLocalizedText(
    value: FeatureLocalizedText | undefined,
    locale?: string
): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'object') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }
    const entries = Object.entries(value)
        .map(([key, text]): readonly [string, string] => [
            localePrimaryTag(key),
            typeof text === 'string' ? text.trim() : ''
        ])
        .filter(([tag, text]) => tag.length > 0 && text.length > 0);
    if (entries.length === 0) return undefined;
    const preferred = localePrimaryTag(locale ?? '');
    const matched = entries.find(([tag]) => tag === preferred)?.[1];
    if (matched) return matched;
    const zhCN = entries.find(([tag]) => tag === 'zh')?.[1];
    if (zhCN) return zhCN;
    const enUS = entries.find(([tag]) => tag === 'en')?.[1];
    if (enUS) return enUS;
    return entries[0][1];
}
