# `@opendesk/genoffice-slides`

This directory is an internal npm workspace package that exposes the complete embedded
Slides editor through explicit host entry points:

- `@opendesk/genoffice-slides/main` — Electron host lifecycle and IPC registration
- `@opendesk/genoffice-slides/preload` — sandboxed Slides preload entry
- `@opendesk/genoffice-slides/renderer` — editor renderer bootstrap
- `@opendesk/genoffice-slides/vite` — source aliases and build entries
- `@opendesk/genoffice-slides/engine` — offline PPTX engine API
- `@opendesk/genoffice-slides/hap-manifest` — HAP artifacts and runtime dependency contract

The `apps/` and `packages/` subdirectories contain an unmodified source snapshot of
[`genspark-ai/genoffice`](https://github.com/genspark-ai/genoffice) at commit
`4da673d4dfa994bd0b4a9bc43430e4a058a17c61`.

Included:

- `apps/slides`
- Pure TypeScript/WASM packages required by the Slides editor

Excluded:

- `ee/` and its enterprise license
- `apps/sheets` and the Rust spreadsheet sidecar
- Docs, PDF, suite Shell, packaging outputs, and upstream tests

The upstream sources remain under the included Apache License 2.0 and retain their
original copyright notices. The package wrapper in `src/` is licensed under Mulan
PSL v2.

OpenDesk keeps this package as a development dependency because electron-vite bundles
its TypeScript sources. The OHOS packager reads `hap-manifest.json`, preserves the
main-process runtime dependency closure, copies the complete renderer/preload/WASM
output, and fails the HAP build if anything required by the editor is missing.

The GenOffice and Genspark names and logos are not used as OpenDesk product branding.
