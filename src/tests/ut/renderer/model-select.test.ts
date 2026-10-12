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
    return { input, suggestions, loading, error, control };
}

describe('model selection loading', () => {
    test('allows typing during discovery and renders escaped suggestions without replacing the draft', async () => {
        const { input, suggestions, loading, error, control } = fixture();
        let resolve!: (names: string[]) => void;
        const request = control.load(
            () =>
                new Promise((done) => {
                    resolve = done;
                })
        );
        expect(input.getAttribute('aria-busy')).toBe('true');
        expect(loading.hidden).toBe(false);
        input.value = 'unlisted-model';
        resolve(['b', '<img src=x>', 'b', 'a']);
        await request;
        expect(input.disabled).toBe(false);
        expect(loading.hidden).toBe(true);
        expect(error.hidden).toBe(true);
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('focus'));
        // An unlisted draft need not match a suggestion; clear the search without selecting one.
        expect(input.value).toBe('unlisted-model');
        input.value = '';
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input'));
        expect(
            new Set(
                Array.from(suggestions.querySelectorAll<HTMLButtonElement>('[role=option]')).map(
                    (option) => option.value
                )
            )
        ).toEqual(new Set(['<img src=x>', 'a', 'b']));
        expect(suggestions.querySelector('img')).toBeNull();
    });

    test('filters suggestions and accepts them by keyboard or click', async () => {
        const { input, suggestions, control } = fixture();
        await control.load(async () => ['model-a', 'model-b']);
        input.value = 'model-b';
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input'));
        expect(suggestions.textContent).toBe('model-b');
        const key = (value: string) => {
            const event = new input.ownerDocument.defaultView!.Event('keydown', { cancelable: true });
            Object.assign(event, { key: value });
            input.dispatchEvent(event);
        };
        key('ArrowDown');
        key('Enter');
        expect(input.value).toBe('model-b');
        expect(suggestions.hidden).toBe(true);
        input.value = '';
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input'));
        key('ArrowUp');
        key('Enter');
        expect(input.value).toBe('model-b');
        input.value = '';
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input'));
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
        await control.load(async () => {
            throw new Error('MODEL_LIST_INVALID');
        });
        expect(error.textContent).toBe('config.model.discovery.serverError');
        await control.load(async () => {
            throw new Error('untrusted server or network detail');
        });
        expect(error.textContent).toBe('config.model.discovery.serverError');
        await control.load(async () => ['working']);
        expect(error.hidden).toBe(true);
        expect(input.disabled).toBe(false);
    });

    test('ignores stale success and failure after a provider switch or reset', async () => {
        const { input, suggestions, error, control } = fixture();
        let resolve!: (names: string[]) => void;
        const old = control.load(
            () =>
                new Promise((done) => {
                    resolve = done;
                })
        );
        await control.load(async () => ['new']);
        resolve(['old']);
        await old;
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('focus'));
        expect(suggestions.textContent).toContain('new');
        expect(suggestions.textContent).not.toContain('old');
        let reject!: (error: Error) => void;
        const pending = control.load(
            () =>
                new Promise((_done, fail) => {
                    reject = fail;
                })
        );
        control.reset();
        reject(new Error('MODEL_LIST_HTTP_500'));
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
