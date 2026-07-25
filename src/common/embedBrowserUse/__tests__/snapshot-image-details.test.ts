import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderAriaTreeToYaml, type AriaNode, type FrameAriaResult } from '../cdp/aria.js';
import { IMAGE_DETAIL_MIN_RENDERED_AREA, SNAPSHOT_INJECTION } from '../cdp/snapshot.js';

function captureInjectedSnapshot(markup: string): FrameAriaResult {
    const { document, window } = parseHTML(`<html><head><title>Images</title></head><body>${markup}</body></html>`);
    const elementPrototype = window.HTMLElement.prototype as unknown as {
        getBoundingClientRect: () => { width: number; height: number };
    };
    elementPrototype.getBoundingClientRect = function () {
        const element = this as unknown as Element;
        return {
            width: Number(element.getAttribute('data-width') ?? 1280),
            height: Number(element.getAttribute('data-height') ?? 720)
        };
    };

    const dataFallback = document.querySelector('#data-fallback') as HTMLImageElement;
    Object.defineProperty(dataFallback, 'currentSrc', {
        configurable: true,
        value: 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
    });

    const result = vm.runInNewContext(SNAPSHOT_INJECTION, {
        document,
        window: {
            innerWidth: 1280,
            innerHeight: 720,
            scrollX: 0,
            scrollY: 0
        },
        location: { href: 'https://example.test/gallery' },
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

function collectImages(node: AriaNode): AriaNode[] {
    const images = node.role === 'img' ? [node] : [];
    for (const child of node.children) {
        if (typeof child !== 'string') {
            images.push(...collectImages(child));
        }
    }
    return images;
}

describe('snapshot image details', () => {
    test('uses rendered CSS area and only annotates images at or above the threshold', () => {
        expect(IMAGE_DETAIL_MIN_RENDERED_AREA).toBe(10_000);
        const snapshot = captureInjectedSnapshot(`
            <img alt="large-original-small-render" src="https://example.test/original-large.png"
                width="4000" height="3000" data-width="99" data-height="100">
            <img alt="boundary" src="https://example.test/boundary.png"
                data-width="100" data-height="100">
            <img alt="rounded-boundary" src="https://example.test/rounded.png"
                data-width="99.6" data-height="100.4">
            <img id="data-fallback" alt="data-fallback" src="https://example.test/lazy.png"
                data-width="200" data-height="100">
            <img alt="inline-data" src="data:image/png;base64,AAAA"
                data-width="200" data-height="100">
        `);
        const images = Object.fromEntries(collectImages(snapshot.root).map((node) => [node.name, node]));

        expect(images['large-original-small-render'].image).toBeUndefined();
        expect(images.boundary.image).toEqual({
            url: 'https://example.test/boundary.png',
            width: 100,
            height: 100
        });
        expect(images['rounded-boundary'].image).toEqual({
            url: 'https://example.test/rounded.png',
            width: 100,
            height: 100
        });
        expect(images['data-fallback'].image).toEqual({
            url: 'https://example.test/lazy.png',
            width: 200,
            height: 100
        });
        expect(images['inline-data'].image).toBeUndefined();
    });

    test('renders large image URL and size inline while preserving the accessible name and ref', () => {
        const root: AriaNode = {
            role: 'fragment',
            name: '',
            children: [
                {
                    role: 'img',
                    name: 'Bridge photo',
                    children: [],
                    props: {},
                    image: {
                        url: 'https://example.test/bridge.jpg',
                        width: 320,
                        height: 180
                    },
                    ref: 'e3'
                },
                {
                    role: 'img',
                    name: 'Small icon',
                    children: [],
                    props: {},
                    ref: 'e4'
                }
            ],
            props: {}
        };

        const yaml = renderAriaTreeToYaml(root);

        expect(yaml).toContain(`img "Bridge photo" <https://example.test/bridge.jpg>, size: 320 * 180 [ref=e3]`);
        expect(yaml).toContain(`img "Small icon" [ref=e4]`);
        expect(yaml).not.toContain('- /url:');
    });
});
