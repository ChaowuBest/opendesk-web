/**
 * Mock for the pi-tui backing package to avoid ESM parsing issues in Jest.
 * All exports that are used across the codebase are mocked here.
 */

// --- Base rendering primitives ---

// ANSI escape sequence regex: CSI (SGR/cursor), OSC, APC
const ANSI_REGEX = /\x1b\[[0-9;]*[mGKHJ]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b_[^\x07]*(?:\x07|\x1b\\)/g;

function stripAnsiInternal(s: string): string {
    return s.replace(ANSI_REGEX, '');
}

const _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function _graphemeWidth(segment: string): number {
    const cp = segment.codePointAt(0) ?? 0;
    // Emoji and pictographs (width 2)
    if (
        (cp >= 0x1f000 && cp <= 0x1ffff) ||
        (cp >= 0x2600 && cp <= 0x27bf && /^\p{RGI_Emoji}$/v.test(segment)) ||
        segment.includes('\uFE0F')
    ) {
        return 2;
    }
    // CJK and fullwidth ranges (width 2)
    if (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6)
    ) {
        return 2;
    }
    return 1;
}

export const visibleWidth = (s: string): number => {
    const clean = stripAnsiInternal(s);
    let width = 0;
    for (const { segment } of _segmenter.segment(clean)) {
        width += _graphemeWidth(segment);
    }
    return width;
};

export const truncateToWidth = (s: string, w: number, ellipsis: string = '...', pad: boolean = false): string => {
    const vw = visibleWidth(s);
    if (vw <= w) {
        return pad ? s + ' '.repeat(Math.max(0, w - vw)) : s;
    }
    // Truncation needed – strip ANSI and truncate by visible width
    const clean = stripAnsiInternal(s);
    const ellipsisW = visibleWidth(ellipsis);
    const targetW = Math.max(0, w - ellipsisW);
    let result = '';
    let currentW = 0;
    for (const { segment } of _segmenter.segment(clean)) {
        const segW = _graphemeWidth(segment);
        if (currentW + segW > targetW) break;
        result += segment;
        currentW += segW;
    }
    const truncated = result + (currentW < vw ? ellipsis : '');
    if (pad) {
        const truncatedW = visibleWidth(truncated);
        return truncated + ' '.repeat(Math.max(0, w - truncatedW));
    }
    return truncated;
};
export const wrapTextWithAnsi = (s: string, _w: number) => [s];
export const isKeyRelease = () => false;

// --- Event/Input ---
export const parseKey = (value: string) => value;
const rawCtrlChar = (key: string): string | undefined => {
    if (!/^[a-z]$/.test(key)) return undefined;
    return String.fromCharCode(key.charCodeAt(0) - 96);
};
export const matchesKey = (value: unknown, key: unknown) => {
    if (value === key) return true;
    if (typeof value === 'string' && typeof key === 'string' && key.startsWith('ctrl+')) {
        return value === rawCtrlChar(key.slice('ctrl+'.length));
    }
    return false;
};
export const TUI_KEYBINDINGS: Record<string, string | string[]> = {
    'tui.editor.deleteCharBackward': 'backspace',
    'tui.editor.newLine': 'shift+enter',
    'tui.editor.submit': 'enter',
    'tui.editor.tab': 'tab',
    'tui.select.up': 'up',
    'tui.select.down': 'down',
    'tui.select.pageUp': 'pageUp',
    'tui.select.pageDown': 'pageDown',
    'tui.select.confirm': 'enter',
    'tui.select.cancel': ['escape', 'ctrl+c']
};

export class KeybindingsManager {
    private actionToKeys = new Map<string, string[]>();

    constructor(
        defaults: Record<string, string | string[]> = TUI_KEYBINDINGS,
        overrides: Record<string, string | string[]> = {}
    ) {
        for (const [action, keys] of Object.entries({ ...defaults, ...overrides })) {
            this.actionToKeys.set(action, Array.isArray(keys) ? keys : [keys]);
        }
    }

