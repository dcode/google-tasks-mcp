# google-tasks-mcp

An [MCP](https://modelcontextprotocol.io) server for **Google Tasks** with the full API surface: task-list CRUD, task CRUD, move/reorder, and a `diff_tasks` change-harvester that tells you what happened since your agent last looked.

Built for agents that maintain a task mirror (project lists your assistant keeps in sync, completions you tick on your phone that the agent picks up later), but it works fine as a general Tasks connector.

## Why another one

The existing options each miss something this use case needs:

- [zcaceres/gtasks-mcp](https://github.com/zcaceres/gtasks-mcp), the most-cited one, has no task-list operations at all: you can't create, rename, or delete lists, which rules out per-project lists entirely. The `gtasks-mcp` npm name is also a tombstone (the package was unpublished).
- [arpitbatra123/mcp-googletasks](https://github.com/arpitbatra123/mcp-googletasks) covers the full surface but isn't on npm, so it's clone-and-build, and auth means pasting an OAuth code back through a tool call.
- [google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) does everything, plus all of Workspace, plus an OAuth 2.1 setup and a native-build gotcha on Windows. Overkill if you only want Tasks.

None of them deal with the API's nastiest quirk: tasks completed in the Google Tasks apps become `hidden`, so a naive query silently misses exactly the completions a sync agent needs to see. `diff_tasks` exists because of that quirk.

## Install

```bash
# 1. One-time auth (see Google Cloud setup below first)
npx google-tasks-mcp auth

# 2. Register with your MCP client, e.g. Claude Code:
claude mcp add -s user gtasks -- npx google-tasks-mcp
```

Any MCP-capable client works; the server speaks stdio.

## Google Cloud setup (one-time, ~15 minutes)

The Tasks API requires your own OAuth client. No verification, no billing.

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **Google Tasks API**.
3. **Google Auth Platform** (consent screen): User type **External** (Internal is Workspace-only). App name + your email. Scope: `https://www.googleapis.com/auth/tasks` (classified *sensitive*, not *restricted*: no security audit needed).
4. **Credentials → Create credentials → OAuth client ID → Desktop app** → download the JSON.
5. Save it as `~/.config/google-tasks-mcp/client_secret.json` (or point `GTASKS_MCP_CREDENTIALS` at it).
6. **The trap everyone hits:** while the consent screen's publishing status is "Testing", refresh tokens expire every 7 days and you will re-auth weekly. Set publishing status to **In production** (skip verification; you'll click through a one-time "Google hasn't verified this app" interstitial: Advanced → Continue). Tokens then persist indefinitely.
7. Run `npx google-tasks-mcp auth`: a browser opens, you approve, the refresh token lands in `~/.config/google-tasks-mcp/token.json`. Done forever (revoking access or 6 months of disuse are the only expiries).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GTASKS_MCP_DIR` | `~/.config/google-tasks-mcp` | Config directory |
| `GTASKS_MCP_CREDENTIALS` | `<dir>/client_secret.json` | OAuth client file |
| `GTASKS_MCP_TOKEN` | `<dir>/token.json` | Cached refresh token (stdio mode only) |
| `PORT` | unset | Set to switch from stdio to multi-tenant HTTP mode (see below) |
| `GTASKS_MCP_PUBLIC_URL` | — | **Required in HTTP mode.** The externally-reachable base URL this server is deployed at, e.g. `https://google-tasks-mcp.example.com` (no trailing slash). Used to advertise RFC 9728 protected-resource metadata so a gateway can discover Google as the authorization server. |

## Multi-user hosting (Obot and similar OAuth-aware gateways)

Everything above is single-user: one refresh token, cached to disk, for whoever
runs `auth`. Set `PORT` (and `GTASKS_MCP_PUBLIC_URL`) and the server switches
modes entirely — it speaks [Streamable HTTP](https://modelcontextprotocol.io)
on `POST /mcp` (plus a `GET /healthz` and a `GET
/.well-known/oauth-protected-resource/mcp`) instead of stdio, and stops
managing anyone's credentials itself. In this mode the server is a pure OAuth
**resource server**: it never runs the OAuth dance and never touches a
refresh token. Something in front of it — an OAuth-aware gateway like
[Obot](https://obot.ai)'s `mcp-oauth-proxy` — does that per user and forwards
each request as `Authorization: Bearer <that user's Google access token>`.
The gateway finds Google in the first place via the RFC 9728 metadata this
server serves at `/.well-known/oauth-protected-resource/mcp`, which every
`401` response points at through its `WWW-Authenticate: ... resource_metadata="..."`
parameter.

### Building the image

A `Dockerfile` is included for this mode only (local stdio use doesn't need
it). It builds and runs `node dist/index.js` with `PORT=8080` baked in.
[`.github/workflows/publish-container.yml`](.github/workflows/publish-container.yml)
publishes it to `ghcr.io/justerlex/google-tasks-mcp` automatically:

- pushing a `vX.Y.Z` tag publishes that version plus `latest`.
- pushing to `main` (or running the workflow manually) publishes a rolling
  build tagged with its `git describe` output, plus `edge` — the
  Docker-ecosystem convention for "latest build off the default branch,"
  not necessarily stable.

To build it yourself instead:

```bash
docker build -t google-tasks-mcp .
docker push <your-registry>/google-tasks-mcp:latest   # wherever you'll run it from
```

### Adding it as an Obot catalog entry

Runtime: **Remote**, not Containerized. As of Obot v0.25.2, Obot's gateway
only runs its OAuth-discovery/static-OAuth-broker logic
(`CheckForMCPAuth` in `pkg/api/handlers/mcpgateway/oauth/mcpoauthhandler.go`)
for catalog entries with `Runtime: Remote` — Containerized-runtime servers
are explicitly treated as "no OAuth required" and Obot never contacts the
upstream authorization server for them at all, no matter what this server
returns. That's a confirmed, currently-open gap
([obot-platform/obot#5372](https://github.com/obot-platform/obot/issues/5372)),
not a configuration mistake — Containerized simply doesn't wire this up yet.
Remote does, so Obot doesn't deploy the container for you; you run it
yourself (the included `Dockerfile`/image works fine for this) somewhere
Obot's gateway can reach over HTTPS. It must be a real, non-private address:
Obot's remote-MCP-URL validation blocks loopback/private-IP targets by
default, so an in-cluster-only Service address won't pass unless that
validation is explicitly relaxed.

**Remote Server Configuration:**

| Field | Value |
|---|---|
| URL | `https://<your-host>/mcp` — wherever you deployed the image, with `PORT=8080`, `GTASKS_MCP_PUBLIC_URL=https://<your-host>` and `GTASKS_MCP_CREDENTIALS` set |
| Advanced → Static OAuth | **required** — see below |

Google doesn't support OAuth Dynamic Client Registration, so generic
MCP-spec discovery alone can't get Obot a client to use. Obot's "Advanced →
Static OAuth" section on a Remote entry is exactly the escape hatch for
this: fill in the same Google OAuth client's **Client ID and Client
Secret** there (the same client the [Google Cloud
setup](#google-cloud-setup-one-time-15-minutes) above produced). Obot's
static-OAuth code builds the redirect URL itself from a fixed path
(`system.MCPOAuthCallbackURL`), so it's the same one registered below
regardless of how many Remote/static-OAuth entries you add.

This server still needs the same client's `client_id` (not the secret) via
`GTASKS_MCP_CREDENTIALS` — `{"client_id": "…"}` is enough — purely to verify
the audience of whatever access token Obot forwards it; that verification is
independent of, and doesn't need to agree on structure with, Obot's own
Static OAuth config.

Before Obot's OAuth flow will work, add Obot's callback as an authorized
redirect URI on that same Google Cloud OAuth client:

```
https://<your-obot-host>/oauth/mcp/callback
```

This is a single fixed path for the whole Obot instance — Obot's own
"Static OAuth" callback, shared across every Remote server configured this
way, not something specific to this catalog entry. It routes each completed
grant back to the right in-flight per-user request via the OAuth `state`
parameter, so you only register it once.

Token handling is intentionally minimal-footprint:

- Nothing is written to disk. `GTASKS_MCP_TOKEN`/`GTASKS_MCP_DIR` are unused
  in HTTP mode — there is no local token cache to protect because there isn't
  one.
- Each request gets its own ephemeral Google API client built from that
  request's bearer token, scoped via `AsyncLocalStorage` to that single call.
  It's unreachable from any other request, tenant, or session, and is
  discarded (GC'd) the moment the call returns.
- The server is stateless — no session store — so a new `McpServer` instance
  is built per request. Concurrent tenants never share in-memory state.
- Invalid, expired, or wrong-audience tokens get a `401` with
  `WWW-Authenticate: Bearer`; the rejection reason is logged for the operator
  but never echoed back to the caller.

## Tools

**Task lists:** `list_tasklists`, `get_tasklist`, `create_tasklist`, `update_tasklist`, `delete_tasklist`

**Tasks:** `list_tasks` (filters: completed/hidden/deleted, `updatedMin`, due bounds), `get_task`, `create_task`, `update_task`, `complete_task`, `delete_task`, `move_task` (reorder, re-parent, or move across lists)

**Sync:** `diff_tasks(since, [tasklist])` returns everything that changed after an RFC3339 timestamp, grouped per list into `completed` / `active` / `deleted`. It sweeps every list unless you name one.

## Design notes (API sharp edges, handled)

- **Due dates are date-only.** The API silently discards the time portion, and naive RFC3339 values can land a day off. Pass `YYYY-MM-DD`; the server normalizes to UTC midnight.
- **App-completed tasks go hidden.** Ticking a task in the Google Tasks app sets `hidden: true`; a plain list call never sees it again. `diff_tasks` always queries with `showCompleted + showHidden + showDeleted`, so nothing is missed.
- **No sync tokens.** Unlike the Calendar API, Tasks has no incremental sync token. `diff_tasks` uses `updatedMin`; keep a snapshot on your side and pass its timestamp.
- **`position` is read-only.** Reordering only works through `move_task` (parent + previous). This includes subtask nesting.
- **There is deliberately no `clear_completed` tool.** The API's `tasks.clear` wipes completed tasks from a list, which permanently destroys the evidence `diff_tasks` depends on. An LLM should not be able to call that casually. If you truly need it, the Tasks apps expose it in their UI.

## Development

```bash
git clone https://github.com/justerlex/google-tasks-mcp
cd google-tasks-mcp
npm install
npm run build
node dist/index.js auth   # one-time
node dist/index.js        # stdio server
```

One TypeScript file, ~650 lines: `src/index.ts`.

## License

[MIT](LICENSE)
