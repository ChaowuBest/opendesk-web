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
 * 组件名 → assistant-ui Elements 组件的映射，以及 askUI 的交互状态。
 *
 * props 已在主进程按 catalog 校验过，这里只做字段对接；交互组件在拿到 requestId 后才接上
 * 回调，提交经 window.genuiAPI 回到主进程，成功后先本地显示回执，不必等工具结果刷新。
 */

import { useState, type ReactNode } from 'react';
import type {
    ApprovalCardProps,
    ApprovalResponse,
    ChartProps,
    ComparisonCardProps,
    DataTableProps,
    FormProps,
    FormResponse,
    LinkPreviewProps,
    OptionListProps,
    OptionListResponse,
    QuestionFlowProps,
    QuestionFlowResponse,
    SpecSheetProps
} from '../../common/genui/catalog.js';
import type { GenUiPayload } from '../../common/genui/protocol.js';
import { OptionList } from './vendor/assistant-ui/elements/option-list';
import { QuestionFlow } from './vendor/assistant-ui/elements/question-flow';
import { ApprovalCard } from './vendor/assistant-ui/elements/approval-card';
import { ElicitationForm, type ElicitationField } from './vendor/assistant-ui/elements/elicitation-form';
import { DataTable, type DataTableColumn } from './vendor/assistant-ui/elements/data-table';
import { Chart } from './vendor/assistant-ui/elements/chart';
import { ComparisonCard } from './vendor/assistant-ui/elements/comparison-card';
import { LinkPreview } from './vendor/assistant-ui/elements/link-preview';
import { SpecSheet } from './vendor/assistant-ui/elements/spec-sheet';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

interface AskState<R> {
    response: R | undefined;
    interactive: boolean;
    cancelled: boolean;
    error: string | undefined;
    submit: (response: R) => Promise<void>;
}

function useAskState<R>(payload: GenUiPayload, t: Translate): AskState<R> {
    const [local, setLocal] = useState<{ response?: R; error?: string }>({});
    const response = (payload.response as R | undefined) ?? local.response;
    const cancelled = payload.cancelled === true;
    const interactive =
        payload.mode === 'ask' &&
        payload.status === 'running' &&
        typeof payload.requestId === 'string' &&
        response === undefined &&
        !cancelled;

    const submit = async (next: R): Promise<void> => {
        const api = window.genuiAPI;
        const result = api && payload.requestId ? await api.respond(payload.requestId, next) : null;
        if (result?.ok) {
            setLocal({ response: next });
            return;
        }
        const error =
            !result || result.error === 'expired'
                ? t('renderer.genui.expired')
                : t('renderer.genui.submitFailed', { message: result.message ?? result.error });
        setLocal({ error });
        // 抛出让组件恢复可操作状态（OptionList 等约定 rejected promise 表示未提交）
        throw new Error(error);
    };

    return { response, interactive, cancelled, error: local.error, submit };
}

function Notice({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'error' }) {
    return (
        <p className={tone === 'error' ? 'text-xs text-red-600 dark:text-red-400' : 'text-muted-foreground text-xs'}>
            {children}
        </p>
    );
}

function ignoreRejection(promise: Promise<void>): void {
    promise.catch(() => undefined);
}

function OptionListWidget({ payload, t }: WidgetProps) {
    const props = payload.props as OptionListProps;
    const ask = useAskState<OptionListResponse>(payload, t);
    return (
        <>
            <OptionList
                options={props.options}
                selectionMode={props.selectionMode}
                minSelections={props.minSelections}
                maxSelections={props.maxSelections}
                confirmLabel={props.confirmLabel ?? t('renderer.genui.confirm')}
                choice={ask.response?.selected}
                onConfirm={ask.interactive ? (ids) => ask.submit({ selected: ids }) : undefined}
            />
            {ask.cancelled ? <Notice>{t('renderer.genui.cancelled')}</Notice> : null}
            {ask.error ? <Notice tone="error">{ask.error}</Notice> : null}
        </>
    );
}

