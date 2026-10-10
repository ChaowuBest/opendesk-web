import { describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createModelSelect } from '../../../renderer/utils/model-select.js';

function fixture() {
    const { document } = parseHTML('<select></select><span></span><p></p>');
    const select = document.querySelector('select') as HTMLSelectElement;
    const loading = document.querySelector('span') as HTMLElement;
    const error = document.querySelector('p') as HTMLElement;
    const control = createModelSelect({ select, loading, error, t: (key) => key });
    return { select, loading, error, control };
}

describe('model selection loading', () => {
    test('starts disabled, shows loading, and enables escaped model options on success', async () => {
        const { select, loading, error, control } = fixture();
        expect(select.disabled).toBe(true);
        let resolve!: (names: string[]) => void;
        const request = control.load(
            () =>
                new Promise((done) => {
                    resolve = done;
                })
        );
        expect(select.disabled).toBe(true);
        expect(select.getAttribute('aria-busy')).toBe('true');
        expect(loading.hidden).toBe(false);
        resolve(['b', '<img src=x>', 'b', 'a']);
        await request;
        expect(select.disabled).toBe(false);
        expect(loading.hidden).toBe(true);
        expect(error.hidden).toBe(true);
        expect(new Set(Array.from(select.options).map((option) => option.value))).toEqual(
            new Set(['', '<img src=x>', 'a', 'b'])
        );
        expect(select.querySelector('img')).toBeNull();
    });

    test('shows errors for failed and empty results, and can retry', async () => {
        const { select, error, control } = fixture();
        await control.load(async () => {
            throw new Error('MODEL_LIST_HTTP_401');
        });
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe('config.model.discovery.unauthorized');
        expect(select.disabled).toBe(true);
        await control.load(async () => []);
        expect(error.textContent).toBe('config.model.discovery.empty');
        await control.load(async () => ['working']);
        expect(error.hidden).toBe(true);
        expect(select.disabled).toBe(false);
    });

    test('ignores stale success and failure after a provider switch or reset', async () => {
        const { select, error, control } = fixture();
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
        expect(select.textContent).toContain('new');
        expect(select.textContent).not.toContain('old');
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
        expect(select.disabled).toBe(true);
    });

    test('preserves an existing edited model even if discovery fails, without selecting another model', async () => {
        const { select, control } = fixture();
        await control.load(async () => ['other'], 'saved-model');
        expect(select.value).toBe('saved-model');
        await control.load(async () => {
            throw new Error('network');
        }, 'saved-model');
        expect(select.value).toBe('saved-model');
        expect(select.disabled).toBe(false);
        control.reset();
        expect(select.querySelector('option[value="saved-model"]')).toBeNull();
    });
});
