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

import type { GenUiComponentName } from '../../../common/genui/protocol.js';

/** 每个组件一份合法 props，供目录、工具与组件渲染测试共用。 */
export const SAMPLE_PROPS: Record<GenUiComponentName, Record<string, unknown>> = {
    'option-list': {
        options: [
            { id: 'staging', label: '预发环境', description: '先在预发验证' },
            { id: 'prod', label: '生产环境', description: '直接上线' },
            { id: 'canary', label: '灰度', disabled: true }
        ],
        selectionMode: 'single'
    },
    'question-flow': {
        steps: [
            {
                id: 'size',
                question: '团队规模？',
                options: [
                    { id: 'small', label: '10 人以内' },
                    { id: 'large', label: '10 人以上' }
                ]
            },
            {
                id: 'budget',
                question: '预算？',
                selectionMode: 'multiple',
                options: [
                    { id: 'low', label: '低' },
                    { id: 'mid', label: '中' },
                    { id: 'high', label: '高' }
                ]
            }
        ]
    },
    'approval-card': {
        title: '删除 3 个文件',
        subtitle: '工作区 /home/opendesk/project',
        description: '这些文件删除后无法恢复',
        command: 'rm build/a.log build/b.log build/c.log',
        details: [{ label: '文件数', value: '3' }],
        variant: 'destructive'
    },
    form: {
        message: '请确认发布信息',
        fields: [
            { name: 'version', label: '版本号', kind: 'text', required: true, default: '1.2.0' },
            { name: 'channel', label: '渠道', kind: 'choice', options: ['stable', 'beta'], default: 'stable' },
            { name: 'notify', label: '通知用户', kind: 'toggle', default: true }
        ]
    },
    'data-table': {
        caption: '季度销售',
        columns: [
            { key: 'region', label: '区域', priority: 'primary' },
            { key: 'revenue', label: '收入', align: 'end', format: { kind: 'currency', currency: 'CNY' } },
            { key: 'growth', label: '增长', align: 'end', format: { kind: 'percent', basis: 'fraction' } },
            { key: 'active', label: '在售', format: { kind: 'boolean' } }
        ],
        rows: [
            { region: '华东', revenue: 1280000, growth: 0.12, active: true },
            { region: '华南', revenue: 860000, growth: -0.03, active: false }
        ],
        defaultSort: { key: 'revenue', direction: 'desc' }
    },
    chart: {
        label: '日活用户',
        value: 12840,
        delta: '+8.2%',
        points: [9800, 10200, 11050, 10900, 11800, 12840],
        variant: 'area',
        trend: 'up'
    },
    'comparison-card': {
        traitLabels: ['价格', '离线可用'],
        options: [
            { id: 'a', name: '方案 A', headline: '便宜', traits: ['¥99/月', false] },
            { id: 'b', name: '方案 B', headline: '功能全', traits: ['¥199/月', '支持'] }
        ],
        recommendedId: 'b',
        reason: '需要离线使用'
    },
    'link-preview': {
        href: 'https://example.com/post',
        title: '示例文章',
        description: '一段摘要',
        siteName: 'Example'
    },
    'spec-sheet': {
        title: '服务器配置',
        rows: [
            { label: 'CPU', value: '8 核', emphasis: true },
            { label: '内存', value: '32 GB' }
        ]
    }
};
