# OpenClaw Node Protocol Specification

**Version**: Protocol v3
**Last Updated**: 2026-03-22
**Source**: OpenClaw Gateway WebSocket Protocol (`src/gateway/`)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Transport Layer](#2-transport-layer)
3. [Message Framing](#3-message-framing)
4. [Handshake Flow](#4-handshake-flow)
5. [Device Identity & Cryptography](#5-device-identity--cryptography)
6. [Roles & Scopes](#6-roles--scopes)
7. [Node Methods Reference](#7-node-methods-reference)
8. [Node Events Reference](#8-node-events-reference)
9. [Node Pairing Flow](#9-node-pairing-flow)
10. [Node Session Management](#10-node-session-management)
11. [Node Command Invocation](#11-node-command-invocation)
12. [Node Discovery](#12-node-discovery)
13. [Error Codes](#13-error-codes)
14. [Implementation Guide](#14-implementation-guide)
15. [File Reference](#15-file-reference)

---

## 1. Overview

The OpenClaw Gateway WebSocket protocol is the **single control plane + node transport** for OpenClaw. All clients—including CLI, web UI, macOS app, iOS/Android nodes, and headless nodes—connect over WebSocket and declare their role and scope at handshake time.

The protocol is asymmetric:
- **Gateway (server)**: Owns state (sessions, pairing, node registry), runs channels, enforces auth and ACLs.
- **Node (client)**: A capability host that provides device capabilities (camera, screen, canvas, location, voice, etc.) to the gateway.

---

## 2. Transport Layer

| Property | Value |
|----------|-------|
| Protocol | WebSocket (text frames, JSON payloads) |
| Default Port | `18789` |
| TLS | Supported, optional certificate pinning |
| First Frame | Must be a `connect` request |
| Handshake Timeout | 30 seconds |

### 2.1 WebSocket URL Format

```
ws[s]://<host>:<port>
wss://gateway.example.com:18789   # TLS recommended
ws://localhost:18789              # Local development
```

### 2.2 Connection States

```
CONNECTING → HANDLING_HANDSHAKE → AUTHENTICATED → CONNECTED → DISCONNECTED
```

---

## 3. Message Framing

All messages are JSON objects over WebSocket text frames.

### 3.1 Request Frame

```typescript
{
  type: "req",
  id: string,        // Unique request ID (UUID recommended)
  method: string,    // Method name to invoke
  params?: unknown   // Method parameters
}
```

**Example**:
```json
{
  "type": "req",
  "id": "req-001",
  "method": "node.pair.request",
  "params": {
    "nodeId": "device-fingerprint",
    "displayName": "Living Room iPad",
    "platform": "ios",
    "caps": ["camera", "canvas"]
  }
}
```

### 3.2 Response Frame

```typescript
{
  type: "res",
  id: string,           // Correlates to request ID
  ok: boolean,          // true = success, false = failure
  payload?: unknown,    // Result data (when ok=true)
  error?: {             // Error details (when ok=false)
    code: string,
    message: string,
    details?: unknown,
    retryable?: boolean,
    retryAfterMs?: number
  }
}
```

**Success Example**:
```json
{
  "type": "res",
  "id": "req-001",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3
  }
}
```

**Error Example**:
```json
{
  "type": "res",
  "id": "req-001",
  "ok": false,
  "error": {
    "code": "DEVICE_AUTH_NONCE_REQUIRED",
    "message": "device nonce required",
    "details": {
      "canRetryWithDeviceToken": false,
      "recommendedNextStep": "update_auth_configuration"
    }
  }
}
```

### 3.3 Event Frame

```typescript
{
  type: "event",
  event: string,           // Event name
  payload?: unknown,       // Event data
  seq?: number,            // Sequence number (optional)
  stateVersion?: string    // State version for ordering (optional)
}
```

**Example**:
```json
{
  "type": "event",
  "event": "node.invoke.request",
  "payload": {
    "id": "invoke-123",
    "nodeId": "device-fingerprint",
    "command": "camera.snap",
    "paramsJSON": "{\"flash\":true}",
    "timeoutMs": 30000,
    "idempotencyKey": "idem-123"
  }
}
```

---

## 4. Handshake Flow

The handshake establishes a mutually authenticated connection.

### 4.1 Complete Handshake Sequence

```
Client                              Server
  | <----- connect.challenge -------|  (1) Server sends challenge nonce
  |                                  |
  | ------- connect req ------------>|  (2) Client sends connect request
  |                                  |     (signed with challenge nonce)
  |                                  |
  | <------- hello-ok --------------|  (3) Server accepts connection
```

### 4.2 Step 1: Server Challenge

When a WebSocket connection is established, the server immediately sends:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": {
    "nonce": "random-base64url-string",
    "ts": 1737264000000
  }
}
```

**Field Description**:
- `nonce`: A random string the client must sign to prove possession of their private key
- `ts`: Server timestamp (milliseconds since epoch)

### 4.3 Step 2: Client Connect Request

The client responds with a `connect` request frame:

```json
{
  "type": "req",
  "id": "<unique-id>",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "displayName": "My iPhone",
      "version": "1.2.3",
      "platform": "ios",
      "deviceFamily": "iPhone",
      "modelIdentifier": "iPhone15,2",
      "mode": "node",
      "instanceId": "optional-instance-uuid"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": {
      "camera.capture": true,
      "screen.record": false
    },
    "auth": {
      "token": "<pairing-token-or-device-token>"
    },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "<device-fingerprint>",
      "publicKey": "<base64url-public-key>",
      "signature": "<base64url-ed25519-signature>",
      "signedAt": 1737264000000,
      "nonce": "<challenge-nonce-from-step-1>"
    }
  }
}
```

**ConnectParams Schema** (from `src/gateway/protocol/schema/frames.ts`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `minProtocol` | integer | Yes | Minimum supported protocol version |
| `maxProtocol` | integer | Yes | Maximum supported protocol version |
| `client.id` | string | Yes | Client identifier (see Client IDs) |
| `client.displayName` | string | No | Human-readable name |
| `client.version` | string | Yes | Client version string |
| `client.platform` | string | Yes | Platform (ios, android, macos, linux, etc.) |
| `client.deviceFamily` | string | No | Device family (e.g., "iPhone", "Pixel") |
| `client.modelIdentifier` | string | No | Model identifier (e.g., "iPhone15,2") |
| `client.mode` | string | Yes | Client mode (see Client Modes) |
| `client.instanceId` | string | No | Unique instance identifier |
| `role` | string | No | Connection role: "node" or "operator" |
| `scopes` | string[] | No | Permission scopes requested |
| `caps` | string[] | No | Capability categories |
| `commands` | string[] | No | Command allowlist for invoke |
| `permissions` | object | No | Granular permission toggles |
| `auth.token` | string | No | Pairing or device token |
| `auth.bootstrapToken` | string | No | Bootstrap token for first connect |
| `auth.deviceToken` | string | No | Device token from previous pairing |
| `auth.password` | string | No | Password auth (less common) |
| `device.id` | string | No | Device fingerprint (Ed25519 key ID) |
| `device.publicKey` | string | No | Base64url encoded Ed25519 public key |
| `device.signature` | string | No | Ed25519 signature of auth payload |
| `device.signedAt` | integer | No | Signature timestamp (ms since epoch) |
| `device.nonce` | string | No | Challenge nonce being signed |
| `locale` | string | No | Locale preference (e.g., "en-US") |
| `userAgent` | string | No | User agent string |

### 4.4 Step 3: Server Hello-OK

On successful authentication, the server responds:

```json
{
  "type": "res",
  "id": "<request-id>",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "server": {
      "version": "1.2.3",
      "connId": "connection-uuid"
    },
    "features": {
      "methods": ["node.pair.request", "node.invoke", ...],
      "events": ["node.pair.requested", "node.invoke.request", ...]
    },
    "snapshot": { /* current system state */ },
    "canvasHostUrl": "http://localhost:18789",
    "auth": {
      "deviceToken": "<new-or-refreshed-token>",
      "role": "node",
      "scopes": [],
      "issuedAtMs": 1737264000000
    },
    "policy": {
      "maxPayload": 1048576,
      "maxBufferedBytes": 10485760,
      "tickIntervalMs": 15000
    }
  }
}
```

### 4.5 Protocol Version Negotiation

- Client sends `minProtocol` and `maxProtocol` in connect params
- Server picks the highest mutually supported version
- If versions are incompatible, server closes the connection with an error
- Current protocol version: **3**

---

## 5. Device Identity & Cryptography

### 5.1 Key Algorithm

| Property | Value |
|----------|-------|
| Algorithm | Ed25519 |
| Key Generation | `crypto.generateKeyPairSync("ed25519")` |
| Public Key Format | SPKI PEM or raw base64url |
| Device ID | SHA256 fingerprint of raw public key |

### 5.2 Key Derivation

From `src/infra/device-identity.ts`:

```typescript
// Ed25519 SPKI prefix (hex)
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";

// Extract raw public key bytes from PEM
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  // If standard Ed25519 SPKI, strip prefix
  if (spki.length === 38 && spki.startsWith(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

// Device ID = SHA256(raw public key bytes)
function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}
```

### 5.3 Signature Payload Format

**V2 Format**:
```
v2|{deviceId}|{clientId}|{clientMode}|{role}|{scopes}|{signedAtMs}|{token}|{nonce}
```

**V3 Format** (recommended, adds platform and deviceFamily):
```
v3|{deviceId}|{clientId}|{clientMode}|{role}|{scopes}|{signedAtMs}|{token}|{nonce}|{platform}|{deviceFamily}
```

**Field Details**:

| Field | Description |
|-------|-------------|
| `deviceId` | Device fingerprint (SHA256 of public key) |
| `clientId` | Client identifier string |
| `clientMode` | "node" for nodes |
| `role` | Connection role |
| `scopes` | Comma-separated scope list (empty for nodes) |
| `signedAtMs` | Unix timestamp in milliseconds |
| `token` | Pairing token or device token (empty string if none) |
| `nonce` | Challenge nonce from `connect.challenge` |
| `platform` | Platform string (V3 only) |
| `deviceFamily` | Device family string (V3 only) |

**Building the payload** (from `src/gateway/device-auth.ts`):

```typescript
function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    params.platform ?? "",
    params.deviceFamily ?? "",
  ].join("|");
}
```

### 5.4 Signing

```typescript
import crypto from "node:crypto";

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}
```

### 5.5 Signature Verification

```typescript
function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string
): boolean {
  try {
    // publicKey can be PEM or raw base64url
    const key = publicKey.includes("BEGIN")
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({
          key: Buffer.concat([
            ED25519_SPKI_PREFIX,  // "302a300506032b6570032100"
            base64UrlDecode(publicKey)
          ]),
          type: "spki",
          format: "der"
        });
    const sig = base64UrlDecode(signatureBase64Url);
    return crypto.verify(null, Buffer.from(payload, "utf8"), key, sig);
  } catch {
    return false;
  }
}
```

### 5.6 Signature Validation Rules

| Check | Requirement |
|-------|-------------|
| Timestamp skew | Signed timestamp must be within ±2 minutes of server time |
| Nonce | Must exactly match the `connect.challenge` nonce |
| Device ID | `device.id` must match SHA256(publicKey) |
| Public key format | Must be valid Ed25519 key |

---

## 6. Roles & Scopes

### 6.1 Roles

| Role | Description |
|------|-------------|
| `operator` | Control plane client (CLI, UI, automation) |
| `node` | Capability host (camera, screen, canvas, system.run) |

### 6.2 Operator Scopes

| Scope | Description |
|-------|-------------|
| `operator.read` | Read access to gateway state |
| `operator.write` | Write access to gateway state |
| `operator.admin` | Admin operations (config changes) |
| `operator.approvals` | Approve/reject exec requests |
| `operator.pairing` | Manage device/node pairing |

### 6.3 Client Modes

From `src/gateway/protocol/client-info.ts`:

```typescript
const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
} as const;
```

### 6.4 Client IDs

```typescript
const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
} as const;
```

### 6.5 Node Capabilities

Nodes declare capabilities at connect time:

| Category | Description | Example Commands |
|----------|-------------|------------------|
| `camera` | Camera access | `camera.snap`, `camera.record` |
| `canvas` | Canvas/display | `canvas.navigate`, `canvas.screenshot` |
| `screen` | Screen recording | `screen.record` |
| `location` | GPS/location | `location.get` |
| `voice` | Microphone/audio | `voice.record` |

---

## 7. Node Methods Reference

Complete list from `src/gateway/server-methods-list.ts`.

### 7.1 Node Pairing Methods

#### `node.pair.request`

Create or reuse a pending pairing request.

**Params** (`src/gateway/protocol/schema/nodes.ts`):
```typescript
{
  nodeId: string,           // Device fingerprint
  displayName?: string,      // Human-readable name
  platform?: string,         // "ios", "android", etc.
  version?: string,          // App version
  coreVersion?: string,      // Core version
  uiVersion?: string,        // UI version
  deviceFamily?: string,     // Device family
  modelIdentifier?: string,  // Model identifier
  caps?: string[],           // Capabilities
  commands?: string[],       // Commands
  remoteIp?: string,        // Remote IP address
  silent?: boolean,          // Hint for auto-approval
}
```

**Result**:
```typescript
{
  status: "pending",
  request: {
    requestId: string,
    nodeId: string,
    displayName?: string,
    ...
    ts: number
  },
  created: boolean  // true if new, false if existing
}
```

**Notes**:
- Idempotent per nodeId
- Returns same pending request on repeated calls
- `silent: true` hints for auto-approval flows

#### `node.pair.list`

List pending and paired nodes.

**Params**: `{}`

**Result**:
```typescript
{
  pending: Array<{
    requestId: string,
    nodeId: string,
    displayName?: string,
    platform?: string,
    ...
    ts: number
  }>,
  paired: Array<{
    nodeId: string,
    displayName?: string,
    token: string,
    ...
    approvedAtMs: number
  }>
}
```

#### `node.pair.approve`

Approve a pending pairing request. Issues a new token.

**Params**:
```typescript
{
  requestId: string  // From node.pair.list pending request
}
```

**Result**:
```typescript
{
  requestId: string,
  node: {
    nodeId: string,
    token: string,         // New pairing token
    displayName?: string,
    ...
    approvedAtMs: number
  }
}
```

**Notes**:
- Always generates a fresh token
- Re-pairing rotates the token

#### `node.pair.reject`

Reject a pending pairing request.

**Params**:
```typescript
{
  requestId: string
}
```

**Result**:
```typescript
{
  requestId: string,
  nodeId: string
}
```

#### `node.pair.verify`

Verify a node's pairing token.

**Params**:
```typescript
{
  nodeId: string,
  token: string
}
```

**Result**:
```typescript
{
  ok: boolean,
  node?: NodePairingPairedNode
}
```

### 7.2 Node Management Methods

#### `node.list`

List all paired nodes.

**Params**: `{}`

#### `node.describe`

Get detailed information about a specific node.

**Params**:
```typescript
{ nodeId: string }
```

#### `node.rename`

Rename a paired node.

**Params**:
```typescript
{
  nodeId: string,
  displayName: string
}
```

### 7.3 Node Command Invocation

#### `node.invoke`

Invoke a command on a connected node.

**Params**:
```typescript
{
  nodeId: string,
  command: string,           // Command name (e.g., "camera.snap")
  params?: unknown,          // Command parameters
  timeoutMs?: number,        // Timeout in milliseconds (default: 30000)
  idempotencyKey: string     // Unique key for idempotency
}
```

**Result**:
```typescript
{
  ok: boolean,
  payload?: unknown,
  payloadJSON?: string,
  error?: { code?: string, message?: string }
}
```

**NodeInvokeParamsSchema**:
```typescript
{
  nodeId: NonEmptyString,
  command: NonEmptyString,
  params: Type.Optional(Type.Unknown()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  idempotencyKey: NonEmptyString
}
```

#### `node.invoke.result`

Return the result of a command invocation (sent by node to gateway).

**Params**:
```typescript
{
  id: string,                // Invoke request ID
  nodeId: string,
  ok: boolean,
  payload?: unknown,
  payloadJSON?: string,
  error?: {
    code?: string,
    message?: string
  }
}
```

#### `node.event`

Send an event to a node.

**Params**:
```typescript
{
  event: string,
  payload?: unknown,
  payloadJSON?: string
}
```

### 7.4 Node Pending Work Methods

For nodes that may be backgrounded or offline.

#### `node.pending.enqueue`

Enqueue a pending action for a node.

**Params**:
```typescript
{
  nodeId: string,
  type: "status.request" | "location.request",
  priority?: "normal" | "high",
  expiresInMs?: number,      // 1000 to 86400000 (1s to 24h)
  wake?: boolean             // Wake the node if sleeping
}
```

**Result**:
```typescript
{
  nodeId: string,
  revision: number,
  queued: {
    id: string,
    type: string,
    priority: string,
    createdAtMs: number,
    expiresAtMs?: number,
    payload?: Record<string, unknown>
  },
  wakeTriggered: boolean
}
```

#### `node.pending.drain`

Drain (retrieve) pending items for a node.

**Params**:
```typescript
{
  maxItems?: number  // 1 to 10, default 10
}
```

**Result**:
```typescript
{
  nodeId: string,
  revision: number,
  items: Array<{
    id: string,
    type: "status.request" | "location.request",
    priority: "default" | "normal" | "high",
    createdAtMs: number,
    expiresAtMs?: number,
    payload?: Record<string, unknown>
  }>,
  hasMore: boolean
}
```

#### `node.pending.pull`

Node-side: Pull pending actions assigned to this node.

**Params**: `{}`

#### `node.pending.ack`

Acknowledge that pending actions were processed.

**Params**:
```typescript
{
  ids: string[]  // Array of item IDs to acknowledge
}
```

---

## 8. Node Events Reference

From `src/gateway/server-methods-list.ts`.

### 8.1 Connection Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `connect.challenge` | Server → Client | Server challenge for auth |
| `tick` | Server → Client | Periodic heartbeat |
| `shutdown` | Server → Client | Server shutdown notice |

### 8.2 Pairing Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `node.pair.requested` | Server → Operator | New pairing request created |
| `node.pair.resolved` | Server → Operator | Request approved/rejected/expired |

### 8.3 Node Command Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `node.invoke.request` | Server → Node | Invoke command on node |
| `node.invoke.result` | Node → Server | Command result from node |

### 8.4 NodeInvokeRequestEvent Schema

```typescript
{
  id: string,              // Invoke request ID
  nodeId: string,
  command: string,         // Command name
  paramsJSON?: string,     // JSON-encoded params
  timeoutMs?: number,      // Timeout in ms
  idempotencyKey?: string  // Idempotency key
}
```

---

## 9. Node Pairing Flow

Complete flow documented in `docs/gateway/pairing.md`.

### 9.1 Full Pairing Sequence

```
Node                              Gateway                           Operator
  |                                  |                                  |
  | (1) Connect WS + node.pair.req  |                                  |
  |--------------------------------->|                                  |
  |                                  | (2) Store pending request         |
  |                                  |---------------------------------->|
  |                                  |                                  |
  |                                  | (3) node.pair.requested event     |
  |                                  |<---------------------------------|
  |                                  |                                  |
  |                                  | (4) operator reviews/approves    |
  |                                  |<---------------------------------|
  |                                  |                                  |
  | (5) node.pair.approve returns    |                                  |
  |<---------------------------------|                                  |
  |   token = "new-pairing-token"    |                                  |
  |                                  |                                  |
  | (6) Disconnect                   |                                  |
  |                                  |                                  |
  | (7) Reconnect with token         |                                  |
  |--------------------------------->|                                  |
  |                                  |                                  |
  | (8) hello-ok with deviceToken    |                                  |
  |<---------------------------------|                                  |
```

### 9.2 Pairing Storage

| File | Location | Description |
|------|---------|-------------|
| `pending.json` | `~/.openclaw/nodes/` | Pending pairing requests |
| `paired.json` | `~/.openclaw/nodes/` | Approved paired nodes |

**Pending Request TTL**: 5 minutes

### 9.3 Token Generation

From `src/infra/pairing-token.ts`:

```typescript
const PAIRING_TOKEN_BYTES = 32;

function generatePairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
}

function verifyPairingToken(provided: string, expected: string): boolean {
  if (provided.trim().length === 0 || expected.trim().length === 0) {
    return false;
  }
  return safeEqualSecret(provided, expected);  // Constant-time comparison
}
```

### 9.4 Auto-Approval (macOS app)

The macOS app can silently approve when:
- Request is marked `silent: true`
- App can verify SSH connection to gateway host as same user

Otherwise falls back to "Approve/Reject" prompt.

---

## 10. Node Session Management

From `src/gateway/node-registry.ts`.

### 10.1 NodeSession Structure

```typescript
interface NodeSession {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
}
```

### 10.2 NodeRegistry API

```typescript
class NodeRegistry {
  // Register a new node connection
  register(client: GatewayWsClient, opts: { remoteIp?: string }): NodeSession

  // Unregister on disconnect
  unregister(connId: string): string | null

  // List all connected nodes
  listConnected(): NodeSession[]

  // Get a specific node
  get(nodeId: string): NodeSession | undefined

  // Invoke a command on a node
  invoke(params: {
    nodeId: string,
    command: string,
    params?: unknown,
    timeoutMs?: number,
    idempotencyKey?: string
  }): Promise<NodeInvokeResult>

  // Handle invoke result from node
  handleInvokeResult(params: NodeInvokeResultParams): boolean

  // Send event to a node
  sendEvent(nodeId: string, event: string, payload?: unknown): boolean
}
```

### 10.3 Pending Invokes

When `node.invoke` is called, the server:
1. Creates a pending invoke with a unique request ID
2. Sends `node.invoke.request` event to the node
3. Waits for `node.invoke.result` with matching ID
4. Resolves or rejects the promise
5. Times out after `timeoutMs` (default 30 seconds)

---

## 11. Node Command Invocation

Complete flow in `src/gateway/server-methods/nodes.ts`.

### 11.1 Command Invocation Flow

```
Operator/Client                     Gateway                           Node
    |                                  |                                |
    | (1) node.invoke                 |                                |
    |─────────────────────────────────>|                                |
    |                                  |                                |
    |                                  | (2) Validate command allowlist |
    |                                  | (3) Check node connected       |
    |                                  | (4) Send node.invoke.request   |
    |                                  |───────────────────────────────>|
    |                                  |                                |
    |                                  | (5) Node executes command      |
    |                                  |<───────────────────────────────|
    |                                  |                                |
    | (6) node.invoke result          |                                |
    |<─────────────────────────────────|                                |
```

### 11.2 Command Validation

1. Command must be in node's declared `commands` array
2. Node must be currently connected
3. If node is offline, Gateway may attempt wake via APNs (iOS)
4. If node is background-restricted, action may be queued via `node.pending.enqueue`

### 11.3 Node-Initiated Commands

Nodes can also receive `node.event` messages for push notifications.

---

## 12. Node Discovery

Complete documentation in `docs/gateway/discovery.md`.

### 12.1 Discovery Mechanisms

| Mechanism | Scope | Description |
|-----------|-------|-------------|
| Bonjour/mDNS | LAN only | `_openclaw-gw._tcp` service |
| Tailnet | Cross-network | Tailscale MagicDNS |
| Manual/SSH | Any | Direct connection fallback |

### 12.2 Bonjour Service Advertisement

**Service Type**: `_openclaw-gw._tcp`

**TXT Record Keys**:

| Key | Description |
|-----|-------------|
| `role` | Always "gateway" |
| `lanHost` | Local hostname |
| `sshPort` | SSH port (default 22) |
| `gatewayPort` | Gateway WS port (default 18789) |
| `gatewayTls` | 1 if TLS enabled |
| `gatewayTlsSha256` | TLS cert fingerprint (if available) |
| `canvasPort` | Canvas host port |
| `cliPath` | Path to CLI binary |
| `tailnetDns` | Tailscale MagicDNS name |

### 12.3 Transport Selection Policy

Recommended client behavior (in order):
1. Use paired direct endpoint if configured and reachable
2. Else use Bonjour-discovered gateway on LAN
3. Else use configured tailnet DNS/IP
4. Else fall back to SSH

### 12.4 Disable Discovery

```bash
# Disable Bonjour advertisement
OPENCLAW_DISABLE_BONJOUR=1

# Override CLI path
OPENCLAW_CLI_PATH=/usr/local/bin/openclaw

# Override SSH port
OPENCLAW_SSH_PORT=22

# Publish Tailnet DNS hint
OPENCLAW_TAILNET_DNS=gateway.example.com
```

---

## 13. Error Codes

### 13.1 Device Authentication Errors

From `src/gateway/server/ws-connection/message-handler.ts`.

| Error Code | Message | Reason |
|------------|---------|--------|
| `DEVICE_AUTH_NONCE_REQUIRED` | device nonce required | Client omitted `device.nonce` |
| `DEVICE_AUTH_NONCE_MISMATCH` | device nonce mismatch | Signed with stale/wrong nonce |
| `DEVICE_AUTH_SIGNATURE_INVALID` | device signature invalid | Signature doesn't match payload |
| `DEVICE_AUTH_SIGNATURE_EXPIRED` | device signature expired | Timestamp outside ±2 minutes |
| `DEVICE_AUTH_DEVICE_ID_MISMATCH` | device identity mismatch | device.id doesn't match public key |
| `DEVICE_AUTH_PUBLIC_KEY_INVALID` | device public key invalid | Key format/canonicalization failed |

### 13.2 Node Invocation Errors

| Error Code | Message | Reason |
|------------|---------|--------|
| `NOT_CONNECTED` | node not connected | Node is not currently connected |
| `UNAVAILABLE` | failed to send invoke to node | WebSocket send failed |
| `TIMEOUT` | node invoke timed out | No response within timeoutMs |

### 13.3 Auth Error Recovery

Errors include `error.details` with:
```typescript
{
  code: string,
  message: string,
  details?: {
    canRetryWithDeviceToken: boolean,
    recommendedNextStep: (
      "retry_with_device_token" |
      "update_auth_configuration" |
      "update_auth_credentials" |
      "wait_then_retry" |
      "review_auth_configuration"
    )
  }
}
```

---

## 14. Implementation Guide

### 14.1 Complete Connection Sequence

```typescript
import WebSocket from "ws";
import crypto from "node:crypto";

// 1. Configuration
const GATEWAY_URL = "wss://gateway.example.com:18789";
const DEVICE_ID = computeDeviceId(publicKey);
const PAIRING_TOKEN = "your-pairing-token"; // From node.pair.approve

// 2. Connect
const ws = new WebSocket(GATEWAY_URL);

ws.on("open", () => {
  console.log("WebSocket connected, waiting for challenge...");
});

ws.on("message", async (data) => {
  const msg = JSON.parse(data.toString());

  // 3. Handle challenge
  if (msg.event === "connect.challenge") {
    const { nonce, ts } = msg.payload;

    // 4. Build auth payload
    const authPayload = buildDeviceAuthPayloadV3({
      deviceId: DEVICE_ID,
      clientId: "my-node",
      clientMode: "node",
      role: "node",
      scopes: [],
      signedAtMs: Date.now(),
      token: PAIRING_TOKEN,
      nonce: nonce,
      platform: "android",
      deviceFamily: "Pixel 7"
    });

    // 5. Sign
    const signature = signDevicePayload(privateKey, authPayload);

    // 6. Send connect request
    ws.send(JSON.stringify({
      type: "req",
      id: crypto.randomUUID(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "my-node",
          displayName: "My Android Device",
          version: "1.0.0",
          platform: "android",
          deviceFamily: "Pixel 7",
          modelIdentifier: "Pixel 7",
          mode: "node"
        },
        role: "node",
        caps: ["camera", "location"],
        commands: ["camera.snap", "location.get"],
        permissions: {
          "camera.capture": true,
          "location.get": true
        },
        auth: {
          token: PAIRING_TOKEN
        },
        device: {
          id: DEVICE_ID,
          publicKey: base64UrlEncode(publicKeyRaw),
          signature: signature,
          signedAt: Date.now(),
          nonce: nonce
        }
      }
    }));
  }

  // 7. Handle hello-ok
  if (msg.type === "res" && msg.payload?.type === "hello-ok") {
    console.log("Connected! Protocol:", msg.payload.protocol);
    const deviceToken = msg.payload.auth?.deviceToken;
    // Save deviceToken for future connections
  }

  // 8. Handle node.invoke.request
  if (msg.event === "node.invoke.request") {
    const { id, command, paramsJSON, timeoutMs } = msg.payload;
    console.log(`Invoke: ${command}`);

    // Execute command locally
    const result = await executeCommand(command, JSON.parse(paramsJSON || "{}"));

    // 9. Send result
    ws.send(JSON.stringify({
      type: "req",
      id: crypto.randomUUID(),
      method: "node.invoke.result",
      params: {
        id: id,
        nodeId: DEVICE_ID,
        ok: true,
        payload: result
      }
    }));
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err);
});
```

### 14.2 Full Pairing Flow

```typescript
async function pairNode(gatewayUrl: string, nodeInfo: NodeInfo) {
  const ws = new WebSocket(gatewayUrl);
  let challengeNonce: string;

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === "connect.challenge") {
      challengeNonce = msg.payload.nonce;

      // Anonymous connect (no token yet)
      ws.send(JSON.stringify({
        type: "req",
        id: crypto.randomUUID(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "temp-node",
            version: "1.0.0",
            platform: nodeInfo.platform,
            mode: "node"
          },
          role: "node",
          device: {
            id: computeDeviceId(publicKey),
            publicKey: base64UrlEncode(publicKeyRaw),
            signature: signDevicePayload(privateKey, buildPayload(challengeNonce)),
            signedAt: Date.now(),
            nonce: challengeNonce
          }
        }
      }));
    }

    if (msg.type === "res" && msg.payload?.type === "hello-ok") {
      // Connected anonymously, now request pairing
      ws.send(JSON.stringify({
        type: "req",
        id: crypto.randomUUID(),
        method: "node.pair.request",
        params: {
          nodeId: computeDeviceId(publicKey),
          displayName: nodeInfo.displayName,
          platform: nodeInfo.platform,
          version: nodeInfo.version,
          caps: nodeInfo.caps,
          commands: nodeInfo.commands,
          silent: false
        }
      }));
    }

    if (msg.type === "res" && msg.method === "node.pair.request") {
      console.log("Pairing request submitted, waiting for approval...");
      // Wait for operator to approve via CLI or UI
    }
  });

  // After approval, reconnect with token (in real impl, would wait for event)
}
```

### 14.3 Required Dependencies

```typescript
// Core
import crypto from "node:crypto";        // Built-in Node.js
import WebSocket from "ws";              // ws package

