import { type TUI, matchesKey, type KeyId } from "@mariozechner/pi-tui";

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
