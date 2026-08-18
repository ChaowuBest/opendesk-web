# OpenDesk Plugin

`@bitclub.ai/opendesk-plugin-sdk` is the public SDK for native OpenDesk plugins. It exports the plugin definition helpers, hook and contribution contracts, and package validation API.

```ts
import { definePlugin, tool } from '@bitclub.ai/opendesk-plugin-sdk';
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

`ToolDefinition` supports the same host-managed execution capabilities used by native tools: Agent visibility,
serial execution, declared permissions, incremental result updates, cancellation signals, cleanup, and CLI/GUI
renderers. OpenDesk adapts the public contract to its internal `BaseTool` runtime without exposing `TaskState`.

Validate a plugin package before publishing it:

```bash
opendesk-plugin validate ./my-plugin
```
