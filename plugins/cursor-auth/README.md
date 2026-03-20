# Cursor Auth Plugin for Alma

Use your Cursor subscription to access Claude, GPT, Gemini, and other models inside Alma with full tool-calling support.

## How it works

1. **OAuth** — Browser-based login to Cursor via PKCE (poll-based, no callback needed).
2. **Model discovery** — Queries Cursor's gRPC API for all available models.
3. **Local proxy** — Translates `POST /v1/chat/completions` (OpenAI format) into Cursor's protobuf/HTTP2 Connect protocol.
4. **Native tool routing** — Rejects Cursor's built-in filesystem/shell tools and exposes Alma's tool surface via Cursor MCP instead.

## Architecture

```
Alma  -->  AI SDK  -->  /v1/chat/completions  -->  Local HTTP proxy
                                                        |
                                                   Node.js http2
                                                        |
                                                   api2.cursor.sh
                                                 /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives Alma tools via RequestContext (as MCP tool defs)
2. Model tries native tools (readArgs, shellArgs, etc.)
3. Proxy rejects each with typed error (ReadRejected, ShellRejected, etc.)
4. Model falls back to MCP tool -> mcpArgs exec message
5. Proxy emits OpenAI tool_calls SSE chunk
6. Alma executes tool, sends result in follow-up request
7. Proxy resumes HTTP/2 stream with mcpResult, streams continuation
```

## Install

Copy `main.js` and `manifest.json` into `~/.config/alma/plugins/cursor-auth/`. The bundled `main.js` is self-contained with all dependencies included — no `npm install` needed.

## Build from source

If you need to rebuild `main.js` from the TypeScript sources:

```sh
cd plugins/cursor-auth
bun install
bun run build
```

This bundles `main.ts` + all `lib/` modules + `proto/agent_pb.ts` + `@bufbuild/protobuf` into a single `main.js`.

## Authenticate

Use the Cursor provider settings in Alma to log in, or run the `Login to Cursor` command.

The plugin will:
1. Open Cursor's login page in your browser
2. Poll for login completion (no callback server needed)
3. Store tokens securely in Alma's encrypted storage

Tokens are refreshed automatically before expiration.

## Models

Models are discovered dynamically from Cursor's API. If discovery fails, the plugin falls back to a hardcoded list:

| Model | Reasoning | Context |
|-------|-----------|---------|
| composer-2 | Yes | 200K |
| claude-4-sonnet | Yes | 200K |
| claude-3.5-sonnet | No | 200K |
| gpt-4o | No | 128K |
| cursor-small | No | 200K |
| gemini-2.5-pro | Yes | 1M |

## Key differences from opencode-cursor

| Feature | opencode-cursor | cursor-auth (Alma) |
|---------|----------------|-------------------|
| Runtime | Bun | Node.js (Electron) |
| HTTP/2 | Child process bridge | Direct `node:http2` |
| Proxy server | `Bun.serve()` | `http.createServer()` |
| Auth flow | Plugin hooks | `providers.register()` |
| Token storage | OpenCode auth API | Alma secret storage |
| Plugin format | npm package | Alma plugin manifest |

## Requirements

- [Alma](https://github.com/your-org/alma)
- Active [Cursor](https://cursor.com) subscription
- Node.js >= 18 (included with Electron)
