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

export interface LoginFields {
    username: HTMLInputElement;
    password: HTMLInputElement;
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

export function fillLoginFields(fields: LoginFields, values: { username: string; password: string }): void {
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    // Use the native setter so controlled React/Vue inputs receive normal input/change events.
    for (const [input, value] of [
        [fields.username, values.username],
        [fields.password, values.password]
    ] as const) {
        inputSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
}
