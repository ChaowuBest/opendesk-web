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

interface LoginFields {
    username: HTMLInputElement;
    password: HTMLInputElement;
}
interface CredentialBridge {
    list(): Promise<{ requestId: string; usernames: string[]; label: string } | null>;
    fill(requestId: string, username: string): Promise<{ username: string; password: string } | null>;
    save(candidate: { username: string; password: string }): Promise<unknown>;
}

/** Only unambiguous, visible login forms; registration and password-reset fields are excluded. */
export function findLoginFields(target: Element): LoginFields | null {
    const associatedForm =
        target instanceof HTMLInputElement || target instanceof HTMLButtonElement ? target.form : null;
    const scope = associatedForm ?? target.closest('form') ?? target.getRootNode();
    if (!(scope instanceof Document || scope instanceof ShadowRoot || scope instanceof HTMLFormElement)) return null;
    const visible = (input: HTMLInputElement) =>
        !input.disabled &&
        !input.readOnly &&
        !input.closest('[hidden],[inert]') &&
        input.getClientRects().length > 0 &&
        getComputedStyle(input).visibility !== 'hidden' &&
        getComputedStyle(input).display !== 'none';
    const autocompleteHas = (input: HTMLInputElement, token: string) => input.autocomplete.split(/\s+/).includes(token);
    const controls =
        scope instanceof HTMLFormElement ? Array.from(scope.elements) : Array.from(scope.querySelectorAll('input'));
    const inputs = controls.filter(
        (control): control is HTMLInputElement => control instanceof HTMLInputElement && visible(control)
    );
    const passwords = inputs.filter((input) => input.type === 'password');
    if (passwords.length !== 1 || autocompleteHas(passwords[0], 'new-password')) return null;
    const password = passwords[0];
    const candidates = inputs
        .slice(0, inputs.indexOf(password))
        .filter((input) => ['text', 'email', 'tel'].includes(input.type) && !autocompleteHas(input, 'one-time-code'));
    const username = candidates.find((input) => autocompleteHas(input, 'username')) ?? candidates.at(-1);
    if (!username) return null;
    if (target instanceof HTMLInputElement && target !== username && target !== password) return null;
    return { username, password };
}

