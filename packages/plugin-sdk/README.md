# OpenDesk Plugin

`@bitclub.ai/opendesk-plugin-sdk` is the public SDK for native OpenDesk plugins. It exports the plugin definition helpers, hook and contribution contracts, and package validation API.

```ts
import { definePlugin, OPENDESK_PLUGIN_HOOK_NAMES, tool } from '@bitclub.ai/opendesk-plugin-sdk';
import type {
    ChatMessage,
    PermissionRequest,
    PermissionRule,
    ReasoningEffort,
    ToolDefinition
} from '@bitclub.ai/opendesk-plugin-sdk';
```

These contracts are the same types used by OpenDesk itself. The package build bundles their declarations, so plugin
projects do not need to import files from the OpenDesk repository.

`OPENDESK_PLUGIN_HOOK_NAMES` is the runtime list of hook names accepted by the current API. TypeScript
plugins can use `PluginHookName` for the corresponding string-literal union.

`ToolDefinition` supports the same host-managed execution capabilities used by native tools: Agent visibility,
serial execution, declared permissions, incremental result updates, cancellation signals, cleanup, and CLI/GUI
renderers. OpenDesk adapts the public contract to its internal `BaseTool` runtime without exposing `TaskState`.

Validate a plugin package before publishing it:

```bash
opendesk-plugin-sdk validate ./my-plugin
```

## Appearance capability

Declare `appearance` in the manifest `capabilities` to customize the application look and feel. The surface is
opening up gradually; currently available:

```ts
export default definePlugin({
    id: 'my-brand',
    capabilities: ['appearance'],
    setup(ctx) {
        // A plain string, or a localized map keyed by BCP 47 language tags
        ctx.appearance.setAppTitle({ zh: '我的桌面', en: 'MyDesk' });
        ctx.appearance.setAppDescription({ zh: '一站式工作台', en: 'All-in-one workbench' });

        // A single path for all themes...
        ctx.appearance.setAppLogo('./assets/logo.png');
        // ...or theme variants; a missing side reuses the other one
        ctx.appearance.setAppLogo({ dark: './assets/logo-dark.png', light: './assets/logo-light.png' });
    }
});
```

- `setAppTitle(title)` overrides the application title shown in the GUI top-left brand area (replaces "OpenDesk").
- `setAppDescription(description)` overrides the description shown below the title (replaces the default tagline).
  Both accept localized maps that resolve against the current UI language and re-resolve when the user switches
  languages.
- `setAppLogo(logoPath)` overrides the logo shown next to the title. Paths must be relative to the plugin root
  directory (where the manifest lives), be one of png/jpg/jpeg/svg/webp/gif/ico, and not exceed 2MB.

All calls return a `PluginRegistration`; disposing it (or deactivating the plugin) reverts to the default
appearance. When several plugins set the same field, the most recent activation wins until that registration is
disposed.
