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

import type { RuntimeMetadata, ToolCall } from './messages.js';
import type { TaskState } from './states/tasks.js';

export type TaskExtensionCheckpoint =
    | 'after_completion'
    | 'after_tools'
    | 'after_tool_turn'
    | 'before_finish'
    | 'after_finish_hooks'
    | 'after_hook_backoff';

export interface TaskExtensionCheckpointOptions {
    includeSupplements?: boolean;
}

export interface TaskExtensionInputResult {
    status: 'ok' | 'error';
    supplementId?: string;
    messageKey?: string;
    messageArgs?: Record<string, unknown>;
}

export interface TaskExtension {
    readonly key: string;
    restore?(raw: Record<string, unknown>, wasRunningAtShutdown: boolean): void;
    serialize?(): Record<string, unknown>;
    toSimplifiedJSON?(): Record<string, unknown>;
    toRenderJSON?(): Record<string, unknown>;
    handleUserMessage?(message: string, imageDataUris?: string[]): Promise<TaskExtensionInputResult | undefined>;
    getAssistantMetadata?(userMetadata?: RuntimeMetadata): RuntimeMetadata | undefined;
    onHistoryMutation?(source: string): void;
    prepareFork?(target: TaskState): void;
    beforeToolCall?(toolCall: ToolCall): boolean;
    checkpoint?(checkpoint: TaskExtensionCheckpoint, options?: TaskExtensionCheckpointOptions): Promise<boolean>;
    onTurnIterationFailed?(reason: string, skipIfRuntimeInterrupted: boolean): void;
    onTurnSettled?(): void;
    afterTurnFinished?(): void;
}

export type TaskExtensionFactory = (task: TaskState) => TaskExtension;

const extensionFactories = new Map<string, TaskExtensionFactory>();
const activeManagers = new Set<WeakRef<TaskExtensionManager>>();

export function registerTaskExtension(key: string, factory: TaskExtensionFactory): void {
    extensionFactories.set(key, factory);
    for (const reference of activeManagers) {
        const manager = reference.deref();
        if (manager) {
            manager.attachFactory(key, factory);
        } else {
            activeManagers.delete(reference);
        }
    }
}

export class TaskExtensionManager {
    private readonly extensions = new Map<string, TaskExtension>();
    private restoredRaw?: Record<string, unknown>;
    private wasRunningAtShutdown: boolean = false;

    constructor(private readonly task: TaskState) {
        activeManagers.add(new WeakRef(this));
        for (const [key, factory] of extensionFactories) {
            this.attachFactory(key, factory);
        }
    }

    attachFactory(key: string, factory: TaskExtensionFactory): void {
        if (this.extensions.has(key)) return;
        const extension = factory(this.task);
        if (extension.key !== key) {
            throw new Error(`Task extension factory key mismatch: expected ${key}, got ${extension.key}`);
        }
        this.extensions.set(key, extension);
        if (this.restoredRaw) {
            extension.restore?.(this.restoredRaw, this.wasRunningAtShutdown);
        }
    }

    get<T extends TaskExtension>(key: string): T | undefined {
        return this.extensions.get(key) as T | undefined;
    }

    require<T extends TaskExtension>(key: string): T {
        const extension = this.get<T>(key);
        if (!extension) {
            throw new Error(`Task extension not registered: ${key}`);
        }
        return extension;
    }

    restore(raw: Record<string, unknown>, wasRunningAtShutdown: boolean): void {
        this.restoredRaw = raw;
        this.wasRunningAtShutdown = wasRunningAtShutdown;
        for (const extension of this.extensions.values()) {
            extension.restore?.(raw, wasRunningAtShutdown);
        }
    }

    serialize(): Record<string, unknown> {
        const result: Record<string, unknown> = {
            ...this.restoredRaw,
            ...this.collect((extension) => extension.serialize?.())
        };
        for (const [key, value] of Object.entries(result)) {
            if (value === undefined) delete result[key];
        }
        return result;
    }

    toSimplifiedJSON(): Record<string, unknown> {
        return this.collect((extension) => extension.toSimplifiedJSON?.());
    }

    toRenderJSON(): Record<string, unknown> {
        return this.collect((extension) => extension.toRenderJSON?.());
    }

    async handleUserMessage(message: string, imageDataUris?: string[]): Promise<TaskExtensionInputResult | undefined> {
        for (const extension of this.extensions.values()) {
            const result = await extension.handleUserMessage?.(message, imageDataUris);
            if (result) return result;
        }
        return undefined;
    }

    getAssistantMetadata(userMetadata?: RuntimeMetadata): RuntimeMetadata | undefined {
        for (const extension of this.extensions.values()) {
            const metadata = extension.getAssistantMetadata?.(userMetadata);
            if (metadata) return metadata;
        }
        return undefined;
    }

    onHistoryMutation(source: string): void {
        for (const extension of this.extensions.values()) {
            extension.onHistoryMutation?.(source);
        }
    }

    prepareFork(target: TaskState): void {
        for (const extension of this.extensions.values()) {
            extension.prepareFork?.(target);
        }
    }

    beforeToolCall(toolCall: ToolCall): boolean {
        for (const extension of this.extensions.values()) {
            if (extension.beforeToolCall?.(toolCall) === true) return true;
        }
        return false;
    }

    async checkpoint(
        checkpoint: TaskExtensionCheckpoint,
        options: TaskExtensionCheckpointOptions = {}
    ): Promise<boolean> {
        let materialized = false;
        for (const extension of this.extensions.values()) {
            if ((await extension.checkpoint?.(checkpoint, options)) === true) {
                materialized = true;
            }
        }
        return materialized;
    }

    onTurnIterationFailed(reason: string, skipIfRuntimeInterrupted: boolean = true): void {
        for (const extension of this.extensions.values()) {
            extension.onTurnIterationFailed?.(reason, skipIfRuntimeInterrupted);
        }
    }

    onTurnSettled(): void {
        for (const extension of this.extensions.values()) {
            extension.onTurnSettled?.();
        }
    }

    afterTurnFinished(): void {
        for (const extension of this.extensions.values()) {
            extension.afterTurnFinished?.();
        }
    }

    private collect(
        project: (extension: TaskExtension) => Record<string, unknown> | undefined
    ): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const extension of this.extensions.values()) {
            Object.assign(result, project(extension));
        }
        return result;
    }
}
