# pi-tui non-direct API type contract diff

Old package: `@mariozechner/pi-tui@0.58.4`
New package: `@earendil-works/pi-tui@0.80.3`

| Rule                        | Type classification                        | Old symbol declarations                                                                                                                                                                                  | New symbol declarations                                                                                                                                                                                  | Old declaration files                                                                                                                 | New declaration files                                                                                                                 |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| autocomplete-item           | symbol-declaration-identical               | AutocompleteItem:dist/autocomplete.d.ts:23d25193f651acde                                                                                                                                                 | AutocompleteItem:dist/autocomplete.d.ts:23d25193f651acde                                                                                                                                                 | dist/autocomplete.d.ts:d154b73f77a58697                                                                                               | dist/autocomplete.d.ts:a815b90761216f34                                                                                               |
| box-component               | symbol-declaration-identical               | Box:dist/components/box.d.ts:0556b7307dd719fb                                                                                                                                                            | Box:dist/components/box.d.ts:0556b7307dd719fb                                                                                                                                                            | dist/components/box.d.ts:4052d49a961488c5                                                                                             | dist/components/box.d.ts:fa3c2e4d2a9ecccb                                                                                             |
| component-interface         | symbol-declaration-identical               | Component:dist/tui.d.ts:ff4d267cb5d04c16                                                                                                                                                                 | Component:dist/tui.d.ts:ff4d267cb5d04c16                                                                                                                                                                 | dist/tui.d.ts:f7bfb5d36739de24                                                                                                        | dist/tui.d.ts:65dd54f44921448f                                                                                                        |
| editor-component            | symbol-declaration-identical               | Editor:dist/components/editor.d.ts:44548733789f559b<br>Editor:dist/editor-component.d.ts:66cd4b9336e7d7f1                                                                                                | Editor:dist/components/editor.d.ts:44548733789f559b<br>Editor:dist/editor-component.d.ts:66cd4b9336e7d7f1                                                                                                | dist/components/editor.d.ts:caa35b686ac63837<br>dist/editor-component.d.ts:9b4a09542311b06e                                           | dist/components/editor.d.ts:fc3b400c5c965e49<br>dist/editor-component.d.ts:5de081a8879f096e                                           |
| editor-theme                | symbol-declaration-identical               | EditorTheme:dist/components/editor.d.ts:44548733789f559b                                                                                                                                                 | EditorTheme:dist/components/editor.d.ts:44548733789f559b                                                                                                                                                 | dist/components/editor.d.ts:caa35b686ac63837                                                                                          | dist/components/editor.d.ts:fc3b400c5c965e49                                                                                          |
| focusable-interface         | symbol-declaration-identical               | Focusable:dist/tui.d.ts:528d4b8fdcb06f4a<br>CURSOR_MARKER:dist/tui.d.ts:a8249cf0a27fe4c6                                                                                                                 | Focusable:dist/tui.d.ts:528d4b8fdcb06f4a<br>CURSOR_MARKER:dist/tui.d.ts:a8249cf0a27fe4c6                                                                                                                 | dist/tui.d.ts:f7bfb5d36739de24                                                                                                        | dist/tui.d.ts:65dd54f44921448f                                                                                                        |
| input-component             | symbol-declaration-identical               | Input:dist/components/input.d.ts:b9cc6661d397bede                                                                                                                                                        | Input:dist/components/input.d.ts:b9cc6661d397bede                                                                                                                                                        | dist/components/input.d.ts:758021d6da682e45                                                                                           | dist/components/input.d.ts:f2a2bab62c83d6e4                                                                                           |
| key-helper                  | symbol-declaration-changed-review-required | Key:dist/keys.d.ts:12a7e1936ad06c9d                                                                                                                                                                      | Key:dist/keys.d.ts:bb8985c53d0fe248                                                                                                                                                                      | dist/keys.d.ts:fa04a432b2ff3fc4                                                                                                       | dist/keys.d.ts:58d05b6227c8657e                                                                                                       |
| key-id-type                 | symbol-declaration-changed-review-required | KeyId:dist/keys.d.ts:12a7e1936ad06c9d                                                                                                                                                                    | KeyId:dist/keys.d.ts:bb8985c53d0fe248                                                                                                                                                                    | dist/keys.d.ts:fa04a432b2ff3fc4                                                                                                       | dist/keys.d.ts:58d05b6227c8657e                                                                                                       |
| loader-component            | symbol-declaration-changed-review-required | Loader:dist/components/loader.d.ts:976251f9a207f740<br>Loader:dist/components/cancellable-loader.d.ts:2a5f4ae3a2489303<br>CancellableLoader:dist/components/cancellable-loader.d.ts:12fade00c4c2e45e     | Loader:dist/components/loader.d.ts:e318d316ff9838ec<br>Loader:dist/components/cancellable-loader.d.ts:f9b972d97b92dbb0<br>CancellableLoader:dist/components/cancellable-loader.d.ts:12fade00c4c2e45e     | dist/components/loader.d.ts:ccfad070b8d78965<br>dist/components/cancellable-loader.d.ts:dd75e53991f686cb                              | dist/components/loader.d.ts:bc143de7a72f27e9<br>dist/components/cancellable-loader.d.ts:d2e79d87e3a5e41c                              |
| markdown-component          | symbol-declaration-identical               | Markdown:dist/components/markdown.d.ts:0b2c77f193c87929                                                                                                                                                  | Markdown:dist/components/markdown.d.ts:0b2c77f193c87929                                                                                                                                                  | dist/components/markdown.d.ts:f9bc0eeddae9c6a3                                                                                        | dist/components/markdown.d.ts:b877d6ef2033c4e0                                                                                        |
| markdown-theme              | symbol-declaration-identical               | MarkdownTheme:dist/components/markdown.d.ts:0b2c77f193c87929                                                                                                                                             | MarkdownTheme:dist/components/markdown.d.ts:0b2c77f193c87929                                                                                                                                             | dist/components/markdown.d.ts:f9bc0eeddae9c6a3                                                                                        | dist/components/markdown.d.ts:b877d6ef2033c4e0                                                                                        |
| overlay-handle              | symbol-declaration-changed-review-required | OverlayHandle:dist/tui.d.ts:62228a3b7b45859d                                                                                                                                                             | OverlayHandle:dist/tui.d.ts:7c3c078209ef8e6c                                                                                                                                                             | dist/tui.d.ts:f7bfb5d36739de24                                                                                                        | dist/tui.d.ts:65dd54f44921448f                                                                                                        |
| process-terminal            | symbol-declaration-changed-review-required | ProcessTerminal:dist/terminal.d.ts:8995e29c02cef98f                                                                                                                                                      | ProcessTerminal:dist/terminal.d.ts:c9ed4071f5a102cc                                                                                                                                                      | dist/terminal.d.ts:8087de53e26ac0a9                                                                                                   | dist/terminal.d.ts:f9e6abc6aa350c2f                                                                                                   |
| select-item-type            | symbol-declaration-identical               | SelectItem:dist/components/select-list.d.ts:e5a201069ddc9874                                                                                                                                             | SelectItem:dist/components/select-list.d.ts:e5a201069ddc9874                                                                                                                                             | dist/components/select-list.d.ts:c171ec0168a1966d                                                                                     | dist/components/select-list.d.ts:885ce3c876841d9c                                                                                     |
| select-list-component       | symbol-declaration-identical               | SelectList:dist/components/select-list.d.ts:080a9fb1dcefdf2d                                                                                                                                             | SelectList:dist/components/select-list.d.ts:080a9fb1dcefdf2d                                                                                                                                             | dist/components/select-list.d.ts:c171ec0168a1966d                                                                                     | dist/components/select-list.d.ts:885ce3c876841d9c                                                                                     |
| select-list-theme           | symbol-declaration-identical               | SelectListTheme:dist/components/select-list.d.ts:080a9fb1dcefdf2d                                                                                                                                        | SelectListTheme:dist/components/select-list.d.ts:080a9fb1dcefdf2d                                                                                                                                        | dist/components/select-list.d.ts:c171ec0168a1966d                                                                                     | dist/components/select-list.d.ts:885ce3c876841d9c                                                                                     |
| slash-command-type          | symbol-declaration-changed-review-required | SlashCommand:dist/autocomplete.d.ts:0c6aaacf8675c6cf                                                                                                                                                     | SlashCommand:dist/autocomplete.d.ts:06493948e9b9afd3                                                                                                                                                     | dist/autocomplete.d.ts:d154b73f77a58697                                                                                               | dist/autocomplete.d.ts:a815b90761216f34                                                                                               |
| tui-class                   | symbol-declaration-changed-review-required | TUI:dist/tui.d.ts:1f87acd93a299c17                                                                                                                                                                       | TUI:dist/tui.d.ts:6f145b4fe1731e2a                                                                                                                                                                       | dist/tui.d.ts:f7bfb5d36739de24                                                                                                        | dist/tui.d.ts:65dd54f44921448f                                                                                                        |
| terminal-type               | symbol-declaration-changed-review-required | Terminal:dist/terminal.d.ts:59abd22d27c986d5                                                                                                                                                             | Terminal:dist/terminal.d.ts:75ecd5d6b84b8291                                                                                                                                                             | dist/terminal.d.ts:8087de53e26ac0a9                                                                                                   | dist/terminal.d.ts:f9e6abc6aa350c2f                                                                                                   |
| text-component              | symbol-declaration-identical               | Text:dist/components/text.d.ts:a0c3a79c7f5fbb3b                                                                                                                                                          | Text:dist/components/text.d.ts:a0c3a79c7f5fbb3b                                                                                                                                                          | dist/components/text.d.ts:a4e6f13012d5e4f8                                                                                            | dist/components/text.d.ts:fc0566f2753fd994                                                                                            |
| is-key-release              | symbol-declaration-identical               | isKeyRelease:dist/keys.d.ts:4223c08b95080670                                                                                                                                                             | isKeyRelease:dist/keys.d.ts:4223c08b95080670                                                                                                                                                             | dist/keys.d.ts:fa04a432b2ff3fc4                                                                                                       | dist/keys.d.ts:58d05b6227c8657e                                                                                                       |
| matches-key                 | symbol-declaration-identical               | matchesKey:dist/keys.d.ts:4b168ec2f0fff9b3                                                                                                                                                               | matchesKey:dist/keys.d.ts:4b168ec2f0fff9b3                                                                                                                                                               | dist/keys.d.ts:fa04a432b2ff3fc4                                                                                                       | dist/keys.d.ts:58d05b6227c8657e                                                                                                       |
| parse-key                   | symbol-declaration-identical               | parseKey:dist/keys.d.ts:864418405cfea81a                                                                                                                                                                 | parseKey:dist/keys.d.ts:864418405cfea81a                                                                                                                                                                 | dist/keys.d.ts:fa04a432b2ff3fc4                                                                                                       | dist/keys.d.ts:58d05b6227c8657e                                                                                                       |
| package-scope-import        | type-file-identical                        | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          |                                                                                                                                       |                                                                                                                                       |
| action-delete-char-backward | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/editor.d.ts:caa35b686ac63837                                                | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/editor.d.ts:fc3b400c5c965e49                                                |
| action-select-up            | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/select-list.d.ts:c171ec0168a1966d                                           | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/select-list.d.ts:885ce3c876841d9c                                           |
| action-select-down          | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/select-list.d.ts:c171ec0168a1966d                                           | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/select-list.d.ts:885ce3c876841d9c                                           |
| action-select-page-up       | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/select-list.d.ts:c171ec0168a1966d                                           | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/select-list.d.ts:885ce3c876841d9c                                           |
| action-select-page-down     | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/select-list.d.ts:c171ec0168a1966d                                           | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/select-list.d.ts:885ce3c876841d9c                                           |
| action-select-confirm       | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/select-list.d.ts:c171ec0168a1966d                                           | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/select-list.d.ts:885ce3c876841d9c                                           |
| action-select-cancel        | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/select-list.d.ts:c171ec0168a1966d                                           | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/select-list.d.ts:885ce3c876841d9c                                           |
| action-input-newline        | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/input.d.ts:758021d6da682e45<br>dist/components/editor.d.ts:caa35b686ac63837 | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/input.d.ts:f2a2bab62c83d6e4<br>dist/components/editor.d.ts:fc3b400c5c965e49 |
| action-input-submit         | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/input.d.ts:758021d6da682e45<br>dist/components/editor.d.ts:caa35b686ac63837 | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/input.d.ts:f2a2bab62c83d6e4<br>dist/components/editor.d.ts:fc3b400c5c965e49 |
| action-input-tab            | keybinding-id-changed                      | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          | dist/keybindings.d.ts:820dc5eb9c408850<br>dist/components/input.d.ts:758021d6da682e45<br>dist/components/editor.d.ts:caa35b686ac63837 | dist/keybindings.d.ts:318012f5c89583f9<br>dist/components/input.d.ts:f2a2bab62c83d6e4<br>dist/components/editor.d.ts:fc3b400c5c965e49 |
| rendering-utils             | symbol-declaration-identical               | visibleWidth:dist/utils.d.ts:ff5227d927901971<br>truncateToWidth:dist/utils.d.ts:ac6c365fc166deaf<br>wrapTextWithAnsi:dist/utils.d.ts:d85d72acc2d9c426<br>sliceByColumn:dist/utils.d.ts:f81e15732dc355a2 | visibleWidth:dist/utils.d.ts:ff5227d927901971<br>truncateToWidth:dist/utils.d.ts:ac6c365fc166deaf<br>wrapTextWithAnsi:dist/utils.d.ts:d85d72acc2d9c426<br>sliceByColumn:dist/utils.d.ts:f81e15732dc355a2 | dist/utils.d.ts:14cb0859f970a540                                                                                                      | dist/utils.d.ts:acd953a807848c55                                                                                                      |
| overlay-focus               | symbol-declaration-changed-review-required | OverlayHandle:dist/tui.d.ts:62228a3b7b45859d                                                                                                                                                             | OverlayHandle:dist/tui.d.ts:7c3c078209ef8e6c                                                                                                                                                             | dist/tui.d.ts:f7bfb5d36739de24                                                                                                        | dist/tui.d.ts:65dd54f44921448f                                                                                                        |
| jest-mocks                  | type-file-identical                        | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          |                                                                                                                                       |                                                                                                                                       |
| documentation-references    | type-file-identical                        | no symbol declaration extracted                                                                                                                                                                          | no symbol declaration extracted                                                                                                                                                                          |                                                                                                                                       |                                                                                                                                       |

