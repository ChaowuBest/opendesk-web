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
 * macOS NSBrowser 风格的列视图文件/目录浏览器组件。
 *
 * 用法：
 *   const selector = new FileSelector({
 *       listDirectory: (path, opts) => window.workspaceAPI.listDirectory(path, opts),
 *       onSelect: (path) => { ... },
 *       directoryOnly: true,
 *   });
 *   container.appendChild(selector.element);
 *   selector.setRoot('/Users/liyi');
 */

export interface FSEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    isDrive?: boolean; // 新增：标记是否为盘符
    driveLetter?: string; // 新增：盘符字母（如 'C'）
    size?: number; // 新增：总容量（字节）
    free?: number; // 新增：可用空间（字节）
}

export interface FileSelectorOptions {
    /** 获取指定目录下的条目列表 */
    listDirectory: (dirPath: string, opts?: { includeFiles?: boolean; extensions?: string[] }) => Promise<FSEntry[]>;
    /** 当用户选中某个条目时回调 */
    onSelect?: (path: string | null) => void;
    /** 浏览器区域高度（CSS 值），默认 '260px' */
    height?: string;
    /** 仅显示目录（默认 true） */
    directoryOnly?: boolean;
    /** 当 directoryOnly=false 时，仅显示这些扩展名的文件（如 ['.ts', '.js']） */
    extensions?: string[];
    /** 重命名回调（可选，提供后右键菜单才出现重命名） */
    renameEntry?: (oldPath: string, newName: string) => Promise<string>;
    /** 新建文件夹回调（可选，提供后右键菜单才出现新建文件夹） */
    createDirectory?: (parentPath: string, dirName: string) => Promise<string>;
    /** 删除回调（可选，提供后右键菜单才出现删除） */
    deleteEntry?: (entryPath: string) => Promise<void>;
    /** 删除确认弹窗（可选，提供后删除前会先弹窗确认） */
    confirmDelete?: (name: string) => Promise<boolean>;
}

interface Column {
    parentPath: string;
    entries: FSEntry[];
    selectedPath: string | null;
}

const COLUMN_SLIDE_MS = 220;

export class FileSelector {
    readonly element: HTMLDivElement;
    private _columns: Column[] = [];
    private _selectedPath: string | null = null;
    private _opts: FileSelectorOptions;
    private _styleInjected = false;
    private _contextMenu: HTMLDivElement | null = null;
    /** 正在进行 inline-edit 时锁定点击 */
    private _editing = false;
    /** 是否显示隐藏文件（. 开头） */
    private _showHidden = false;
    /** 当前根目录路径，用于切换显示隐藏后刷新 */
    private _rootPath = '';

    constructor(opts: FileSelectorOptions) {
        this._opts = opts;
        this.element = document.createElement('div');
        this.element.className = 'od-fsel';
        const h = opts.height ?? '260px';
        if (h === '100%') {
            this.element.style.flex = '1';
            this.element.style.minHeight = '0';
        } else {
            this.element.style.height = h;
        }
        this._injectStyle();
        this._render();

        // 点击其它区域关闭右键菜单
        this._onDocClick = this._onDocClick.bind(this);
        document.addEventListener('click', this._onDocClick, true);
    }

    get selectedPath(): string | null {
        return this._selectedPath;
    }

    /** 右键菜单是否处于打开状态 */
    get hasOpenMenu(): boolean {
        return this._contextMenu !== null;
    }

    /** 是否有内联编辑正在进行（重命名、新建文件夹等） */
    get isEditing(): boolean {
        return this._editing;
    }

    /** 关闭右键菜单（供外部调用，如拦截 Esc 键） */
    dismissMenu(): void {
        this._dismissMenu();
    }

    destroy(): void {
        document.removeEventListener('click', this._onDocClick, true);
        this._dismissMenu();
    }

