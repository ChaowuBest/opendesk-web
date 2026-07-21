/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：渲染独立的 Workflow Manager 和 Run 详情界面。
 */

import { escapeHtml } from '../../../../common/utils/escape.js';
import { createRendererTranslator } from '../../../../renderer/locale.js';
import type { WorkflowAgentSnapshot, WorkflowRun, WorkflowRunPhase } from '../../../aikernel/workflow.js';
import './style.css';

const SELECTED_RUN_STORAGE_KEY = 'opendesk.workflow.selectedRunId';

interface WorkflowRunListItem {
    runId: string;
}

class WorkflowEntryWidget extends HTMLElement {
    private run?: WorkflowRun;
    private selectedPhaseId?: string;
    private selectedAgentId?: string;
    private stopping = false;
    private t = createRendererTranslator();

    connectedCallback(): void {
        void this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            const settings = await window.top?.settingAPI?.loadSettingObject?.();
            this.t = createRendererTranslator(settings);
        } catch {
            this.t = createRendererTranslator();
        }
        window.applicationAPI.subscribe('runUpdated', (run: WorkflowRun) => {
            if (this.run?.id === run.id) {
                this.run = run;
                this.ensureSelection();
                this.render();
            }
        });
        window.applicationAPI.subscribe('runSelected', (runId: string) => {
            this.storeSelectedRunId(runId);
            void this.reload(runId);
        });
        await this.reload();
    }

    private async reload(selectedRunId?: string): Promise<void> {
        try {
            let runId = selectedRunId ?? this.readSelectedRunId();
            if (!runId) {
                const summaries = (await window.applicationAPI.callMainWorld('listRunsForUI')) as WorkflowRunListItem[];
                runId = summaries[0]?.runId;
            }
            this.run = runId ? await window.applicationAPI.callMainWorld('getRunForUI', runId) : undefined;
            if (this.run) {
                this.storeSelectedRunId(this.run.id);
            }
            this.selectedPhaseId = this.defaultPhaseId(this.run);
            this.selectedAgentId = undefined;
            this.render();
        } catch (err) {
            this.innerHTML = `<div class="workflow-detail-error w-full h-full p-4 text-[12px]">${escapeHtml(
                err instanceof Error ? err.message : String(err)
            )}</div>`;
        }
    }

    private ensureSelection(): void {
        const run = this.run;
        if (!run) {
            this.selectedPhaseId = undefined;
            this.selectedAgentId = undefined;
            return;
        }
        if (!run.phases.some((phase) => phase.id === this.selectedPhaseId)) {
            this.selectedPhaseId = this.defaultPhaseId(run);
        }
        const selectedAgent = run.agents.find((agent) => agent.id === this.selectedAgentId);
        if (!selectedAgent) {
            this.selectedAgentId = undefined;
        } else {
            this.selectedPhaseId = selectedAgent.phaseId;
        }
    }

    private render(): void {
        const run = this.run;
        if (!run) {
            this.innerHTML = `<div class="workflow-detail-loading w-full h-full flex items-center justify-center text-[12px]">${escapeHtml(
                this.t('workflow.detail.empty')
            )}</div>`;
            return;
        }
        this.ensureSelection();
        const phases = run.phases;
        const agents = run.agents;
        const selectedPhase = phases.find((phase) => phase.id === this.selectedPhaseId);
        const selectedAgent = agents.find((agent) => agent.id === this.selectedAgentId);
        const runMeta = statusMeta(run.status, this.statusLabel(run.status));
        const stopLabel = this.t('workflow.detail.stop');
        this.innerHTML = `
        <div class="workflow-detail-shell w-full h-full min-w-0 overflow-x-hidden border-l flex flex-col">
            <div class="workflow-detail-header px-4 py-3 border-b flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <div class="flex items-center gap-2">
                        <button type="button" class="workflow-detail-back w-7 h-7 rounded-md" data-action="back" title="${escapeHtml(this.t('workflow.detail.back'))}">
                            <i class="fa-solid fa-arrow-left"></i>
                        </button>
                        <div class="workflow-detail-title text-[14px] font-semibold truncate">${escapeHtml(run.definition.name)}</div>
                        <span class="text-[11px] ${runMeta.text}">
                            <i class="fa-solid ${runMeta.icon}"></i> ${escapeHtml(runMeta.label)}
                        </span>
                    </div>
                    <div class="workflow-detail-muted text-[11px] mt-1 pl-9 truncate">${escapeHtml(run.definition.description)}</div>
                    <div class="workflow-detail-subtle text-[10px] mt-1 pl-9 truncate">${escapeHtml(run.id)}</div>
                </div>
                <div class="workflow-detail-muted text-right text-[11px] shrink-0 space-y-1">
                    <div>${escapeHtml(this.t('workflow.detail.agents', { count: agents.length }))}</div>
                    ${
                        run.status === 'running'
                            ? `<div class="flex items-center justify-end gap-1">
                                <button type="button" class="workflow-detail-action rounded-md border disabled:opacity-40"
                                    data-action="stop" ${this.stopping ? 'disabled' : ''}
                                    aria-label="${escapeHtml(stopLabel)}" data-tooltip="${escapeHtml(stopLabel)}">
                                    <i class="fa-solid fa-stop"></i>
                                </button>
                            </div>`
                            : ''
                    }
                </div>
            </div>
            <div class="flex-1 min-h-0 min-w-0 grid grid-cols-[280px_minmax(0,1fr)] overflow-x-hidden">
                <div class="workflow-detail-sidebar border-r p-3 overflow-y-auto overflow-x-hidden">
                    <div class="workflow-detail-section-title text-[11px] font-semibold mb-2">${escapeHtml(this.t('workflow.detail.phases'))}</div>
                    ${phases.map((phase) => this.renderPhaseRow(phase, phase.id === this.selectedPhaseId)).join('')}
                </div>
                <div class="min-w-0 max-w-full p-3 overflow-y-auto overflow-x-hidden">
                    ${
                        selectedAgent
                            ? this.renderAgentDetail(selectedAgent)
                            : this.renderAgentList(
                                  agents.filter(
                                      (agent) => !this.selectedPhaseId || agent.phaseId === this.selectedPhaseId
                                  ),
                                  selectedPhase
                              )
                    }
                </div>
            </div>
        </div>`;
        this.bindInteractions(run);
    }

    private bindInteractions(run: WorkflowRun): void {
        this.querySelector<HTMLButtonElement>('[data-action="back"]')?.addEventListener('click', () => {
            window.parent?.globalControlAPI?.openTask?.(run.hostTaskId);
        });
        this.querySelector<HTMLButtonElement>('[data-action="stop"]')?.addEventListener('click', () => {
            void this.stopRun();
        });
        this.querySelectorAll<HTMLElement>('[data-phase-id]').forEach((row) => {
            row.addEventListener('click', () => {
                this.selectedPhaseId = row.dataset.phaseId;
                this.selectedAgentId = undefined;
                this.render();
            });
        });
        this.querySelectorAll<HTMLElement>('[data-agent-id]').forEach((row) => {
            row.addEventListener('click', () => {
                this.selectedAgentId = row.dataset.agentId;
                this.render();
            });
        });
        this.querySelector<HTMLButtonElement>('[data-action="agent-back"]')?.addEventListener('click', () => {
            this.selectedAgentId = undefined;
            this.render();
        });
    }

    private renderPhaseRow(phase: WorkflowRunPhase, selected: boolean): string {
        const meta = statusMeta(phase.status, this.statusLabel(phase.status));
        const phaseAgents = this.run?.agents.filter((agent) => agent.phaseId === phase.id) ?? [];
        const done = phaseAgents.filter((agent) => agent.status !== 'running').length;
        return `
        <div class="workflow-phase-row rounded-md px-2 py-1.5 mb-1 cursor-pointer ${selected ? 'is-selected' : ''}"
            data-phase-id="${escapeHtml(phase.id)}">
            <div class="flex items-center gap-2 min-w-0">
                <i class="fa-solid ${meta.icon} text-[10px] ${meta.text}"></i>
                <span class="text-[12px] truncate flex-1">${escapeHtml(phase.name)}</span>
                <span class="workflow-phase-progress workflow-detail-muted text-[11px]">${done}/${phaseAgents.length}</span>
            </div>
        </div>`;
    }

    private renderAgentList(agents: WorkflowAgentSnapshot[], phase?: WorkflowRunPhase): string {
        const heading = phase
            ? this.t('workflow.detail.agentsForPhase', { phase: phase.name, count: agents.length })
            : this.t('workflow.detail.agentsForRun', { count: agents.length });
        if (agents.length === 0) {
            return `
            <div class="workflow-detail-muted text-[12px]">
                <div class="font-semibold mb-2">${escapeHtml(heading)}</div>
                <div>${escapeHtml(this.t('workflow.detail.noAgents'))}</div>
            </div>`;
        }
        return `
        <div class="text-[12px]">
            <div class="workflow-detail-muted font-semibold mb-2">${escapeHtml(heading)}</div>
            <div class="space-y-1">
                ${agents.map((agent) => this.renderAgentRow(agent)).join('')}
            </div>
        </div>`;
    }

    private renderAgentRow(agent: WorkflowAgentSnapshot): string {
        const meta = statusMeta(agent.status, this.statusLabel(agent.status));
        return `
        <div class="workflow-agent-row rounded-md border cursor-pointer px-2 py-1.5"
            data-agent-id="${escapeHtml(agent.id)}">
            <div class="flex items-center gap-2 min-w-0">
                <i class="fa-solid ${meta.icon} ${meta.text} w-3"></i>
                <span class="workflow-agent-title truncate flex-1">${escapeHtml(agent.title)}</span>
                <span class="workflow-agent-muted text-[10px] shrink-0">${escapeHtml(agent.model ?? '')}</span>
            </div>
        </div>`;
    }

    private renderAgentDetail(agent: WorkflowAgentSnapshot): string {
        const meta = statusMeta(agent.status, this.statusLabel(agent.status));
        const outcome =
            agent.output !== undefined
                ? JSON.stringify(agent.output, null, 2)
                : agent.error || agent.summary || this.t('workflow.detail.agentNoOutcome');
        return `
        <div class="workflow-detail-content text-[12px] min-w-0 max-w-full overflow-x-hidden">
            <button type="button" class="workflow-agent-detail-back mb-3 px-2 py-1 rounded-md" data-action="agent-back">
                <i class="fa-solid fa-arrow-left"></i> ${escapeHtml(this.t('workflow.detail.backToPhase'))}
            </button>
            <div class="workflow-agent-detail-card border rounded-lg p-3">
                <div class="flex items-center gap-2">
                    <i class="fa-solid ${meta.icon} ${meta.text}"></i>
                    <div class="font-semibold truncate">${escapeHtml(agent.title)}</div>
                    <span class="workflow-agent-muted text-[11px]">${escapeHtml(agent.model ?? '')}</span>
                </div>
                <div class="workflow-agent-muted text-[11px] mt-1">${escapeHtml(agent.summary ?? '')}</div>
            </div>
            <div class="mt-3">
                <div class="workflow-agent-muted text-[11px] font-semibold mb-1">${escapeHtml(this.t('workflow.detail.agentPrompt'))}</div>
                <pre class="workflow-agent-detail-text whitespace-pre-wrap text-[11px] border rounded-lg p-3 max-h-48 overflow-y-auto overflow-x-hidden max-w-full">${escapeHtml(agent.prompt)}</pre>
            </div>
            <div class="mt-3">
                <div class="workflow-agent-muted text-[11px] font-semibold mb-1">${escapeHtml(this.t('workflow.detail.agentOutcome'))}</div>
                <div class="workflow-agent-detail-text text-[11px] border rounded-lg p-3 whitespace-pre-wrap max-h-[52vh] overflow-y-auto overflow-x-hidden max-w-full">${escapeHtml(outcome)}</div>
            </div>
        </div>`;
    }

    private async stopRun(): Promise<void> {
        if (!this.run || this.run.status !== 'running' || this.stopping) {
            return;
        }
        this.stopping = true;
        this.render();
        try {
            this.run = await window.applicationAPI.callMainWorld('stopRunForUI', this.run.id);
            this.ensureSelection();
        } finally {
            this.stopping = false;
            this.render();
        }
    }

    private defaultPhaseId(run?: WorkflowRun): string | undefined {
        if (!run?.phases.length) {
            return undefined;
        }
        return run.phases.find((phase) => phase.status === 'running')?.id ?? run.phases[0].id;
    }

    private statusLabel(
        status: WorkflowRun['status'] | WorkflowRunPhase['status'] | WorkflowAgentSnapshot['status']
    ): string {
        return this.t(`workflow.status.${status}`);
    }

    private readSelectedRunId(): string | undefined {
        try {
            return window.top?.localStorage.getItem(SELECTED_RUN_STORAGE_KEY) ?? undefined;
        } catch {
            return undefined;
        }
    }

    private storeSelectedRunId(runId: string): void {
        try {
            window.top?.localStorage.setItem(SELECTED_RUN_STORAGE_KEY, runId);
        } catch {
            // Selection is a frontend convenience; runId remains queryable from the run index.
        }
    }
}

function statusMeta(
    status: WorkflowRun['status'] | WorkflowRunPhase['status'] | WorkflowAgentSnapshot['status'],
    label: string
): { icon: string; label: string; text: string } {
    switch (status) {
        case 'pending':
            return { icon: 'fa-clock', label, text: 'od-workflow-status-muted' };
        case 'running':
            return { icon: 'fa-circle-notch fa-spin', label, text: 'od-workflow-status-running' };
        case 'succeeded':
            return { icon: 'fa-check', label, text: 'od-workflow-status-success' };
        case 'failed':
            return { icon: 'fa-xmark', label, text: 'od-workflow-status-failed' };
        case 'cancelled':
            return { icon: 'fa-ban', label, text: 'od-workflow-status-muted' };
    }
}

if (!customElements.get('workflow-entry-widget')) {
    customElements.define('workflow-entry-widget', WorkflowEntryWidget);
}
