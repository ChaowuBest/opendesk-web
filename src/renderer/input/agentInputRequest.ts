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

export const AGENT_INPUT_REQUEST_EVENT = 'opendesk-agent-input-request';

export interface InsertTextAgentInputRequest {
    type: 'insert-text';
    text: string;
    placement: 'append' | 'replace';
    focus?: boolean;
}

export type AgentInputRequest = InsertTextAgentInputRequest;

export interface AgentInputTarget {
    getCurrentText?: () => unknown;
    setText: (text: string) => void;
    focus?: () => void;
}

function isAgentInputRequest(value: unknown): value is AgentInputRequest {
    if (!value || typeof value !== 'object') return false;
    const request = value as Partial<AgentInputRequest>;
    return (
        request.type === 'insert-text' &&
        typeof request.text === 'string' &&
        (request.placement === 'append' || request.placement === 'replace')
    );
}

export function applyAgentInputRequest(input: AgentInputTarget, request: AgentInputRequest): void {
    const currentText = String(input.getCurrentText?.() || '');
    const nextText =
        request.placement === 'append' && currentText.trim() ? `${currentText}\n\n${request.text}` : request.text;
    input.setText(nextText);
    if (request.focus) input.focus?.();
}

export function dispatchAgentInputRequest(target: EventTarget, request: AgentInputRequest): boolean {
    return target.dispatchEvent(
        new CustomEvent<AgentInputRequest>(AGENT_INPUT_REQUEST_EVENT, {
            detail: request,
            bubbles: true,
            composed: true
        })
    );
}

export function listenForAgentInputRequests(
    host: EventTarget,
    resolveInput: () => AgentInputTarget | null | undefined
): () => void {
    const handleRequest = (event: Event): void => {
        const request = (event as CustomEvent<unknown>).detail;
        if (!isAgentInputRequest(request)) return;
        const input = resolveInput();
        if (!input) return;
        applyAgentInputRequest(input, request);
    };

    host.addEventListener(AGENT_INPUT_REQUEST_EVENT, handleRequest);
    return () => host.removeEventListener(AGENT_INPUT_REQUEST_EVENT, handleRequest);
}
