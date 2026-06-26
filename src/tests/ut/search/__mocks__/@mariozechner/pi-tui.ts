/**
 * Mock for @mariozechner/pi-tui to avoid ESM parsing issues in Jest.
 */

export const visibleWidth = (s: string) => s.length;
export const truncateToWidth = (s: string, w: number) => s.slice(0, w);
export const wrapTextWithAnsi = (s: string, _w: number) => [s];
export const isKeyRelease = () => false;
export const parseKey = (value: string) => value;
export const matchesKey = (value: unknown, key: unknown) => value === key;
export const getEditorKeybindings = () => ({});

// Types (exported as values for Jest mock resolution)
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
export class Editor extends Markdown {}
export class ProcessTerminal {}
export class OverlayHandle {}

// Theme types (exported as empty objects)
export const EditorTheme = {};
export const MarkdownTheme = {};
export const SelectListTheme = {};

// TUI
export class TUI {}

// Key
export const Key = {
    ctrl: (key: string) => `ctrl+${key}`,
    shift: (key: string) => `shift+${key}`,
    alt: (key: string) => `alt+${key}`
};

// Autocomplete
export class CombinedAutocompleteProvider {}
export class SlashCommand {}
export class AutocompleteProvider {}
export type AutocompleteItem = any;
export type KeyId = string;

export class EditorKeybindingsManager {}
export const setEditorKeybindings = () => {};
export type SelectItem = any;
