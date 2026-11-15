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
 * 生成式 UI 组件目录（主进程与渲染进程共用）。
 *
 * 模型只提供数据：showUI / askUI 工具参数里的 props 按这里的 zod schema 校验，
 * 渲染进程按组件名把 props 交给预制的 React 组件（src/renderer/genui）。
 * askUI 的组件在用户操作后回传 response，同样在主进程按 schema 校验后作为工具结果交还模型。
 */

import { z } from 'zod';
import { GENUI_COMPONENT_NAMES, type GenUiComponentName, type GenUiMode } from './protocol.js';

export * from './protocol.js';

const id = z.string().trim().min(1).max(64);
const shortText = z.string().trim().min(1).max(120);
const longText = z.string().trim().max(600);

const choiceOption = z.object({
    id: id.describe('选项 id，用户的选择按 id 回传'),
    label: shortText,
    description: longText.optional(),
    disabled: z.boolean().optional()
});

function requireUniqueIds(items: readonly { id: string }[], ctx: z.RefinementCtx, path: (string | number)[]): void {
    const seen = new Set<string>();
    items.forEach((item, index) => {
        if (seen.has(item.id)) {
            ctx.addIssue({ code: 'custom', message: `id "${item.id}" 重复`, path: [...path, index, 'id'] });
        }
        seen.add(item.id);
    });
}

function checkSelectionBounds(
    value: { options: readonly unknown[]; minSelections?: number; maxSelections?: number },
    ctx: z.RefinementCtx,
    path: (string | number)[] = []
): void {
    const { minSelections, maxSelections, options } = value;
    if (maxSelections !== undefined && maxSelections > options.length) {
        ctx.addIssue({ code: 'custom', message: 'maxSelections 不能大于选项数', path: [...path, 'maxSelections'] });
    }
    if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
        ctx.addIssue({
            code: 'custom',
            message: 'minSelections 不能大于 maxSelections',
            path: [...path, 'minSelections']
        });
    }
}

const selectionFields = {
    options: z.array(choiceOption).min(2).max(12),
    selectionMode: z.enum(['single', 'multiple']).optional().describe('single 点选即提交；multiple 勾选后点确认'),
    minSelections: z.number().int().min(1).optional(),
    maxSelections: z.number().int().min(1).optional()
};

// ─── 交互组件（askUI）──────────────────────────────────────────────────────────

const optionListProps = z
    .object({
        ...selectionFields,
        confirmLabel: z.string().trim().max(20).optional()
    })
    .superRefine((value, ctx) => {
        requireUniqueIds(value.options, ctx, ['options']);
        checkSelectionBounds(value, ctx);
    });

const questionFlowStep = z
    .object({
        id,
        question: shortText,
        description: longText.optional(),
        ...selectionFields
    })
    .superRefine((value, ctx) => {
        requireUniqueIds(value.options, ctx, ['options']);
        checkSelectionBounds(value, ctx);
    });

const questionFlowProps = z
    .object({
        steps: z.array(questionFlowStep).min(1).max(6),
        completeLabel: z.string().trim().max(20).optional()
    })
    .superRefine((value, ctx) => requireUniqueIds(value.steps, ctx, ['steps']));

const approvalCardProps = z.object({
    title: shortText,
    subtitle: shortText,
    description: longText.optional(),
    command: z.string().max(2000).optional().describe('要执行的命令或操作原文，以等宽字体展示'),
    details: z
        .array(z.object({ label: shortText, value: z.string().max(600) }))
        .max(12)
        .optional(),
    variant: z.enum(['default', 'destructive']).optional().describe('破坏性操作用 destructive'),
    approveLabel: z.string().trim().max(20).optional(),
    denyLabel: z.string().trim().max(20).optional()
});