Classification notes:

- `symbol-declaration-identical`: extracted declaration snippets for mapped symbols are identical.
- `symbol-declaration-changed-review-required`: extracted declaration snippets changed; behavior evidence or explicit replacement mapping is required.
- `type-file-identical`: the relevant declaration file hash did not change.
- `type-file-changed-review-required`: the declaration file changed; behavior evidence or explicit replacement mapping is required.
- `keybinding-id-changed`: old action labels were replaced by namespaced keybinding ids.
- `removed-or-replaced`: old helper export was removed by upstream and mapped to the new API.

## Declaration excerpts

### editor-component

Type classification: `symbol-declaration-identical`

Old declarations:

```ts
// Editor dist/components/editor.d.ts 44548733789f559b
export interface EditorTheme {
    borderColor: (str: string) => string;
    selectList: SelectListTheme;
}

// Editor dist/editor-component.d.ts 66cd4b9336e7d7f1
export interface EditorComponent extends Component {
    /** Get the current text content */
    getText(): string;
    /** Set the text content */
    setText(text: string): void;
    /** Handle raw terminal input (key presses, paste sequences, etc.) */
    handleInput(data: string): void;
    /** Called when user submits (e.g., Enter key) */
    onSubmit?: (text: string) => void;
    /** Called when text changes */
    onChange?: (text: string) => void;
    /** Add text to history for up/down navigation */
    addToHistory?(text: string): void;
    /** Insert text at current cursor position */
    insertTextAtCursor?(text: string): void;
    /**
     * Get text with any markers expanded (e.g., paste markers).
     * Falls back to getText() if not implemented.
     */
    getExpandedText?(): string;
    /** Set the autocomplete provider */
    setAutocompleteProvider?(provider: AutocompleteProvider): void;
    /** Border color function */
    borderColor?: (str: string) => string;
    /** Set horizontal padding */
    setPaddingX?(padding: number): void;
    /** Set max visible items in autocomplete dropdown */
    setAutocompleteMaxVisible?(maxVisible: number): void;
}
```

