import type { SlashCommand as PiTuiSlashCommand, AutocompleteItem, KeyId } from "@mariozechner/pi-tui";

export interface SlashCommandHandler {
    name: string;
    description: string;
    shortcut?: KeyId;
    /** 命令来源，用于重复检测时的提示 */
    source?: string;
    execute: (args: string) => void | Promise<void>;
    getArgumentCompletions?: (argPrefix: string) => AutocompleteItem[] | null;
}

export class SlashCommandRegistry {
    private commands: Map<string, SlashCommandHandler> = new Map();

    /**
     * 注册命令，如果命令已存在则返回 false 并发出警告
     * @param command 要注册的命令
     * @param warnOnDuplicate 是否在重复时发出警告（默认 true）
     * @returns 是否注册成功
     */
    register(command: SlashCommandHandler, warnOnDuplicate: boolean = true): boolean {
        const existing = this.commands.get(command.name);
        if (existing) {
            if (warnOnDuplicate) {
                const existingSource = existing.source || '未知来源';
                const newSource = command.source || '未知来源';
                console.warn(`[SlashCommandRegistry] 命令 "/${command.name}" 已被 "${existingSource}" 注册，忽略来自 "${newSource}" 的重复注册`);
            }
            return false;
        }
        this.commands.set(command.name, command);
        return true;
    }

    /**
     * 强制注册命令，覆盖已存在的同名命令
     * @param command 要注册的命令
     */
    registerOverride(command: SlashCommandHandler): void {
        const existing = this.commands.get(command.name);
        if (existing) {
            const existingSource = existing.source || '未知来源';
            const newSource = command.source || '未知来源';
            console.warn(`[SlashCommandRegistry] 命令 "/${command.name}" 已被 "${existingSource}" 注册，被 "${newSource}" 覆盖`);
        }
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

    /**
     * 检查命令是否已存在
     */
    has(name: string): boolean {
        return this.commands.has(name);
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