const formField = z
    .object({
        name: z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
            .describe('字段名，回传结果的键'),
        label: shortText,
        kind: z.enum(['text', 'choice', 'toggle']),
        options: z.array(shortText).min(2).max(12).optional().describe('kind=choice 时必填'),
        required: z.boolean().optional(),
        default: z.union([z.string().max(2000), z.boolean()]).optional()
    })
    .superRefine((value, ctx) => {
        if (value.kind === 'choice' && !value.options) {
            ctx.addIssue({ code: 'custom', message: 'kind=choice 时必须提供 options', path: ['options'] });
        }
    });

const formProps = z
    .object({
        message: z.string().trim().min(1).max(600),
        source: z.string().trim().max(60).optional().describe('表单头部显示的来源名称'),
        fields: z.array(formField).min(1).max(12),
        submitLabel: z.string().trim().max(20).optional()
    })
    .superRefine((value, ctx) => {
        const seen = new Set<string>();
        value.fields.forEach((field, index) => {
            if (seen.has(field.name)) {
                ctx.addIssue({
                    code: 'custom',
                    message: `字段名 "${field.name}" 重复`,
                    path: ['fields', index, 'name']
                });
            }
            seen.add(field.name);
        });
    });

// ─── 展示组件（showUI）─────────────────────────────────────────────────────────

const dataTableFormat = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text') }),
    z.object({
        kind: z.literal('number'),
        decimals: z.number().int().min(0).max(6).optional(),
        compact: z.boolean().optional(),
        unit: z.string().max(12).optional()
    }),
    z.object({
        kind: z.literal('currency'),
        currency: z.string().length(3).describe('ISO 4217，如 CNY、USD'),
        decimals: z.number().int().min(0).max(6).optional(),
        compact: z.boolean().optional()
    }),
    z.object({
        kind: z.literal('percent'),
        decimals: z.number().int().min(0).max(6).optional(),
        basis: z.enum(['fraction', 'unit']).optional().describe('fraction: 0.12 表示 12%；unit: 12 表示 12%')
    }),
    z.object({
        kind: z.literal('delta'),
        decimals: z.number().int().min(0).max(6).optional(),
        unit: z.string().max(12).optional(),
        upIsGood: z.boolean().optional()
    }),
    z.object({ kind: z.literal('date'), style: z.enum(['date', 'datetime', 'relative']).optional() }),
    z.object({
        kind: z.literal('boolean'),
        trueLabel: z.string().max(20).optional(),
        falseLabel: z.string().max(20).optional()
    }),
    z.object({ kind: z.literal('link'), hrefKey: z.string().max(64).optional() }),
    z.object({
        kind: z.literal('badge'),
        tones: z.record(z.string(), z.enum(['neutral', 'success', 'warning', 'danger'])).optional()
    }),
    z.object({ kind: z.literal('list'), max: z.number().int().min(1).max(20).optional() })
]);

const dataTableCell = z.union([
    z.string().max(2000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(200), z.number()])).max(20)
]);

const dataTableProps = z
    .object({
        caption: z.string().trim().max(120).optional(),
        columns: z
            .array(
                z.object({
                    key: z.string().min(1).max(64),
                    label: shortText,
                    format: dataTableFormat.optional(),
                    align: z.enum(['start', 'end']).optional(),
                    sortable: z.boolean().optional(),
                    priority: z.enum(['primary', 'secondary']).optional().describe('窄屏时 secondary 列收进展开行')
                })
            )
            .min(1)
            .max(12),
        rows: z.array(z.record(z.string(), dataTableCell)).max(200),
        rowKey: z.string().max(64).optional(),
        defaultSort: z.object({ key: z.string().max(64), direction: z.enum(['asc', 'desc']) }).optional()
    })
    .superRefine((value, ctx) => {
        const keys = new Set(value.columns.map((column) => column.key));
        if (keys.size !== value.columns.length) {
            ctx.addIssue({ code: 'custom', message: '列 key 重复', path: ['columns'] });
        }
        if (value.defaultSort && !keys.has(value.defaultSort.key)) {
            ctx.addIssue({ code: 'custom', message: 'defaultSort.key 不是已声明的列', path: ['defaultSort', 'key'] });
        }
    });