New declarations:

```ts
// Editor dist/components/editor.d.ts 44548733789f559b
export interface EditorTheme {
    borderColor: (str: string) => string;
    selectList: SelectListTheme;
}

// Editor dist/editor-component.d.ts 66cd4b9336e7d7f1
export interface EditorComponent extends Component {
    /** Get the current text content */
    getText(): string;
    /** Set the text content */
    setText(text: string): void;
    /** Handle raw terminal input (key presses, paste sequences, etc.) */
    handleInput(data: string): void;
    /** Called when user submits (e.g., Enter key) */
    onSubmit?: (text: string) => void;
    /** Called when text changes */
    onChange?: (text: string) => void;
    /** Add text to history for up/down navigation */
    addToHistory?(text: string): void;
    /** Insert text at current cursor position */
    insertTextAtCursor?(text: string): void;
    /**
     * Get text with any markers expanded (e.g., paste markers).
     * Falls back to getText() if not implemented.
     */
    getExpandedText?(): string;
    /** Set the autocomplete provider */
    setAutocompleteProvider?(provider: AutocompleteProvider): void;
    /** Border color function */
    borderColor?: (str: string) => string;
    /** Set horizontal padding */
    setPaddingX?(padding: number): void;
    /** Set max visible items in autocomplete dropdown */
    setAutocompleteMaxVisible?(maxVisible: number): void;
}
```