// Or for browser environments:
// const ws = new WebSocket(url);
```

### 14.4 Key Utility Functions

```typescript
// Base64url encode
function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// Base64url decode
function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

// SHA256 hash
function sha256(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

// Generate random nonce
function generateNonce(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}
```

---

## 15. File Reference

| File Path | Purpose |
|-----------|---------|
| `docs/gateway/protocol.md` | Protocol documentation |
| `docs/gateway/pairing.md` | Node pairing documentation |
| `docs/gateway/discovery.md` | Discovery mechanisms |
| `src/gateway/protocol/schema/frames.ts` | Frame type definitions |
| `src/gateway/protocol/schema/nodes.ts` | Node-specific schemas |
| `src/gateway/protocol/schema/primitives.ts` | Basic type definitions |
| `src/gateway/protocol/client-info.ts` | Client IDs and modes |
| `src/gateway/server-methods-list.ts` | All RPC methods and events |
| `src/gateway/server/ws-connection.ts` | WebSocket connection handler |
| `src/gateway/node-registry.ts` | Node session management |
| `src/infra/device-identity.ts` | Ed25519 key management |
| `src/infra/node-pairing.ts` | Node pairing operations |
| `src/infra/pairing-token.ts` | Pairing token generation |
| `src/gateway/device-auth.ts` | Auth payload construction |
| `src/shared/device-auth-store.ts` | Device token storage |

---

## Appendix A: Protocol Version History

| Version | Changes |
|---------|---------|
| 1 | Initial version |
| 2 | Added device auth with signatures |
| 3 | Added V3 auth payload with platform/deviceFamily |

---

## Appendix B: Security Notes

See `docs/gateway/security/index.md` for complete security model documentation.

Key points:
- Personal assistant trust model (single operator boundary)
- Gateway + Node = same trust domain
- Pairing token rotation on re-pair
- Signature timestamp must be within ±2 minutes
- Constant-time token comparison (`safeEqualSecret`)

---

## Appendix C: Example Code (TypeScript)

See Section 14 for complete implementation examples.
