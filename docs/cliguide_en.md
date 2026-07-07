# OpenDesk CLI User Guide

## Table of Contents

1. [Introduction](#introduction)
2. [Quick Start](#quick-start)
3. [Agent modes](#agent-modes)
4. [TUI Overview](#tui-overview)
5. [Slash Commands](#slash-commands)
6. [Keyboard Shortcuts](#keyboard-shortcuts)
7. [Configuration](#configuration)
8. [Command-Line Options](#command-line-options)
9. [Advanced Features](#advanced-features)
10. [Developer Guide](#developer-guide)
11. [FAQ](#faq)
12. [Getting Help](#getting-help)

---

## Introduction

OpenDesk CLI is the terminal edition of OpenDesk. It provides a text-based user interface (TUI) so you can use OpenDesk without launching the full desktop app. It supports natural-language chat with the AI assistant, task management, file operations, and more.

---

## Quick Start

### Launching the CLI

From the project root:

```bash
npm run cli
```

This builds the CLI and starts the OpenDesk terminal UI.

### First-time setup

On first launch, if no model is configured you will see setup prompts. Typical steps:

1. Enter `/config` to open the settings menu
2. Choose **Model provider settings** and add a provider
3. Choose **Model settings** and add a model
4. Choose **Default model** and pick the model you want to use

After that, you are ready to use OpenDesk CLI.

---

## Agent modes

The main agent’s **mode** controls the **permission boundary** for file access, shell commands, tool calls, and related behavior. Each mode wires a different `permissionFactory` so you can trade safety for autonomy.

### How it works

- **Switch inside a session**: Change mode anytime in the TUI without restarting. Use **Shift+Tab** for the mode picker, or `/mode <id>` in the input box (see [Slash commands](#slash-commands)).
- **Set at startup**: Pass `--mode <mode>` on the CLI to set the initial mode for this process. `--allow-everything` is equivalent to `--mode unlimited` (see [Command-line options](#command-line-options)).
- **Planning workflow**: **Plan** mode is for read-only exploration plus writing only under `.plan`. After you approve a plan, you normally switch to **Standard** or **Solo** to implement it—Plan disables tools such as `editFile` and `writeFile` on the main codebase.
- **Default**: When nothing else applies, the default is **standard** (matches `defaultModeId()` in code).

### Available modes

| Mode ID     | Badge        | Summary                                                                                                                                                                                                                 |
| ----------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `standard`  | ⚡ standard  | **Default.** Free read/write inside the workspace; access outside the workspace usually requires confirmation—typical “local project assistant” behavior.                                                               |
| `plan`      | 📋 plan      | **Planning.** Read-only code exploration and read-only-style shell usage; **only `.plan` is writable** for plan documents. Cannot directly edit application source until you change mode—design first, implement later. |
| `solo`      | 🎮 solo      | **High autonomy.** Read/write inside and outside the workspace, closer to unattended operation; **sensitive paths** can still be denied by policy.                                                                      |
| `unlimited` | 🔓 unlimited | **Unrestricted.** Permission checks are effectively disabled—**highest risk**; same as `--allow-everything`.                                                                                                            |

### Switching and when to use what

- **TUI**: **Shift+Tab**, or `/mode plan`, `/mode standard`, etc.
- **CLI**: e.g. `npm run cli -- --mode plan`; composable with `-c`, `--headless`, etc.
- **Practical guidance**: Use `standard` day to day; use `plan` → then `standard`/`solo` for “spec then code”; use `solo` / `unlimited` only when you fully trust the environment and task.

---

## TUI Overview

### Layout

1. **Banner** — OpenDesk branding and current workspace
2. **Task view** — Conversation history and assistant replies
3. **Todo list** — Todos for the active task (when present)
4. **Input area** — Your prompt and status bar
5. **Log panel** — Optional log output

### Status bar

The status bar shows:

- Current model name
- Context window size
- Total tokens used in the conversation
- Task runtime

---

## Slash Commands

Type `/` in the input box to see available commands.

### Command list

| Command         | Description                                    | Usage                                                    |
| --------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `/new`          | Start a new task (optionally with a message)   | `/new [message]`                                         |
| `/switch`       | Switch to another task                         | `/switch`                                                |
| `/help`         | Shortcuts and command help                     | `/help`                                                  |
| `/exit`         | Exit OpenDesk                                  | `/exit`                                                  |
| `/quit`         | Exit with confirmation                         | `/quit`                                                  |
| `/cancel`       | Clear queued outgoing messages                 | `/cancel`                                                |
| `/clear`        | Delete all task history                        | `/clear`                                                 |
| `/export`       | Export current session to HTML                 | `/export [filename]`                                     |
| `/import`       | Import session data                            | `/import [filename]`                                     |
| `/config`       | Open settings                                  | `/config`                                                |
| `/log`          | Log panel                                      | `/log [off\|last\|all]`                                  |
| `/debug`        | Debug helpers                                  | `/debug log [on\|off]` or `/debug taskid`                |
| `/quickpass`    | Export quickpass                               | `/quickpass config base\|all`                            |
| `/dashboard`    | Open dashboard                                 | `/dashboard`                                             |
| `/stop`         | Stop the running task                          | `/stop`                                                  |
| `/upgrade`      | Check for updates                              | `/upgrade`                                               |
| `/rename`       | Rename current task                            | `/rename [new name]`                                     |
| `/fork`         | Duplicate current task                         | `/fork`                                                  |
| `/recover`      | Rebuild task list from files                   | `/recover tasks`                                         |
| `/compact`      | Compress current task context                  | `/compact`                                               |
| `/memory`       | Long-term memory                               | `/memory`                                                |
| `/bookmark`     | Bookmarks                                      | `/bookmark`                                              |
| `/notification` | Notifications                                  | `/notification`                                          |
| `/undo`         | Pick a user message to rewind into input       | `/undo`                                                  |
| `/redo`         | Restore later messages from the last `/undo`   | `/redo`                                                  |
| `/btw`          | Quick side question (no full context/tools)    | `/btw [text]`                                            |
| `/mode`         | View or switch agent mode (also **Shift+Tab**) | `/mode plan`                                             |
| `/reason`       | Reasoning depth and thinking display           | `/reason`, `/reason effort high`, `/reason display full` |
| `/manual`       | Open the user manual                           | `/manual`                                                |

### Details

#### `/new` — New task

```bash
/new Analyze this project
```

Creates a task and optionally sends the first message immediately.

#### `/switch` — Switch task

```bash
/switch
```

Opens the task picker. **Enter** selects a task; **Delete** / **Backspace** can delete the selected task (with confirmation). Hints are shown at the bottom of the panel.

#### `/export` — Export session

```bash
/export my-session.html
```

Exports HTML. If you omit the filename, a timestamped name is generated.

#### `/log` — Logs

```bash
/log all    # show all logs
/log last   # last 10 lines
/log off    # hide log panel
```

#### `/debug` — Debug

```bash
/debug log on     # enable debug logging
/debug log off    # disable debug logging
/debug log        # show debug log state
/debug taskid     # print current task id (or a notice if none)
```

#### `/quickpass` — Quickpass

```bash
/quickpass config base  # basic settings only (no app config)
/quickpass config all   # all settings (includes app config)
```

A quickpass is a special string like `[[Opendesk 快捷口令 -- <base64>]]`. Share it with another OpenDesk user; they paste it into the TUI input and submit to import.

**Export:** `/quickpass config base` or `/quickpass config all`; the string is shown in a dialog for easy copy.

**Import:** Paste the full string into the chat input and press **Enter**. If the payload is “base” only, existing app configuration is kept.

#### `/mode` — Agent mode

Use `/mode <id>` with `standard`, `plan`, `solo`, or `unlimited`, or press **Shift+Tab** for the picker. Background on modes and permissions is in [Agent modes](#agent-modes) above.

#### `/reason` — Reasoning settings

`/reason` with no arguments shows the default model’s reasoning depth and how “thinking” output is displayed.

```bash
/reason                              # show current settings
/reason effort default               # model default depth
/reason effort none|low|medium|high  # set depth for the default model
/reason display full                 # show full chain-of-thought style output
/reason display partial              # tail preview (default)
```

---

## Keyboard Shortcuts

| Shortcut   | Action                     |
| ---------- | -------------------------- |
| `Ctrl + N` | New task                   |
| `Ctrl + L` | Switch task                |
| `Ctrl + C` | Clear input or exit prompt |
| `Tab`      | Command completion         |
| `Enter`    | Submit                     |
| `↑` / `↓`  | Input history              |

---

## Configuration

### Opening settings

`/config` opens the menu where you can manage:

1. **Model providers** — Add and manage providers
2. **Models** — Add and manage model entries
3. **Default model** — Which model is selected by default

### Config files

Settings live under your user app directory; the exact path depends on the OS.

---

## Command-Line Options

OpenDesk CLI accepts:

```
opendesk [workspace] [options]
```

### Options

| Option                      | Description                                                                          | Default                    |
| --------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| `workspace`                 | Workspace directory path                                                             | Current directory (`.`)    |
| `--model <alias>`           | Model alias to use                                                                   | Configured default model   |
| `-c, --command <command>`   | Run one command and exit                                                             | None                       |
| `--headless`                | Headless mode (no TUI; requires `-c`)                                                | None                       |
| `--export-html <path>`      | After `-c` completes, export session as HTML                                         | None                       |
| `--export-json <path>`      | After `-c` completes, export session as JSON                                         | None                       |
| `--dump-log <path>`         | Write all log output to a file                                                       | None                       |
| `--profile <path>`          | Write performance profile JSON (requires `-c`)                                       | None                       |
| `--allow-everything`        | Skip permission checks; allow all operations (same as `--mode unlimited`)            | None                       |
| `--mode <mode>`             | Agent mode at startup: `standard`, `plan`, `solo`, `unlimited`                       | From config / default mode |
| `--language <lang>`         | UI strings: `auto`, `zh-CN`, `en-US` (this run only; does not change saved settings) | `auto`                     |
| `--config-directory <path>` | Custom directory for settings, tasks, and app data                                   | Default app directory      |
| `-v, --version`             | Print version                                                                        | None                       |

In addition, several **top-level subcommands** do not start the TUI—for example `plugins`, `tools`, `quickpass`, and `channels`. For the full list, run `npm run cli -- --help` or `opendesk --help` on the built binary.

### Examples

```bash
# Start in the current directory
npm run cli

# Start in a specific workspace
npm run cli -- /path/to/workspace

# Use a specific model
npm run cli -- --model gpt-4

# Run a single command
npm run cli -- -c "Analyze the code layout in this directory"

# Headless run and export session
npm run cli -- --headless -c "Fix the bug" --export-json result.json

# Performance profile
npm run cli -- -c "Refactor" --profile profile.json

# Headless + profile + log dump
npm run cli -- --headless -c "Fix the bug" --profile profile.json --dump-log debug.log

# UI language (this session only)
npm run cli -- --language en-US

# Start in plan mode (can combine with -c, etc.)
npm run cli -- --mode plan

# Custom config directory
npm run cli -- --config-directory /path/to/config
```

---

## Advanced Features

### Message queue

While the assistant is busy, you can queue more messages; they run in order when the current turn finishes.

### Todos

The assistant can maintain todos; they appear in the todo panel.

### Task switcher

Switch back to any historical task; state and todos are preserved.

In `/switch` (or `Ctrl+L`):

- **Enter** — activate selected task
- **Delete / Backspace** — delete selected task (confirm)
- **Esc** — close panel

### Channel plugins

When a channel plugin delivers a message, the UI may switch focus to the related task and show a notification with channel and sender context.

### Profiling (`--profile`)

After `-c` finishes, `--profile <path>` writes timing data (LLM vs tools, per turn, aggregates).

```bash
npm run cli -- -c "Analyze the code layout" --profile profile.json
```

#### Profile JSON shape

```json
{
    "version": 1,
    "task_id": "task_abc12345_x7yz",
    "total_ms": 45230,
    "llm_total_ms": 30120,
    "tool_total_ms": 12500,
    "overhead_ms": 2610,
    "turns": [
        {
            "turn": 0,
            "llm_ms": 15060,
            "tool_ms": 8200,
            "total_ms": 23260,
            "tool_calls": [
                { "name": "readFile", "duration_ms": 120 },
                { "name": "executeCommand", "duration_ms": 8080 }
            ]
        }
    ],
    "tool_aggregates": [
        {
            "tool_name": "executeCommand",
            "call_count": 3,
            "total_ms": 10200,
            "avg_ms": 3400,
            "min_ms": 1500,
            "max_ms": 8080
        }
    ],
    "timeline": [
        {
            "category": "llm_completion",
            "name": "streamComplete",
            "turn": 0,
            "start_ms": 1712534400000,
            "end_ms": 1712534415060,
            "duration_ms": 15060,
            "meta": { "prompt_tokens": 1200, "completion_tokens": 350 }
        }
    ]
}
```

#### Field reference

| Field             | Meaning                                    |
| ----------------- | ------------------------------------------ |
| `total_ms`        | End-to-end task time                       |
| `llm_total_ms`    | Cumulative LLM time                        |
| `tool_total_ms`   | Cumulative tool time                       |
| `overhead_ms`     | Framework overhead (= total − llm − tool)  |
| `turns`           | Per-turn LLM/tool breakdown                |
| `tool_aggregates` | Per-tool stats (count, sum, avg, min, max) |
| `timeline`        | Ordered events with timings                |

---

## Developer Guide

### Entry and build

#### Entrypoint

[`src/main/cli.ts`](src/main/cli.ts):

1. Parses CLI flags (`commander`)
2. Initializes the CLI platform
3. Configures logging transports
4. Starts the TUI (or headless runner)

#### Build

Built with `esbuild`; see [`esbuild.config.ts`](esbuild.config.ts):

- **Release** — `dist/cli/opendesk` (minified, no sourcemap)
- **Debug** — `dist/cli/opendesk-debug` (unminified, inline sourcemap)

The build injects a shebang and require shim for Node ESM.

### Architecture

#### Platform abstraction

[`src/platforms/base.ts`](src/platforms/base.ts) — `AbstractPlatform`:

```
AbstractPlatform (base)
├── CliPlatform
└── ElectronPlatform
```

#### CLI platform

[`CliPlatform`](src/platforms/cli.ts) — app registration, paths, worker paths.

#### TUI

Under [`src/main/tui/`](src/main/tui/):

- [`OpenDeskTUI`](src/main/tui/entry.ts) — main controller
- [`src/main/tui/components/`](src/main/tui/components/) — UI pieces (`taskview`, `input`, `help`, `todolist`, `config/`, …)

#### State

- [`GlobalState`](src/main/aikernel/states/global.ts)
- [`TaskManagerState`](src/main/aikernel/states/tasks.ts)

### Relationship to the Electron GUI

Shared: AI kernel ([`src/main/aikernel/`](src/main/aikernel/)), most applications, state, utilities.

| Area          | CLI           | Electron         |
| ------------- | ------------- | ---------------- |
| UI            | TUI (pi-tui)  | Web              |
| Windows       | Terminal      | `BrowserWindow`  |
| Apps          | Subset        | Full set         |
| Notifications | Logs / in-TUI | OS notifications |

Electron adds GUI-heavy apps (e.g. A2A, Recall, PPT, Designer, SkillMgr). Compare [`CliPlatform`](src/platforms/cli.ts) and [`ElectronPlatform`](src/platforms/electron.ts).

### Reuse

1. **Apps** — Anything extending [`BaseApplication`](src/main/applications/base.ts) without GUI-only deps.
2. **AI kernel** — Fully shared.
3. **State** — Same task/config model.
4. **Workers** — [`initializeAppWorkers()`](src/main/applications/worker.ts).

### Extending

#### New slash command

Add `registerMycommandCommand` under [`src/main/tui/commands/`](src/main/tui/commands/) and wire it in [`registerAllCommands()`](src/main/tui/commands/index.ts); [`OpenDeskTUI.setupCommands()`](src/main/tui/entry.ts) loads everything.

```typescript
tui.commandRegistry.register({
    name: 'mycommand',
    description: 'My custom command',
    shortcut: Key.ctrl('m'), // optional
    execute: async (args: string) => {
        // implementation
    }
});
```

#### New TUI component

Follow patterns in [`src/main/tui/components/`](src/main/tui/components/) and import TUI primitives directly from `@earendil-works/pi-tui`.

#### Cross-platform code

Use `getPlatform().getName()` when behavior must differ.

### Tool rendering in the CLI

#### Pieces

1. `BaseTool.renderToolCallCli()`
2. `ToolCallView` — custom vs default
3. `DefaultToolCallView`
4. `ToolCallMessagePartView` — multiple calls

#### Flow

```
ToolCall
    ↓
ToolCallView
    ↓
├─ renderToolCallCli()? → yes → custom lines (string[])
│
└─ no → DefaultToolCallView (compact one-liner)
```

#### Default line

[`DefaultToolCallView`](src/main/tui/components/toolcall.ts) renders e.g.:

```
  ● toolname ·········· Running…
```

`chalk` styling:

- Pending: gray `○`
- Running: bright blue `●`
- Success: bright green `✔`
- Error: bright red `✘`

#### Custom render

```typescript
class MyCustomTool extends BaseTool {
    // ...

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return [
            '╭───────────────────────────────────────────────╮',
            '│  My Custom Tool                               │',
            '│  params: ' + JSON.stringify(toolcall.params) + ' │',
            '╰───────────────────────────────────────────────╯'
        ];
    }
}
```

Signature:

```typescript
renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined
```

- `toolcall` — params, status, result, …
- `width` — terminal width for layout
- Return `undefined` to fall back to default

#### `ToolCall` fields

[`ToolCall`](src/main/aikernel/messages.ts): `tool_name`, `params`, `status`, `result`, optional `tool` instance.

#### Helpers in `toolcall.ts`

- `statusDisplay(status)` — icon + label (e.g. running → blue dot + “Running…”)
- `truncText(str, maxWidth)` — ANSI- and wide-char-aware truncation
- `visibleWidth(str)` — visible width ignoring ANSI

#### Wiring in `TaskView`

`AssistantMessageView` → `ToolCallMessagePartView` → `ToolCallView`; `updateToolCallPart()` streams state changes.

Tips: use `chalk`, respect width, match TUI style, keep status obvious.

---

## FAQ

### How do I quit?

`/exit`, or **Ctrl+C** with an empty input and confirm.

### Where is my config?

Under your user app directory; path depends on the OS.

### Multiple CLI instances?

Yes; prefer separate workspaces to avoid conflicting writes.

---

## Getting Help

1. `/help` inside the CLI
2. Project documentation
3. Issues on GitCode

---

_Enjoy OpenDesk CLI._
