#!/usr/bin/env node
/**
 * google-tasks-mcp · MCP server for the Google Tasks API.
 *
 * Full surface: task-list CRUD + task CRUD + move + a purpose-built
 * `diff_tasks` tool for harvesting changes since a timestamp.
 *
 * Two run modes:
 *  - stdio (default): single local user. Auth is a one-time
 *    `google-tasks-mcp auth` run (browser OAuth via @google-cloud/local-auth);
 *    the refresh token is cached to disk and the server itself never opens
 *    a browser.
 *  - HTTP (when PORT is set): multi-tenant, for hosting behind an OAuth-aware
 *    gateway like Obot. No token ever touches disk here — see the "Multi-user
 *    hosting" section in README.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
// Per-API package, never the "googleapis" monolith: that one eager-loads all
// ~330 API surfaces (~7k files) at import and can cold-start slower than an
// MCP client's connect timeout.
import { tasks, tasks_v1, auth } from "@googleapis/tasks";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";

const VERSION = "0.4.0";
const SCOPES = ["https://www.googleapis.com/auth/tasks"];
const GOOGLE_AUTHORIZATION_SERVER = "https://accounts.google.com";
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";

const CONFIG_DIR =
  process.env.GTASKS_MCP_DIR ?? path.join(os.homedir(), ".config", "google-tasks-mcp");
const CREDENTIALS_PATH =
  process.env.GTASKS_MCP_CREDENTIALS ?? path.join(CONFIG_DIR, "client_secret.json");
const TOKEN_PATH = process.env.GTASKS_MCP_TOKEN ?? path.join(CONFIG_DIR, "token.json");
// HTTP mode only: the externally-reachable base URL this server is deployed at (e.g.
// https://google-tasks-mcp.example.com). Needed to advertise RFC 9728 protected-resource
// metadata pointing back at itself, and at Google as the authorization server.
const PUBLIC_URL = process.env.GTASKS_MCP_PUBLIC_URL;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function loadSavedClient() {
  try {
    const content = await fs.readFile(TOKEN_PATH, "utf-8");
    return auth.fromJSON(JSON.parse(content));
  } catch {
    return null;
  }
}

async function saveCredentials(client: { credentials: { refresh_token?: string | null } }) {
  const content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
  const keys = JSON.parse(content);
  const key = keys.installed ?? keys.web;
  const payload = JSON.stringify(
    {
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    },
    null,
    2
  );
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, payload);
}

async function runAuthFlow(): Promise<void> {
  try {
    await fs.access(CREDENTIALS_PATH);
  } catch {
    console.error(
      `No OAuth client file at ${CREDENTIALS_PATH}\n` +
        `Create a Google Cloud "Desktop app" OAuth client and save its JSON there\n` +
        `(or point GTASKS_MCP_CREDENTIALS at it). Full runbook: README.md`
    );
    process.exit(1);
  }
  // Lazy: only this one-time command needs local-auth, the server never does.
  const { authenticate } = await import("@google-cloud/local-auth");
  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (!client.credentials.refresh_token) {
    console.error(
      "Google returned no refresh token. Remove the app's access at " +
        "https://myaccount.google.com/permissions and run auth again."
    );
    process.exit(1);
  }
  await saveCredentials(client);
  console.error(`✓ Token saved to ${TOKEN_PATH}. The MCP server is ready to run.`);
}

let tasksApi: tasks_v1.Tasks | null = null;

// Per-request auth, set only in HTTP (multi-tenant) mode. Scoped to the async
// call chain of a single tool invocation: never written anywhere, never
// shared across tenants, and unreachable once that call returns.
const requestAuth = new AsyncLocalStorage<AuthInfo>();

async function api(): Promise<tasks_v1.Tasks> {
  const authInfo = requestAuth.getStore();
  if (authInfo) {
    // Multi-tenant HTTP mode: build a fresh, request-scoped client from the
    // caller's own (already-verified) Google access token. No refresh_token,
    // no disk, no module-level cache — nothing here outlives this call.
    const client = new auth.OAuth2();
    client.setCredentials({ access_token: authInfo.token });
    return tasks({ version: "v1", auth: client as never });
  }

  if (tasksApi) return tasksApi;
  const client = await loadSavedClient();
  if (!client) {
    throw new Error(
      `No saved token at ${TOKEN_PATH}. Run \`npx google-tasks-mcp auth\` once to authenticate.`
    );
  }
  tasksApi = tasks({ version: "v1", auth: client as never });
  return tasksApi;
}

/**
 * Verifies a bearer token is a genuine Google access token issued to *this*
 * server's OAuth client and carrying the Tasks scope, by asking Google
 * directly — the token is opaque to us, so we can't validate it locally.
 * This stops a stray or unrelated bearer token (wrong audience, wrong scope,
 * expired) from ever reaching the Tasks API on someone else's behalf.
 */
