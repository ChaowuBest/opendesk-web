import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderAriaTreeToYaml, runAriaPasses, type AriaNode, type FrameAriaResult } from '../cdp/aria.js';
import { SNAPSHOT_INJECTION } from '../cdp/snapshot.js';
import { DEFAULT_ARIA_PASSES } from '../passes/index.js';

function captureInjectedSnapshot(markup: string): FrameAriaResult {
    const { document, window } = parseHTML(`<html><head><title>Icons</title></head><body>${markup}</body></html>`);
    const elementPrototype = window.HTMLElement.prototype as unknown as {
        getBoundingClientRect: () => { width: number; height: number };
    };
    elementPrototype.getBoundingClientRect = function () {
        const element = this as unknown as Element;
        return {
            width: Number(element.getAttribute('data-width') ?? 0),
            height: Number(element.getAttribute('data-height') ?? 0)
        };
    };

    const result = vm.runInNewContext(SNAPSHOT_INJECTION, {
        document,
        window: {
            innerWidth: 1280,
            innerHeight: 720,
            scrollX: 0,
            scrollY: 0
        },
        location: { href: 'https://example.test/icons' },
        getComputedStyle: (element: Element) => ({
            cursor: '',
            display: element.tagName === 'IMG' ? 'inline' : 'block',
            opacity: '1',
            pointerEvents: 'auto',
            visibility: 'visible'
        }),
        HTMLInputElement: window.HTMLInputElement,
        HTMLTextAreaElement: window.HTMLTextAreaElement
    });
    return JSON.parse(result) as FrameAriaResult;
}

function findNodes(node: AriaNode, role: string, name?: string): AriaNode[] {
    const out: AriaNode[] = [];
    if (node.role === role && (name === undefined || node.name === name)) out.push(node);
    for (const child of node.children) {
        if (typeof child !== 'string') {
            out.push(...findNodes(child, role, name));
        }
    }
    return out;
}

describe('snapshot icon-font detection', () => {
    test('lifts a Font Awesome <i> icon into a named icon node', () => {
        const snapshot = captureInjectedSnapshot(`<i class="fa fa-cog" data-width="16" data-height="16"></i>`);
        expect(findNodes(snapshot.root, 'icon', 'fa-cog')).toHaveLength(1);
        // <i> must not be reported as a generic img anymore.
        expect(findNodes(snapshot.root, 'img')).toHaveLength(0);
    });

    test('skips family/size modifier classes when naming the icon', () => {
        const snapshot = captureInjectedSnapshot(
            `<i class="fa-solid fa-cog fa-2x" data-width="16" data-height="16"></i>`
        );
        expect(findNodes(snapshot.root, 'icon', 'fa-cog')).toHaveLength(1);
    });

    test('keeps a decorated <span> as generic but named from its class', () => {
        const snapshot = captureInjectedSnapshot(
            `<span class="glyphicon glyphicon-search" data-width="16" data-height="16"></span>`
        );
        // <span> is not an icon tag: stays generic, keeps a class-derived name.
        expect(findNodes(snapshot.root, 'icon')).toHaveLength(0);
        expect(findNodes(snapshot.root, 'generic', 'glyphicon-search')).toHaveLength(1);
    });

    test('keeps an icon inside a button so the control keeps its glyph context', () => {
        const snapshot = captureInjectedSnapshot(
            `<button data-width="40" data-height="40"><i class="fa fa-plus" data-width="16" data-height="16"></i></button>`
        );
        expect(findNodes(snapshot.root, 'icon', 'fa-plus')).toHaveLength(1);
    });

    test('does NOT treat an empty <i> without a class as an icon', () => {
        const snapshot = captureInjectedSnapshot(`<i data-width="16" data-height="16"></i>`);
        expect(findNodes(snapshot.root, 'icon')).toHaveLength(0);
    });

    test('does NOT treat a zero-sized element as an icon', () => {
        const snapshot = captureInjectedSnapshot(`<i class="fa fa-cog" data-width="0" data-height="0"></i>`);
        expect(findNodes(snapshot.root, 'icon')).toHaveLength(0);
    });

    test('does NOT treat an element with real text content as an icon', () => {
        const snapshot = captureInjectedSnapshot(`<i class="fa fa-cog" data-width="16" data-height="16">x</i>`);
        expect(findNodes(snapshot.root, 'icon')).toHaveLength(0);
    });

    test('icon and named generic survive the default pass pipeline (regression: was dropped as empty generic)', () => {
        const snapshot = captureInjectedSnapshot(
            `<i class="fa fa-cog" data-width="16" data-height="16"></i>` +
                `<span class="glyphicon glyphicon-search" data-width="16" data-height="16"></span>`
        );
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);
        expect(findNodes(optimized, 'icon', 'fa-cog')).toHaveLength(1);
        expect(findNodes(optimized, 'generic', 'glyphicon-search')).toHaveLength(1);
    });

    test('renders icon and named generic in the YAML snapshot', () => {
        const snapshot = captureInjectedSnapshot(
            `<i class="fa fa-cog" data-width="16" data-height="16"></i>` +
                `<span class="glyphicon glyphicon-search" data-width="16" data-height="16"></span>`
        );
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);
        const yaml = renderAriaTreeToYaml(optimized);
        expect(yaml).toContain('icon "fa-cog"');
        expect(yaml).toContain('generic "glyphicon-search"');
    });
});
