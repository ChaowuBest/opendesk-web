import { jest } from '@jest/globals';

export function mockModelAPI() {
    return {
        fetchProviderModels: jest.fn(async () => ['gpt-4o', 'gpt-4o-mini']),
        estimateContextSize: jest.fn(async () => 128000),
        estimateMaxOutputTokens: jest.fn(async () => 16000),
        getModelReasoningEfforts: jest.fn(async () => [])
    };
}

// linkedom does not maintain selectedIndex when selecting an option.
export function choose(select: HTMLSelectElement, value: string) {
    const option = Array.from(select.options).find((option) => option.value === value);
    if (!option) throw new Error(`Missing test option: ${value}`);
    for (const item of select.options) item.removeAttribute('selected');
    option.selected = true;
    Object.defineProperty(select, 'selectedIndex', {
        value: Array.from(select.options).indexOf(option),
        configurable: true
    });
    select.dispatchEvent(new Event('change'));
}

export async function settle() {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
