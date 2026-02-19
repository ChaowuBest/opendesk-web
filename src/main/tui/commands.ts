import type { SlashCommand as PiTuiSlashCommand, AutocompleteItem, KeyId } from "@mariozechner/pi-tui";

export interface SlashCommandHandler {
    name: string;
    description: string;
    shortcut?: KeyId;
    execute: (args: string) => void | Promise<void>;
    getArgumentCompletions?: (argPrefix: string) => AutocompleteItem[] | null;
}

export class SlashCommandRegistry {
    private commands: Map<string, SlashCommandHandler> = new Map();

    register(command: SlashCommandHandler) {
        this.commands.set(command.name, command);
    }

    unregister(name: string) {
        this.commands.delete(name);
    }

    get(name: string): SlashCommandHandler | undefined {
        return this.commands.get(name);
    }

    getAll(): SlashCommandHandler[] {
        return Array.from(this.commands.values());
    }

    toPiTuiSlashCommands(): PiTuiSlashCommand[] {
        return this.getAll().map(cmd => ({
            name: cmd.name,
            description: cmd.description,
            getArgumentCompletions: cmd.getArgumentCompletions,
        }));
    }

    static formatKeyLabel(key: KeyId): string {
        return key.split('+').map(part => {
            if (part === 'ctrl') return 'Ctrl';
            if (part === 'shift') return 'Shift';
            if (part === 'alt') return 'Alt';
            return part.toUpperCase();
        }).join('+');
    }

    /**
     * 尝试作为斜杠指令执行，返回 true 表示已匹配并执行
     */
    async execute(input: string): Promise<boolean> {
        const trimmed = input.trim();
        if (!trimmed.startsWith('/')) return false;

        const spaceIdx = trimmed.indexOf(' ');
        const cmdName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
        const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

        const handler = this.commands.get(cmdName);
        if (!handler) return false;

        await handler.execute(args);
        return true;
    }
}