function QuestionFlowWidget({ payload, t }: WidgetProps) {
    const props = payload.props as QuestionFlowProps;
    const ask = useAskState<QuestionFlowResponse>(payload, t);
    return (
        <>
            <QuestionFlow
                steps={props.steps}
                completeLabel={props.completeLabel ?? t('renderer.genui.submit')}
                nextLabel={t('renderer.genui.next')}
                choice={ask.response?.answers}
                onComplete={ask.interactive ? (answers) => ask.submit({ answers }) : undefined}
            />
            {ask.cancelled ? <Notice>{t('renderer.genui.cancelled')}</Notice> : null}
            {ask.error ? <Notice tone="error">{ask.error}</Notice> : null}
        </>
    );
}

function ApprovalCardWidget({ payload, t }: WidgetProps) {
    const props = payload.props as ApprovalCardProps;
    const ask = useAskState<ApprovalResponse>(payload, t);
    const decision = ask.response?.decision;
    const state = decision === 'approve' ? 'done' : decision === 'deny' || ask.cancelled ? 'denied' : 'request';
    const statusLabel =
        decision === 'approve'
            ? t('renderer.genui.approved')
            : decision === 'deny'
              ? t('renderer.genui.denied')
              : ask.cancelled
                ? t('renderer.genui.cancelled')
                : undefined;
    return (
        <>
            <ApprovalCard
                state={state}
                title={props.title}
                subtitle={props.subtitle}
                description={props.description}
                command={props.command}
                details={props.details}
                variant={props.variant}
                allowOnceLabel={props.approveLabel ?? t('renderer.genui.approve')}
                denyLabel={props.denyLabel ?? t('renderer.genui.deny')}
                statusLabel={statusLabel}
                onAllowOnce={ask.interactive ? () => ignoreRejection(ask.submit({ decision: 'approve' })) : undefined}
                onDeny={ask.interactive ? () => ignoreRejection(ask.submit({ decision: 'deny' })) : undefined}
            />
            {ask.error ? <Notice tone="error">{ask.error}</Notice> : null}
        </>
    );
}

function initialFormValues(props: FormProps): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of props.fields) {
        if (field.kind === 'toggle') {
            values[field.name] = field.default === true || field.default === 'true' ? 'true' : 'false';
        } else {
            values[field.name] = typeof field.default === 'string' ? field.default : '';
        }
    }
    return values;
}

function FormWidget({ payload, t }: WidgetProps) {
    const props = payload.props as FormProps;
    const ask = useAskState<FormResponse>(payload, t);
    const [values, setValues] = useState(() => initialFormValues(props));
    const submitted = ask.response?.action === 'submit' ? ask.response.values : undefined;
    const fields: ElicitationField[] = props.fields.map((field) => {
        const submittedValue = submitted?.[field.name];
        const value = submittedValue === undefined ? (values[field.name] ?? '') : String(submittedValue);
        return {
            name: field.name,
            label: field.label,
            kind: field.kind,
            value,
            ...(field.options ? { options: field.options } : {}),
            ...(field.required ? { required: true } : {})
        };
    });
    const state =
        ask.response?.action === 'submit'
            ? 'accepted'
            : ask.response?.action === 'decline' || ask.cancelled
              ? 'declined'
              : 'request';
    const submit = () => {
        const result: Record<string, string | boolean> = {};
        for (const field of props.fields) {
            const value = values[field.name] ?? '';
            result[field.name] = field.kind === 'toggle' ? value === 'true' : value;
        }
        ignoreRejection(ask.submit({ action: 'submit', values: result }));
    };
    return (
        <>
            <ElicitationForm
                server={props.source ?? t('renderer.genui.form.source')}
                message={props.message}
                fields={fields}
                state={state}
                labels={{
                    needsInput: t('renderer.genui.form.needsInput'),
                    send: props.submitLabel ?? t('renderer.genui.form.send'),
                    decline: t('renderer.genui.form.decline'),
                    sent: t('renderer.genui.form.sent'),
                    declined: ask.cancelled ? t('renderer.genui.cancelled') : t('renderer.genui.form.declined'),
                    on: t('renderer.genui.form.on'),
                    off: t('renderer.genui.form.off')
                }}
                onFieldChange={
                    ask.interactive
                        ? (name, value) => setValues((current) => ({ ...current, [name]: value }))
                        : undefined
                }
                onAccept={ask.interactive ? submit : undefined}
                onDecline={ask.interactive ? () => ignoreRejection(ask.submit({ action: 'decline' })) : undefined}
            />
            {ask.error ? <Notice tone="error">{ask.error}</Notice> : null}
        </>
    );
}

