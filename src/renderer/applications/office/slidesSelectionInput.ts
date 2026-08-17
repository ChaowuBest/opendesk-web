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

import type { AgentInputRequest } from '../../input/agentInputRequest.js';

interface SlidesSelectionElement {
    id?: unknown;
    type?: unknown;
    text?: unknown;
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
}

interface SlidesSelectionContext {
    slideIndex?: unknown;
    selectedElements?: unknown;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function readSelectionContext(value: unknown): SlidesSelectionContext {
    return value && typeof value === 'object' ? (value as SlidesSelectionContext) : {};
}

function formatElement(value: unknown): string {
    const element = value && typeof value === 'object' ? (value as SlidesSelectionElement) : {};
    const type = String(element.type || 'element');
    const id = String(element.id || '');
    const text = typeof element.text === 'string' ? element.text.trim().replace(/\s+/g, ' ') : '';
    const dimensions = [element.x, element.y, element.width, element.height];
    const box = dimensions.every((dimension) => typeof dimension === 'number' && Number.isFinite(dimension))
        ? ` @ (${Math.round(element.x as number)}, ${Math.round(element.y as number)}) ${Math.round(element.width as number)}×${Math.round(element.height as number)}`
        : '';
    return `- ${type}${id ? ` (${id})` : ''}${box}${text ? `: “${text.slice(0, 160)}”` : ''}`;
}

export function createSlidesSelectionInputRequest(contextValue: unknown, translate: Translate): AgentInputRequest {
    const context = readSelectionContext(contextValue);
    const page = Number(context.slideIndex) + 1;
    const elements = Array.isArray(context.selectedElements) ? context.selectedElements.slice(0, 32) : [];
    const header = translate('renderer.fileExplorer.pptx.ai.selectionPrompt', {
        page: Number.isFinite(page) ? page : 1
    });

    // TODO(input-context-capsules): Return an immutable selection capsule when AgentInput
    // exposes the shared context substrate; text insertion is the temporary transport.
    return {
        type: 'insert-text',
        placement: 'append',
        focus: true,
        text: [header, ...elements.map(formatElement)].join('\n')
    };
}
