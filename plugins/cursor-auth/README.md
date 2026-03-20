# Cursor Auth Plugin for Alma

Use your Cursor subscription to access Claude, GPT, Gemini, and other models inside Alma with full tool-calling and image support.

## How it works

1. **OAuth** — Browser-based login to Cursor via PKCE (poll-based).
2. **Model discovery** — Queries Cursor's gRPC API for all available models.
3. **Local proxy** — Starts a local HTTP server that translates OpenAI chat/completions format into Cursor's protobuf/HTTP2 Connect protocol.
4. **Image support** — Decodes base64 images from AI SDK and passes them to Cursor via `SelectedContext.selectedImages`.
5. **Native tool routing** — Rejects Cursor's built-in filesystem/shell tools and exposes Alma's tool surface via Cursor MCP instead.

## Architecture

```
Alma  -->  AI SDK  -->  Local HTTP proxy  -->  HTTP/2 Connect stream
                        (localhost:PORT)              |
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

```sh
cd plugins/cursor-auth
bun install
bun run build
```

This bundles all modules (TypeScript source + protobuf schema + `@bufbuild/protobuf` runtime) into a single `main.js`.

## Authenticate

Use the Cursor provider settings in Alma to log in, or run the `Login to Cursor` command.

The plugin will:
1. Open Cursor's login page in your browser
2. Poll for login completion (no callback server needed)
3. Store tokens securely in Alma's encrypted storage

Tokens are refreshed automatically before expiration.

## Models

Models are discovered dynamically from Cursor's API. Fallback list:

| Model | Reasoning | Context |
|-------|-----------|---------|
| composer-2 | Yes | 200K |
| claude-4-sonnet | Yes | 200K |
| claude-3.5-sonnet | No | 200K |
| gpt-4o | No | 128K |
| cursor-small | No | 200K |
| gemini-2.5-pro | Yes | 1M |

## Troubleshooting

### Plugin not updating after changes

Alma caches compiled plugins as `.mjs` files. If you update the plugin but Alma still uses old code, clear the cache and restart:

```sh
rm -f ~/Library/Application\ Support/alma/plugin-cache/*.mjs
```

Then restart Alma.

### Model responds with `[object Object]`

This usually means the plugin cache has stale code. Clear the cache as described above.

## Requirements

- [Alma](https://github.com/yetone/alma)
- Active [Cursor](https://cursor.com) subscription

## Credits

This plugin is based on and inspired by [opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) by [@ephraimduncan](https://github.com/ephraimduncan). The core gRPC protocol translation, protobuf schema, OAuth flow, and proxy architecture are adapted from that project. Thank you for the excellent open-source work!