class GoogleTokenVerifier {
  constructor(private readonly clientId: string) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) throw new Error("token rejected by Google");
    const info = (await res.json()) as {
      aud?: string;
      azp?: string;
      scope?: string;
      expires_in?: string;
    };
    if (info.aud !== this.clientId && info.azp !== this.clientId) {
      throw new Error("token was not issued for this server's OAuth client");
    }
    const scopes = (info.scope ?? "").split(" ").filter(Boolean);
    if (!scopes.includes(SCOPES[0])) {
      throw new Error("token is missing the Tasks scope");
    }
    return {
      token,
      clientId: this.clientId,
      scopes,
      expiresAt: info.expires_in ? Math.floor(Date.now() / 1000) + Number(info.expires_in) : undefined,
    };
  }
}

/** Reads just the client_id out of the same OAuth client JSON documented in
 *  the README (client_secret.json) — HTTP mode only ever needs the public
 *  half to check token audience; it never needs and never sees the secret. */
async function loadHttpClientId(): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
  } catch {
    throw new Error(
      `No OAuth client file at ${CREDENTIALS_PATH}. HTTP mode needs the client_id from the same ` +
        `Google Cloud OAuth client documented in README.md (or point GTASKS_MCP_CREDENTIALS at it).`
    );
  }
  const keys = JSON.parse(content);
  const clientId = (keys.installed ?? keys.web ?? keys)?.client_id;
  if (!clientId) throw new Error(`${CREDENTIALS_PATH} has no client_id.`);
  return clientId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Google Tasks due dates are DATE-ONLY: the API discards any time portion.
 *  Accept bare YYYY-MM-DD and normalize to the UTC-midnight form the API
 *  expects, so callers never get an off-by-one-day surprise. */
