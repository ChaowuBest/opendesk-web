import type { OpenDeskTUI } from "../entry.js";
import { TaskSwitcher } from "../components/taskswitcher.js";
import { Key } from "@mariozechner/pi-tui";


export function registerSwitchCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "switch",
        description: "切换到其他任务",
        shortcut: Key.ctrl("l"),
        execute: async () => {
            const switcher = new TaskSwitcher(tui);
            switcher.show();
        }
    });
}
