import { describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { enhanceWebLinks } from '../../../renderer/utils/web-linkify.js';

describe('web URL link enhancement', () => {
    test('turns plain HTTP(S) URLs into safe external links', () => {
        const { document } = parseHTML('<div id="root">结果地址：https://example.com/docs?q=OpenDesk，后续说明</div>');
        const root = document.querySelector('#root')!;

        enhanceWebLinks(root);

        const link = root.querySelector('a');
        expect(link?.getAttribute('href')).toBe('https://example.com/docs?q=OpenDesk');
        expect(link?.getAttribute('target')).toBe('_blank');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(root.textContent).toBe('结果地址：https://example.com/docs?q=OpenDesk，后续说明');
    });

    test('does not nest links or modify code and form controls', () => {
        const { document } = parseHTML(`<div id="root">
            <a href="https://example.com/existing">https://example.com/existing</a>
            <code>https://example.com/code</code>
            <pre>https://example.com/pre</pre>
            <button>https://example.com/action</button>
            <span>https://example.com/plain.</span>
        </div>`);
        const root = document.querySelector('#root')!;

        enhanceWebLinks(root);
        enhanceWebLinks(root);

        expect(root.querySelectorAll('a')).toHaveLength(2);
        expect(root.querySelector('code a')).toBeNull();
        expect(root.querySelector('pre a')).toBeNull();
        expect(root.querySelector('button a')).toBeNull();
        expect(root.querySelector('span a')?.getAttribute('href')).toBe('https://example.com/plain');
        expect(root.querySelector('span')?.textContent).toBe('https://example.com/plain.');
    });

    test('keeps balanced closing parentheses inside a URL and trims unmatched punctuation', () => {
        const { document } = parseHTML(
            '<div id="root">文档 https://example.com/a_(b)，另见 (https://example.com/next)。</div>'
        );
        const root = document.querySelector('#root')!;

        enhanceWebLinks(root);

        expect(Array.from(root.querySelectorAll('a')).map((link) => link.getAttribute('href'))).toEqual([
            'https://example.com/a_(b)',
            'https://example.com/next'
        ]);
    });
});
