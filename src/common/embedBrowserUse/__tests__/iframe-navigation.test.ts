import { describe, expect, jest, test } from '@jest/globals';
import { resolveNestedRefCoords, selectChildFrame } from '../cdp/aria.js';

type FakeFrame = {
    url: string;
    frames: FakeFrame[];
    executeJavaScript: jest.Mock;
};

describe('iframe navigation', () => {
    test('prefers a unique URL match when Electron child-frame order differs from DOM iframe order', () => {
        const wrong = { url: 'https://wrong.example/', frames: [], executeJavaScript: jest.fn() };
        const expected = { url: 'https://target.example/', frames: [], executeJavaScript: jest.fn() };

        expect(selectChildFrame([wrong, expected] as any, 0, 'https://target.example/')).toBe(expected);
    });

    test('scrolls each outer iframe into view before resolving the inner target coordinates', async () => {
        const child: FakeFrame = {
            url: 'https://frame.example/',
            frames: [],
            executeJavaScript: jest.fn(async () => JSON.stringify({ x: 30, y: 40, tag: 'button', text: 'Go' }))
        };
        const main: FakeFrame = {
            url: 'https://host.example/',
            frames: [child],
            executeJavaScript: jest
                .fn()
                .mockResolvedValueOnce(JSON.stringify({ x: 10, y: 20, tag: 'iframe', text: '' }))
                .mockResolvedValueOnce({ index: 0, src: 'https://frame.example/' })
        };

        await expect(resolveNestedRefCoords(main as any, 'e1-e2')).resolves.toEqual({
            x: 40,
            y: 60,
            tag: 'button',
            text: 'Go'
        });

        expect(main.executeJavaScript.mock.calls[0][0]).toContain('el.scrollIntoView');
    });
});
