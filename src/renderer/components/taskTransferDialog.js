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

import { MODAL_CSS, detectDarkMode } from './confirmModal.js';
import { escapeHtml } from '../../common/utils/escape.js';
import { showWorkspacePicker } from './workspacePicker.ts';

const TRANSFER_CSS = `
[data-task-transfer] .od-confirm-modal-card { width: 640px; max-width: 94vw; }
[data-task-transfer] .od-confirm-modal-body { max-height: 65vh; overflow-y: auto; }
.od-transfer-toolbar { display: flex; gap: 12px; align-items: center; margin: 16px 0 10px; flex-wrap: wrap; }
.od-transfer-search { flex: 1; min-width: 140px; background: var(--mc-card-bg); color: var(--mc-ink); border: 1px solid var(--mc-line); border-radius: 8px; padding: 8px 10px; font: inherit; }
.od-transfer-list { max-height: 300px; overflow-y: auto; border: 1px solid var(--mc-line); border-radius: 8px; }
.od-transfer-row { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border-bottom: 1px solid var(--mc-line); cursor: pointer; }
.od-transfer-row:last-child { border-bottom: 0; }
.od-transfer-row input { margin-top: 4px; accent-color: var(--mc-accent); }
.od-transfer-row span { min-width: 0; overflow-wrap: anywhere; }
.od-transfer-row small { display: block; color: var(--mc-ink3); margin-top: 4px; }
.od-transfer-row:has(input:disabled) { opacity: .65; cursor: default; }
.od-transfer-description, .od-transfer-status { color: var(--mc-ink2); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.od-transfer-status { margin-top: 12px; }
.od-transfer-result { display: block; width: 100%; text-align: left; padding: 10px; color: var(--mc-ink); background: var(--mc-card-bg); border: 0; border-bottom: 1px solid var(--mc-line); cursor: pointer; font: inherit; }
.od-transfer-info { display: flex; gap: 10px; padding: 12px 14px; border: 1px solid var(--mc-line); border-radius: 8px; background: color-mix(in srgb, #568de5 10%, var(--mc-card-bg)); }
.od-transfer-info-icon { color: #568de5; font-size: 18px; }
.od-transfer-workspace { display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 8px; padding: 12px; border: 1px solid var(--mc-line); border-radius: 8px; background: var(--mc-card-bg); color: var(--mc-ink); font: inherit; text-align: left; cursor: pointer; }
.od-transfer-workspace span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
[data-task-transfer] button:disabled { opacity: .5; cursor: default; }
`;

let opening = false;

export async function showTaskTransfer(host, t, mode) {
    if (opening || document.querySelector('[data-task-transfer]')) return;
    opening = true;
    try {
        const dialog = new TaskTransferDialog(host, t, mode);
        let preview, error;
        if (mode === 'import') {
            try {
                preview = await window.taskManagerAPI.previewTaskImport();
                if (!preview) return;
            } catch (failure) {
                error = failure;
            }
        }
        await dialog.open(preview, error);
        return dialog;
    } finally {
        opening = false;
    }
}

class TaskTransferDialog {
    constructor(host, t, mode) {
        this.host = host;
        this.t = t;
        this.mode = mode;
        this.entries = [];
        this.selected = new Set();
        this.busy = false;
        this.query = '';
        this.operationId = crypto.randomUUID();
        this.previousFocus = document.activeElement;
    }

