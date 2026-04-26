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

export interface GUIShortcutEntry {
    /** Unique identifier */
    id: string;
    /** Display label, e.g. "放大界面" */
    label: string;
    /** Category for grouping in help panel, e.g. "显示", "编辑" */
    category: string;
    /** Key combo string(s) for display, e.g. "Ctrl+=" */
    keys: string[];
    /** Matching function: returns true if the KeyboardEvent matches */
    match: (e: KeyboardEvent) => boolean;
    /** Handler called when shortcut fires */
    handler: (e: KeyboardEvent) => void;
}

class GUIShortcutManager {
    private shortcuts: GUIShortcutEntry[] = [];
    private attached = false;
    private boundListener: ((e: KeyboardEvent) => void) | null = null;

    register(entry: GUIShortcutEntry) {
        const existing = this.shortcuts.findIndex((s) => s.id === entry.id);
        if (existing >= 0) {
            this.shortcuts[existing] = entry;
        } else {
            this.shortcuts.push(entry);
        }
    }

    unregister(id: string) {
        this.shortcuts = this.shortcuts.filter((s) => s.id !== id);
    }

    getAll(): GUIShortcutEntry[] {
        return [...this.shortcuts];
    }

    getGroupedByCategory(): Map<string, GUIShortcutEntry[]> {
        const map = new Map<string, GUIShortcutEntry[]>();
        for (const s of this.shortcuts) {
            if (!map.has(s.category)) {
                map.set(s.category, []);
            }
            map.get(s.category)!.push(s);
        }
        return map;
    }

    attach() {
        if (this.attached) return;
        this.boundListener = (e: KeyboardEvent) => {
            for (const s of this.shortcuts) {
                if (s.match(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    s.handler(e);
                    return;
                }
            }
        };
        window.addEventListener('keydown', this.boundListener, true);
        this.attached = true;
    }

    detach() {
        if (!this.attached || !this.boundListener) return;
        window.removeEventListener('keydown', this.boundListener, true);
        this.boundListener = null;
        this.attached = false;
    }
}

export const guiShortcutManager = new GUIShortcutManager();
