/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type { OpenDeskTUI } from '../../../tui/entry.js';
import { getPluginHost } from './host.js';

const fallbackAbortSignal = new AbortController().signal;

export function syncPluginTuiCommands(tui: OpenDeskTUI, previous: ReadonlySet<string>): Set<string> {
    for (const name of previous) tui.commandRegistry.unregister(name);

    const registered = new Set<string>();
    for (const contribution of getPluginHost().listCommands()) {
        const definition = contribution.definition;
        const added = tui.commandRegistry.register({
            name: definition.name,
            description: definition.description,
            source: contribution.pluginId,
            execute: async (args) => {
                const task = tui.getActiveTask();
                const outcome = await getPluginHost().runCommand(
                    contribution.id,
                    { raw: args },
                    {
                        taskId: task?.task_id,
                        workspace: task?.getWorkspace() || tui.workspace || undefined,
                        abort: task?.getAbortSignal() ?? fallbackAbortSignal
                    }
                );
                if (outcome.status === 'invalid_arguments') {
                    tui.showTextPage(definition.name, `${outcome.message}\n\n${outcome.usage}`);
                    return;
                }
                if (outcome.status === 'help') {
                    tui.showTextPage(definition.name, outcome.text);
                    return;
                }
                const result = outcome.result;
                if (typeof result === 'string') {
                    tui.showTextPage(definition.name, result);
                } else if (result) {
                    tui.showTextPage(result.title || definition.name, result.output);
                }
            }
        });
        if (added) registered.add(definition.name);
    }
    return registered;
}
