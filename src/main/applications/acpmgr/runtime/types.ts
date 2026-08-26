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

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export type AcpProjectedToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface AcpProjectedToolLocation {
    path: string;
    line?: number;
}

export type AcpProjectedUpdate =
    | { type: 'message_delta'; text: string; messageId?: string }
    | { type: 'message_replace'; text: string; messageId: string }
    | { type: 'thought_delta'; text: string; messageId?: string }
    | { type: 'thought_replace'; text: string; messageId: string }
    | {
          type: 'tool_call';
          toolCallId: string;
          title: string;
          status: AcpProjectedToolStatus;
          rawInput?: unknown;
          rawOutput?: unknown;
          locations?: AcpProjectedToolLocation[];
      }
    | {
          type: 'plan';
          entries: Array<{
              content: string;
              status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
              priority?: 'low' | 'medium' | 'high';
          }>;
      }
    | { type: 'metadata'; data: Record<string, unknown> }
    | { type: 'error'; title: string; message: string };

export interface AcpTaskRuntimeTurnRequest {
    taskId: string;
    prompt: string;
    imageDataUris?: string[];
    workspace: string;
    persistedState?: Record<string, unknown>;
    signal: AbortSignal;
    onUpdate(update: AcpProjectedUpdate): Promise<void>;
    checkpoint(state: Record<string, unknown>): Promise<void>;
    requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

export interface AcpTaskRuntimeTurnResult {
    stopReason: 'completed' | 'cancelled' | 'max_tokens' | 'refusal' | 'error';
    state?: Record<string, unknown>;
}