    matches(data: string, action: string): boolean {
        return (this.actionToKeys.get(action) ?? []).some((key) => matchesKey(data, key));
    }
}

let keybindings = new KeybindingsManager();
export const getKeybindings = () => keybindings;
export const setKeybindings = (manager: KeybindingsManager) => {
    keybindings = manager;
};
export const getEditorKeybindings = getKeybindings;

// --- Core classes ---
export class Component {
    invalidate() {}

    render(_width: number): string[] {
        return [];
    }
}

export class Box extends Component {
    private children: Component[] = [];
    private bgFn: ((text: string) => string) | undefined;

    constructor(
        public width = 0,
        public height = 0
    ) {
        super();
    }

    addChild(child: Component) {
        this.children.push(child);
    }

    removeChild(child: Component) {
        this.children = this.children.filter((candidate) => candidate !== child);
    }

    clear() {
        this.children = [];
    }

    setBgFn(fn: (text: string) => string) {
        this.bgFn = fn;
    }

    render(width: number): string[] {
        const lines = this.children.flatMap((child) => child.render(width));
        return this.bgFn ? lines.map((line) => this.bgFn!(line)) : lines;
    }
}

export class Text extends Component {
    constructor(private text = '') {
        super();
    }

    setText(text: string) {
        this.text = text;
    }

    render(_width: number): string[] {
        return [this.text];
    }
}

export class SelectList extends Component {
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    selectedIndex = 0;

    constructor(
        public items: any[] = [],
        public visibleItems = items.length,
        public theme?: unknown
    ) {
        super();
    }

    setItems(items: any[]) {
        this.items = items;
    }

    getSelectedItem() {
        return this.items[this.selectedIndex];
    }

    render(_width: number): string[] {
        return this.items.map((item) => String(item?.label ?? item?.value ?? item));
    }
}

export class Loader extends Component {}
export class Markdown extends Text {}
export class Input extends Component {
    focused = false;
    private value = '';

    getValue() {
        return this.value;
    }

    setValue(value: string) {
        this.value = value;
    }

    render(_width: number): string[] {
        return [`> ${this.value}`];
    }
}
export class Editor extends Markdown {
    focused = false;
    borderColor = (text: string) => text;
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;
    disableSubmit = false;
    private value = '';

    constructor(..._args: any[]) {
        super('');
    }

    setText(text: string) {
        this.value = text;
        super.setText(text);
        this.onChange?.(text);
    }

    getText() {
        return this.value;
    }

    addToHistory(_text: string) {}

    setAutocompleteProvider(_provider: unknown) {}

    handleInput(data: string) {
        if (data.length > 0 && data.charCodeAt(0) >= 32) {
            this.setText(this.value + data);
        }
    }

    cancelAutocomplete() {}
}

// --- System ---
export class ProcessTerminal {}
export class TUI {
    terminal = { rows: 40, columns: 120 };

    requestRender(_force?: boolean) {}

    setFocus(_component: unknown) {}

    addChild(_component: unknown) {}

    addInputListener(_listener: unknown) {
        return () => {};
    }

    start() {}
}
export class OverlayHandle {}

// --- Key handling ---
export const Key = {
    ctrl: (key: string) => `ctrl+${key}`,
    shift: (key: string) => `shift+${key}`,
    alt: (key: string) => `alt+${key}`
};
export type KeyId = string;

// --- Autocomplete ---
export class CombinedAutocompleteProvider {}
export class SlashCommand {}
export class AutocompleteProvider {}
export type AutocompleteItem = any;

// --- Editor ---
export class EditorKeybindingsManager {}
export const setEditorKeybindings = setKeybindings;

// --- Theme types ---
export const EditorTheme = {};
export const MarkdownTheme = {};
export const SelectListTheme = {};

// --- List/Select ---
export type SelectItem = any;
