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

interface ModelSelectOptions {
    select: HTMLSelectElement;
    loading: HTMLElement;
    error: HTMLElement;
    t: (key: string, params?: Record<string, string | number>) => string;
}

export function createModelSelect({ select, loading, error, t }: ModelSelectOptions) {
    let generation = 0;
    const render = (names: string[], selected = '', placeholder = 'config.model.discovery.select') => {
        select.replaceChildren();
        const addOption = (value: string, label: string) => {
            const option = select.ownerDocument.createElement('option');
            option.value = value;
            option.textContent = label;
            option.selected = value === selected;
            select.appendChild(option);
        };
        addOption('', t(placeholder));
        for (const name of names) addOption(name, name);
        select.disabled = names.length === 0;
    };
    const reset = (placeholder = 'config.model.discovery.providerFirst') => {
        generation++;
        render([], '', placeholder);
        select.setAttribute('aria-busy', 'false');
        loading.hidden = true;
        error.hidden = true;
        error.textContent = '';
    };
    reset();
    return {
        reset,
        async load(fetchNames: () => Promise<string[]>, selected = ''): Promise<void> {
            const request = ++generation;
            render([], '', 'config.model.discovery.loading');
            select.setAttribute('aria-busy', 'true');
            loading.hidden = false;
            error.hidden = true;
            error.textContent = '';
            try {
                const result = await fetchNames();
                if (request !== generation) return;
                const names = [...new Set(result)].sort();
                if (names.length === 0) throw new Error('MODEL_LIST_EMPTY');
                // Keep the saved name when editing providers that no longer advertise an existing model.
                if (selected && !names.includes(selected)) names.unshift(selected);
                render(names, selected);
            } catch (cause) {
                if (request !== generation) return;
                render(selected ? [selected] : [], selected);
                const message = cause instanceof Error ? cause.message : '';
                const status = message.match(/MODEL_LIST_HTTP_(\d+)/)?.[1];
                error.textContent = t(
                    status === '401' || status === '403'
                        ? 'config.model.discovery.unauthorized'
                        : status
                          ? 'config.model.discovery.httpError'
                          : message === 'MODEL_LIST_EMPTY'
                            ? 'config.model.discovery.empty'
                            : message === 'MODEL_LIST_INVALID'
                              ? 'config.model.discovery.invalid'
                              : 'config.model.discovery.failed',
                    status ? { status } : undefined
                );
                error.hidden = false;
            } finally {
                if (request === generation) {
                    loading.hidden = true;
                    select.setAttribute('aria-busy', 'false');
                }
            }
        }
    };
}