function normalizeDue(due?: string): string | undefined {
  if (!due) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00.000Z` : due;
}

async function drainPages<T>(
  fetchPage: (pageToken?: string) => Promise<{ data: { items?: T[]; nextPageToken?: string | null } }>
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetchPage(pageToken);
    out.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function register(
  server: McpServer,
  name: string,
  description: string,
  shape: z.ZodRawShape,
  fn: (args: Record<string, unknown>) => Promise<unknown>
): void {
  server.tool(name, description, shape, async (args: Record<string, unknown>, extra): Promise<ToolResult> =>
    // Scope this call's Google auth (if any — only set in HTTP mode) to the
    // async chain of this one tool invocation, so concurrent tenants never
    // see each other's tokens even though every request shares one process.
    requestAuth.run(extra.authInfo as AuthInfo, async () => {
      try {
        return ok(await fn(args));
      } catch (e) {
        const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
        const msg = err.response?.data?.error?.message ?? err.message ?? String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    })
  );
}

/** Builds a fresh server with every tool registered. Called once for the
 *  single long-lived stdio connection, and once per HTTP request in
 *  multi-tenant mode (a Server accepts only one live transport at a time,
 *  so concurrent tenants each need their own instance). */
function buildServer(): McpServer {
  const server = new McpServer({ name: "google-tasks-mcp", version: VERSION });

  // ---------------------------------------------------------------------------
  // Task-list tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "list_tasklists",
    "List all of the user's task lists (id, title, updated).",
    {},
    async () => {
      const t = await api();
      return drainPages((pageToken) => t.tasklists.list({ maxResults: 100, pageToken }));
    }
  );

  register(
    server,
    "get_tasklist",
    "Get a single task list by id.",
    { tasklist: z.string().describe("Task list id") },
    async (a) => {
      const t = await api();
      return (await t.tasklists.get({ tasklist: a.tasklist as string })).data;
    }
  );

  register(
    server,
    "create_tasklist",
    "Create a new task list. Emoji in titles render fine in the Google Tasks apps.",
    { title: z.string().describe("Title of the new task list") },
    async (a) => {
      const t = await api();
      return (await t.tasklists.insert({ requestBody: { title: a.title as string } })).data;
    }
  );

  register(
    server,
    "update_tasklist",
    "Rename a task list.",
    {
      tasklist: z.string().describe("Task list id"),
      title: z.string().describe("New title"),
    },
    async (a) => {
      const t = await api();
      return (
        await t.tasklists.patch({
          tasklist: a.tasklist as string,
          requestBody: { title: a.title as string },
        })
      ).data;
    }
  );

  register(
    server,
    "delete_tasklist",
    "Delete a task list AND all tasks in it. Irreversible: confirm intent before calling.",
    { tasklist: z.string().describe("Task list id") },
    async (a) => {
      const t = await api();
      await t.tasklists.delete({ tasklist: a.tasklist as string });
      return { deleted: a.tasklist };
    }
  );

  // ---------------------------------------------------------------------------
  // Task tools
  // ---------------------------------------------------------------------------

  register(
    server,
    "list_tasks",
    "List tasks in a task list. By default returns only active (needsAction) tasks; " +
      "set the show* flags for completed/hidden/deleted ones. Note: tasks completed in the " +
      "Google Tasks apps become hidden, so harvesting completions needs showCompleted AND showHidden.",
    {
      tasklist: z.string().describe("Task list id"),
      showCompleted: z.boolean().optional().describe("Include completed tasks (default false)"),
      showHidden: z.boolean().optional().describe("Include hidden tasks (default false)"),
      showDeleted: z.boolean().optional().describe("Include deleted tasks (default false)"),
      updatedMin: z
        .string()
        .optional()
        .describe("RFC3339 timestamp; only tasks updated after this moment"),
      dueMin: z.string().optional().describe("RFC3339 lower bound on due date"),
      dueMax: z.string().optional().describe("RFC3339 upper bound on due date"),
    },
    async (a) => {
      const t = await api();
      return drainPages((pageToken) =>
        t.tasks.list({
          tasklist: a.tasklist as string,
          maxResults: 100,
          pageToken,
          showCompleted: (a.showCompleted as boolean | undefined) ?? false,
          showHidden: (a.showHidden as boolean | undefined) ?? false,
          showDeleted: (a.showDeleted as boolean | undefined) ?? false,
          updatedMin: a.updatedMin as string | undefined,
          dueMin: a.dueMin as string | undefined,
          dueMax: a.dueMax as string | undefined,
        })
      );
    }
  );

  register(
    server,
    "get_task",
    "Get a single task by id.",
    {
      tasklist: z.string().describe("Task list id"),
      task: z.string().describe("Task id"),
    },
    async (a) => {
      const t = await api();
      return (await t.tasks.get({ tasklist: a.tasklist as string, task: a.task as string })).data;
    }
  );

  register(
    server,
    "create_task",
    "Create a task. Due dates are DATE-ONLY in Google Tasks (any time portion is discarded); " +
      "pass YYYY-MM-DD and it is normalized safely.",
    {
      tasklist: z.string().describe("Task list id"),
      title: z.string().describe("Task title"),
      notes: z.string().optional().describe("Free-text notes on the task"),
      due: z.string().optional().describe("Due date, YYYY-MM-DD (or full RFC3339)"),
      parent: z.string().optional().describe("Parent task id, to create as a subtask"),
      previous: z.string().optional().describe("Sibling task id to insert after"),
    },
    async (a) => {
      const t = await api();
      return (
        await t.tasks.insert({
          tasklist: a.tasklist as string,
          parent: a.parent as string | undefined,
          previous: a.previous as string | undefined,
          requestBody: {
            title: a.title as string,
            notes: a.notes as string | undefined,
            due: normalizeDue(a.due as string | undefined),
          },
        })
      ).data;
    }
  );

  register(
    server,
    "update_task",
    "Update a task's title, notes, due date, or status (needsAction | completed).",
    {
      tasklist: z.string().describe("Task list id"),
      task: z.string().describe("Task id"),
      title: z.string().optional().describe("New title"),
      notes: z.string().optional().describe("New notes"),
      due: z.string().optional().describe("New due date, YYYY-MM-DD (or full RFC3339)"),
      status: z.enum(["needsAction", "completed"]).optional().describe("New status"),
    },
    async (a) => {
      const t = await api();
      const body: tasks_v1.Schema$Task = {};
      if (a.title !== undefined) body.title = a.title as string;
      if (a.notes !== undefined) body.notes = a.notes as string;
      if (a.due !== undefined) body.due = normalizeDue(a.due as string);
      if (a.status !== undefined) body.status = a.status as string;
      return (
        await t.tasks.patch({
          tasklist: a.tasklist as string,
          task: a.task as string,
          requestBody: body,
        })
      ).data;
    }
  );

  register(
    server,
    "complete_task",
    "Mark a task completed (shorthand for update_task with status=completed).",
    {
      tasklist: z.string().describe("Task list id"),
      task: z.string().describe("Task id"),
    },
    async (a) => {
      const t = await api();
      return (
        await t.tasks.patch({
          tasklist: a.tasklist as string,
          task: a.task as string,
          requestBody: { status: "completed" },
        })
      ).data;
    }
  );

  register(
    server,
    "delete_task",
    "Delete a single task.",
    {
      tasklist: z.string().describe("Task list id"),
      task: z.string().describe("Task id"),
    },
    async (a) => {
      const t = await api();
      await t.tasks.delete({ tasklist: a.tasklist as string, task: a.task as string });
      return { deleted: a.task };
    }
  );

  register(
    server,
    "move_task",
    "Reorder a task (position is read-only; this is the only way to reorder), re-parent it " +
      "as a subtask, or move it to another list via destinationTasklist.",
    {
      tasklist: z.string().describe("Current task list id"),
      task: z.string().describe("Task id"),
      parent: z.string().optional().describe("New parent task id (omit for top level)"),
      previous: z.string().optional().describe("Sibling task id to place after (omit for first position)"),
      destinationTasklist: z.string().optional().describe("Target task list id, to move across lists"),
    },
    async (a) => {
      const t = await api();
      return (
        await t.tasks.move({
          tasklist: a.tasklist as string,
          task: a.task as string,
          parent: a.parent as string | undefined,
          previous: a.previous as string | undefined,
          destinationTasklist: a.destinationTasklist as string | undefined,
        })
      ).data;
    }
  );

  // ---------------------------------------------------------------------------
  // Diff tool
  // ---------------------------------------------------------------------------

  register(
    server,
    "diff_tasks",
    "Harvest every change since a timestamp: returns tasks updated after `since`, grouped per " +
      "list into completed / active / deleted. Queries with showCompleted+showHidden+showDeleted " +
      "so completions made in the Google Tasks apps (which become hidden) are not missed. " +
      "Omit `tasklist` to sweep every list. The API has no sync tokens; keep your own snapshot " +
      "and pass its timestamp as `since`.",
    {
      since: z.string().describe("RFC3339 timestamp, e.g. 2026-07-20T00:00:00.000Z"),
      tasklist: z.string().optional().describe("Limit to one task list id (default: all lists)"),
    },
    async (a) => {
      const t = await api();
      const lists = a.tasklist
        ? [(await t.tasklists.get({ tasklist: a.tasklist as string })).data]
        : await drainPages((pageToken) => t.tasklists.list({ maxResults: 100, pageToken }));

      const result = [];
      for (const list of lists) {
        const changed = await drainPages<tasks_v1.Schema$Task>((pageToken) =>
          t.tasks.list({
            tasklist: list.id!,
            maxResults: 100,
            pageToken,
            updatedMin: a.since as string,
            showCompleted: true,
            showHidden: true,
            showDeleted: true,
          })
        );
        if (changed.length === 0) continue;
        result.push({
          list: { id: list.id, title: list.title },
          completed: changed.filter((x) => !x.deleted && x.status === "completed"),
          active: changed.filter((x) => !x.deleted && x.status !== "completed"),
          deleted: changed.filter((x) => x.deleted),
        });
      }
      return { since: a.since, changedLists: result.length, changes: result };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP (multi-tenant) mode
// ---------------------------------------------------------------------------

/**
 * Streamable-HTTP entry point for hosted, multi-tenant deployments (e.g. an
 * Obot catalog entry running as a multi-user server). Stateless by design —
 * no session store, so there is nothing server-side that could mix up two
 * tenants' state: every request is independently authenticated and gets its
 * own McpServer + transport, used once and discarded.
 *
 * Auth model: this process is a pure OAuth Resource Server. It never runs
 * the OAuth dance and never sees a refresh token — an upstream OAuth-aware
 * gateway (e.g. Obot's mcp-oauth-proxy, configured with the same client
 * credentials JSON from README.md) does that per user and forwards each
 * request with `Authorization: Bearer <google-access-token>`. Every request
 * is (re)verified against Google, so nothing is trusted just because it came
 * through the gateway. The gateway finds Google in the first place via the
 * RFC 9728 protected-resource metadata served at PROTECTED_RESOURCE_PATH,
 * advertised in every 401's `WWW-Authenticate: ... resource_metadata="..."`.
 */
async function runHttpServer(port: number): Promise<void> {
  if (!PUBLIC_URL) {
    console.error(
      "GTASKS_MCP_PUBLIC_URL is required in HTTP mode: the externally-reachable base URL " +
        "this server is deployed at (e.g. https://google-tasks-mcp.example.com), used to " +
        "advertise RFC 9728 protected-resource metadata so an OAuth-aware gateway can discover " +
        "Google as the authorization server."
    );
    process.exit(1);
  }
  const resourceMetadataURL = `${PUBLIC_URL}${PROTECTED_RESOURCE_PATH}`;

  // Lazy imports: only HTTP mode pays for the transport/HTTP-adapter code.
  const { createServer: createHttpServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const clientId = await loadHttpClientId();
  const verifier = new GoogleTokenVerifier(clientId);

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");

      if (pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (pathname === PROTECTED_RESOURCE_PATH) {
        // RFC 9728 protected-resource metadata: tells an OAuth-aware gateway that Google is the
        // authorization server for this resource, so it can broker a real Google token instead
        // of assuming this server runs its own OAuth.
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            resource: `${PUBLIC_URL}/mcp`,
            authorization_servers: [GOOGLE_AUTHORIZATION_SERVER],
            scopes_supported: SCOPES,
            bearer_methods_supported: ["header"],
          })
        );
        return;
      }
      if (pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        res
          .writeHead(405, { "content-type": "application/json" })
          .end(jsonRpcError(-32000, "Method not allowed."));
        return;
      }

      const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) {
        res
          .writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer realm="google-tasks-mcp", resource_metadata="${resourceMetadataURL}"`,
          })
          .end(jsonRpcError(-32001, "Missing bearer token."));
        return;
      }

      let authInfo: AuthInfo;
      try {
        authInfo = await verifier.verifyAccessToken(token);
      } catch (e) {
        // Never echo the token or the verifier's internal detail back to an
        // unauthenticated caller; log the reason for the operator only.
        console.error("Rejected bearer token:", e instanceof Error ? e.message : "verification failed");
        res
          .writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer realm="google-tasks-mcp", error="invalid_token", resource_metadata="${resourceMetadataURL}"`,
          })
          .end(jsonRpcError(-32001, "Invalid or expired access token."));
        return;
      }

      (req as typeof req & { auth?: AuthInfo }).auth = authInfo;

      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => void transport.close());
        await buildServer().connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        console.error("Error handling MCP request:", e instanceof Error ? e.message : String(e));
        if (!res.headersSent) {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(jsonRpcError(-32603, "Internal server error"));
        }
      }
    })();
  });

  httpServer.listen(port, () => {
    console.error(`google-tasks-mcp v${VERSION} listening on :${port}/mcp (multi-tenant HTTP mode)`);
  });
}

function jsonRpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  if (cmd === "auth") {
    await runAuthFlow();
    return;
  }
  if (cmd && cmd !== "serve") {
    console.error(`Unknown command "${cmd}". Usage: google-tasks-mcp [auth]`);
    process.exit(1);
  }

  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  if (port) {
    await runHttpServer(port);
    return;
  }

  await buildServer().connect(new StdioServerTransport());
  // stdout is the MCP protocol channel; all human output goes to stderr.
  console.error(`google-tasks-mcp v${VERSION} running on stdio`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
