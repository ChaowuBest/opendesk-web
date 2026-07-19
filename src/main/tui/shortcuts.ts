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

import { type TUI, matchesKey, type KeyId } from '@earendil-works/pi-tui';

export interface ShortcutEntry {
    key: KeyId;
    handler: () => void | boolean;
}

/**
 * 全局快捷键管理器：通过 TUI.addInputListener 拦截键盘事件。
 * handler 返回 true 或 void 表示已消费，返回 false 表示放行。
 */
export class KeyboardShortcutManager {
    private shortcuts: ShortcutEntry[] = [];
    private removeListener?: () => void;

    register(entry: ShortcutEntry) {
        this.shortcuts.push(entry);
    }

    attach(tui: TUI) {
        this.removeListener = tui.addInputListener((data: string) => {
            for (const s of this.shortcuts) {
                if (matchesKey(data, s.key)) {
                    const result = s.handler();
                    if (result !== false) {
                        return { consume: true };
                    }
                }
            }
            return undefined;
        });
    }

    detach() {
        this.removeListener?.();
        this.removeListener = undefined;
    }
}
