import { describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createModelSelect } from '../../../renderer/utils/model-select.js';

function fixture() {
    const { document } = parseHTML('<input><button></button><div hidden></div><span></span><p></p>');
    const input = document.querySelector('input') as HTMLInputElement;
    const suggestions = document.querySelector('div') as HTMLElement;
    const toggle = document.querySelector('button') as HTMLButtonElement;
    const loading = document.querySelector('span') as HTMLElement;
    const error = document.querySelector('p') as HTMLElement;
    const control = createModelSelect({ input, suggestions, toggle, loading, error, t: (key) => key });
    const emit = (type: string, key?: string) =>
        input.dispatchEvent(Object.assign(new document.defaultView!.Event(type, { cancelable: true }), { key }));
    const type = (value = '') => {
        input.value = value;
        emit('input');
    };
    return { input, suggestions, loading, error, control, emit, type };
}

describe('model selection loading', () => {
    test('allows typing during discovery and renders escaped suggestions without replacing the draft', async () => {
        const { input, suggestions, loading, error, control, type } = fixture();
        const pending = Promise.withResolvers<string[]>();
        const request = control.load(() => pending.promise);
        expect(input.getAttribute('aria-busy')).toBe('true');
        expect(loading.hidden).toBe(false);
        input.value = 'unlisted-model';
        pending.resolve(['b', '<img src=x>', 'b', 'a']);
        await request;
        expect(input.disabled).toBe(false);
        expect(loading.hidden).toBe(true);
        expect(error.hidden).toBe(true);
        // An unlisted draft need not match a suggestion; clear the search without selecting one.
        expect(input.value).toBe('unlisted-model');
        type();
        expect(
            Array.from(suggestions.querySelectorAll<HTMLButtonElement>('[role=option]'), (option) => option.value)
        ).toEqual(['<img src=x>', 'a', 'b']);
        expect(suggestions.querySelector('img')).toBeNull();
    });

    test('filters suggestions and accepts them by keyboard or click', async () => {
        const { input, suggestions, control, emit, type } = fixture();
        await control.load(async () => ['model-a', 'model-b']);
        type('model-b');
        expect(suggestions.textContent).toBe('model-b');
        emit('keydown', 'ArrowDown');
        emit('keydown', 'Enter');
        expect(input.value).toBe('model-b');
        expect(suggestions.hidden).toBe(true);
        type();
        emit('keydown', 'ArrowUp');
        emit('keydown', 'Enter');
        expect(input.value).toBe('model-b');
        type();
        (suggestions.querySelector('[role=option]') as HTMLButtonElement).click();
        expect(input.value).toBe('model-a');
        expect(suggestions.hidden).toBe(true);
    });

    test('shows errors for failed and empty results, and can retry', async () => {
        const { input, error, control } = fixture();
        await control.load(async () => {
            throw new Error('MODEL_LIST_HTTP_401');
        });
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe('config.model.discovery.httpError');
        expect(input.disabled).toBe(false);
        await control.load(async () => []);
        expect(error.textContent).toBe('config.model.discovery.serverError');
        for (const message of ['MODEL_LIST_INVALID', 'untrusted server or network detail']) {
            await control.load(async () => {
                throw new Error(message);
            });
            expect(error.textContent).toBe('config.model.discovery.serverError');
        }
        await control.load(async () => ['working']);
        expect(error.hidden).toBe(true);
        expect(input.disabled).toBe(false);
    });

    test('ignores stale success and failure after a provider switch or reset', async () => {
        const { suggestions, error, control, emit } = fixture();
        const stale = Promise.withResolvers<string[]>();
        const old = control.load(() => stale.promise);
        await control.load(async () => ['new']);
        stale.resolve(['old']);
        await old;
        emit('focus');
        expect(suggestions.textContent).toContain('new');
        expect(suggestions.textContent).not.toContain('old');
        const failing = Promise.withResolvers<string[]>();
        const pending = control.load(() => failing.promise);
        control.reset();
        failing.reject(new Error('MODEL_LIST_HTTP_500'));
        await pending;
        expect(error.hidden).toBe(true);
        expect(suggestions.children).toHaveLength(0);
    });

    test('preserves an existing edited model even if discovery fails, without selecting another model', async () => {
        const { input, control } = fixture();
        input.value = 'saved-model';
        await control.load(async () => ['other']);
        expect(input.value).toBe('saved-model');
        await control.load(async () => {
            throw new Error('network');
        });
        expect(input.value).toBe('saved-model');
        expect(input.disabled).toBe(false);
        control.reset();
        expect(input.value).toBe('saved-model');
    });
});
