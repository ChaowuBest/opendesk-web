import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderAriaTreeToYaml, runAriaPass, runAriaPasses, type AriaNode, type FrameAriaResult } from '../cdp/aria.js';
import { SNAPSHOT_INJECTION } from '../cdp/snapshot.js';
import { DEFAULT_ARIA_PASSES } from '../passes/index.js';
import { normalizeGenericsPass } from '../passes/normalizeGenericsPass.js';

/**
 * Reproduces the taobao IM (旺旺) chat input structure: a `.placeholder`
 * div rendered ON TOP of an EMPTY `<pre contenteditable>` editor. Before the
 * fix the snapshot dropped the editor entirely (contenteditable had no
 * implicit role → generic → normalizeGenericsPass discarded the ref-bearing
 * empty generic), so the agent only ever saw the placeholder div and clicked
 * / typed into the wrong element — the real input never got focus.
 */
const TAOBAO_EDIT_BOX = `
<div class="chat-input" data-width="640" data-height="140">
  <div class="editBox" data-width="640" data-height="100">
    <div class="placeholder" data-width="560" data-height="24">请输入消息，按Enter键 或 点击发送按钮发送</div>
    <pre class="edit" contenteditable="true" spellcheck="false" data-width="560" data-height="100"></pre>
  </div>
</div>`;

function captureInjectedSnapshot(markup: string): FrameAriaResult {
    const { document, window } = parseHTML(`<html><head><title>Chat</title></head><body>${markup}</body></html>`);
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

    // linkedom's isContentEditable only looks at the element's own attribute;
    // real Chromium marks EVERY descendant of an editing host as editable
    // (inheritance). Emulate the spec semantics so the host-only textbox
    // mapping in getRole is actually exercised.
    Object.defineProperty(window.HTMLElement.prototype, 'isContentEditable', {
        configurable: true,
        get(this: Element) {
            let node: Element | null = this;
            while (node) {
                const attr = node.getAttribute('contenteditable');
                if (attr !== null) {
                    const value = attr.toLowerCase();
                    if (value === 'true' || value === '') return true;
                    if (value === 'false') return false;
                }
                node = node.parentElement;
            }
            return false;
        }
    });

    const result = vm.runInNewContext(SNAPSHOT_INJECTION, {
        document,
        window: {
            innerWidth: 1280,
            innerHeight: 720,
            scrollX: 0,
            scrollY: 0
        },
        location: { href: 'https://market.m.taobao.com/chat' },
        getComputedStyle: () => ({
            cursor: '',
            display: 'block',
            opacity: '1',
            pointerEvents: 'auto',
            visibility: 'visible'
        }),
        HTMLInputElement: window.HTMLInputElement,
        HTMLTextAreaElement: window.HTMLTextAreaElement
    });
    return JSON.parse(result) as FrameAriaResult;
}

function findNodes(node: AriaNode, role: string): AriaNode[] {
    const out: AriaNode[] = [];
    if (node.role === role) out.push(node);
    for (const child of node.children) {
        if (typeof child !== 'string') out.push(...findNodes(child, role));
    }
    return out;
}

function findNodeByRef(node: AriaNode, ref: string): AriaNode | undefined {
    if (node.ref === ref) return node;
    for (const child of node.children) {
        if (typeof child !== 'string') {
            const hit = findNodeByRef(child, ref);
            if (hit) return hit;
        }
    }
    return undefined;
}