function DataTableWidget({ payload, t, locale }: WidgetProps) {
    const props = payload.props as DataTableProps;
    const columns: DataTableColumn[] = props.columns.map((column) =>
        column.format?.kind === 'boolean'
            ? {
                  ...column,
                  format: {
                      ...column.format,
                      trueLabel: column.format.trueLabel ?? t('renderer.genui.table.yes'),
                      falseLabel: column.format.falseLabel ?? t('renderer.genui.table.no')
                  }
              }
            : column
    );
    return (
        <DataTable
            columns={columns}
            rows={props.rows}
            rowKey={props.rowKey}
            caption={props.caption}
            defaultSort={props.defaultSort}
            locale={locale}
            emptyMessage={t('renderer.genui.table.empty')}
        />
    );
}

function ChartWidget({ payload }: WidgetProps) {
    const props = payload.props as ChartProps;
    return (
        <Chart
            label={props.label}
            value={props.value}
            delta={props.delta}
            points={props.points}
            visibleCount={props.points.length}
            variant={props.variant}
            trend={props.trend}
            upIsGood={props.upIsGood}
        />
    );
}

function ComparisonCardWidget({ payload, t }: WidgetProps) {
    const props = payload.props as ComparisonCardProps;
    return (
        <ComparisonCard
            traitLabels={props.traitLabels}
            options={props.options}
            recommendedId={props.recommendedId}
            reason={props.reason}
            recommendedLabel={t('renderer.genui.recommended')}
        />
    );
}

function LinkPreviewWidget({ payload }: WidgetProps) {
    const props = payload.props as LinkPreviewProps;
    return <LinkPreview {...props} />;
}

function SpecSheetWidget({ payload }: WidgetProps) {
    const props = payload.props as SpecSheetProps;
    return (
        <SpecSheet title={props.title} subtitle={props.subtitle} rows={props.rows} visibleCount={props.rows.length} />
    );
}

interface WidgetProps {
    payload: GenUiPayload;
    t: Translate;
    locale: string;
}

const WIDGETS: Record<GenUiPayload['component'], (props: WidgetProps) => ReactNode> = {
    'option-list': OptionListWidget,
    'question-flow': QuestionFlowWidget,
    'approval-card': ApprovalCardWidget,
    form: FormWidget,
    'data-table': DataTableWidget,
    chart: ChartWidget,
    'comparison-card': ComparisonCardWidget,
    'link-preview': LinkPreviewWidget,
    'spec-sheet': SpecSheetWidget
};

export function GenUiWidget({ payload, t, locale }: { payload: GenUiPayload; t: Translate; locale: string }) {
    const Widget = WIDGETS[payload.component];
    return (
        <div
            className="od-genui-widget text-foreground flex flex-col gap-2"
            data-component={payload.component}
            data-status={payload.status}
        >
            {payload.title ? <div className="text-[13.5px] leading-5 font-medium">{payload.title}</div> : null}
            <Widget payload={payload} t={t} locale={locale} />
        </div>
    );
}
