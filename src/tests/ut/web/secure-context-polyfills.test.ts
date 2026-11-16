import { describe, expect, it, jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';

const { installSecureContextPolyfills } = await import('../../../renderer/web/secure-context-polyfills.js');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function insecureGlobal(execCommand: (command: string) => boolean = () => true) {
    // 非安全上下文：有 getRandomValues，没有 randomUUID 与 clipboard
    const crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
    const navigator = {};
    const body = { appendChild: jest.fn() };
    const document = {
        body,
        execCommand: jest.fn(execCommand),
        createElement: () => ({ value: '', style: {}, setAttribute: jest.fn(), select: jest.fn(), remove: jest.fn() })
    };
    return { crypto, navigator, document } as unknown as typeof globalThis;
}

describe('secure context polyfills', () => {
    it('adds an RFC 4122 v4 crypto.randomUUID when the browser hides it', () => {
        const target = insecureGlobal();
        installSecureContextPolyfills(target);
        const ids = new Set(Array.from({ length: 200 }, () => target.crypto.randomUUID()));
        expect(ids.size).toBe(200);
        for (const id of ids) expect(id).toMatch(UUID_V4);
    });

    it('keeps the native implementations in a secure context', () => {
        const nativeUUID = jest.fn(() => '00000000-0000-4000-8000-000000000000');
        const nativeClipboard = { readText: jest.fn(), writeText: jest.fn() };
        const target = {
            crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: nativeUUID },
            navigator: { clipboard: nativeClipboard }
        } as unknown as typeof globalThis;
        installSecureContextPolyfills(target);
        expect(target.crypto.randomUUID).toBe(nativeUUID);
        expect((target.navigator as Navigator).clipboard).toBe(nativeClipboard);
    });

    it('provides a clipboard that copies through execCommand and reads back in-page copies', async () => {
        const target = insecureGlobal();
        installSecureContextPolyfills(target);
        const clipboard = (target.navigator as Navigator).clipboard;
        await expect(clipboard.readText()).resolves.toBe('');
        await clipboard.writeText('hello');
        expect((target.document as unknown as { execCommand: jest.Mock }).execCommand).toHaveBeenCalledWith('copy');
        await expect(clipboard.readText()).resolves.toBe('hello');
    });

    it('rejects writeText when even execCommand cannot copy', async () => {
        const target = insecureGlobal(() => false);
        installSecureContextPolyfills(target);
        await expect((target.navigator as Navigator).clipboard.writeText('x')).rejects.toMatchObject({
            name: 'NotAllowedError'
        });
    });
});