const chartProps = z.object({
    label: shortText.describe('指标名称'),
    value: z
        .union([z.string().max(40), z.number()])
        .transform(String)
        .describe('当前值（已格式化的文本，如 "¥12.4万"）'),
    delta: z.string().max(40).optional().describe('变化量文本，如 "+12%"'),
    points: z.array(z.number()).min(2).max(200).describe('按时间顺序的历史数据点'),
    variant: z.enum(['area', 'line', 'bars']).optional(),
    trend: z.enum(['up', 'down', 'flat']).optional(),
    upIsGood: z.boolean().optional().describe('上涨是否是好事（收入 true，延迟 false）')
});

const comparisonCardProps = z
    .object({
        traitLabels: z.array(shortText).min(1).max(10).describe('对比维度名称'),
        options: z
            .array(
                z.object({
                    id,
                    name: shortText,
                    headline: z.string().trim().max(120),
                    traits: z
                        .array(z.union([z.string().max(120), z.literal(false)]))
                        .describe('与 traitLabels 一一对应；false 表示不具备')
                })
            )
            .min(2)
            .max(4),
        recommendedId: id,
        reason: z.string().trim().min(1).max(600).describe('推荐理由')
    })
    .superRefine((value, ctx) => {
        requireUniqueIds(value.options, ctx, ['options']);
        value.options.forEach((option, index) => {
            if (option.traits.length !== value.traitLabels.length) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'traits 数量必须与 traitLabels 一致',
                    path: ['options', index, 'traits']
                });
            }
        });
        if (!value.options.some((option) => option.id === value.recommendedId)) {
            ctx.addIssue({ code: 'custom', message: 'recommendedId 不在 options 中', path: ['recommendedId'] });
        }
    });

const httpUrl = z
    .string()
    .max(2000)
    .refine((value) => /^https?:\/\//i.test(value), '只支持 http/https 链接');

const linkPreviewProps = z.object({
    href: httpUrl,
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(600).optional(),
    image: httpUrl.optional(),
    siteName: z.string().trim().max(60).optional(),
    favicon: httpUrl.optional(),
    layout: z.enum(['card', 'compact']).optional()
});

const specSheetProps = z.object({
    title: shortText,
    subtitle: z.string().trim().max(200).optional(),
    rows: z
        .array(z.object({ label: shortText, value: z.string().max(600), emphasis: z.boolean().optional() }))
        .min(1)
        .max(40)
});

// ─── 回传结构 ─────────────────────────────────────────────────────────────────

const optionListResponse = z.object({ selected: z.array(id).min(1) });
const questionFlowResponse = z.object({ answers: z.record(id, z.array(id).min(1)) });
const approvalResponse = z.object({ decision: z.enum(['approve', 'deny']) });
const formResponse = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('submit'),
        values: z.record(z.string(), z.union([z.string().max(10000), z.boolean()]))
    }),
    z.object({ action: z.literal('decline') })
]);

export type OptionListProps = z.output<typeof optionListProps>;
export type QuestionFlowProps = z.output<typeof questionFlowProps>;
export type ApprovalCardProps = z.output<typeof approvalCardProps>;
export type FormProps = z.output<typeof formProps>;
export type DataTableProps = z.output<typeof dataTableProps>;
export type ChartProps = z.output<typeof chartProps>;
export type ComparisonCardProps = z.output<typeof comparisonCardProps>;
export type LinkPreviewProps = z.output<typeof linkPreviewProps>;
export type SpecSheetProps = z.output<typeof specSheetProps>;
export type OptionListResponse = z.output<typeof optionListResponse>;
export type QuestionFlowResponse = z.output<typeof questionFlowResponse>;
export type ApprovalResponse = z.output<typeof approvalResponse>;
export type FormResponse = z.output<typeof formResponse>;

interface GenUiComponentDefinition {
    mode: GenUiMode;
    /** 写进工具说明，告诉模型何时使用 */
    summary: string;
    props: z.ZodType;
    response?: z.ZodType;
    /** 把用户回传转成给模型看的文字 */
    describeResponse?: (props: any, response: any) => string;
}

