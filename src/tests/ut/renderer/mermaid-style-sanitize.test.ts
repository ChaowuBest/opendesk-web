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

describe('createMermaidConfig design palette', () => {
    // 与 docs/designs/modal.html 设计 Token 同源的 12 色分类色带：
    // 全部取自 modal.html 调色盘的深浅两版语义色与跨模式变体，并按明度从高到低
    // 排序、避免相邻色块同色，用于 pie/timeline/journey/mindmap。
    const LIGHT_RAMP = [
        '#ED6B56',
        '#4267B2',
        '#3DBF82',
        '#E2A23B',
        '#B98AE0',
        '#E85A5A',
        '#DF4436',
        '#7AA2E8',
        '#1F9D66',
        '#B87503',
        '#7B4BAA',
        '#DC2626'
    ];
    const DARK_RAMP = [
        '#ED6B56',
        '#7AA2E8',
        '#3DBF82',
        '#E2A23B',
        '#B98AE0',
        '#E85A5A',
        '#E8563F',
        '#4267B2',
        '#1F9D66',
        '#B87503',
        '#7B4BAA',
        '#DC2626'
    ];

    it('applies light-mode design tokens to theme variables', () => {
        const vars = createMermaidConfig(false).themeVariables;
        expect(vars).toMatchObject({
            darkMode: false,
            background: '#FBFAF8',
            primaryColor: '#EBF1FB',
            primaryTextColor: '#1C1917',
            primaryBorderColor: '#4267B2',
            secondaryColor: '#E7F5EE',
            secondaryBorderColor: '#1F9D66',
            tertiaryColor: '#FDF3E3',
            tertiaryBorderColor: '#B87503',
            textColor: '#4A4642',
            titleColor: '#1C1917',
            lineColor: '#8A8580',
            clusterBkg: '#F5F4F2',
            clusterBorder: '#E7E5E2',
            actorBkg: '#FFFFFF',
            actorBorder: '#4267B2',
            signalColor: '#4A4642',
            labelBoxBkgColor: '#EBF1FB',
            loopTextColor: '#4267B2',
            noteBkgColor: '#FDF3E3',
            stateBkg: '#EBF1FB',
            transitionColor: '#8A8580',
            classText: '#1C1917',
            attributeBackgroundColorOdd: '#FFFFFF',
            taskBkgColor: '#EBF1FB',
            activeTaskBkgColor: '#FDEEEC',
            doneTaskBkgColor: '#E7F5EE',
            critBkgColor: '#FEF2F2',
            todayLineColor: '#DF4436',
            vertLineColor: '#8A8580',
            excludeBkgColor: '#EFEEEA',
            faceColor: '#FDF3E3',
            git0: '#DF4436',
            gitBranchLabel0: '#FFFFFF',
            arrowheadColor: '#8A8580',
            pieTitleTextColor: '#1C1917',
            pieSectionTextColor: '#FFFFFF'
        });
    });

    it('applies dark-mode design tokens to theme variables', () => {
        const vars = createMermaidConfig(true).themeVariables;
        expect(vars).toMatchObject({
            darkMode: true,
            background: '#1B1A18',
            primaryColor: '#373B45',
            primaryTextColor: '#EFEDEA',
            primaryBorderColor: '#7AA2E8',
            secondaryColor: '#2D3F34',
            secondaryBorderColor: '#3DBF82',
            tertiaryColor: '#463A29',
            tertiaryBorderColor: '#E2A23B',
            textColor: '#D5D1CB',
            titleColor: '#EFEDEA',
            lineColor: '#9B968F',
            clusterBkg: '#232120',
            clusterBorder: '#3B3835',
            actorBkg: '#2A2826',
            actorBorder: '#7AA2E8',
            signalColor: '#D5D1CB',
            labelBoxBkgColor: '#373B45',
            loopTextColor: '#7AA2E8',
            noteBkgColor: '#463A29',
            stateBkg: '#373B45',
            transitionColor: '#9B968F',
            classText: '#EFEDEA',
            attributeBackgroundColorOdd: '#2A2826',
            taskBkgColor: '#373B45',
            activeTaskBkgColor: '#482F2A',
            doneTaskBkgColor: '#2D3F34',
            critBkgColor: '#473030',
            todayLineColor: '#E8563F',
            vertLineColor: '#9B968F',
            excludeBkgColor: '#33302D',
            faceColor: '#463A29',
            git0: '#E8563F',
            gitBranchLabel0: '#FFFFFF',
            arrowheadColor: '#9B968F',
            pieTitleTextColor: '#EFEDEA',
            pieSectionTextColor: '#FFFFFF'
        });
    });

    it('provides brand categorical ramps for pie, timeline, journey and mindmap diagrams', () => {
        const light = createMermaidConfig(false).themeVariables;
        const dark = createMermaidConfig(true).themeVariables;
        for (let i = 0; i < 12; i++) {
            expect(light[`pie${i + 1}`]).toBe(LIGHT_RAMP[i]);
            expect(light[`cScale${i}`]).toBe(LIGHT_RAMP[i]);
            expect(light[`cScaleLabel${i}`]).toBe('#FFFFFF');
            expect(light[`cScaleInv${i}`]).toBe('#EFEEEA');
            expect(dark[`pie${i + 1}`]).toBe(DARK_RAMP[i]);
            expect(dark[`cScale${i}`]).toBe(DARK_RAMP[i]);
            expect(dark[`cScaleLabel${i}`]).toBe('#FFFFFF');
            expect(dark[`cScaleInv${i}`]).toBe('#33302D');
        }
        // journey 的 fillType 不走色带：section 色块与标题文字共用 CSS fill，
        // 用蓝/绿浅底交替保证文字可读，标题文字色由 themeCSS 覆盖
        for (let i = 0; i < 8; i++) {
            expect(light[`fillType${i}`]).toBe(i % 2 === 0 ? '#EBF1FB' : '#E7F5EE');
            expect(dark[`fillType${i}`]).toBe(i % 2 === 0 ? '#373B45' : '#2D3F34');
        }
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
