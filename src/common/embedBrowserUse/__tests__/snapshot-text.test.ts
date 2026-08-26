import { collectSnapshotPrefix, makeSessionEvaluator, renderSnapshotText, setSnapshotPrefixProvider } from '../main';
import type { PageSnapshot } from '../protocol';

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
    return {
        url: 'https://example.com/page',
        title: 'Example',
        viewport: { width: 800, height: 600 },
        scroll: { x: 0, y: 0 },
        ariaSnapshot: '- button "Go" [ref=e1]',
        ...overrides
    };
}

/** 最小 CDPSession 替身：只实现 renderSnapshotText / evaluator 用到的 send */
function fakeSession(handler: (method: string, params?: Record<string, any>) => any) {
    const calls: Array<{ method: string; params?: Record<string, any> }> = [];
    return {
        calls,
        session: {
            send: async (method: string, params?: Record<string, any>) => {
                calls.push({ method, params });
                return handler(method, params);
            }
        } as any
    };
}

describe('renderSnapshotText', () => {
    afterEach(() => setSnapshotPrefixProvider(undefined));

    it('renders page info followed by the ARIA body', () => {
        expect(renderSnapshotText(snapshot())).toBe(
            [
                '- Page URL: https://example.com/page',
                '- Page Title: Example',
                '- Viewport: 800x600',
                '',
                '[Accessibility Snapshot]',
                '- button "Go" [ref=e1]'
            ].join('\n')
        );
    });

    it('omits the title line when the page has no title', () => {
        expect(renderSnapshotText(snapshot({ title: '' }))).not.toContain('Page Title');
    });

    it('includes the scroll line only when the page is scrolled', () => {
        expect(renderSnapshotText(snapshot())).not.toContain('- Scroll:');
        expect(renderSnapshotText(snapshot({ scroll: { x: 0, y: 240 } }))).toContain('- Scroll: 0,240');
    });

    it('places prefix lines before the page info and info lines after it', () => {
        const text = renderSnapshotText(snapshot(), {
            prefixLines: ['## Browser Hints', ''],
            infoLines: ['- Mode: diff']
        });
        const lines = text.split('\n');
        expect(lines[0]).toBe('## Browser Hints');
        expect(lines.indexOf('- Page URL: https://example.com/page')).toBeLessThan(lines.indexOf('- Mode: diff'));
        expect(lines.indexOf('- Mode: diff')).toBeLessThan(lines.indexOf('[Accessibility Snapshot]'));
    });

    it('is unchanged when prefix and info lines are empty', () => {
        expect(renderSnapshotText(snapshot(), { prefixLines: [], infoLines: [] })).toBe(renderSnapshotText(snapshot()));
    });
});

describe('snapshot prefix provider', () => {
    afterEach(() => setSnapshotPrefixProvider(undefined));

    it('returns no prefix when no provider is registered', async () => {
        const { session } = fakeSession(() => ({ result: { value: null } }));
        await expect(collectSnapshotPrefix(snapshot(), session)).resolves.toEqual([]);
    });

    it('passes the snapshot and a page evaluator to the provider', async () => {
        const { session } = fakeSession(() => ({ result: { value: '<html>needle</html>' } }));
        setSnapshotPrefixProvider(async (page, evaluate) => {
            const dom = await evaluate('document.documentElement.outerHTML');
            return [`url=${page.url}`, `dom=${String(dom)}`];
        });

        await expect(collectSnapshotPrefix(snapshot(), session)).resolves.toEqual([
            'url=https://example.com/page',
            'dom=<html>needle</html>'
        ]);
    });

    it('degrades to no prefix when the provider throws', async () => {
        const { session } = fakeSession(() => ({ result: { value: null } }));
        setSnapshotPrefixProvider(() => {
            throw new Error('provider exploded');
        });

        await expect(collectSnapshotPrefix(snapshot(), session)).resolves.toEqual([]);
    });

    it('degrades to no prefix when page evaluation fails', async () => {
        const { session } = fakeSession(() => ({ exceptionDetails: { text: 'evaluation blocked' } }));
        setSnapshotPrefixProvider(async (_page, evaluate) => [String(await evaluate('1+1'))]);

        await expect(collectSnapshotPrefix(snapshot(), session)).resolves.toEqual([]);
    });

    it('accepts a synchronous provider', async () => {
        const { session } = fakeSession(() => ({ result: { value: null } }));
        setSnapshotPrefixProvider(() => ['static prefix']);

        await expect(collectSnapshotPrefix(snapshot(), session)).resolves.toEqual(['static prefix']);
    });

    it('can be removed by passing undefined', async () => {
        const { session } = fakeSession(() => ({ result: { value: null } }));
        setSnapshotPrefixProvider(() => ['temporary']);
        await expect(collectSnapshotPrefix(snapshot(), session)).resolves.toEqual(['temporary']);

        setSnapshotPrefixProvider(undefined);
        await expect(collectSnapshotPrefix(snapshot(), session)).resolves.toEqual([]);
    });
});

describe('makeSessionEvaluator', () => {
    it('evaluates expressions by value and awaits promises', async () => {
        const { session, calls } = fakeSession(() => ({ result: { value: 42 } }));

        await expect(makeSessionEvaluator(session)('1+41')).resolves.toBe(42);
        expect(calls).toEqual([
            {
                method: 'Runtime.evaluate',
                params: { expression: '1+41', returnByValue: true, awaitPromise: true }
            }
        ]);
    });

    it('surfaces page-side exceptions as errors', async () => {
        const { session } = fakeSession(() => ({ exceptionDetails: { text: 'boom' } }));
        await expect(makeSessionEvaluator(session)('nope()')).rejects.toThrow('boom');
    });
});