### input-component

Type classification: `symbol-declaration-identical`

Old declarations:

```ts
// Input dist/components/input.d.ts b9cc6661d397bede
export declare class Input implements Component, Focusable {
    private value;
    private cursor;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    /** Focusable interface - set by TUI when focus changes */
    focused: boolean;
    private pasteBuffer;
    private isInPaste;
    private killRing;
    private lastAction;
    private undoStack;
    getValue(): string;
    setValue(value: string): void;
    handleInput(data: string): void;
    private insertCharacter;
    private handleBackspace;
    private handleForwardDelete;
    private deleteToLineStart;
    private deleteToLineEnd;
    private deleteWordBackwards;
    private deleteWordForward;
    private yank;
    private yankPop;
    private pushUndo;
    private undo;
    private moveWordBackwards;
    private moveWordForwards;
    private handlePaste;
    invalidate(): void;
    render(width: number): string[];
}
```

New declarations:

```ts
// Input dist/components/input.d.ts b9cc6661d397bede
export declare class Input implements Component, Focusable {
    private value;
    private cursor;
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    /** Focusable interface - set by TUI when focus changes */
    focused: boolean;
    private pasteBuffer;
    private isInPaste;
    private killRing;
    private lastAction;
    private undoStack;
    getValue(): string;
    setValue(value: string): void;
    handleInput(data: string): void;
    private insertCharacter;
    private handleBackspace;
    private handleForwardDelete;
    private deleteToLineStart;
    private deleteToLineEnd;
    private deleteWordBackwards;
    private deleteWordForward;
    private yank;
    private yankPop;
    private pushUndo;
    private undo;
    private moveWordBackwards;
    private moveWordForwards;
    private handlePaste;
    invalidate(): void;
    render(width: number): string[];
}
```

