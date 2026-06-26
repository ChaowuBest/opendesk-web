/**
 * Mock for @mariozechner/pi-tui to avoid ESM parsing issues in Jest.
 * All exports that are used across the codebase are mocked here.
 */

// --- Base rendering primitives ---
export const visibleWidth = (s: string) => s.length;
export const truncateToWidth = (s: string, w: number) => s.slice(0, w);
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
export const getEditorKeybindings = () => ({});

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
export const setEditorKeybindings = () => {};

// --- Theme types ---
export const EditorTheme = {};
export const MarkdownTheme = {};
export const SelectListTheme = {};

// --- List/Select ---
export type SelectItem = any;