    async setRoot(dirPath: string): Promise<void> {
        this._rootPath = dirPath;
        this._columns = [];
        this._selectedPath = null;
        this._notifySelect();
        try {
            const entries = await this._list(dirPath);
            this._columns = [{ parentPath: dirPath, entries, selectedPath: null }];
        } catch {
            this._columns = [{ parentPath: dirPath, entries: [], selectedPath: null }];
        }
        this._render();
    }

    /** 切换是否显示隐藏文件，并刷新目录列表 */
    async setShowHidden(show: boolean): Promise<void> {
        if (this._showHidden === show) return;
        this._showHidden = show;
        if (this._rootPath) {
            await this.setRoot(this._rootPath);
        }
    }

    /**
     * 导航到指定路径，展开沿途所有列并选中目标。
     * 支持虚拟根目录（{DRIVE_ROOT} / {OH_ROOT}）下的路径匹配。
     */
    async navigateToPath(targetPath: string, rootPath?: string): Promise<void> {
        const root = rootPath ?? this._rootPath;
        const normTarget = targetPath.replace(/\\/g, '/').replace(/\/+$/, '');
        const isVirtualRoot = root === '{DRIVE_ROOT}' || root === '{OH_ROOT}';

        // 重置到根目录
        this._rootPath = root;
        this._columns = [];
        this._selectedPath = null;
        try {
            const entries = await this._list(root);
            this._columns = [{ parentPath: root, entries, selectedPath: null }];
        } catch {
            this._columns = [{ parentPath: root, entries: [], selectedPath: null }];
            this._render();
            return;
        }

        if (!normTarget || normTarget === root) {
            this._render();
            return;
        }

        // 计算从根到目标的路径段
        let segments: string[] = [];
        if (!isVirtualRoot) {
            const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
            if (normTarget.startsWith(normRoot + '/')) {
                segments = normTarget
                    .substring(normRoot.length + 1)
                    .split('/')
                    .filter(Boolean);
            } else if (normTarget !== normRoot) {
                // 目标不在根目录下，尝试以 / 为根重新加载
                this._rootPath = '/';
                try {
                    const rootEntries = await this._list('/');
                    this._columns = [{ parentPath: '/', entries: rootEntries, selectedPath: null }];
                } catch {
                    this._render();
                    return;
                }
                segments = normTarget.split('/').filter(Boolean);
            }
        }

        // 逐层展开
        let colIdx = 0;
        while (colIdx < this._columns.length) {
            const col = this._columns[colIdx];
            let entry: FSEntry | undefined;

            if (segments.length > 0) {
                entry = col.entries.find((e) => e.name === segments[0] && e.isDirectory);
                if (entry) segments.shift();
            } else if (isVirtualRoot && colIdx === 0) {
                // 虚拟根目录：按路径前缀匹配
                entry = col.entries.find((e) => {
                    const ePath = e.path.replace(/\\/g, '/').replace(/\/+$/, '');
                    return normTarget === ePath || normTarget.startsWith(ePath + '/');
                });
                if (entry) {
                    const ePath = entry.path.replace(/\\/g, '/').replace(/\/+$/, '');
                    if (normTarget.startsWith(ePath + '/')) {
                        segments = normTarget
                            .substring(ePath.length + 1)
                            .split('/')
                            .filter(Boolean);
                    }
                }
            }

            if (!entry) break;

            col.selectedPath = entry.path;
            this._selectedPath = entry.path;

            try {
                const children = await this._list(entry.path);
                if (children.length > 0) {
                    this._columns.push({ parentPath: entry.path, entries: children, selectedPath: null });
                }
            } catch {
                break;
            }
            colIdx++;
        }

        this._notifySelect();
        this._render();

        // 将各列的选中项竖直滚动到可见区域
        requestAnimationFrame(() => {
            this.element.querySelectorAll('.od-fscol').forEach((colEl) => {
                const selected = colEl.querySelector('.od-fsitem.selected') as HTMLElement | null;
                if (!selected) return;
                const colRect = (colEl as HTMLElement).getBoundingClientRect();
                const itemRect = selected.getBoundingClientRect();
                if (itemRect.top < colRect.top) {
                    (colEl as HTMLElement).scrollTop -= colRect.top - itemRect.top;
                } else if (itemRect.bottom > colRect.bottom) {
                    (colEl as HTMLElement).scrollTop += itemRect.bottom - colRect.bottom;
                }
            });
        });
    }

