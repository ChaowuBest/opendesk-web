import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { findLoginFields, fillLoginFields } from '../../../renderer/browser-credentials/login-fields.js';
import { showCredentialSuggestions } from '../../../renderer/browser-credentials/suggestion-list.js';

let restore: Array<() => void>;
beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    const globals = {
        window,
        CSSStyleSheet: class {
            replaceSync() {}
        },
        document: window.document,
        Document: window.Document,
        ShadowRoot: window.ShadowRoot,
        HTMLInputElement: window.HTMLInputElement,
        HTMLButtonElement: window.HTMLButtonElement,
        HTMLFormElement: window.HTMLFormElement,
        Event: window.Event,
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
    };
    restore = Object.entries(globals).map(([key, value]) => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        return () =>
            previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key);
    });
});
afterEach(() => restore.reverse().forEach((reset) => reset()));
function form(markup: string) {
    document.body.innerHTML = `<form>${markup}<button type="submit">Login</button></form>`;
    const form = document.querySelector('form')!;
    Object.setPrototypeOf(form, HTMLFormElement.prototype);
    // linkedom has no layout or form association implementation; supply those DOM contracts only.
    Object.defineProperty(form, 'elements', { get: () => form.querySelectorAll('input,button') });
    for (const element of form.querySelectorAll('input,button'))
        Object.defineProperty(element, 'form', { value: form });
    for (const input of form.querySelectorAll('input')) {
        input.type ||= 'text';
        Object.defineProperty(input, 'autocomplete', { get: () => input.getAttribute('autocomplete') || '' });
        input.getClientRects = () => [{}] as DOMRectList;
    }
    return form;
}
describe('login field adapter', () => {
    it('selects the username field ahead of unrelated text inputs and rejects OTP input targets', () => {
        const page = form(
            '<input id="user" autocomplete="username"><input id="otp" autocomplete="one-time-code"><input type="password">'
        );
        expect(findLoginFields(page.querySelector('button')!)?.username.id).toBe('user');
        expect(findLoginFields(page.querySelector('#otp')!)).toBeNull();
    });
    it.each(['new-password', 'multiple', 'hidden'])('excludes %s password forms', (kind) => {
        const page = form('<input><input type="password">' + (kind === 'multiple' ? '<input type="password">' : ''));
        const password = page.querySelector('input[type="password"]')!;
        if (kind === 'new-password') password.setAttribute('autocomplete', 'new-password');
        if (kind === 'hidden') password.setAttribute('hidden', '');
        expect(findLoginFields(page.querySelector('button')!)).toBeNull();
    });
    it('fills through the native setter and notifies controlled inputs', () => {
        const page = form('<input autocomplete="username"><input type="password">');
        const fields = findLoginFields(page.querySelector('button')!)!;
        const events: string[] = [];
        for (const input of [fields.username, fields.password]) {
            input.addEventListener('input', () => events.push('input'));
            input.addEventListener('change', () => events.push('change'));
        }
        fillLoginFields(fields, { username: 'demo', password: 'new-test-password' });
        expect([fields.username.value, fields.password.value]).toEqual(['demo', 'new-test-password']);
        expect(events).toEqual(['input', 'change', 'input', 'change']);
    });
    it('requires keyboard selection before Enter and removes the candidate list on dismissal', () => {
        const page = form('<input autocomplete="username"><input type="password">');
        const target = page.querySelector('input')!;
        target.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 40, width: 300 }) as DOMRect;
        // linkedom does not implement layout, constructed stylesheets or scrolling.
        Object.assign(window, { innerWidth: 1000, innerHeight: 700 });
        const buttonPrototype = Object.getPrototypeOf(document.createElement('button'));
        const previous = buttonPrototype.scrollIntoView;
        buttonPrototype.scrollIntoView = () => undefined;
        restore.push(() => {
            buttonPrototype.scrollIntoView = previous;
        });
        const selected: string[] = [];
        const list = showCredentialSuggestions(target, { usernames: ['alice', 'bob'], label: 'Accounts' }, (username) =>
            selected.push(username)
        );
        const key = (value: string) =>
            Object.assign(new Event('keydown', { cancelable: true }), { key: value }) as KeyboardEvent;
        expect(list.handleKey(key('Enter'))).toBe(false);
        expect(selected).toEqual([]);
        expect(list.handleKey(key('ArrowDown'))).toBe(true);
        expect(list.handleKey(key('Enter'))).toBe(true);
        expect(selected).toEqual(['alice']);
        list.destroy();
        expect(document.querySelector('[data-opendesk-credentials]')).toBeNull();
    });
});
