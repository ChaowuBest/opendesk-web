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

export interface AskUserOption {
    label: string;
    description: string;
}

export interface AskUserQuestion {
    question: string;
    header: string;
    options: AskUserOption[];
    multiple?: boolean;
}

export interface AskUserRequest {
    requestId: string;
    questions: AskUserQuestion[];
    taskId: string;
    taskName: string | null;
    workspace?: string;
}

export interface AskUserPromptContext {
    toolCallId?: string;
    messageId?: string;
}

export interface AskUserResponse {
    answers: Record<number, string[]>;
    cancelled?: boolean;
}

export interface AskUserProvider {
    prompt(request: AskUserRequest, context?: AskUserPromptContext): Promise<AskUserResponse>;
    isPrompting?(): boolean;
    cancelCurrent?(): void;
}

export type ExitPlanModeAction = 'execute-standard' | 'execute-solo' | 'continue-editing';

export interface ExitPlanModeResponse {
    action: ExitPlanModeAction;
}

export interface ExitPlanModeRemoteContext {
    planRelativePath: string;
}

export interface ExitPlanModeProvider {
    promptAndSwitch(
        planContent: string,
        planFilePath: string,
        taskId?: string,
        taskName?: string,
        remoteContext?: ExitPlanModeRemoteContext
    ): Promise<ExitPlanModeResponse>;
    isPrompting?(): boolean;
    cancelCurrent?(): void;
}

export type PermissionDenyReason = 'user_denied' | 'timeout' | 'no_prompt_provider' | 'task_stopped';

export interface PermissionUserResponse {
    decision: 'allow' | 'deny';
    rememberScope: 'none' | 'prefix' | 'type';
    selectedPrefixPattern?: string;
    denyReason?: PermissionDenyReason;
}

export type InteractionType = 'askUser' | 'exitPlanMode' | 'permission';
export type InteractionTerminalStatus =
    | 'accepted'
    | 'superseded'
    | 'timeout'
    | 'cancelled'
    | 'resolved'
    | 'failed';