    /* ───────── helpers ───────── */

    private _notifySelect(): void {
        this._opts.onSelect?.(this._selectedPath);
    }

    private _list(dirPath: string): Promise<FSEntry[]> {
        // 虚拟根目录不需要 includeFiles 参数
        if (dirPath === '{DRIVE_ROOT}' || dirPath === '{OH_ROOT}') {
            return this._opts.listDirectory(dirPath, { showHidden: this._showHidden });
        }
        const dirOnly = this._opts.directoryOnly !== false;
        return this._opts.listDirectory(dirPath, {
            includeFiles: !dirOnly,
            extensions: this._opts.extensions,
            showHidden: this._showHidden
        });
    }

    /* ───────── styles ───────── */

    private _injectStyle(): void {
        if (this._styleInjected) return;
        if (document.querySelector('#od-fsel-style')) {
            this._styleInjected = true;
            return;
        }
        const style = document.createElement('style');
        style.id = 'od-fsel-style';
        style.textContent = `
.od-fsel {
    display: flex;
    border: 1px solid var(--od-border, #e5e7eb);
    border-radius: 10px;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--od-bg-muted, #fafafa);
    scroll-behavior: smooth;
    position: relative;
}
.od-fsel::-webkit-scrollbar { height: 6px; }
.od-fsel::-webkit-scrollbar-track { background: transparent; }
.od-fsel::-webkit-scrollbar-thumb { background: var(--od-text-disabled, #d1d5db); border-radius: 3px; }
.od-fsel::-webkit-scrollbar-thumb:hover { background: var(--od-text-muted, #9ca3af); }
/* Dark mode file selector scrollbar */
html[data-theme="dark"] .od-fsel::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18);
}
html[data-theme="dark"] .od-fsel::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.28);
}

.od-fscol {
    min-width: 190px; max-width: 220px; flex-shrink: 0;
    border-right: 1px solid var(--od-border, #e5e7eb);
    overflow-y: auto; overflow-x: hidden;
    background: var(--od-bg-elevated, #fff); height: 100%;
}
.od-fscol:last-child { border-right: none; }
.od-fscol::-webkit-scrollbar { width: 5px; }
.od-fscol::-webkit-scrollbar-track { background: transparent; }
.od-fscol::-webkit-scrollbar-thumb { background: var(--od-text-disabled, #d1d5db); border-radius: 3px; }
.od-fscol::-webkit-scrollbar-thumb:hover { background: var(--od-text-muted, #9ca3af); }
/* Dark mode file selector column scrollbar */
html[data-theme="dark"] .od-fscol::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18);
}
html[data-theme="dark"] .od-fscol::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.28);
}

/* 列动画 */
.od-fscol-enter {
    animation: od-fscol-in ${COLUMN_SLIDE_MS}ms cubic-bezier(0.25,0.46,0.45,0.94) forwards;
}
@keyframes od-fscol-in {
    from { opacity: 0; transform: translateX(40px); }
    to   { opacity: 1; transform: translateX(0); }
}
.od-fscol-exit {
    animation: od-fscol-out ${COLUMN_SLIDE_MS}ms cubic-bezier(0.55,0.06,0.68,0.19) forwards;
    pointer-events: none;
}
@keyframes od-fscol-out {
    from { opacity: 1; transform: translateX(0); min-width: 190px; }
    to   { opacity: 0; transform: translateX(30px); min-width: 0; max-width: 0; border-right-width: 0; padding: 0; overflow: hidden; }
}

/* 条目 */
.od-fsitem {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 10px; cursor: pointer; border: none; background: none;
    text-align: left; width: 100%; font-size: var(--fs-md); color: var(--od-text, #374151);
    transition: background 0.1s; font-family: inherit;
}
.od-fsitem:hover { background: var(--od-bg-subtle, #f3f4f6); }
.od-fsitem.selected { background: var(--od-accent, #3b82f6); color: #fff; }
.od-fsitem.selected .od-fsitem-chevron { color: #fff; }
.od-fsitem-icon { font-size: var(--fs-md); color: var(--od-text-muted, #6b7280); flex-shrink: 0; }
.od-fsitem.selected .od-fsitem-icon { color: #dbeafe; }
.od-fsitem[data-is-drive="1"] { font-weight: 500; }
.od-fsitem-size { flex-shrink: 0; margin-left: auto; }
.od-fsitem-name {
    flex: 1; min-width: 0; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
}
.od-fsitem[data-is-drive="1"] .od-fsitem-name {
    overflow: visible;
    text-overflow: clip;
}
.od-fsitem-chevron { font-size: var(--fs-2xs); color: var(--od-text-muted, #9ca3af); flex-shrink: 0; }
.od-fscol-empty { padding: 12px; font-size: var(--fs-sm); color: var(--od-text-disabled, #9ca3af); text-align: center; }

/* inline 编辑输入框 */
.od-fsitem-edit {
    flex: 1; min-width: 0; font-size: var(--fs-md); font-family: inherit;
    border: 1px solid var(--od-accent, #3b82f6); border-radius: 3px; outline: none;
    padding: 1px 4px; color: var(--od-text, #1f2937); background: var(--od-bg-elevated, #fff);
}
`;
        document.head.appendChild(style);
        this._styleInjected = true;
    }