function labelsOf(options: readonly { id: string; label: string }[], ids: readonly string[]): string {
    const labels = new Map(options.map((option) => [option.id, option.label]));
    return ids.map((value) => labels.get(value) ?? value).join('、');
}

export const GENUI_COMPONENTS = {
    'option-list': {
        mode: 'ask',
        summary: '一个问题配若干选项卡片（带说明），单选点即提交，多选勾选后确认。标题写在 title 里。',
        props: optionListProps,
        response: optionListResponse,
        describeResponse: (props: OptionListProps, response: OptionListResponse) =>
            `用户选择：${labelsOf(props.options, response.selected)}`
    },
    'question-flow': {
        mode: 'ask',
        summary: '多步问答：依次回答 1-6 个选择题后一起提交，适合收集多项偏好。',
        props: questionFlowProps,
        response: questionFlowResponse,
        describeResponse: (props: QuestionFlowProps, response: QuestionFlowResponse) =>
            props.steps
                .map(
                    (step) => `问题：${step.question}\n回答：${labelsOf(step.options, response.answers[step.id] ?? [])}`
                )
                .join('\n')
    },
    'approval-card': {
        mode: 'ask',
        summary: '执行有影响的操作（删除、发送、付款、部署等）前请用户批准或拒绝，可附命令原文和详情。',
        props: approvalCardProps,
        response: approvalResponse,
        describeResponse: (props: ApprovalCardProps, response: ApprovalResponse) =>
            response.decision === 'approve' ? `用户批准了「${props.title}」` : `用户拒绝了「${props.title}」`
    },
    form: {
        mode: 'ask',
        summary: '让用户填写或确认几项信息（文本、单选、开关），用户可提交或拒绝。',
        props: formProps,
        response: formResponse,
        describeResponse: (props: FormProps, response: FormResponse) => {
            if (response.action === 'decline') return '用户拒绝填写表单';
            const lines = props.fields.map(
                (field) => `${field.label}（${field.name}）：${String(response.values[field.name] ?? '')}`
            );
            return `用户提交了表单：\n${lines.join('\n')}`;
        }
    },
    'data-table': {
        mode: 'show',
        summary: '结构化数据表格（可排序、可格式化数字/金额/百分比/日期/徽标），超过 3 行的对比数据优先用它。',
        props: dataTableProps
    },
    chart: {
        mode: 'show',
        summary: '单个指标的趋势卡：当前值、变化量和一串历史数据点画成面积/折线/柱状迷你图。',
        props: chartProps
    },
    'comparison-card': {
        mode: 'show',
        summary: '2-4 个方案按同一组维度对比，并标出推荐项和理由。',
        props: comparisonCardProps
    },
    'link-preview': {
        mode: 'show',
        summary: '一个网页链接的预览卡片（标题、摘要、站点、配图）。',
        props: linkPreviewProps
    },
    'spec-sheet': {
        mode: 'show',
        summary: '一组键值参数（规格、配置、摘要信息），可强调重点行。',
        props: specSheetProps
    }
} satisfies Record<GenUiComponentName, GenUiComponentDefinition>; // 与协议里的组件名一一对应

export function getGenUiComponent(name: GenUiComponentName): GenUiComponentDefinition {
    return GENUI_COMPONENTS[name];
}

export function listGenUiComponents(mode: GenUiMode): GenUiComponentName[] {
    return GENUI_COMPONENT_NAMES.filter((name) => GENUI_COMPONENTS[name].mode === mode);
}

/** 把 zod 错误压成一行行 "路径: 原因"，作为工具错误交还模型自行修正。 */
export function formatGenUiIssues(error: z.ZodError, prefix = 'props'): string {
    return error.issues
        .slice(0, 8)
        .map((issue) => {
            const path = [prefix, ...issue.path.map(String)].join('.');
            return `${path}: ${issue.message}`;
        })
        .join('\n');
}

