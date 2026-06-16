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

import { applyClick, computeVisual } from './checkbox.js';
import { isSameOrAncestor, normalizePath } from './utils.js';

export interface FSEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    isDrive?: boolean;
    driveLetter?: string;
    size?: number;
    free?: number;
}

export interface FileTreeChecksOptions {
    listDirectory: (dirPath: string, opts?: { includeFiles?: boolean }) => Promise<FSEntry[]>;
    onSelect?: (path: string | null) => void;
    getEntries?: () => unknown[];
    getVisualContext?: () => Record<string, unknown>;
    onCommit?: (payload: { path: string; result: unknown }) => void;
    onShowModal?: (payload: { path: string; result: unknown }) => void;
    onToast?: (payload: { path: string; result: unknown; toast: unknown }) => void;
    height?: string;
}

interface Column {
    parentPath: string;
    entries: FSEntry[];
    selectedPath: string | null;
}

type CheckboxVisualState = 'checked' | 'indeterminate' | 'empty' | 'system-skip' | 'unavailable';

interface CheckboxVisual {
    state: CheckboxVisualState;
    cause?: string;
}

interface CheckboxClickResult {
    action?: string;
    nextEntries?: unknown[];
    toast?: unknown;
}

const MIN_STRETCH_COLUMN_WIDTH = 190;
const FIXED_COLUMN_WIDTH = 220;
const COLUMN_FADE_MS = 180;
const DRIVE_ROOT_PATH = '{DRIVE_ROOT}';

function isDriveRootPath(path: string): boolean {
    return path === DRIVE_ROOT_PATH;
}

function directoriesOnly(entries: FSEntry[]): FSEntry[] {
    return entries.filter((entry) => entry.isDirectory || entry.isDrive);
}

function isCheckboxClickResult(result: unknown): result is CheckboxClickResult {
    return typeof result === 'object' && result !== null;
}

function pathParts(path: string): string[] {
    return normalizePath(path).split('/').filter(Boolean);
}