export function installCredentialFormSupport(bridge: CredentialBridge): void {
    let interaction = 0;
    let popup:
        | {
              host: HTMLElement;
              fields: LoginFields;
              buttons: HTMLButtonElement[];
              select: (index: number) => void;
              active: number;
          }
        | undefined;
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const eventElement = (event: Event) =>
        event.composedPath().find((element) => element instanceof Element) as Element | undefined;

    function dismiss(): void {
        interaction += 1;
        popup?.host.remove();
        popup = undefined;
    }

    async function choose(target: HTMLInputElement): Promise<void> {
        dismiss();
        const fields = findLoginFields(target);
        if (!fields || target !== fields.username) return;
        const generation = interaction;
        const list = await bridge.list();
        if (
            !list ||
            !list.usernames.length ||
            generation !== interaction ||
            !target.isConnected ||
            !target.matches(':focus')
        )
            return;
        const host = document.createElement('div');
        host.setAttribute('data-opendesk-credentials', '');
        const rect = target.getBoundingClientRect();
        const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const below = window.innerHeight - rect.bottom - 8;
        const above = Math.max(0, rect.top - 8);
        const height = Math.min(240, Math.max(below, above));
        const top =
            below >= Math.min(240, 40 + list.usernames.length * 38) || below >= above
                ? rect.bottom + 4
                : Math.max(8, rect.top - Math.min(height, 40 + list.usernames.length * 38) - 4);
        host.style.cssText = `all:initial;position:fixed;z-index:2147483647;left:${left}px;top:${top}px;width:${width}px;`;
        const root = host.attachShadow({ mode: 'closed' });
        // Constructed stylesheets keep site CSP from stripping the isolated dropdown's layout.
        const style = new CSSStyleSheet();
        style.replaceSync(`:host{color-scheme:light}section{font:14px system-ui,sans-serif;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 14px #0003;overflow:auto;max-height:${height}px}
            header{padding:10px 12px;font-size:12px;color:#657080}button{display:block;box-sizing:border-box;width:100%;min-height:38px;border:0;background:transparent;text-align:left;padding:9px 12px;color:inherit;font:inherit;cursor:pointer;overflow-wrap:anywhere}
            button:hover,button[aria-selected=true]{background:#e8f0fe}`);
        const section = document.createElement('section');
        section.setAttribute('role', 'listbox');
        section.setAttribute('aria-label', list.label);
        const heading = document.createElement('header');
        heading.textContent = list.label;
        section.append(heading);
        const buttons: HTMLButtonElement[] = [];
        const select = async (username: string) => {
            dismiss();
            const selectionGeneration = interaction;
            const selected = await bridge.fill(list.requestId, username);
            const current = findLoginFields(target);
            if (
                !selected ||
                selectionGeneration !== interaction ||
                !target.isConnected ||
                !current ||
                current.username !== fields.username ||
                current.password !== fields.password
            )
                return;
            // Use the native setter so controlled React/Vue inputs receive normal input/change events.
            for (const [input, value] of [
                [fields.username, selected.username],
                [fields.password, selected.password]
            ] as const) {
                inputSetter.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
        };
        for (const username of list.usernames) {
            const button = document.createElement('button');
            button.type = 'button';
            button.tabIndex = -1;
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', 'false');
            button.textContent = username;
            button.addEventListener('pointerdown', (event) => event.preventDefault());
            button.addEventListener('click', (event) => {
                if (event.isTrusted) void select(username).catch(dismiss);
            });
            buttons.push(button);
            section.append(button);
        }
        root.adoptedStyleSheets = [style];
        root.append(section);
        document.documentElement.append(host);
        popup = {
            host,
            fields,
            buttons,
            select: (index) => {
                void select(list.usernames[index]).catch(dismiss);
            },
            active: -1
        };
    }

    function capture(target: Element): void {
        const fields = findLoginFields(target);
        if (!fields || !fields.username.value || !fields.password.value) return;
        const candidate = { username: fields.username.value, password: fields.password.value };
        // Only the main-process vault can determine whether this submission is already saved:
        // another browser view may have cleared it since the previous submission.
        void bridge.save(candidate).catch(() => undefined);
    }

    document.addEventListener(
        'pointerdown',
        (event) => {
            if (event.isTrusted && !event.composedPath().includes(popup?.host as EventTarget)) dismiss();
        },
        true
    );
    document.addEventListener(
        'focusin',
        (event) => {
            if (popup && eventElement(event) !== popup.fields.username) dismiss();
        },
        true
    );
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    document.addEventListener(
        'scroll',
        (event) => {
            if (!event.composedPath().includes(popup?.host as EventTarget)) dismiss();
        },
        true
    );
    document.addEventListener(
        'keyup',
        (event) => {
            if (!event.isTrusted || event.key !== 'Tab') return;
            const target = eventElement(event);
            if (target instanceof HTMLInputElement) void choose(target).catch(dismiss);
        },
        true
    );
    document.addEventListener(
        'keydown',
        (event) => {
            if (!event.isTrusted) return;
            if (popup) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    popup.active =
                        (popup.active +
                            (event.key === 'ArrowDown' ? 1 : popup.active < 0 ? 0 : -1) +
                            popup.buttons.length) %
                        popup.buttons.length;
                    popup.buttons.forEach((button, index) =>
                        button.setAttribute('aria-selected', String(index === popup!.active))
                    );
                    popup.buttons[popup.active].scrollIntoView({ block: 'nearest' });
                    return;
                }
                if (event.key === 'Enter' && popup.active >= 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    popup.select(popup.active);
                    return;
                }
                dismiss();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    return;
                }
            }
            const target = eventElement(event);
            if (event.key === 'Enter' && !event.repeat && !event.isComposing && target instanceof HTMLInputElement)
                capture(target);
        },
        true
    );
    document.addEventListener(
        'click',
        (event) => {
            if (!event.isTrusted) return;
            const element = eventElement(event);
            if (element instanceof HTMLInputElement) void choose(element).catch(dismiss);
            const target = element?.closest('button,input[type="submit"]');
            if (
                (target instanceof HTMLButtonElement && target.type === 'submit') ||
                (target instanceof HTMLInputElement && target.type === 'submit')
            )
                capture(target);
        },
        true
    );
    document.addEventListener(
        'input',
        (event) => {
            if (event.isTrusted) {
                dismiss();
            }
        },
        true
    );
}
