---
name: jetski-mcp
description: >-
  How to configure, authenticate, live-reload, troubleshoot, and invoke Model
  Context Protocol (MCP) servers for both read and write operations in Jetski on
  Cloudtop. Use this skill whenever adding or debugging MCP servers in
  .agents/mcp_config.json or ~/.gemini/config/mcp_config.json, completing OAuth
  device flows or token setup, reloading MCP servers via Language Server RPC, or
  executing MCP read and write operations.
---

# Configuring, Authenticating, and Operating MCP Servers in Jetski on Cloudtop

This skill documents how Jetski discovers, authenticates, live-reloads, and
invokes Model Context Protocol (MCP) servers—for both **read** and **write**
operations—on Cloudtop environments.

---

## 1. Discovery Locations & Per-Conversation Config Behavior

### 1.1 Project-Level vs. Global Configuration

1. **Project-Level Configuration (`.agents/` at Repo Root — Preferred)**:
   - **MCP Servers**: `.agents/mcp_config.json` (gitignored, `chmod 600`; generic template tracked at `.agents/mcp_config.json.example`).
   - **Skills**: `.agents/skills/<skill-name>/SKILL.md` (tracked in git).
   - **Plugins**: `.agents/plugins/<plugin-name>/`.
2. **Global Configuration (Machine-Wide)**:
   - **MCP Servers**: `~/.gemini/config/mcp_config.json` (`chmod 600`).
   - **Skills**: `~/.gemini/config/skills/<skill-name>/SKILL.md`.
   - **Generated Tool Schemas**: When a server reaches `MCP_SERVER_STATUS_READY`, Jetski writes its tool schemas to `~/.gemini/jetski/mcp/<serverName>/<toolName>.json`.

### 1.2 Per-Conversation Server Allowlist (`LaunchedMcpServers`)

When a Jetski conversation starts, the active MCP server names are snapshotted
into that conversation's configuration (`LaunchedMcpServers` with
`InheritUser: false`).

- **Live Reload for New Conversations**: Calling `RefreshMcpServers` via the
  Language Server RPC spawns any newly configured servers and writes their tool
  schemas to `~/.gemini/jetski/mcp/<serverName>/`. Any **new** conversation will
  immediately allow `call_mcp_tool` on those servers.
- **Calling Newly Added Servers in an Already-Running Conversation**: If a server
  was added to `mcp_config.json` _after_ the current conversation started,
  `call_mcp_tool` in that existing conversation will reject the server (`mcp
server "<name>" is not allowed`). To interact with the server immediately in
  the same conversation without restarting, use the **Direct Stdio JSON-RPC
  Client** in [Section 5.2](#52-direct-stdio-json-rpc-client-for-existing-conversations--batch-scripts).

---

## 2. Cloudtop Configuration Rules (`.agents/mcp_config.json`)

### Rule A: Resolve Absolute NVM Binary Paths + `env.PATH`

Jetski's background Language Server does not source interactive shell profiles
(`~/.bashrc`) or NVM initialization scripts. Passing bare `"command": "npx"`
fails with `env: ‘node’: No such file or directory`.

1. Dynamically resolve the active NVM `bin` path:
   ```bash
   NVM_BIN="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | tail -n 1)/bin"
   ```
2. Set `"command"` to `<NVM_BIN>/npx` and prepend `<NVM_BIN>` to `env.PATH`:
   ```json
   {
     "mcpServers": {
       "<server-name>": {
         "command": "<NVM_BIN>/npx",
         "args": ["-y", "<mcp-package-name>"],
         "env": {
           "PATH": "<NVM_BIN>:/usr/local/bin:/usr/bin:/bin",
           "API_ACCESS_TOKEN": "<API_ACCESS_TOKEN>"
         }
       }
     }
   }
   ```

### Rule B: Remote SSE/HTTP Servers Use `serverUrl`

For remote SSE/HTTP MCP endpoints, Jetski expects `"serverUrl": "https://..."`.
On headless Cloudtop environments, prefer official **stdio** packages configured
with environment tokens over browser-cookie-gated remote URLs.

### Rule C: Warm Up Cold `npx` Packages Before First Connect

A cold `npx -y <package>` download can hit the MCP connection timeout and leave
a partially extracted directory under `~/.npm/_npx/<hash>/` (causing subsequent
launches to fail with `ERR_MODULE_NOT_FOUND`). Warm the package first from the
shell:

```bash
export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | tail -n 1)/bin:$PATH"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"warmup","version":"1.0"}}}' \
  | npx -y <mcp-package-name> >/dev/null
```

### Rule D: Secret Hygiene & File Permissions

- Enforce `chmod 600` on `.agents/mcp_config.json`, `~/.gemini/config/mcp_config.json`,
  and any local CLI credential files.
- Ensure `.gitignore` and `.git/info/exclude` ignore `.agents/mcp_config.json*`
  (except `!.agents/mcp_config.json.example`) so live credentials are never
  staged or committed.
- Never print raw tokens to terminal output; inspect only token prefixes or
  character lengths (`${#TOKEN}`).

---

## 3. Authentication, Credentials & OAuth Workflows

### 3.1 Credential Sources on Cloudtop

1. **Local `.env` (Gitignored)**:
   - Parse API keys and access tokens programmatically from `.env` and write
     them directly into `.agents/mcp_config.json` without echoing values to
     stdout.
   - Do not assume a token in `.env` is valid simply because it is non-empty:
     build-scoped or rotated tokens may fail against live APIs (`401`). Always
     verify with a lightweight read call after configuring.
2. **Local CLI Auth Stores**:
   - Many stdio MCP servers reuse credentials cached by their companion CLIs in
     the user's home directory (`~/.<vendor>rc`, `~/.<vendor>/mcp.json`, or
     `~/.config/<vendor>/config.json`).
   - Do not set placeholder strings for optional token environment variables when
     relying on a CLI session, as a non-empty placeholder overrides the valid
     CLI session token.