    /* ───────── render ───────── */

    private _render(newColumnIndex?: number): void {
        const savedScrollTops: number[] = [];
        this.element.querySelectorAll('.od-fscol').forEach((el) => {
            savedScrollTops.push((el as HTMLElement).scrollTop);
        });

        this.element.innerHTML = '';
        for (let colIdx = 0; colIdx < this._columns.length; colIdx++) {
            const col = this._columns[colIdx];
            const colEl = document.createElement('div');
            colEl.className = 'od-fscol';
            if (newColumnIndex !== undefined && colIdx === newColumnIndex) {
                colEl.classList.add('od-fscol-enter');
            }
            colEl.dataset.colIdx = String(colIdx);

            if (col.entries.length === 0) {
                const emptyText = col.parentPath === '{DRIVE_ROOT}' ? '未检测到磁盘' : '空目录';
                colEl.innerHTML = `<div class="od-fscol-empty">${emptyText}</div>`;
            } else {
                for (const entry of col.entries) {
                    colEl.appendChild(this._buildItem(entry, colIdx));
                }
            }

            // 右键菜单（空白区域 → 新建文件夹）
            colEl.addEventListener('contextmenu', (e) => {
                if ((e.target as HTMLElement).closest('.od-fsitem')) return;
                e.preventDefault();
                this._showColumnContextMenu(e as MouseEvent, colIdx, col.parentPath);
            });

            this.element.appendChild(colEl);
        }

        requestAnimationFrame(() => {
            const colEls = this.element.querySelectorAll('.od-fscol');
            colEls.forEach((el, idx) => {
                if (idx < savedScrollTops.length) {
                    (el as HTMLElement).scrollTop = savedScrollTops[idx];
                }
            });
            this.element.scrollLeft = this.element.scrollWidth;
        });
    }

    private _buildItem(entry: FSEntry, colIdx: number): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = 'od-fsitem';
        const col = this._columns[colIdx];
        if (entry.path === col?.selectedPath) btn.classList.add('selected');
        btn.dataset.path = entry.path;
        btn.dataset.col = String(colIdx);
        btn.dataset.isDir = entry.isDirectory ? '1' : '0';
        if (entry.isDrive) btn.dataset.isDrive = '1';

