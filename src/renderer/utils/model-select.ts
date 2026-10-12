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
    input: HTMLInputElement;
    suggestions: HTMLElement;
    toggle: HTMLButtonElement;
    loading: HTMLElement;
    error: HTMLElement;
    t: (key: string, params?: Record<string, string | number>) => string;
}

export function createModelSelect({ input, suggestions, toggle, loading, error, t }: ModelSelectOptions) {
    let generation = 0;
    let names: string[] = [];
    let active = -1;
    const close = () => {
        suggestions.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    };
    const choose = (name: string) => {
        input.value = name;
        const EventClass = input.ownerDocument.defaultView!.Event;
        input.dispatchEvent(new EventClass('input', { bubbles: true }));
        input.dispatchEvent(new EventClass('change', { bubbles: true }));
        close();
    };
    const show = (all = false) => {
        close();
        suggestions.replaceChildren();
        const query = all ? '' : input.value.trim().toLowerCase();
        for (const name of names.filter((name) => name.toLowerCase().includes(query))) {
            const option = input.ownerDocument.createElement('button');
            option.type = 'button';
            option.value = name;
            option.textContent = name;
            option.tabIndex = -1;
            option.id = `${suggestions.id}-${suggestions.children.length}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            // Keep input focus until the click chooses an option, rather than closing on blur.
            option.addEventListener('mousedown', (event) => event.preventDefault());
            option.addEventListener('click', () => choose(name));
            suggestions.appendChild(option);
        }
        suggestions.hidden = suggestions.children.length === 0;
        input.setAttribute('aria-expanded', String(!suggestions.hidden));
    };
    input.addEventListener('input', () => show());
    input.addEventListener('focus', () => show());
    input.addEventListener('click', () => show());
    input.addEventListener('blur', close);
    toggle.addEventListener('mousedown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
        const wasOpen = !suggestions.hidden;
        input.focus();
        if (wasOpen) close();
        else show(true);
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (suggestions.hidden) show();
            const options = Array.from(suggestions.children) as HTMLButtonElement[];
            if (!options.length) return;
            event.preventDefault();
            event.stopPropagation();
            active =
                active < 0
                    ? event.key === 'ArrowDown'
                        ? 0
                        : options.length - 1
                    : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            options.forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
            input.setAttribute('aria-activedescendant', options[active].id);
            options[active].scrollIntoView?.({ block: 'nearest' });
        } else if (event.key === 'Enter' && !suggestions.hidden && active >= 0) {
            event.preventDefault();
            event.stopPropagation();
            choose((suggestions.children[active] as HTMLButtonElement).value);
        } else if (event.key === 'Escape' && !suggestions.hidden) {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    });
    const reset = (placeholder = 'config.model.discovery.select') => {
        generation++;
        names = [];
        suggestions.replaceChildren();
        toggle.disabled = true;
        close();
        input.placeholder = t(placeholder);
        input.setAttribute('aria-busy', 'false');
        loading.hidden = true;
        error.hidden = true;
        error.textContent = '';
    };
    reset();
    return {
        reset,
        async load(fetchNames: () => Promise<string[]>): Promise<void> {
            reset();
            const request = generation;
            input.setAttribute('aria-busy', 'true');
            loading.hidden = false;
            error.hidden = true;
            error.textContent = '';
            try {
                const result = await fetchNames();
                if (request !== generation) return;
                names = [...new Set(result)].sort();
                if (names.length === 0) throw new Error('MODEL_LIST_EMPTY');
                // Discovery only supplies suggestions; it must never replace a user's draft or saved name.
                toggle.disabled = false;
                if (input.ownerDocument.activeElement === input) show();
            } catch (cause) {
                if (request !== generation) return;
                const message = cause instanceof Error ? cause.message : '';
                const status = message.match(/^MODEL_LIST_HTTP_(\d+)$/)?.[1];
                // Local request errors and nonstandard responses cannot reliably identify the cause.
                error.textContent = t(
                    status ? 'config.model.discovery.httpError' : 'config.model.discovery.serverError',
                    status ? { status } : undefined
                );
                error.hidden = false;
            } finally {
                if (request === generation) {
                    loading.hidden = true;
                    input.setAttribute('aria-busy', 'false');
                }
            }
        }
    };
}