### 3.2 Headless OAuth Device-Code Flow

When an MCP service requires user-scoped OAuth permissions (for both read and
write scopes) on a remote Cloudtop:

1. Initiate the OAuth device authorization request (`POST /oauth/device/code`)
   requesting both read and write scopes required by the server.
2. Surface the verification URL and `user_code` to the user so they can approve
   access in their local browser.
3. Poll the token endpoint (`POST /oauth/device/token`) at the server-specified
   interval until authorization completes.
4. Persist the issued access token to the service's local credential store
   (`chmod 600`) and sync it into `.agents/mcp_config.json` and
   `~/.gemini/config/mcp_config.json`.
5. **Progressive Skill Mode Flag Caution**: Some MCP packages enable progressive
   tool discovery by default and reject explicit `--scopes` or `--all-scopes`
   CLI flags unless progressive mode is explicitly disabled via an environment
   flag. Check `<package> --help` before passing scope flags in `args`.

---

## 4. Live-Reloading & Verifying MCP Server State (`lsrpc`)

After updating `.agents/mcp_config.json` or `~/.gemini/config/mcp_config.json`,
trigger a live reload and inspect server readiness via the Language Server RPC
endpoint (`ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` are available in
the agent shell environment):

```bash
cat > /tmp/lsrpc.sh <<'EOF'
: "${ANTIGRAVITY_LS_ADDRESS:=localhost:5387}"
lsrpc() {
  curl -sS -X POST \
    "http://${ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/$1" \
    -H "Content-Type: application/json" \
    -H "x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}" \
    -d "$2"
}
EOF

# 1. Reload MCP servers (retry if child processes take >100ms to terminate):
source /tmp/lsrpc.sh
for i in $(seq 1 8); do
  res=$(lsrpc RefreshMcpServers '{}')
  [ "$res" = "{}" ] && break
  sleep 1
done

# 2. Verify all configured servers report MCP_SERVER_STATUS_READY:
sleep 2
source /tmp/lsrpc.sh && lsrpc GetMcpServerStates '{}' | jq '[.states[] | {
  serverName: .spec.serverName,
  status,
  isGlobal: .spec.isGlobal,
  error,
  toolCount: (.tools | length)
}]'
rm -f /tmp/lsrpc.sh
```

---

## 5. Interacting with MCPs: Read & Write Operations

### 5.1 Native Tool Invocation (`call_mcp_tool`)

1. **Read Schema Before Calling**:
   Inspect `~/.gemini/jetski/mcp/<serverName>/<toolName>.json` via `view_file` to
   confirm required arguments, types, and enum values.
2. **Execute Read or Write Calls**:
   Invoke `call_mcp_tool` with `ServerName`, `ToolName`, and `Arguments`.
3. **Two-Step Sub-Tool Discovery**:
   For MCP servers that expose a meta-search and meta-execution tool pair:
   - First invoke the server's tool-search endpoint to list available sub-tools
     and their input schemas.
   - Then invoke the server's tool-execution endpoint with the target sub-tool
     name and validated parameters.

### 5.2 Direct Stdio JSON-RPC Client (For Existing Conversations & Batch Scripts)

When calling a newly configured MCP server inside an already-running
conversation (where `LaunchedMcpServers` was frozen before the server was added)
or when scripting batch read/write operations:

```javascript
// Usage: node mcp-call.mjs <serverName> <toolName> '<jsonArgs>'
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [, , serverName, toolName, rawArgs = "{}"] = process.argv;
const configPath = path.resolve(process.cwd(), ".agents/mcp_config.json");
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers[
  serverName
];
if (!cfg) throw new Error(`Unknown MCP server: ${serverName}`);

const proc = spawn(cfg.command, cfg.args || [], {
  env: { ...process.env, ...(cfg.env || {}) },
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = readline.createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  if (!line.trim().startsWith("{")) return;
  const msg = JSON.parse(line);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(msg.error) : resolve(msg.result);
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
}

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-stdio-client", version: "1.0.0" },
});
proc.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n",
);

const result = await rpc("tools/call", {
  name: toolName,
  arguments: JSON.parse(rawArgs),
});
console.log(JSON.stringify(result, null, 2));
proc.kill();
```

### 5.3 Safe Read & Write Verification Protocol

1. **Verify Read First**:
   Execute a read-only identity or resource listing call to confirm the token
   and scope are accepted before running broader queries or mutations.
2. **Non-Destructive Write Verification**:
   When asked to prove MCP write capability without permanently altering
   production state:
   - Perform a reversible metadata update on a single record (e.g., assigning
     and then unassigning a record, or creating and immediately deleting a
     isolated test resource).
   - Read back the resource after each mutation to confirm both the write and
     the rollback succeeded.
3. **Production Write Guardrails**:
   - Snapshot pre-images before mutating shared service settings or schemas.
   - Clean up any temporary test rows before concluding the session.
   - Gate external side effects (such as outbound messages or emails) on
     explicit user approval.
