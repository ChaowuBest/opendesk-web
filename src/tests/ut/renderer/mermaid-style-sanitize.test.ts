import { describe, expect, it } from '@jest/globals';
import { parseHTML } from 'linkedom';

import {
    createMermaidConfig,
    mountMermaidSvg,
    sanitizeMermaidStyleContent
} from '../../../renderer/components/previewer.js';

describe('sanitizeMermaidStyleContent', () => {
    it('strips external url() from style but keeps #fragment refs and normal css', () => {
        const svg =
            '<svg><style>#id .node rect{fill:#ECECFF;}a{fill:url(https://evil.example/x.png);}b{marker-end:url(#arrowPath);}</style><g></g></svg>';
        const result = sanitizeMermaidStyleContent(svg);
        expect(result).not.toContain('evil.example');
        expect(result).toContain('url(#arrowPath)');
        expect(result).toContain('fill:#ECECFF');
    });

    it('strips @import from style', () => {
        const svg = '<svg><style>@import url(https://evil.example/x.css);#id .n{fill:#fff;}</style><g></g></svg>';
        const result = sanitizeMermaidStyleContent(svg);
        expect(result).not.toContain('@import');
        expect(result).not.toContain('evil.example');
        expect(result).toContain('fill:#fff');
    });

    it('keeps svg without <style> unchanged', () => {
        const svg = '<svg><g><rect></rect></g></svg>';
        expect(sanitizeMermaidStyleContent(svg)).toBe(svg);
    });

    it('keeps internal fragment url unchanged', () => {
        const svg = '<svg><style>a{marker-end:url(#pEnd);}</style><g></g></svg>';
        expect(sanitizeMermaidStyleContent(svg)).toContain('url(#pEnd)');
    });
});

describe('Mermaid rendering isolation', () => {
    it('disables HTML labels in both the root and flowchart configuration', () => {
        expect(createMermaidConfig(false)).toMatchObject({
            htmlLabels: false,
            flowchart: { htmlLabels: false },
            theme: 'default'
        });
        expect(createMermaidConfig(true)).toMatchObject({ theme: 'dark' });
    });

    it('keeps Mermaid theme styles inside an isolated shadow root', () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            SVGElement: window.SVGElement
        });
        const host = document.createElement('div');
        document.body.appendChild(host);

        const svg = mountMermaidSvg(
            host,
            '<svg viewBox="0 0 640 320" width="100%" height="320"><style>.node{fill:#ececff;}</style><rect class="node" /></svg>'
        );

        expect(host.querySelector('style')).toBeNull();
        expect(host.shadowRoot?.querySelector('style')?.textContent).toContain('fill:#ececff');
        expect(svg?.getAttribute('width')).toBeNull();
        expect(svg?.getAttribute('height')).toBeNull();
        expect(svg?.style.width).toBe('640px');
        expect(svg?.style.maxWidth).toBe('100%');
        expect(svg?.style.height).toBe('auto');
    });
});
