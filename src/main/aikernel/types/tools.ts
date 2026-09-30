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

import type { z } from 'zod';
import type { PermissionRequest } from './permissions.js';

/** Stable task information exposed while a tool is evaluated or executed. */
export interface ToolExecutionContext {
    taskId?: string;
    workspace?: string;
    abort: AbortSignal;
}

/** Incremental result writer backed by OpenDesk's runtime ToolResult. */
export interface ToolResultWriter {
    attachResult(chunk: string): void;
    updateResult(result: string): void;
    /**
     * Replaces the structured result. Legacy tools may set
     * `ui.requiresUserAttention` to a boolean when they cannot provide a
     * `render.requiresUserAttention` callback.
     */
    updateResultObject(resultObject: object): void;
}

export type ToolExecutionResult =
    | void
    | string
    | {
          output: string;
          resultObject?: object;
      };

export interface ToolRenderContext {
    tool: string;
    callId: string;
    status: 'pending' | 'running' | 'success' | 'error';
    args: unknown;
    result?: string;
    resultObject?: object;
}

export type ToolRenderContent =
    | {
          type: 'text';
          text: string;
      }
    | {
          type: 'code';
          code: string;
          language?: string;
      }
    | {
          type: 'keyValue';
          items: Array<{
              label: string;
              value: string;
          }>;
      };

export interface ToolRenderers {
    gui?(context: ToolRenderContext): ToolRenderContent | undefined | Promise<ToolRenderContent | undefined>;
    cli?(context: ToolRenderContext & { width: number }): string[] | undefined;
    /**
     * Whether the current tool-call phase requires direct user action, such as
     * scanning a QR code or completing OAuth authorization. Returning true keeps
     * the custom renderer visible in minimal mode; return false to explicitly
     * suppress it, or undefined to use OpenDesk's structured-state fallback.
     */
    requiresUserAttention?(context: ToolRenderContext): boolean | undefined;
}

/**
 * Public tool contract shared by OpenDesk and external plugins.
 * Runtime-only state such as TaskState remains behind the host adapter.
 */
export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    parameters: T;
    agentIds?: readonly string[];
    serialExecution?: boolean;
    getDeclaredPermissions?(args: z.output<T>, context: ToolExecutionContext): PermissionRequest[];
    execute(args: z.output<T>, context: ToolExecutionContext, result: ToolResultWriter): Promise<ToolExecutionResult>;
    stop?(): void | Promise<void>;
    render?: ToolRenderers;
}
