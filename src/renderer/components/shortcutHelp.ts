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

import { guiShortcutManager } from './shortcutManager.ts';

class ShortcutHelpPanel extends HTMLElement {
    private backdrop: HTMLDivElement | null = null;
    private panel: HTMLDivElement | null = null;
    private _visible = false;

    connectedCallback() {
        this.style.display = 'none';
    }

    toggle() {
        if (this._visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    show() {
        if (this._visible) return;
        this._visible = true;
        this.style.display = '';
        this._render();
    }

    hide() {
        if (!this._visible) return;
        this._visible = false;
        if (this.panel) {
            this.panel.style.opacity = '0';
            this.panel.style.transform = 'translate(-50%, -50%) scale(0.96)';
        }
        if (this.backdrop) {
            this.backdrop.style.opacity = '0';
        }
        setTimeout(() => {
            this.innerHTML = '';
            this.style.display = 'none';
            this.backdrop = null;
            this.panel = null;
        }, 200);
    }

    private _render() {
        const grouped = guiShortcutManager.getGroupedByCategory();
        const categories = Array.from(grouped.entries());

        const colCount = Math.min(categories.length, 3);
        const columns: [string, (typeof categories)[0][1]][][] = Array.from({ length: colCount }, () => []);
        categories.forEach((cat, i) => {
            columns[i % colCount].push(cat);
        });

        const renderKey = (combo: string) => {
            const parts: string[] = [];
            let rest = combo;
            while (rest.length > 0) {
                const m = rest.match(/^([A-Za-z\u4e00-\u9fff]+)\+/);
                if (m) {
                    parts.push(m[1]);
                    rest = rest.slice(m[0].length);
                } else {
                    parts.push(rest);
                    break;
                }
            }
            return parts
                .filter((p) => p.length > 0)
                .map((k) => `<kbd class="shortcut-help-kbd">${k.trim()}</kbd>`)
                .join('<span class="shortcut-help-plus">+</span>');
        };

        const renderColumn = (cats: [string, (typeof categories)[0][1]][]) => {
            return cats
                .map(
                    ([category, entries]) => `
                <div class="shortcut-help-category">
                    <h3 class="shortcut-help-category-title">${category}</h3>
                    ${entries
                        .map(
                            (entry) => `
                        <div class="shortcut-help-row">
                            <span class="shortcut-help-label">${entry.label}</span>
                            <span class="shortcut-help-keys">
                                ${entry.keys.map((k) => renderKey(k)).join(' <span class="shortcut-help-or">/</span> ')}
                            </span>
                        </div>`
                        )
                        .join('')}
                </div>`
                )
                .join('');
        };

        this.innerHTML = `
        <div class="shortcut-help-backdrop"></div>
        <div class="shortcut-help-panel">
            <div class="shortcut-help-header">
                <h2 class="shortcut-help-title">
                    <i class="fa-solid fa-keyboard" style="margin-right:8px;opacity:0.6"></i>快捷键速查
                </h2>
                <button class="shortcut-help-close-btn" title="关闭">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            <div class="shortcut-help-body">
                ${columns.map((col) => `<div class="shortcut-help-column">${renderColumn(col)}</div>`).join('')}
            </div>
            <div class="shortcut-help-footer">
                按 <kbd class="shortcut-help-kbd">Esc</kbd> 关闭此面板
            </div>
        </div>
        `;

        this.backdrop = this.querySelector('.shortcut-help-backdrop');
        this.panel = this.querySelector('.shortcut-help-panel');

        this.backdrop?.addEventListener('click', () => this.hide());
        this.querySelector('.shortcut-help-close-btn')?.addEventListener('click', () => this.hide());

        requestAnimationFrame(() => {
            if (this.backdrop) this.backdrop.style.opacity = '1';
            if (this.panel) {
                this.panel.style.opacity = '1';
                this.panel.style.transform = 'translate(-50%, -50%) scale(1)';
            }
        });
    }
}

customElements.define('shortcut-help-panel', ShortcutHelpPanel);