    async open(preview, previewError) {
        this.overlay = document.createElement('div');
        this.overlay.className = 'od-confirm-modal-overlay';
        this.overlay.dataset.taskTransfer = '';
        if (detectDarkMode(this.host)) this.overlay.classList.add('od-modal-dark');
        this.overlay.innerHTML = `<style>${MODAL_CSS}${TRANSFER_CSS}</style>
            <div class="od-confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="od-transfer-title">
                <div class="od-confirm-modal-banner info"><div class="od-confirm-modal-banner-text">
                    <div id="od-transfer-title" class="od-confirm-modal-title">${this.t(`taskTransfer.${this.mode}`)}</div>
                </div></div>
                <div class="od-confirm-modal-body">
                    ${
                        this.mode === 'export'
                            ? `<div class="od-transfer-info od-transfer-description" data-transfer-info>
                        <span class="od-transfer-info-icon" aria-hidden="true">ⓘ</span>
                        <div><div>${this.t('taskTransfer.includes')}</div><div>${this.t('taskTransfer.excludes')}</div><div>${this.t('taskTransfer.snapshot')}</div></div>
                    </div>`
                            : `<div data-transfer-destination>
                        <label class="od-transfer-description" for="od-transfer-workspace">${this.t('taskTransfer.workspaceLabel')}</label>
                        <button id="od-transfer-workspace" class="od-transfer-workspace" data-transfer-workspace>
                            <i class="fa-regular fa-folder" aria-hidden="true"></i><span data-transfer-workspace-path></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                        </button>
                    </div>`
                    }
                    <div data-transfer-selection hidden>
                        <div class="od-transfer-toolbar">
                            <input class="od-transfer-search" data-transfer-search aria-label="${this.t('taskTransfer.search')}" placeholder="${this.t('taskTransfer.search')}">
                            <button class="od-confirm-btn od-confirm-btn-cancel" data-transfer-all>${this.t('taskTransfer.selectAll')}</button>
                        </div>
                        <div class="od-transfer-list" data-transfer-list></div>
                    </div>
                    <div class="od-transfer-status" data-transfer-status role="status" aria-live="polite"></div>
                    <div data-transfer-results></div>
                </div>
                <div class="od-confirm-modal-footer">
                    <button class="od-confirm-btn od-confirm-btn-cancel" data-transfer-close>${this.t('common.cancel')}</button>
                    <button class="od-confirm-btn od-confirm-btn-primary" data-transfer-submit disabled></button>
                </div>
            </div>`;
        document.body.appendChild(this.overlay);
        this.find('[data-transfer-close]').addEventListener('click', () => this.close());
        this.find('[data-transfer-submit]').addEventListener('click', () => void this.submit());
        this.find('[data-transfer-workspace]')?.addEventListener('click', () => void this.chooseWorkspace());
        this.find('[data-transfer-search]').addEventListener('input', (event) => {
            this.query = event.target.value.toLocaleLowerCase();
            this.renderRows();
        });
        this.find('[data-transfer-all]').addEventListener('click', () => {
            const rows = this.filtered().filter((entry) => !entry.error);
            const clear = rows.every((entry) => this.selected.has(entry.id));
            for (const row of rows) {
                if (clear) this.selected.delete(row.id);
                else this.selected.add(row.id);
            }
            this.renderRows();
        });
        this.onKey = (event) => {
            if (this.choosingWorkspace) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.close();
            }
            if (event.key === 'Tab') {
                const controls = [
                    ...this.overlay.querySelectorAll('button:not(:disabled), input:not(:disabled)')
                ].filter((element) => !element.hidden && !element.closest('[hidden]'));
                if (!controls.length) {
                    event.preventDefault();
                    return;
                }
                const first = controls[0],
                    last = controls[controls.length - 1];
                if (
                    event.shiftKey &&
                    (document.activeElement === first || !this.overlay.contains(document.activeElement))
                ) {
                    event.preventDefault();
                    last.focus();
                } else if (
                    !event.shiftKey &&
                    (document.activeElement === last || !this.overlay.contains(document.activeElement))
                ) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };
        document.addEventListener('keydown', this.onKey, true);
        this.unsubscribe = window.taskManagerAPI.onTaskTransferProgress((event) => {
            if (this.busy && event.operationId === this.operationId)
                this.status(this.t('taskTransfer.progress', { done: event.done, total: event.total }));
        });
        this.setBusy(true);
        this.status(this.t('taskTransfer.reading'));
        try {
            if (previewError) throw previewError;
            if (this.mode === 'import') {
                this.token = preview.token;
                this.entries = preview.entries;
                this.workspace = preview.workspace;
                this.renderWorkspace();
                this.selected = new Set(
                    this.entries.filter((entry) => !entry.error && !entry.duplicate).map((entry) => entry.id)
                );
            } else {
                const tasks = await window.taskManagerAPI.getTaskList();
                this.entries = tasks
                    .filter((task) => !task.parent_id && !task.internal)
                    .map((task) => ({
                        id: task.task_id,
                        name: task.task_name || '',
                        running: task.task_status === 'running'
                    }));
            }
            this.find('[data-transfer-selection]').hidden = false;
            this.status(this.mode === 'import' ? this.t('taskTransfer.duplicatesHint') : '');
        } catch (error) {
            if (this.mode === 'import') this.find('[data-transfer-destination]').hidden = true;
            this.status(error.message || this.t('taskTransfer.error.invalidBundle'));
        }
        this.setBusy(false);
        this.renderRows();
        this.find('[data-transfer-search]').focus();
    }

