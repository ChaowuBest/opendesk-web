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

import { findLoginFields, fillLoginFields, type LoginFields } from './browser-credentials/login-fields.js';
import { showCredentialSuggestions, type CredentialSuggestions } from './browser-credentials/suggestion-list.js';

interface CredentialBridge {
    list(): Promise<{ requestId: string; usernames: string[]; label: string } | null>;
    fill(requestId: string, username: string): Promise<{ username: string; password: string } | null>;
    save(candidate: { username: string; password: string }): Promise<unknown>;
}

export function installCredentialFormSupport(bridge: CredentialBridge): void {
    let interaction = 0;
    let popup: (CredentialSuggestions & { fields: LoginFields }) | undefined;
    const eventElement = (event: Event) =>
        event.composedPath().find((element) => element instanceof Element) as Element | undefined;

    function dismiss(): void {
        interaction += 1;
        popup?.destroy();
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
            fillLoginFields(fields, selected);
        };
        popup = Object.assign(
            showCredentialSuggestions(target, list, (username) => void select(username).catch(dismiss)),
            { fields }
        );
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
                if (popup.handleKey(event)) return;
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
