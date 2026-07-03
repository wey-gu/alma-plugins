# xAI Grok Auth

Use your **SuperGrok subscription** with Alma via xAI OAuth.

Mirrors OpenCode's built-in xai plugin: after login, requests go to the
standard OpenAI-compatible xAI API (`https://api.x.ai/v1`) with your
subscription's OAuth access token as the Bearer credential — no API key or
per-token billing needed.

## How it works

- **OAuth client**: reuses the public Grok-CLI `client_id` that xAI ships for
  desktop OAuth flows (xAI's auth server rejects loopback OAuth from
  non-allowlisted clients). The redirect URI is pinned to
  `http://127.0.0.1:56121/callback` — the port is part of the client
  registration and cannot change.
- **Flow**: PKCE (S256) authorization-code flow against `auth.x.ai`, with
  `plan=generic` and state/nonce validation.
- **Scopes**: `openid profile email offline_access grok-cli:access api:access`
- **Token refresh**: proactive refresh 2 minutes before the JWT `exp` claim,
  single-flight so a rotating refresh token is never replayed, plus a
  401-force-refresh-retry path for tokens invalidated server-side.
- **Models**: static fallback list; the Fetch button pulls the live catalog
  from `/v1/language-models` (falling back to `/v1/models`).

## Usage

1. Install and enable the plugin.
2. Open **Settings → Providers → xAI Grok (SuperGrok)** and click **Connect**.
3. Complete the login in your browser (requires an active SuperGrok
   subscription on your xAI account).
4. Pick a Grok model in the chat model selector.

## Disclaimer

For personal use with your own SuperGrok subscription only. Not for
commercial resale or multi-user services.