### key-helper

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// Key dist/keys.d.ts 12a7e1936ad06c9d
export type KeyId =
    | BaseKey
    | `ctrl+${BaseKey}`
    | `shift+${BaseKey}`
    | `alt+${BaseKey}`
    | `ctrl+shift+${BaseKey}`
    | `shift+ctrl+${BaseKey}`
    | `ctrl+alt+${BaseKey}`
    | `alt+ctrl+${BaseKey}`
    | `shift+alt+${BaseKey}`
    | `alt+shift+${BaseKey}`
    | `ctrl+shift+alt+${BaseKey}`
    | `ctrl+alt+shift+${BaseKey}`
    | `shift+ctrl+alt+${BaseKey}`
    | `shift+alt+ctrl+${BaseKey}`
    | `alt+ctrl+shift+${BaseKey}`
    | `alt+shift+ctrl+${BaseKey}`;
```

New declarations:

```ts
// Key dist/keys.d.ts bb8985c53d0fe248
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;
```

### key-id-type

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// KeyId dist/keys.d.ts 12a7e1936ad06c9d
export type KeyId =
    | BaseKey
    | `ctrl+${BaseKey}`
    | `shift+${BaseKey}`
    | `alt+${BaseKey}`
    | `ctrl+shift+${BaseKey}`
    | `shift+ctrl+${BaseKey}`
    | `ctrl+alt+${BaseKey}`
    | `alt+ctrl+${BaseKey}`
    | `shift+alt+${BaseKey}`
    | `alt+shift+${BaseKey}`
    | `ctrl+shift+alt+${BaseKey}`
    | `ctrl+alt+shift+${BaseKey}`
    | `shift+ctrl+alt+${BaseKey}`
    | `shift+alt+ctrl+${BaseKey}`
    | `alt+ctrl+shift+${BaseKey}`
    | `alt+shift+ctrl+${BaseKey}`;
```

New declarations:

```ts
// KeyId dist/keys.d.ts bb8985c53d0fe248
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;
```

### loader-component

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// Loader dist/components/loader.d.ts 976251f9a207f740
export declare class Loader extends Text {
    private spinnerColorFn;
    private messageColorFn;
    private message;
    private frames;
    private currentFrame;
    private intervalId;
    private ui;
    constructor(
        ui: TUI,
        spinnerColorFn: (str: string) => string,
        messageColorFn: (str: string) => string,
        message?: string
    );
    render(width: number): string[];
    start(): void;
    stop(): void;
    setMessage(message: string): void;
    private updateDisplay;
}

// Loader dist/components/cancellable-loader.d.ts 2a5f4ae3a2489303
import { Loader } from './loader.js';

// CancellableLoader dist/components/cancellable-loader.d.ts 12fade00c4c2e45e
export declare class CancellableLoader extends Loader {
    private abortController;
    /** Called when user presses Escape */
    onAbort?: () => void;
    /** AbortSignal that is aborted when user presses Escape */
    get signal(): AbortSignal;
    /** Whether the loader was aborted */
    get aborted(): boolean;
    handleInput(data: string): void;
    dispose(): void;
}
```

New declarations:

```ts
// Loader dist/components/loader.d.ts e318d316ff9838ec
export interface LoaderIndicatorOptions {
    /** Animation frames. Use an empty array to hide the indicator. */
    frames?: string[];
    /** Frame interval in milliseconds for animated indicators. */
    intervalMs?: number;
}

// Loader dist/components/cancellable-loader.d.ts f9b972d97b92dbb0
import { Loader } from './loader.ts';

// CancellableLoader dist/components/cancellable-loader.d.ts 12fade00c4c2e45e
export declare class CancellableLoader extends Loader {
    private abortController;
    /** Called when user presses Escape */
    onAbort?: () => void;
    /** AbortSignal that is aborted when user presses Escape */
    get signal(): AbortSignal;
    /** Whether the loader was aborted */
    get aborted(): boolean;
    handleInput(data: string): void;
    dispose(): void;
}
```

### overlay-handle

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// OverlayHandle dist/tui.d.ts 62228a3b7b45859d
export interface OverlayHandle {
    /** Permanently remove the overlay (cannot be shown again) */
    hide(): void;
    /** Temporarily hide or show the overlay */
    setHidden(hidden: boolean): void;
    /** Check if overlay is temporarily hidden */
    isHidden(): boolean;
    /** Focus this overlay and bring it to the visual front */
    focus(): void;
    /** Release focus to the previous target */
    unfocus(): void;
    /** Check if this overlay currently has focus */
    isFocused(): boolean;
}
```

New declarations:

```ts
// OverlayHandle dist/tui.d.ts 7c3c078209ef8e6c
export interface OverlayHandle {
    /** Permanently remove the overlay (cannot be shown again) */
    hide(): void;
    /** Temporarily hide or show the overlay */
    setHidden(hidden: boolean): void;
    /** Check if overlay is temporarily hidden */
    isHidden(): boolean;
    /** Focus this overlay and bring it to the visual front */
    focus(): void;
    /** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
    unfocus(options?: OverlayUnfocusOptions): void;
    /** Check if this overlay currently has focus */
    isFocused(): boolean;
}
```

### process-terminal

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// ProcessTerminal dist/terminal.d.ts 8995e29c02cef98f
export declare class ProcessTerminal implements Terminal {
    private wasRaw;
    private inputHandler?;
    private resizeHandler?;
    private _kittyProtocolActive;
    private _modifyOtherKeysActive;
    private stdinBuffer?;
    private stdinDataHandler?;
    private writeLogPath;
    get kittyProtocolActive(): boolean;
    start(onInput: (data: string) => void, onResize: () => void): void;
    /**
     * Set up StdinBuffer to split batched input into individual sequences.
     * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
     *
     * Also watches for Kitty protocol response and enables it when detected.
     * This is done here (after stdinBuffer parsing) rather than on raw stdin
     * to handle the case where the response arrives split across multiple events.
     */
    private setupStdinBuffer;
    /**
     * Query terminal for Kitty keyboard protocol support and enable if available.
     *
     * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
     * it supports the protocol and we enable it with CSI > 1 u.
     *
     * If no Kitty response arrives shortly after startup, fall back to enabling
     * xterm modifyOtherKeys mode 2. This is needed for tmux, which can forward
     * modified enter keys as CSI-u when extended-keys is enabled, but may not
     * answer the Kitty protocol query.
     *
     * The response is detected in setupStdinBuffer's data handler, which properly
     * handles the case where the response arrives split across multiple stdin events.
     */
    private queryAndEnableKittyProtocol;
    /**
     * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
     * console handle so the terminal sends VT sequences for modified keys
     * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
     * discards modifier state and Shift+Tab arrives as plain \t.
     */
    private enableWindowsVTInput;
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
    stop(): void;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
}
```

New declarations:

```ts
// ProcessTerminal dist/terminal.d.ts c9ed4071f5a102cc
export declare class ProcessTerminal implements Terminal {
    private wasRaw;
    private inputHandler?;
    private resizeHandler?;
    private _kittyProtocolActive;
    private _modifyOtherKeysActive;
    private keyboardProtocolPushed;
    private keyboardProtocolNegotiationBuffer;
    private keyboardProtocolBufferFlushTimer?;
    private stdinBuffer?;
    private stdinDataHandler?;
    private progressInterval?;
    private writeLogPath;
    get kittyProtocolActive(): boolean;
    get modifyOtherKeysActive(): boolean;
    start(onInput: (data: string) => void, onResize: () => void): void;
    /**
     * Set up StdinBuffer to split batched input into individual sequences.
     * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
     *
     * Also watches for Kitty protocol response and enables it when detected.
     * This is done here (after stdinBuffer parsing) rather than on raw stdin
     * to handle the case where the response arrives split across multiple events.
     */
    private setupStdinBuffer;
    /**
     * Query terminal for Kitty keyboard protocol support and enable it if available.
     *
     * Kitty's progressive enhancement detection requires requesting the desired
     * flags before querying them. The trailing DA query is a sentinel supported by
     * terminals that do not know Kitty keyboard protocol; receiving DA before a
     * Kitty response enables modifyOtherKeys fallback without a startup timeout.
     *
     * The requested flags are:
     * - 1 = disambiguate escape codes
     * - 2 = report event types (press/repeat/release)
     * - 4 = report alternate keys (shifted key, base layout key)
     */
    private queryAndEnableKittyProtocol;
    private handleKeyboardProtocolNegotiationSequence;
    private readKeyboardProtocolNegotiationSequence;
    private setKeyboardProtocolNegotiationBuffer;
    private clearKeyboardProtocolNegotiationBuffer;
    private flushKeyboardProtocolNegotiationBufferAsInput;
    private scheduleKeyboardProtocolNegotiationBufferFlush;
    private clearKeyboardProtocolNegotiationBufferFlushTimer;
    private forwardInputSequence;
    private enableModifyOtherKeys;
    private disableModifyOtherKeys;
    /**
     * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
     * console handle so the terminal sends VT sequences for modified keys
     * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
     * discards modifier state and Shift+Tab arrives as plain \t.
     */
    private enableWindowsVTInput;
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
    stop(): void;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
    setProgress(active: boolean): void;
    private clearProgressInterval;
}
```

### select-list-component

Type classification: `symbol-declaration-identical`

Old declarations:

```ts
// SelectList dist/components/select-list.d.ts 080a9fb1dcefdf2d
export interface SelectListTheme {
    selectedPrefix: (text: string) => string;
    selectedText: (text: string) => string;
    description: (text: string) => string;
    scrollInfo: (text: string) => string;
    noMatch: (text: string) => string;
}
```

New declarations:

```ts
// SelectList dist/components/select-list.d.ts 080a9fb1dcefdf2d
export interface SelectListTheme {
    selectedPrefix: (text: string) => string;
    selectedText: (text: string) => string;
    description: (text: string) => string;
    scrollInfo: (text: string) => string;
    noMatch: (text: string) => string;
}
```

### slash-command-type

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// SlashCommand dist/autocomplete.d.ts 0c6aaacf8675c6cf
export interface SlashCommand {
    name: string;
    description?: string;
    getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}
```