    renderWorkspace() {
        this.find('[data-transfer-workspace-path]').textContent = this.workspace;
        this.find('[data-transfer-workspace]').title = this.workspace;
    }
    async chooseWorkspace() {
        if (this.busy || this.choosingWorkspace) return;
        this.choosingWorkspace = true;
        // The shared picker owns keyboard focus while this modal is hidden.
        this.overlay.hidden = true;
        this.overlay.style.display = 'none';
        try {
            const selected = await showWorkspacePicker({
                title: this.t('taskTransfer.workspaceLabel'),
                t: this.t,
                initialWorkspace: this.workspace
            });
            if (selected) {
                this.workspace = selected;
                this.renderWorkspace();
            }
        } catch (error) {
            this.status(error.message || this.t('taskTransfer.error.invalidWorkspace'));
        } finally {
            this.choosingWorkspace = false;
            this.overlay.hidden = false;
            this.overlay.style.display = '';
            this.find('[data-transfer-workspace]').focus();
        }
    }
    find(selector) {
        return this.overlay.querySelector(selector);
    }
    status(text) {
        this.find('[data-transfer-status]').textContent = text;
    }
    filtered() {
        return this.entries.filter((entry) => `${entry.name} ${entry.id}`.toLocaleLowerCase().includes(this.query));
    }
    renderRows() {
        const list = this.find('[data-transfer-list]');
        const rows = this.filtered();
        list.innerHTML = rows.length
            ? rows
                  .map((entry, index) => {
                      const detail = entry.error
                          ? this.t(`taskTransfer.error.${entry.error}`)
                          : this.mode === 'import'
                            ? this.t('taskTransfer.messages', { count: entry.messageCount })
                            : entry.running
                              ? this.t('taskTransfer.running')
                              : '';
                      return `<label class="od-transfer-row"><input type="checkbox" data-row="${index}" ${this.selected.has(entry.id) ? 'checked' : ''} ${entry.error || this.busy ? 'disabled' : ''}>
                <span>${escapeHtml(entry.name || this.t('taskTransfer.unnamed'))}<small>${escapeHtml(detail)}</small>
                ${entry.parentId ? `<small>${escapeHtml(this.t('taskTransfer.child'))}</small>` : ''}
                ${entry.duplicate ? `<small>${escapeHtml(this.t('taskTransfer.duplicate'))}</small>` : ''}</span></label>`;
                  })
                  .join('')
            : `<div class="od-transfer-row">${this.t('taskTransfer.empty')}</div>`;
        list.querySelectorAll('[data-row]').forEach((input) =>
            input.addEventListener('change', () => {
                const entry = rows[Number(input.dataset.row)];
                if (input.checked) this.selected.add(entry.id);
                else this.selected.delete(entry.id);
                this.updateSubmit();
            })
        );
        this.updateSubmit();
    }
    updateSubmit() {
        const button = this.find('[data-transfer-submit]');
        button.textContent = this.t(`taskTransfer.${this.mode}Count`, { count: this.selected.size });
        button.disabled = this.busy || !this.selected.size;
    }
    setBusy(value) {
        this.busy = value;
        this.overlay.setAttribute('aria-busy', String(value));
        this.overlay.querySelectorAll('input, button').forEach((element) => {
            element.disabled = value;
        });
        this.updateSubmit();
    }
    async submit() {
        if (this.busy || !this.selected.size) return;
        this.setBusy(true);
        this.status(this.t('taskTransfer.processing'));
        try {
            if (this.mode === 'import') {
                const token = this.token;
                const result = await window.taskManagerAPI.importTaskBundle(
                    token,
                    [...this.selected],
                    this.operationId,
                    this.workspace
                );
                this.token = undefined;
                this.status(
                    this.t('taskTransfer.importResult', {
                        imported: result.imported.length,
                        failed: result.failed.length,
                        skipped: result.skipped
                    })
                );
                const results = this.find('[data-transfer-results]');
                for (const item of result.imported) {
                    const button = document.createElement('button');
                    button.className = 'od-transfer-result';
                    button.textContent = this.t('taskTransfer.openTask', {
                        name: item.name || this.t('taskTransfer.unnamed')
                    });
                    button.addEventListener('click', () => {
                        this.close();
                        void window.globalControlAPI?.openTask(item.taskId);
                    });
                    results.appendChild(button);
                }
                for (const item of result.failed) {
                    const row = document.createElement('div');
                    row.className = 'od-transfer-status';
                    row.textContent = `${item.name || item.sourceId}: ${this.t(`taskTransfer.error.${item.error}`)}`;
                    results.appendChild(row);
                }
            } else {
                const result = await window.taskManagerAPI.exportTaskBundle([...this.selected], this.operationId);
                if (!result) {
                    this.status('');
                    return;
                }
                this.status(this.t('taskTransfer.exportResult', { count: result.count }));
                const button = document.createElement('button');
                button.className = 'od-confirm-btn od-confirm-btn-cancel';
                button.textContent = this.t('taskTransfer.openFolder');
                button.addEventListener('click', async () => {
                    try {
                        await window.fsAPI.showItemInFolder(result.filePath);
                    } catch (error) {
                        this.status(error.message);
                    }
                });
                const close = this.find('[data-transfer-close]');
                close.parentElement.insertBefore(button, close);
            }
            this.find('[data-transfer-selection]').hidden = true;
            if (this.mode === 'import') this.find('[data-transfer-destination]').hidden = true;
            this.find('[data-transfer-submit]').hidden = true;
            this.find('[data-transfer-close]').textContent = this.t('common.close');
        } catch (error) {
            this.status(error.message || this.t('taskTransfer.error.writeFailed'));
        } finally {
            this.setBusy(false);
            this.renderRows();
        }
    }
    close() {
        if (this.busy || this.choosingWorkspace) return;
        if (this.token) void window.taskManagerAPI.discardTaskImport(this.token).catch(() => {});
        this.token = undefined;
        this.unsubscribe?.();
        document.removeEventListener('keydown', this.onKey, true);
        this.overlay.remove();
        this.previousFocus?.focus();
    }
}