export type GenUiPropsCheck = { success: true; props: Record<string, unknown> } | { success: false; error: string };

export function parseGenUiProps(component: GenUiComponentName, props: unknown): GenUiPropsCheck {
    const parsed = GENUI_COMPONENTS[component].props.safeParse(props);
    if (!parsed.success) {
        return { success: false, error: formatGenUiIssues(parsed.error) };
    }
    return { success: true, props: parsed.data as Record<string, unknown> };
}

export type GenUiResponseCheck = { success: true; response: unknown } | { success: false; error: string };

/** 校验渲染进程回传的结果：结构合法，且选中的 id 都来自组件 props。 */
export function parseGenUiResponse(
    component: GenUiComponentName,
    props: Record<string, unknown>,
    response: unknown
): GenUiResponseCheck {
    const definition: GenUiComponentDefinition = GENUI_COMPONENTS[component];
    if (!definition.response) {
        return { success: false, error: `组件 ${component} 不接受回传` };
    }
    const parsed = definition.response.safeParse(response);
    if (!parsed.success) {
        return { success: false, error: formatGenUiIssues(parsed.error, 'response') };
    }
    const data = parsed.data as any;
    if (component === 'option-list') {
        const optionProps = props as OptionListProps;
        const allowed = new Set(optionProps.options.filter((option) => !option.disabled).map((option) => option.id));
        if (!data.selected.every((value: string) => allowed.has(value))) {
            return { success: false, error: 'response.selected 含有未知选项' };
        }
        if (optionProps.selectionMode !== 'multiple' && data.selected.length !== 1) {
            return { success: false, error: '单选只能选择一个选项' };
        }
    }
    if (component === 'question-flow') {
        const flowProps = props as QuestionFlowProps;
        for (const step of flowProps.steps) {
            const answer: string[] | undefined = data.answers[step.id];
            const allowed = new Set(step.options.map((option) => option.id));
            if (!answer || !answer.every((value) => allowed.has(value))) {
                return { success: false, error: `response.answers.${step.id} 缺失或含有未知选项` };
            }
        }
    }
    if (component === 'form' && data.action === 'submit') {
        const formDefinition = props as FormProps;
        for (const field of formDefinition.fields) {
            const value = data.values[field.name];
            if (field.required && field.kind !== 'toggle' && (typeof value !== 'string' || value.trim() === '')) {
                return { success: false, error: `必填字段 ${field.name} 为空` };
            }
            if (
                field.kind === 'choice' &&
                typeof value === 'string' &&
                value !== '' &&
                !field.options?.includes(value)
            ) {
                return { success: false, error: `字段 ${field.name} 的值不在选项中` };
            }
        }
    }
    return { success: true, response: data };
}

export function describeGenUiResponse(
    component: GenUiComponentName,
    props: Record<string, unknown>,
    response: unknown
): string {
    const definition: GenUiComponentDefinition = GENUI_COMPONENTS[component];
    return definition.describeResponse ? definition.describeResponse(props, response) : '';
}

/** 去掉 .int() 生成的 ±MAX_SAFE_INTEGER 边界，压缩写进工具说明的 schema。 */
function compactSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(compactSchema);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if ((key === 'maximum' || key === 'minimum') && Math.abs(Number(item)) === Number.MAX_SAFE_INTEGER) continue;
        result[key] = compactSchema(item);
    }
    return result;
}

/** 生成写入工具说明的组件参考：每个组件一行用途 + props 的 JSON Schema。 */
export function describeGenUiCatalog(mode: GenUiMode): string {
    return listGenUiComponents(mode)
        .map((name) => {
            const definition = GENUI_COMPONENTS[name];
            const schema = z.toJSONSchema(definition.props, { io: 'input', unrepresentable: 'any' }) as Record<
                string,
                unknown
            >;
            delete schema.$schema;
            return `### ${name}\n${definition.summary}\nprops: ${JSON.stringify(compactSchema(schema))}`;
        })
        .join('\n\n');
}