        // 智能选择图标
        let iconCls = 'fa-file';
        if (entry.isDrive) {
            iconCls = 'fa-hard-drive'; // 盘符使用硬盘图标
        } else if (entry.isDirectory) {
            iconCls = 'fa-folder';
        }

        const chevron = entry.isDirectory ? '<i class="fa-solid fa-chevron-right od-fsitem-chevron"></i>' : '';
        const sizeInfo = entry.isDrive && entry.size ? this._formatDriveSize(entry) : '';

        btn.innerHTML = `<i class="fa-solid ${iconCls} od-fsitem-icon"></i><span class="od-fsitem-name">${entry.name}</span>${sizeInfo}${chevron}`;

        btn.addEventListener('click', () => {
            if (this._editing) return;
            if (entry.isDirectory) {
                this._onItemClick(colIdx, entry.path);
            } else {
                this._columns[colIdx].selectedPath = entry.path;
                this._selectedPath = entry.path;
                this._notifySelect();
                this._render();
            }
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._showItemContextMenu(e, entry, colIdx);
        });

        return btn;
    }

    /**
     * 格式化盘符容量信息显示
     */
    private _formatDriveSize(entry: FSEntry): string {
        if (!entry.size || entry.size === 0) return '';

        const gb = (bytes: number) => (bytes / (1024 * 1024 * 1024)).toFixed(1);
        const usedGB = gb(entry.size - (entry.free || 0));
        const totalGB = gb(entry.size);
        const usedPercent = Math.round(((entry.size - (entry.free || 0)) / entry.size) * 100);

        // 颜色标记：>80% 红色，>60% 橙色，否则灰色
        let color = '#9ca3af';
        if (usedPercent > 80) color = '#dc2626';
        else if (usedPercent > 60) color = '#f59e0b';

        return `<span class="od-fsitem-size" style="font-size: var(--fs-xs);color:${color};margin-left:4px;">${usedGB}/${totalGB}GB</span>`;
    }

    /* ───────── item click ───────── */

    private async _onItemClick(colIdx: number, dirPath: string): Promise<void> {
        // 已选中同一目录时无需重复展开
        if (this._columns[colIdx].selectedPath === dirPath) return;

        const columnsToRemove = this._columns.length - colIdx - 1;

        if (columnsToRemove > 0) {
            const colEls = this.element.querySelectorAll('.od-fscol');
            const exiting: HTMLElement[] = [];
            for (let i = colIdx + 1; i < colEls.length; i++) {
                const el = colEls[i] as HTMLElement;
                el.classList.add('od-fscol-exit');
                exiting.push(el);
            }
            const clickedCol = colEls[colIdx] as HTMLElement | undefined;
            if (clickedCol) {
                clickedCol.querySelectorAll('.od-fsitem').forEach((item) => {
                    const el = item as HTMLElement;
                    if (el.dataset.path === dirPath) el.classList.add('selected');
                    else el.classList.remove('selected');
                });
            }
            await new Promise<void>((res) => {
                if (exiting.length > 0) {
                    const last = exiting[exiting.length - 1];
                    last.addEventListener('animationend', () => res(), { once: true });
                    setTimeout(res, COLUMN_SLIDE_MS + 50);
                } else {
                    res();
                }
            });
        }

        this._columns = this._columns.slice(0, colIdx + 1);
        this._columns[colIdx].selectedPath = dirPath;
        this._selectedPath = dirPath;
        this._notifySelect();
        this._render();

        try {
            const children = await this._list(dirPath);
            if (children.length > 0) {
                const newIdx = this._columns.length;
                this._columns.push({ parentPath: dirPath, entries: children, selectedPath: null });
                this._render(newIdx);
            }
        } catch {
            /* _render() already called above, no need to re-render */
        }
    }

    /* ───────── context menu ───────── */

    private _onDocClick(): void {
        this._dismissMenu();
    }

    private _dismissMenu(): void {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
    }

    private _showItemContextMenu(e: MouseEvent, entry: FSEntry, colIdx: number): void {
        this._dismissMenu();
        const menu = this._createMenu(e.clientX, e.clientY);

        if (this._opts.renameEntry) {
            this._addMenuItem(menu, 'fa-pen', '重命名', () => {
                this._dismissMenu();
                this._startRename(entry, colIdx);
            });
        }

        if (entry.isDirectory && this._opts.createDirectory) {
            this._addMenuItem(menu, 'fa-folder-plus', '新建文件夹', () => {
                this._dismissMenu();
                this._startNewFolder(colIdx, entry.path);
            });
        }

        if (this._opts.deleteEntry) {
            this._addMenuItem(
                menu,
                'fa-trash',
                '删除',
                async () => {
                    this._dismissMenu();
                    await this._deleteEntry(entry, colIdx);
                },
                true
            );
        }

        if (menu.children.length === 0) {
            this._dismissMenu();
            return;
        }
        this._contextMenu = menu;
    }

    private _showColumnContextMenu(e: MouseEvent, colIdx: number, parentPath: string): void {
        this._dismissMenu();
        if (!this._opts.createDirectory) return;

        const menu = this._createMenu(e.clientX, e.clientY);
        this._addMenuItem(menu, 'fa-folder-plus', '新建文件夹', () => {
            this._dismissMenu();
            this._startNewFolder(colIdx, parentPath);
        });
        this._contextMenu = menu;
    }

    private _createMenu(x: number, y: number): HTMLDivElement {
        const menu = document.createElement('div');
        menu.className = 'ctx-menu';
        menu.style.minWidth = '140px';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        document.body.appendChild(menu);

        // 边界修正
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
            if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
        });
        return menu;
    }

    private _addMenuItem(menu: HTMLDivElement, icon: string, label: string, action: () => void, danger = false): void {
        const btn = document.createElement('button');
        btn.className = 'ctx-item' + (danger ? ' danger' : '');
        btn.innerHTML = `<span class="ctx-icon-sm"><i class="fa-solid ${icon}"></i></span><span class="ctx-label">${label}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            action();
        });
        menu.appendChild(btn);
    }

    /* ───────── delete ───────── */

    private async _deleteEntry(entry: FSEntry, colIdx: number): Promise<void> {
        if (this._opts.confirmDelete) {
            const confirmed = await this._opts.confirmDelete(entry.name);
            if (!confirmed) return;
        }
        try {
            await this._opts.deleteEntry!(entry.path);
            const col = this._columns[colIdx];
            col.entries = col.entries.filter((e) => e.path !== entry.path);
            // 如果删除的正好是选中项，清除选择及其后续列
            if (col.selectedPath === entry.path) {
                col.selectedPath = null;
                this._columns = this._columns.slice(0, colIdx + 1);
                if (this._selectedPath === entry.path) {
                    this._selectedPath = null;
                    this._notifySelect();
                }
            }
            this._render();
        } catch (err) {
            console.warn('Delete failed:', err);
        }
    }

    /* ───────── inline rename ───────── */

    private _startRename(entry: FSEntry, colIdx: number): void {
        const colEl = this.element.querySelector(`.od-fscol[data-col-idx="${colIdx}"]`) as HTMLElement | null;
        if (!colEl) return;
        const itemEl = colEl.querySelector(`.od-fsitem[data-path="${CSS.escape(entry.path)}"]`) as HTMLElement | null;
        if (!itemEl) return;

        this._editing = true;
        const nameSpan = itemEl.querySelector('.od-fsitem-name') as HTMLElement;
        const oldName = entry.name;

        const input = document.createElement('input');
        input.className = 'od-fsitem-edit';
        input.value = oldName;
        nameSpan.replaceWith(input);
        input.focus();
        // 选中名称（不含扩展名）
        const dotIdx = oldName.lastIndexOf('.');
        input.setSelectionRange(0, dotIdx > 0 ? dotIdx : oldName.length);

        const commit = async () => {
            const newName = input.value.trim();
            if (!newName || newName === oldName) {
                this._editing = false;
                this._render();
                return;
            }
            try {
                const newPath = await this._opts.renameEntry!(entry.path, newName);
                // 更新本列数据
                const col = this._columns[colIdx];
                const idx = col.entries.findIndex((e) => e.path === entry.path);
                if (idx >= 0) {
                    col.entries[idx] = { ...col.entries[idx], name: newName, path: newPath };
                    if (col.selectedPath === entry.path) col.selectedPath = newPath;
                }
                if (this._selectedPath === entry.path) {
                    this._selectedPath = newPath;
                    this._notifySelect();
                }
            } catch (err) {
                console.warn('Rename failed:', err);
            }
            this._editing = false;
            this._render();
        };

        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                input.blur();
            }
            if (e.key === 'Escape') {
                e.stopPropagation();
                input.removeEventListener('blur', commit);
                this._editing = false;
                this._render();
            }
        });
    }

    /* ───────── new folder ───────── */

    private async _startNewFolder(colIdx: number, parentPath: string): Promise<void> {
        // 先展开该目录（如果点的是某个目录条目的右键）
        const col = this._columns[colIdx];
        const isSelectedDir = col.selectedPath === parentPath;

        // 如果 parentPath 是一个条目而非列的 parentPath，需要先展开
        let targetColIdx = colIdx;
        if (parentPath !== col.parentPath) {
            // parentPath 是列内某个目录 → 先点击进入
            if (
                !isSelectedDir ||
                this._columns.length <= colIdx + 1 ||
                this._columns[colIdx + 1].parentPath !== parentPath
            ) {
                await this._onItemClick(colIdx, parentPath);
            }
            targetColIdx = colIdx + 1;
            if (targetColIdx >= this._columns.length) {
                // 空目录被展开后可能没有新列，手动创建
                this._columns.push({ parentPath, entries: [], selectedPath: null });
                this._render();
            }
        }

        // 在目标列末尾插入一个占位条目用于输入
        const targetCol = this._columns[targetColIdx];
        const colEl = this.element.querySelector(`.od-fscol[data-col-idx="${targetColIdx}"]`) as HTMLElement | null;
        if (!colEl) return;

        this._editing = true;

        // 创建占位行
        const placeholder = document.createElement('div');
        placeholder.className = 'od-fsitem';
        placeholder.style.cursor = 'default';
        const input = document.createElement('input');
        input.className = 'od-fsitem-edit';
        input.value = '';
        input.placeholder = '新建文件夹';
        placeholder.innerHTML = '<i class="fa-solid fa-folder od-fsitem-icon" style="color:#f59e0b"></i>';
        placeholder.appendChild(input);
        colEl.appendChild(placeholder);

        // 滚动到可见
        requestAnimationFrame(() => {
            placeholder.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            input.focus();
        });

        const commit = async () => {
            const dirName = input.value.trim();
            if (!dirName) {
                placeholder.remove();
                this._editing = false;
                return;
            }
            try {
                const newPath = await this._opts.createDirectory!(targetCol.parentPath, dirName);
                targetCol.entries.push({ name: dirName, path: newPath, isDirectory: true });
                targetCol.entries.sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
            } catch (err) {
                console.warn('Create directory failed:', err);
            }
            this._editing = false;
            this._render();
        };

        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                input.blur();
            }
            if (e.key === 'Escape') {
                e.stopPropagation();
                input.removeEventListener('blur', commit);
                placeholder.remove();
                this._editing = false;
            }
        });
    }
}
