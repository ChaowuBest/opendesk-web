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

import { type Component, Box, Text, SelectList, matchesKey } from '@mariozechner/pi-tui';
import { defaultSelectListTheme } from '../theme';
import { OpenDeskTUI } from '../entry';
import { SelectTable, type SelectRow } from './selecttable';
import { MemoryRegistry } from '../../aikernel/memory/registry';
import { MEMORY_CATEGORY_LABELS, type MemoryScope, type MemoryMeta } from '../../aikernel/memory/common';

import chalk from 'chalk';

type FilterMode = 'all' | 'global' | 'workspace';

const FILTER_LABELS: Record<FilterMode, string> = {
    all: '全部',
    global: '全局',
    workspace: '工作区'
};

const FILTER_CYCLE: FilterMode[] = ['all', 'workspace', 'global'];

export class MemoryListOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private container: Box;
    private header: Text;
    private table: SelectTable;
    private previewText: Text;
    private separator: Text;
    private filterMode: FilterMode = 'all';
    private allMemories: { scope: MemoryScope; meta: MemoryMeta }[] = [];
    private filteredMemories: { scope: MemoryScope; meta: MemoryMeta }[] = [];
    private hideHandle?: { hide: () => void };

    static async create(openDeskTUI: OpenDeskTUI): Promise<MemoryListOverlay> {
        const view = new MemoryListOverlay(openDeskTUI);
        await view.loadMemories();
        view.applyFilter();
        return view;
    }

    private constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;

        this.header = new Text(this.buildHeaderText());
        this.separator = new Text(chalk.dim('─'.repeat(60)));
        this.previewText = new Text(chalk.dim('  选择一条记忆以预览内容'));

        const rows = this.buildRows();
        this.table = new SelectTable(rows, Math.max(Math.min(rows.length, 12), 3), defaultSelectListTheme);
        this.table.setColumnStrechFactors([0, 1, 0, 0]);
        this.table.setAlignments(['left', 'left', 'left', 'right']);

        this.container = new Box(1, 1);
        this.container.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.container.addChild(this.header);
        this.container.addChild(this.table);
        this.container.addChild(this.separator);
        this.container.addChild(this.previewText);

        this.setupSelectionTracking();
    }

    private async loadMemories() {
        const registry = MemoryRegistry.getInstance();
        this.allMemories = await registry.listAllMemories();
    }

    private applyFilter() {
        if (this.filterMode === 'all') {
            this.filteredMemories = [...this.allMemories];
        } else {
            this.filteredMemories = this.allMemories.filter((m) => m.scope === this.filterMode);
        }
    }

    private buildHeaderText(): string {
        const tabs = FILTER_CYCLE.map((mode) => {
            const label = FILTER_LABELS[mode];
            if (mode === this.filterMode) {
                return chalk.bgHex('#4a6fa5').white.bold(` ${label} `);
            }
            return chalk.dim(` ${label} `);
        }).join(chalk.dim('│'));

        return chalk.bold('🧠 记忆管理') + '  ' + tabs + '  ' + chalk.dim('[Tab 切换]');
    }

    private buildRows(): SelectRow[] {
        if (this.filteredMemories.length === 0) {
            return [
                {
                    labels: ['', '暂无记忆', '', ''],
                    value: '__empty__'
                }
            ];
        }

        return this.filteredMemories.map(({ scope, meta }) => {
            const scopeIcon = scope === 'global' ? '🌍' : '📂';
            const categoryLabel = MEMORY_CATEGORY_LABELS[meta.category] || meta.category;
            const dateStr = this.formatDate(meta.updated_at);

            return {
                labels: [scopeIcon, meta.name, categoryLabel, dateStr],
                value: meta.uid
            };
        });
    }

    private formatDate(isoDate: string): string {
        try {
            const d = new Date(isoDate);
            const now = new Date();
            const diffMs = now.getTime() - d.getTime();
            const diffMinutes = Math.floor(diffMs / (1000 * 60));

            if (diffMinutes < 60) return `${diffMinutes}分钟前`;
            const diffHours = Math.floor(diffMinutes / 60);
            if (diffHours < 24) return `${diffHours}小时前`;
            const diffDays = Math.floor(diffHours / 24);
            if (diffDays < 30) return `${diffDays}天前`;

            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${d.getFullYear()}-${month}-${day}`;
        } catch {
            return '';
        }
    }

    private setupSelectionTracking() {
        this.table.innerList.onSelectionChange = (item) => {
            if (item && item.value !== '__empty__') {
                this.updatePreview(item.value);
            } else {
                this.previewText.setText(chalk.dim('  选择一条记忆以预览内容'));
            }
        };

        // Show preview for the first item
        if (this.filteredMemories.length > 0) {
            this.updatePreview(this.filteredMemories[0].meta.uid);
        }
    }

    private async updatePreview(uid: string) {
        const registry = MemoryRegistry.getInstance();
        const memory = await registry.getMemory(uid);
        if (!memory) {
            this.previewText.setText(chalk.dim('  无法加载记忆内容'));
            return;
        }

        const { meta, content, scope } = memory;
        const lines: string[] = [];

        const scopeLabel = scope === 'global' ? '🌍 全局' : '📂 工作区';
        const categoryLabel = MEMORY_CATEGORY_LABELS[meta.category] || meta.category;

        lines.push(chalk.bold.cyan(`  ${meta.name}`));
        lines.push(chalk.dim(`  ${scopeLabel} · ${categoryLabel} · 关键词: ${meta.keywords.join(', ')}`));
        if (meta.summary) {
            lines.push(chalk.dim(`  摘要: ${meta.summary}`));
        }
        lines.push('');

        const contentLines = content.split('\n');
        const maxPreviewLines = 8;
        const previewLines = contentLines.slice(0, maxPreviewLines);
        for (const line of previewLines) {
            lines.push('  ' + line);
        }
        if (contentLines.length > maxPreviewLines) {
            lines.push(chalk.dim(`  ... 还有 ${contentLines.length - maxPreviewLines} 行`));
        }

        this.previewText.setText(lines.join('\n'));
    }

    private rebuildTable() {
        this.applyFilter();
        this.header.setText(this.buildHeaderText());

        const rows = this.buildRows();
        this.table.innerRows = rows.map((row) => ({ ...row, label: '' }));
        this.table.innerList = new SelectList(
            this.table.innerRows,
            Math.max(Math.min(rows.length, 12), 3),
            defaultSelectListTheme
        );

        this.table.innerList.onSelect = (item) => {
            this.table.onSelect?.(item.value);
        };
        this.table.innerList.onCancel = () => {
            this.table.onCancel?.();
        };

        this.setupSelectionTracking();

        // Force column width recalculation
        (this.table as any).lastWidth = 0;
    }

    private cycleFilter() {
        const currentIdx = FILTER_CYCLE.indexOf(this.filterMode);
        this.filterMode = FILTER_CYCLE[(currentIdx + 1) % FILTER_CYCLE.length];
        this.rebuildTable();
    }

    // ─── Component interface ──────────────────────────

    invalidate(): void {
        this.container.invalidate();
    }

    render(width: number): string[] {
        // Update separator to match width
        const sepWidth = Math.max(1, width - 4);
        this.separator.setText(chalk.dim('─'.repeat(sepWidth)));
        return this.container.render(width);
    }

    handleInput(keyData: string): void {
        if (matchesKey(keyData, 'tab')) {
            this.cycleFilter();
            return;
        }
        if (matchesKey(keyData, 'escape')) {
            this.close();
            return;
        }
        if (matchesKey(keyData, 'enter')) {
            const selected = this.table.innerList.getSelectedItem();
            if (selected && selected.value !== '__empty__') {
                this.close();
            }
            return;
        }
        // Forward all other input (up/down/etc.) to the table
        this.table.handleInput(keyData);
    }

    // ─── Show / Close ──────────────────────────────────

    show() {
        const handle = this.openDeskTUI.tui.showOverlay(this, {
            width: '90%',
            maxHeight: '85%',
            anchor: 'center'
        });
        this.hideHandle = handle;
        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this);
    }

    private close() {
        if (this.hideHandle) {
            this.hideHandle.hide();
        }
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }
}