New declarations:

```ts
// SlashCommand dist/autocomplete.d.ts 06493948e9b9afd3
export interface SlashCommand {
    name: string;
    description?: string;
    argumentHint?: string;
    getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}
```

### tui-class

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// TUI dist/tui.d.ts 1f87acd93a299c17
export declare class TUI extends Container {
    terminal: Terminal;
    private previousLines;
    private previousWidth;
    private previousHeight;
    private focusedComponent;
    private inputListeners;
    /** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
    onDebug?: () => void;
    private renderRequested;
    private cursorRow;
    private hardwareCursorRow;
    private inputBuffer;
    private cellSizeQueryPending;
    private showHardwareCursor;
    private clearOnShrink;
    private maxLinesRendered;
    private previousViewportTop;
    private fullRedrawCount;
    private stopped;
    private focusOrderCounter;
    private overlayStack;
    constructor(terminal: Terminal, showHardwareCursor?: boolean);
    get fullRedraws(): number;
    getShowHardwareCursor(): boolean;
    setShowHardwareCursor(enabled: boolean): void;
    getClearOnShrink(): boolean;
    /**
     * Set whether to trigger full re-render when content shrinks.
     * When true (default), empty rows are cleared when content shrinks.
     * When false, empty rows remain (reduces redraws on slower terminals).
     */
    setClearOnShrink(enabled: boolean): void;
    setFocus(component: Component | null): void;
    /**
     * Show an overlay component with configurable positioning and sizing.
     * Returns a handle to control the overlay's visibility.
     */
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
    /** Hide the topmost overlay and restore previous focus. */
    hideOverlay(): void;
    /** Check if there are any visible overlays */
    hasOverlay(): boolean;
    /** Check if an overlay entry is currently visible */
    private isOverlayVisible;
    /** Find the topmost visible capturing overlay, if any */
    private getTopmostVisibleOverlay;
    invalidate(): void;
    start(): void;
    addInputListener(listener: InputListener): () => void;
    removeInputListener(listener: InputListener): void;
    private queryCellSize;
    stop(): void;
    requestRender(force?: boolean): void;
    private handleInput;
    private parseCellSizeResponse;
    /**
     * Resolve overlay layout from options.
     * Returns { width, row, col, maxHeight } for rendering.
     */
    private resolveOverlayLayout;
    private resolveAnchorRow;
    private resolveAnchorCol;
    /** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
    private compositeOverlays;
    private static readonly SEGMENT_RESET;
    private applyLineResets;
    /** Splice overlay content into a base line at a specific column. Single-pass optimized. */
    private compositeLineAt;
    /**
     * Find and extract cursor position from rendered lines.
     * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
     * Only scans the bottom terminal height lines (visible viewport).
     * @param lines - Rendered lines to search
     * @param height - Terminal height (visible viewport size)
     * @returns Cursor position { row, col } or null if no marker found
     */
    private extractCursorPosition;
    private doRender;
    /**
```

New declarations:

```ts
// TUI dist/tui.d.ts 6f145b4fe1731e2a
export declare class TUI extends Container {
    terminal: Terminal;
    private previousLines;
    private previousKittyImageIds;
    private previousWidth;
    private previousHeight;
    private focusedComponent;
    private inputListeners;
    /** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
    onDebug?: () => void;
    private renderRequested;
    private renderTimer;
    private lastRenderAt;
    private static readonly MIN_RENDER_INTERVAL_MS;
    private cursorRow;
    private hardwareCursorRow;
    private showHardwareCursor;
    private clearOnShrink;
    private maxLinesRendered;
    private previousViewportTop;
    private fullRedrawCount;
    private stopped;
    private pendingOsc11BackgroundReplies;
    private pendingOsc11BackgroundQueries;
    private terminalColorSchemeListeners;
    private terminalColorSchemeNotificationsEnabled;
    private focusOrderCounter;
    private overlayStack;
    private overlayFocusRestore;
    constructor(terminal: Terminal, showHardwareCursor?: boolean);
    get fullRedraws(): number;
    getShowHardwareCursor(): boolean;
    setShowHardwareCursor(enabled: boolean): void;
    getClearOnShrink(): boolean;
    /**
     * Set whether to trigger full re-render when content shrinks.
     * When true (default), empty rows are cleared when content shrinks.
     * When false, empty rows remain (reduces redraws on slower terminals).
     */
    setClearOnShrink(enabled: boolean): void;
    setFocus(component: Component | null): void;
    private setFocusInternal;
    private clearOverlayFocusRestore;
    private clearOverlayFocusRestoreFor;
    private resolveBlockedOverlayFocusResume;
    private getVisibleOverlayFocusRestore;
    private isOverlayFocusAncestor;
    private retargetOverlayPreFocus;
    private isComponentMounted;
    private containsComponent;
    /**
     * Show an overlay component with configurable positioning and sizing.
     * Returns a handle to control the overlay's visibility.
     */
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
    /** Hide the topmost overlay and restore previous focus. */
    hideOverlay(): void;
    /** Check if there are any visible overlays */
    hasOverlay(): boolean;
    /** Check if an overlay entry is currently visible */
    private isOverlayVisible;
    /** Find the visual-frontmost visible capturing overlay, if any */
    private getTopmostVisibleOverlay;
    invalidate(): void;
    start(): void;
    addInputListener(listener: InputListener): () => void;
    removeInputListener(listener: InputListener): void;
    onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
    setTerminalColorSchemeNotifications(enabled: boolean): void;
    private queryCellSize;
    stop(): void;
    requestRender(force?: boolean): void;
    private scheduleRender;
    private handleInput;
    private consumeOsc11BackgroundResponse;
    private consumeTerminalColorSchemeReport;
    private consumeCellSizeResponse;
    /**
     * Resolve overlay layout from options.
     * Returns { width, row, col, maxHeight } for rendering.
```

### terminal-type

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// Terminal dist/terminal.d.ts 59abd22d27c986d5
export interface Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    /**
     * Drain stdin before exiting to prevent Kitty key release events from
     * leaking to the parent shell over slow SSH connections.
     * @param maxMs - Maximum time to drain (default: 1000ms)
     * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
     */
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    get kittyProtocolActive(): boolean;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
}
```

New declarations:

```ts
// Terminal dist/terminal.d.ts 75ecd5d6b84b8291
export interface Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    /**
     * Drain stdin before exiting to prevent Kitty key release events from
     * leaking to the parent shell over slow SSH connections.
     * @param maxMs - Maximum time to drain (default: 1000ms)
     * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
     */
    drainInput(maxMs?: number, idleMs?: number): Promise<void>;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    get kittyProtocolActive(): boolean;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
    setProgress(active: boolean): void;
}
```

### is-key-release

Type classification: `symbol-declaration-identical`

Old declarations:

```ts
// isKeyRelease dist/keys.d.ts 4223c08b95080670
export declare function isKeyRelease(data: string): boolean;
```

New declarations:

```ts
// isKeyRelease dist/keys.d.ts 4223c08b95080670
export declare function isKeyRelease(data: string): boolean;
```

### matches-key

Type classification: `symbol-declaration-identical`

Old declarations:

```ts
// matchesKey dist/keys.d.ts 4b168ec2f0fff9b3
export declare function matchesKey(data: string, keyId: KeyId): boolean;
```

New declarations:

```ts
// matchesKey dist/keys.d.ts 4b168ec2f0fff9b3
export declare function matchesKey(data: string, keyId: KeyId): boolean;
```

### parse-key

Type classification: `symbol-declaration-identical`

Old declarations:

```ts
// parseKey dist/keys.d.ts 864418405cfea81a
export declare function parseKey(data: string): string | undefined;
```

New declarations:

```ts
// parseKey dist/keys.d.ts 864418405cfea81a
export declare function parseKey(data: string): string | undefined;
```

### action-delete-char-backward

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-select-up

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-select-down

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-select-page-up

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-select-page-down

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-select-confirm

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-select-cancel

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-input-newline

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-input-submit

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### action-input-tab

Type classification: `keybinding-id-changed`

Old declarations:

```ts
No extracted declaration.
```

New declarations:

```ts
No extracted declaration.
```

### overlay-focus

Type classification: `symbol-declaration-changed-review-required`

Old declarations:

```ts
// OverlayHandle dist/tui.d.ts 62228a3b7b45859d
export interface OverlayHandle {
    /** Permanently remove the overlay (cannot be shown again) */
    hide(): void;
    /** Temporarily hide or show the overlay */
    setHidden(hidden: boolean): void;
    /** Check if overlay is temporarily hidden */
    isHidden(): boolean;
    /** Focus this overlay and bring it to the visual front */
    focus(): void;
    /** Release focus to the previous target */
    unfocus(): void;
    /** Check if this overlay currently has focus */
    isFocused(): boolean;
}
```

New declarations:

```ts
// OverlayHandle dist/tui.d.ts 7c3c078209ef8e6c
export interface OverlayHandle {
    /** Permanently remove the overlay (cannot be shown again) */
    hide(): void;
    /** Temporarily hide or show the overlay */
    setHidden(hidden: boolean): void;
    /** Check if overlay is temporarily hidden */
    isHidden(): boolean;
    /** Focus this overlay and bring it to the visual front */
    focus(): void;
    /** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
    unfocus(options?: OverlayUnfocusOptions): void;
    /** Check if this overlay currently has focus */
    isFocused(): boolean;
}
```