describe('contenteditable editors in snapshots (taobao IM input regression)', () => {
    test('empty contenteditable editor survives the pipeline as a ref-bearing textbox', () => {
        const snapshot = captureInjectedSnapshot(TAOBAO_EDIT_BOX);
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);

        const textboxes = findNodes(optimized, 'textbox');
        expect(textboxes).toHaveLength(1);
        // The ref is the click/type handle — it must survive the passes.
        expect(textboxes[0].ref).toMatch(/^e\d+$/);
    });

    test('placeholder sibling stays visible next to the editor', () => {
        const snapshot = captureInjectedSnapshot(TAOBAO_EDIT_BOX);
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);

        const yaml = renderAriaTreeToYaml(optimized);
        expect(yaml).toContain('请输入消息');
    });

    test('renders the editor as a textbox line in the YAML snapshot', () => {
        const snapshot = captureInjectedSnapshot(TAOBAO_EDIT_BOX);
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);
        const yaml = renderAriaTreeToYaml(optimized);
        expect(yaml).toMatch(/textbox \[ref=e\d+\]/);
    });

    test('contenteditable with typed text shows the text as its content', () => {
        const markup = `
        <div class="editBox" data-width="640" data-height="100">
          <div class="placeholder" data-width="560" data-height="24">请输入消息</div>
          <pre class="edit" contenteditable="true" data-width="560" data-height="100">你好</pre>
        </div>`;
        const snapshot = captureInjectedSnapshot(markup);
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);

        const textboxes = findNodes(optimized, 'textbox');
        expect(textboxes).toHaveLength(1);
        expect(JSON.stringify(optimized)).toContain('你好');
    });

    test('only the editing host becomes a textbox — descendants keep implicit roles', () => {
        // Chromium semantics: every descendant of an editing host reports
        // isContentEditable === true. Mapping them all to 'textbox' would
        // clobber a link's 'link' role and spawn nested textboxes inside
        // rich-text editors (Gmail compose etc.).
        const markup = `
        <div contenteditable="true" data-width="300" data-height="100">
          <p data-width="280" data-height="24">你好</p>
          <a href="https://example.com/a" data-width="80" data-height="24">链接</a>
        </div>`;
        const snapshot = captureInjectedSnapshot(markup);
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);

        expect(findNodes(optimized, 'textbox')).toHaveLength(1);
        expect(findNodes(optimized, 'link')).toHaveLength(1);
        expect(findNodes(optimized, 'paragraph')).toHaveLength(1);
    });

    test('native textarea value is not duplicated by the textbox text capture', () => {
        // toAriaNode already publishes el.value as the child text of a native
        // input/textarea; visitNode must not push the raw DOM text node on top
        // of it.
        const snapshot = captureInjectedSnapshot('<textarea data-width="200" data-height="60">hello world</textarea>');
        const optimized = runAriaPasses(snapshot.root, DEFAULT_ARIA_PASSES);
        const yaml = renderAriaTreeToYaml(optimized);
        expect((yaml.match(/hello world/g) || []).length).toBe(1);
    });
});

describe('normalizeGenericsPass keeps ref-bearing nodes', () => {
    test('does not drop an empty generic that carries a ref (the editor itself)', () => {
        // editBox > [placeholder(e179, text), pre(e180, empty)]
        const pre: AriaNode = { role: 'generic', name: '', children: [], props: {}, ref: 'e180' };
        const placeholder: AriaNode = {
            role: 'generic',
            name: '',
            children: ['请输入消息，按Enter键 或 点击发送按钮发送'],
            props: {},
            ref: 'e179'
        };
        const box: AriaNode = { role: 'generic', name: '', children: [placeholder, pre], props: {}, ref: 'e178' };

        const out = runAriaPass(box, normalizeGenericsPass);
        expect(findNodeByRef(out, 'e180')).toBeDefined();
    });

    test('still lifts unnamed ref-free decoration generics', () => {
        const inner: AriaNode = { role: 'generic', name: '', children: ['decor'], props: {} };
        const wrapper: AriaNode = { role: 'generic', name: '', children: [inner], props: {} };
        const parent: AriaNode = { role: 'fragment', name: '', children: [wrapper], props: {} };

        const out = runAriaPass(parent, normalizeGenericsPass);
        // The ref-free wrapper is lifted away; the inner generic (with its
        // text) is promoted into the parent.
        expect(out.children).toHaveLength(1);
        const promoted = out.children[0] as AriaNode;
        expect(promoted.role).toBe('generic');
        expect(promoted.children).toContain('decor');
    });

    test('folds a ref-bearing wrapper whose single child carries a ref', () => {
        // Folding drops the wrapper's own ref, but the promoted child keeps
        // the subtree reachable — keeping the wrapper would only add snapshot
        // noise on wrapper-heavy pages.
        const button: AriaNode = { role: 'button', name: '提交', children: [], props: {}, ref: 'e4' };
        const wrapper: AriaNode = { role: 'generic', name: '', children: [button], props: {}, ref: 'e3' };
        const parent: AriaNode = { role: 'fragment', name: '', children: [wrapper], props: {} };

        const out = runAriaPass(parent, normalizeGenericsPass);
        expect(findNodeByRef(out, 'e4')).toBeDefined();
        expect(findNodeByRef(out, 'e3')).toBeUndefined();
    });
});
