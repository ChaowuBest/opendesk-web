import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { renderSafeMarkdown, SEARCH_PREVIEW_TEMPLATE } from '../../../renderer/utils/markdown.js';

const render = jest.fn(async (_id: string, _code: string) => ({
    svg: '<svg><text><tspan>开始</tspan></text><text>结束</text></svg>'
}));
jest.unstable_mockModule('mermaid', () => ({ default: { initialize: jest.fn(), render } }));
jest.unstable_mockModule('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }));

let buildChatFindDocuments: (typeof import('../../../renderer/components/chatFind.js'))['buildChatFindDocuments'];
let readChatFindText: (typeof import('../../../renderer/components/chatFind.js'))['readChatFindText'];
let ChatFind: (typeof import('../../../renderer/components/chatFind.js'))['ChatFind'];

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        document: window.document,
        Node: window.Node,
        window,
        MutationObserver: window.MutationObserver,
        CSS: { escape: (value: string) => value }
    });
    ({ buildChatFindDocuments, readChatFindText, ChatFind } = await import('../../../renderer/components/chatFind.js'));
});

describe('display-only full-history search projections', () => {
    test('indexes unmounted Mermaid labels after rendering, without indexing source or changing the page', async () => {
        const cache = new Map();
        const controller = new AbortController();
        const messages = [
            {
                role: 'assistant',
                message_id: 'old-diagram',
                content: [{ type: 'text', text: '```mermaid\ngraph TD\n A[开始] --> B[结束]\n```' }]
            }
        ];
        let ready!: () => void;
        const prepared = new Promise<void>((resolve) => {
            ready = resolve;
        });
        expect(buildChatFindDocuments(messages, cache, { signal: controller.signal, ready })[0].text).toBe('');
        await prepared;
        const docs = buildChatFindDocuments(messages, cache, { signal: controller.signal, ready });
        expect(docs[0].text.trim()).toBe('开始\n结束');
        expect(docs[0].text).not.toMatch(/graph|TD|-->/);
        expect(document.body.childNodes.length).toBe(0);
    });

    test('HTML and SVG code blocks index their preview text without tags, controls or source syntax', () => {
        for (const lang of ['html', 'svg']) {
            const source = lang === 'html' ? '<p>显示<strong>内容</strong></p>' : '<svg><text>显示内容</text></svg>';
            const docs = buildChatFindDocuments([
                {
                    role: 'user',
                    message_id: lang,
                    content: [
                        {
                            type: 'text',
                            text: '```' + lang + '\n' + source + '\n```'
                        }
                    ]
                }
            ]);
            expect(docs[0].text.trim()).toBe('显示内容');
        }
    });

    test('the first asynchronous diagram hit loads its old message without a second Enter', async () => {
        const scope = document.createElement('div');
        const history = document.createElement('div');
        scope.append(history);
        document.body.append(scope);
        let navigated!: () => void;
        const navigation = new Promise<void>((resolve) => {
            navigated = resolve;
        });
        const ensureMessage = jest.fn(() => navigated());
        const find = new ChatFind(history, {
            getMessages: () => [
                {
                    role: 'assistant',
                    message_id: 'async-old',
                    content: [
                        {
                            type: 'text',
                            text: '```mermaid\ngraph TD\nX[开始] --> Y[结束]\n```'
                        }
                    ]
                }
            ],
            ensureMessage,
            pauseFollow() {},
            translate: (key) => key
        });
        try {
            find.show();
            const input = scope.querySelector('input')!;
            input.value = '开始';
            input.dispatchEvent(new window.Event('input'));
            await navigation;
            expect(ensureMessage).toHaveBeenCalledWith('async-old');
            expect(ensureMessage).toHaveBeenCalledTimes(1);
        } finally {
            find.destroy();
            scope.remove();
        }
    });

    test('history preview indexing keeps active HTML nodes inside an inert template', async () => {
        const { prepareSearchPreviews } = await import('../../../renderer/components/previewer.js');
        const root = document.createElement('div');
        root.innerHTML = renderSafeMarkdown(
            '```html\n<search-probe>内容</search-probe><img src="/probe"><script>active()</script>\n```'
        );
        await prepareSearchPreviews(root);
        const shadow = root.querySelector('.code-preview-shadow-host')!.shadowRoot!;
        expect(shadow.querySelector('search-probe,img,script')).toBeNull();
        const template = shadow.querySelector<HTMLTemplateElement>(`template[${SEARCH_PREVIEW_TEMPLATE}]`)!;
        expect(template.content.querySelector('search-probe')?.textContent).toBe('内容');
        expect(readChatFindText(root).text.trim()).toBe('内容');
    });

    test('closing search prevents an asynchronous diagram from repopulating the index', async () => {
        const cache = new Map();
        const controller = new AbortController();
        const ready = jest.fn();
        buildChatFindDocuments(
            [
                {
                    role: 'user',
                    message_id: 'cancelled',
                    content: [
                        {
                            type: 'text',
                            text: '```mermaid\ngraph LR\nA[开始] --> B[结束]\n```'
                        }
                    ]
                }
            ],
            cache,
            { signal: controller.signal, ready }
        );
        controller.abort();
        cache.clear();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(cache.size).toBe(0);
        expect(ready).not.toHaveBeenCalled();
    });

    test('formulas keep their visual text and exclude the duplicate accessibility/source representation', () => {
        const root = document.createElement('div');
        root.innerHTML =
            '<span class="katex"><span class="katex-mathml"><math><annotation>source</annotation></math></span>' +
            '<span class="katex-html"><span>x</span><span>2</span></span></span>';
        expect(readChatFindText(root).text).toBe('x2');
    });
});