function buildExpansionChain(rootPath: string, targetPath: string): string[] {
    const normalizedRoot = normalizePath(rootPath);
    const normalizedTarget = normalizePath(targetPath);
    if (!normalizedRoot || !normalizedTarget || normalizedRoot === normalizedTarget) {
        return [];
    }

    if (!isDriveRootPath(normalizedRoot) && !isSameOrAncestor(normalizedRoot, normalizedTarget)) {
        return [];
    }

    if (isDriveRootPath(normalizedRoot)) {
        const [drive, ...rest] = pathParts(normalizedTarget);
        if (!drive) {
            return [];
        }

        const chain = [drive];
        let current = drive;
        for (const part of rest) {
            current = `${current}/${part}`;
            chain.push(current);
        }

        return chain;
    }

    const relative = normalizedTarget.slice(normalizedRoot.length).replace(/^\//, '');
    const parts = relative.split('/').filter(Boolean);
    const chain: string[] = [];
    let current = normalizedRoot;
    for (const part of parts) {
        current = current === '/' ? `/${part}` : `${current}/${part}`;
        chain.push(current);
    }

    return chain;
}

export class FileTreeChecks {
    readonly element: HTMLDivElement;
    private _columns: Column[] = [];
    private _selectedPath: string | null = null;
    private _opts: FileTreeChecksOptions;
    private _resizeObserver: ResizeObserver | null = null;
    private _resizeHandler: (() => void) | null = null;
    private _loadSerial = 0;
    private _destroyed = false;
    private _layoutFrame: number | null = null;
    private _columnScrollTops = new Map<string, number>();

    constructor(opts: FileTreeChecksOptions) {
        this._opts = opts;
        this.element = document.createElement('div');
        this.element.className = 'fs-tree';

        const h = opts.height ?? '260px';
        if (h === '100%') {
            this.element.style.flex = '1';
            this.element.style.minHeight = '0';
        } else {
            this.element.style.height = h;
        }

        this._injectStyle();
        this._bindResize();
        this._render();
    }

    get selectedPath(): string | null {
        return this._selectedPath;
    }

    destroy(): void {
        if (this._destroyed) return;

        this._destroyed = true;
        this._loadSerial++;
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }

        if (this._layoutFrame !== null) {
            cancelAnimationFrame(this._layoutFrame);
            this._layoutFrame = null;
        }
    }

    getRenderedRowPaths(): string[] {
        return Array.from(this.element.querySelectorAll<HTMLElement>('.fs-tree-row')).map(
            (row) => row.dataset.path ?? ''
        );
    }

    async setRoot(dirPath: string): Promise<void> {
        if (this._destroyed) return;

        const serial = ++this._loadSerial;
        const normalizedDirPath = normalizePath(dirPath);
        this._columns = [];
        this._columnScrollTops.clear();
        this._selectedPath = null;
        this._notifySelect();
        this._render();

        try {
            const entries = await this._list(normalizedDirPath, 0);
            if (this._destroyed || serial !== this._loadSerial) return;
            this._columns = [{ parentPath: normalizedDirPath, entries, selectedPath: null }];
        } catch {
            if (this._destroyed || serial !== this._loadSerial) return;
            this._columns = [{ parentPath: normalizedDirPath, entries: [], selectedPath: null }];
        }

        this._render(0);
    }

    async setRootEntry(entry: FSEntry): Promise<void> {
        if (this._destroyed) return;

        const serial = ++this._loadSerial;
        const rootEntry = {
            ...entry,
            path: normalizePath(entry.path),
            isDirectory: true
        };
        this._columns = [];
        this._columnScrollTops.clear();
        this._selectedPath = rootEntry.path;
        this._notifySelect();
        this._render();

        try {
            const entries = await this._list(rootEntry.path, 1);
            if (this._destroyed || serial !== this._loadSerial) return;
            this._columns = [
                { parentPath: rootEntry.path, entries: [rootEntry], selectedPath: rootEntry.path },
                { parentPath: rootEntry.path, entries, selectedPath: null }
            ];
        } catch {
            if (this._destroyed || serial !== this._loadSerial) return;
            this._columns = [{ parentPath: rootEntry.path, entries: [rootEntry], selectedPath: rootEntry.path }];
        }

        this._render(0, rootEntry.path, 0);
    }

    async setRootEntryAndExpandTo(entry: FSEntry, targetPath: string): Promise<void> {
        if (this._destroyed) return;

        const serial = ++this._loadSerial;
        const rootEntry = {
            ...entry,
            path: normalizePath(entry.path),
            isDirectory: true
        };
        const normalizedTarget = normalizePath(targetPath);
        const chain = buildExpansionChain(rootEntry.path, normalizedTarget);
        this._columns = [];
        this._columnScrollTops.clear();
        this._selectedPath = rootEntry.path;
        this._notifySelect();
        this._render();

        try {
            const rootChildren = await this._list(rootEntry.path, 1);
            if (this._destroyed || serial !== this._loadSerial) return;

            this._columns = [
                { parentPath: rootEntry.path, entries: [rootEntry], selectedPath: rootEntry.path },
                { parentPath: rootEntry.path, entries: rootChildren, selectedPath: null }
            ];

            if (chain.length === 0) {
                this._selectedPath = rootEntry.path;
                this._notifySelect();
                this._render(0, rootEntry.path, 0);
                return;
            }

            for (let idx = 0; idx < chain.length; idx++) {
                const selectedPath = chain[idx];
                const columnIndex = idx + 1;
                const column = this._columns[columnIndex];
                if (!column) break;

                column.selectedPath = selectedPath;
                this._selectedPath = selectedPath;
                if (idx === chain.length - 1) {
                    this._notifySelect();
                    this._render(columnIndex, selectedPath, columnIndex);
                    return;
                }

                const children = await this._list(selectedPath, columnIndex + 1);
                if (this._destroyed || serial !== this._loadSerial) return;

                this._columns = this._columns.slice(0, columnIndex + 1);
                this._columns.push({ parentPath: selectedPath, entries: children, selectedPath: null });
            }
        } catch {
            if (this._destroyed || serial !== this._loadSerial) return;
        }

        this._notifySelect();
        this._render(this._columns.length - 1);
    }

    async setRootAndExpandTo(rootPath: string, targetPath: string): Promise<void> {
        if (this._destroyed) return;

        const serial = ++this._loadSerial;
        const normalizedRoot = normalizePath(rootPath);
        const normalizedTarget = normalizePath(targetPath);
        const chain = buildExpansionChain(normalizedRoot, normalizedTarget);
        this._columns = [];
        this._columnScrollTops.clear();
        this._selectedPath = null;
        this._notifySelect();
        this._render();

        try {
            const rootEntries = await this._list(normalizedRoot, 0);
            if (this._destroyed || serial !== this._loadSerial) return;

            this._columns = [{ parentPath: normalizedRoot, entries: rootEntries, selectedPath: null }];
            if (chain.length === 0) {
                this._render(0);
                return;
            }

            for (let idx = 0; idx < chain.length; idx++) {
                const selectedPath = chain[idx];
                const column = this._columns[idx];
                if (!column) break;

                column.selectedPath = selectedPath;
                this._selectedPath = selectedPath;
                if (idx === chain.length - 1) {
                    this._notifySelect();
                    this._render(idx);
                    return;
                }

                const children = await this._list(selectedPath, idx + 1);
                if (this._destroyed || serial !== this._loadSerial) return;

                this._columns = this._columns.slice(0, idx + 1);
                this._columns.push({ parentPath: selectedPath, entries: children, selectedPath: null });
            }
        } catch {
            if (this._destroyed || serial !== this._loadSerial) return;
        }

        this._notifySelect();
        this._render(this._columns.length - 1);
    }

    refreshCheckboxes(): void {
        if (this._destroyed) return;

        this.element.querySelectorAll<HTMLElement>('.fs-tree-row[data-path]').forEach((row) => {
            const path = row.dataset.path;
            const checkbox = row.querySelector<HTMLElement>('.fs-tree-checkbox');
            if (!path || !checkbox) return;

            this._applyRowVisual(row, checkbox, path);
        });
    }

    private _notifySelect(): void {
        this._opts.onSelect?.(this._selectedPath);
    }

    private async _list(dirPath: string, columnIdx?: number): Promise<FSEntry[]> {
        void columnIdx;
        const opts = isDriveRootPath(dirPath) ? {} : { includeFiles: false };
        const entries = await this._opts.listDirectory(dirPath, opts);
        return directoriesOnly(entries) as FSEntry[];
    }

    private _bindResize(): void {
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                if (!this._destroyed) this._applyColumnLayout();
            });
            this._resizeObserver.observe(this.element);
            return;
        }

        this._resizeHandler = () => {
            if (!this._destroyed) this._applyColumnLayout();
        };
        window.addEventListener('resize', this._resizeHandler);
    }

    private _getColumnScrollKey(column: Column, colIdx: number): string {
        return `${colIdx}:${column.parentPath}`;
    }

    private _rememberColumnScrollTops(): void {
        this.element.querySelectorAll<HTMLElement>('.fs-tree-col').forEach((el) => {
            const colIdx = Number(el.dataset.colIdx);
            const column = this._columns[colIdx];
            const scrollTop = Number(el.scrollTop);
            if (!column || !Number.isFinite(scrollTop)) return;

            this._columnScrollTops.set(this._getColumnScrollKey(column, colIdx), scrollTop);
        });
    }

    private _restoreColumnScrollTops(): void {
        this.element.querySelectorAll<HTMLElement>('.fs-tree-col').forEach((el) => {
            const colIdx = Number(el.dataset.colIdx);
            const column = this._columns[colIdx];
            if (!column) return;

            const scrollTop = this._columnScrollTops.get(this._getColumnScrollKey(column, colIdx));
            if (scrollTop !== undefined) {
                el.scrollTop = scrollTop;
            }
        });
    }

    private _findRowByPath(path: string): HTMLElement | null {
        for (const row of Array.from(this.element.querySelectorAll<HTMLElement>('.fs-tree-row[data-path]'))) {
            if (row.dataset.path === path) {
                return row;
            }
        }

        return null;
    }

    private _ensurePathVisible(path: string | null | undefined): void {
        if (!path) return;

        const row = this._findRowByPath(path);
        if (typeof row?.scrollIntoView === 'function') {
            row.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        }
    }

    private _ensureColumnVisible(colIdx: number | undefined): void {
        if (colIdx === undefined) return;

        const column = this.element.querySelector<HTMLElement>(`.fs-tree-col[data-col-idx="${colIdx}"]`);
        if (!column) return;

        const containerWidth = this.element.clientWidth || this.element.getBoundingClientRect().width;
        const columnWidth = column.offsetWidth || column.getBoundingClientRect().width;
        if (containerWidth <= 0 || columnWidth <= 0) return;

        const columnRight = column.offsetLeft + columnWidth;
        const maxScrollLeft = Math.max(0, (this.element.scrollWidth || columnRight) - containerWidth);
        this.element.scrollLeft = Math.max(0, Math.min(maxScrollLeft, columnRight - containerWidth));
    }

    private _refreshColumnSelection(colIdx: number): void {
        const column = this._columns[colIdx];
        if (!column) return;

        this.element.querySelectorAll<HTMLElement>(`.fs-tree-row[data-col="${colIdx}"]`).forEach((row) => {
            row.classList.toggle('selected', row.dataset.path === column.selectedPath);
        });
    }

    private _trimRenderedColumns(): void {
        this.element.querySelectorAll<HTMLElement>('.fs-tree-col').forEach((el) => {
            const colIdx = Number(el.dataset.colIdx);
            if (Number.isFinite(colIdx) && colIdx >= this._columns.length) {
                el.remove();
            }
        });
    }

    private _injectStyle(): void {
        if (document.querySelector('#filemgr-tree-checks-style')) return;

        const style = document.createElement('style');
        style.id = 'filemgr-tree-checks-style';
        style.textContent = `
.fs-tree {
    display: flex;
    --filemgr-tree-warning: #f59e0b;
    border: 1px solid var(--od-border);
    border-radius: 8px;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--od-bg-muted);
    position: relative;
}
.fs-tree::-webkit-scrollbar { height: 6px; }
.fs-tree::-webkit-scrollbar-track { background: transparent; }
.fs-tree::-webkit-scrollbar-thumb { background: var(--od-border-strong); border-radius: 3px; }
.fs-tree::-webkit-scrollbar-thumb:hover { background: var(--od-text-disabled); }

.fs-tree-col {
    min-width: ${MIN_STRETCH_COLUMN_WIDTH}px;
    border-right: 1px solid var(--od-border);
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--od-bg-elevated);
    height: 100%;
    box-sizing: border-box;
}
.fs-tree-col:last-child { border-right: none; }
.fs-tree-col::-webkit-scrollbar { width: 5px; }
.fs-tree-col::-webkit-scrollbar-track { background: transparent; }
.fs-tree-col::-webkit-scrollbar-thumb { background: var(--od-border-strong); border-radius: 3px; }
.fs-tree-col::-webkit-scrollbar-thumb:hover { background: var(--od-text-disabled); }
.fs-tree-col-enter {
    animation: fs-tree-col-fade ${COLUMN_FADE_MS}ms ease-out both;
}
@keyframes fs-tree-col-fade {
    from { opacity: 0; }
    to { opacity: 1; }
}

.fs-tree-row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 30px;
    padding: 5px 9px;
    border: none;
    background: none;
    color: var(--od-text);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    transition: background 0.1s, color 0.1s;
}
.fs-tree-row:hover { background: var(--od-bg-muted); }
.fs-tree-row.selected {
    background: color-mix(in srgb, var(--od-accent) 14%, var(--od-bg-elevated));
    color: var(--od-accent);
}
.fs-tree-row[data-is-drive="1"] { font-weight: 500; }
.fs-tree-row.system-skip,
.fs-tree-row.unavailable {
    opacity: 0.45;
}
.fs-tree-row.system-skip:hover,
.fs-tree-row.unavailable:hover {
    background: transparent;
}
.fs-tree-checkbox {
    width: 13px;
    height: 13px;
    flex: 0 0 13px;
    border: 1px solid var(--od-border-strong);
    border-radius: 3px;
    background: var(--od-bg-elevated);
    box-sizing: border-box;
    color: #fff;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    line-height: 1;
}
.fs-tree-checkbox.empty { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--od-bg-elevated) 60%, transparent); }
.fs-tree-checkbox.checked {
    background: var(--od-accent);
    border-color: var(--od-accent);
}
.fs-tree-checkbox.indeterminate {
    background: var(--filemgr-tree-warning);
    border-color: var(--filemgr-tree-warning);
}
.fs-tree-checkbox.system-skip,
.fs-tree-checkbox.unavailable {
    background: var(--od-bg-muted);
    border-color: var(--od-border-strong);
    color: var(--od-text-disabled);
    cursor: not-allowed;
}
.fs-tree-checkbox.unavailable { border-style: dashed; }
.fs-tree-icon {
    width: 14px;
    flex: 0 0 14px;
    color: var(--od-text-muted);
    font-size: 12px;
    text-align: center;
}
.fs-tree-row.selected .fs-tree-icon { color: var(--od-accent); }
.fs-tree-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.fs-tree-chevron {
    flex: 0 0 auto;
    color: var(--od-text-disabled);
    font-size: 9px;
}
.fs-tree-row.selected .fs-tree-chevron { color: var(--od-accent); }
.fs-tree-empty {
    padding: 12px;
    font-size: 11px;
    color: var(--od-text-disabled);
    text-align: center;
}
`;
        document.head.appendChild(style);
    }

    private _render(newColumnIndex?: number, focusPath?: string | null, revealColumnIndex = newColumnIndex): void {
        if (this._destroyed) return;

        this._rememberColumnScrollTops();

        this.element.innerHTML = '';
        for (let colIdx = 0; colIdx < this._columns.length; colIdx++) {
            const col = this._columns[colIdx];
            const colEl = document.createElement('div');
            colEl.className = 'fs-tree-col';
            if (newColumnIndex !== undefined && colIdx === newColumnIndex) {
                colEl.classList.add('fs-tree-col-enter');
            }
            colEl.dataset.colIdx = String(colIdx);
            colEl.addEventListener('scroll', () => {
                this._columnScrollTops.set(this._getColumnScrollKey(col, colIdx), colEl.scrollTop);
            });

            if (col.entries.length === 0) {
                const emptyText = isDriveRootPath(col.parentPath) ? '未检测到磁盘' : '空目录';
                const emptyEl = document.createElement('div');
                emptyEl.className = 'fs-tree-empty';
                emptyEl.textContent = emptyText;
                colEl.appendChild(emptyEl);
            } else {
                for (const entry of col.entries) {
                    colEl.appendChild(this._buildRow(entry, colIdx));
                }
            }

            this.element.appendChild(colEl);
        }

        if (this._layoutFrame !== null) {
            cancelAnimationFrame(this._layoutFrame);
            this._layoutFrame = null;
        }

        this._restoreColumnScrollTops();
        this._ensurePathVisible(focusPath);
        this._layoutFrame = requestAnimationFrame(() => {
            this._layoutFrame = null;
            if (this._destroyed) return;

            this._applyColumnLayout();
            this._restoreColumnScrollTops();
            this._ensureColumnVisible(revealColumnIndex);
            this._ensurePathVisible(focusPath);
        });
    }

    private _buildRow(entry: FSEntry, colIdx: number): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fs-tree-row';
        const col = this._columns[colIdx];
        if (entry.path === col?.selectedPath) btn.classList.add('selected');
        btn.dataset.path = entry.path;
        btn.dataset.col = String(colIdx);
        if (entry.isDrive) btn.dataset.isDrive = '1';

        const checkbox = document.createElement('span');
        checkbox.dataset.path = entry.path;
        checkbox.setAttribute('role', 'checkbox');
        this._applyRowVisual(btn, checkbox, entry.path);

        const icon = document.createElement('i');
        icon.className = `fa-solid ${entry.isDrive ? 'fa-hard-drive' : 'fa-folder'} fs-tree-icon`;
        icon.setAttribute('aria-hidden', 'true');

        const name = document.createElement('span');
        name.className = 'fs-tree-name';
        name.textContent = entry.name;

        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-right fs-tree-chevron';
        chevron.setAttribute('aria-hidden', 'true');

        btn.append(checkbox, icon, name, chevron);
        checkbox.addEventListener('click', (event) => {
            event.stopPropagation();
            this._onCheckboxClick(entry.path);
        });
        btn.addEventListener('click', () => {
            this._onDirectoryClick(colIdx, entry.path);
        });

        return btn;
    }

    private _getEntries(): unknown[] {
        return this._opts.getEntries?.() ?? [];
    }

    private _getVisualContext(): Record<string, unknown> {
        const context = this._opts.getVisualContext?.() ?? {};
        const optionChildrenByPath =
            typeof context.childrenByPath === 'object' && context.childrenByPath !== null ? context.childrenByPath : {};

        return {
            ...context,
            childrenByPath: {
                ...this._getRenderedChildrenByPath(),
                ...optionChildrenByPath
            }
        };
    }

    private _computeVisual(path: string): CheckboxVisual {
        return computeVisual(path, this._getEntries(), this._getVisualContext()) as CheckboxVisual;
    }

    private _getRenderedChildrenByPath(): Record<string, string[]> {
        return this._columns.reduce<Record<string, string[]>>((childrenByPath, column) => {
            childrenByPath[column.parentPath] = column.entries.map((entry) => entry.name);
            return childrenByPath;
        }, {});
    }

    private _applyRowVisual(row: HTMLElement, checkbox: HTMLElement, path: string): void {
        const visual = this._computeVisual(path);
        row.classList.toggle('system-skip', visual.state === 'system-skip');
        row.classList.toggle('unavailable', visual.state === 'unavailable');
        this._applyVisualToCheckbox(checkbox, visual);
    }

    private _applyVisualToCheckbox(checkbox: HTMLElement, visual: CheckboxVisual): void {
        checkbox.className = `fs-tree-checkbox ${visual.state}`;
        checkbox.dataset.state = visual.state;
        checkbox.dataset.cause = visual.cause ?? '';
        checkbox.setAttribute(
            'aria-checked',
            visual.state === 'indeterminate' ? 'mixed' : String(visual.state === 'checked')
        );
        checkbox.setAttribute(
            'aria-disabled',
            String(visual.state === 'system-skip' || visual.state === 'unavailable')
        );
        checkbox.removeAttribute('title');

        if (visual.state === 'checked') {
            checkbox.textContent = '✓';
        } else if (visual.state === 'indeterminate') {
            checkbox.textContent = '−';
        } else if (visual.state === 'system-skip') {
            checkbox.textContent = '×';
        } else if (visual.state === 'unavailable') {
            checkbox.textContent = '!';
        } else {
            checkbox.textContent = '';
        }
    }

    private _onCheckboxClick(path: string): void {
        const result = applyClick(path, this._getEntries(), this._getVisualContext());
        if (!isCheckboxClickResult(result)) return;

        if (result.action === 'commit') {
            this._opts.onCommit?.({ path, result });
            if (result.toast) {
                this._opts.onToast?.({ path, result, toast: result.toast });
            }
            return;
        }

        if (result.action === 'showModal') {
            this._opts.onShowModal?.({ path, result });
            return;
        }

        if (result.action === 'protectedWorkspace') {
            this._opts.onShowModal?.({ path, result });
        }
    }

    private async _onDirectoryClick(colIdx: number, dirPath: string): Promise<void> {
        if (this._destroyed || !this._columns[colIdx]) return;

        const serial = ++this._loadSerial;
        const hadChildColumn = this._columns.length > colIdx + 1;
        this._columns = this._columns.slice(0, hadChildColumn ? colIdx + 2 : colIdx + 1);
        this._columns[colIdx].selectedPath = dirPath;
        this._selectedPath = dirPath;
        this._notifySelect();
        this._trimRenderedColumns();
        this._refreshColumnSelection(colIdx);
        this._ensurePathVisible(dirPath);

        try {
            const children = await this._list(dirPath, colIdx + 1);
            if (this._destroyed || serial !== this._loadSerial) return;
            this._columns = this._columns.slice(0, colIdx + 1);
            if (children.length > 0) {
                const newIdx = this._columns.length;
                this._columns.push({ parentPath: dirPath, entries: children, selectedPath: null });
                this._render(hadChildColumn ? undefined : newIdx, null, newIdx);
            } else {
                this._render(undefined, dirPath);
            }
        } catch {
            if (this._destroyed || serial !== this._loadSerial) return;
            this._columns = this._columns.slice(0, colIdx + 1);
            this._render(undefined, dirPath);
        }
    }

    private _applyColumnLayout(): void {
        if (this._destroyed) return;

        const colEls = Array.from(this.element.querySelectorAll('.fs-tree-col')) as HTMLElement[];
        if (colEls.length === 0) return;

        const containerWidth = this.element.clientWidth || this.element.getBoundingClientRect().width;
        const stretchCapacity = Math.max(1, Math.floor(containerWidth / MIN_STRETCH_COLUMN_WIDTH));
        const shouldStretch = colEls.length <= stretchCapacity;

        for (const colEl of colEls) {
            if (shouldStretch) {
                colEl.style.flex = '1 1 0';
                colEl.style.minWidth = `${MIN_STRETCH_COLUMN_WIDTH}px`;
                colEl.style.maxWidth = 'none';
            } else {
                colEl.style.flex = `0 0 ${FIXED_COLUMN_WIDTH}px`;
                colEl.style.minWidth = `${FIXED_COLUMN_WIDTH}px`;
                colEl.style.maxWidth = `${FIXED_COLUMN_WIDTH}px`;
            }
        }
    }
}
