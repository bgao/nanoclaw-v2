---
name: add-gmail-tool
description: Add Gmail as an MCP tool (read, search, send, label, draft) using OneCLI-managed OAuth. The agent gets Gmail tools in every enabled group; OneCLI injects real tokens at request time so no raw credentials are ever in the container or on disk in usable form.
---

# Add Gmail Tool (OneCLI-native)

This skill wires the [`@gongrzhe/server-gmail-autoauth-mcp`](https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp) stdio MCP server into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `gmail.googleapis.com` and injects the real OAuth bearer from its vault.

Tools exposed (from `gmail-mcp@1.1.11`, surfaced to the agent as `mcp__gmail__<name>`): `search_emails`, `read_email`, `send_email`, `draft_email`, `delete_email`, `modify_email`, `batch_modify_emails`, `batch_delete_emails`, `download_attachment`, `list_email_labels`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`, `list_filters`, `get_filter`, `create_filter`, `create_filter_from_template`, `delete_filter`.

**Why this pattern:** v2's invariant is that containers never receive raw API keys — OneCLI is the sole credential path (see CHANGELOG v2.0.0). The stub-file pattern satisfies this: the container sees `"onecli-managed"` placeholders, the gateway swaps them in flight.

**How OneCLI injects Gmail credentials:** Gmail OAuth is stored as an `AppConnection` in OneCLI's Postgres DB (not as a `Secret`). `secretMode` on the agent does *not* affect Gmail injection — what matters is a row in `agent_app_connections` linking the agent to the Gmail connection. This skill creates that link. See Phase 1.

## Phase 1: Pre-flight

### Verify OneCLI has Gmail connected

The `onecli` CLI (v1.1.1) does not have an `apps` subcommand. Check the Postgres DB directly:

```bash
docker exec onecli-postgres-1 psql -U onecli -d onecli \
  -c "SELECT provider, status, updated_at FROM app_connections WHERE provider = 'gmail';"
```

Expected: one row with `status = connected`.

If no row is returned, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Gmail, and click Connect. Sign in with the Google account you want the agent to act as. Come back when done.

Once connected, verify the granted scopes cover what the agent needs. The OneCLI web UI shows the scopes on the Gmail app detail page. At minimum you need `gmail.readonly`, `gmail.modify`, and `gmail.send`. If scopes are missing, disconnect and reconnect to get a fresh consent screen — there is no way to add scopes to an existing connection without re-authorizing.

### Verify stub credentials exist

```bash
ls -la ~/.gmail-mcp/gcp-oauth.keys.json ~/.gmail-mcp/credentials.json 2>&1
```

If both exist and contain `"onecli-managed"`:

```bash
grep -l onecli-managed ~/.gmail-mcp/gcp-oauth.keys.json ~/.gmail-mcp/credentials.json
```

...skip to Phase 2.

If either file exists but does **not** contain `onecli-managed`, **STOP** and tell the user — these are real OAuth credentials from a previous non-OneCLI install. Back them up, then delete before proceeding. The OneCLI migration normally handles this; if it didn't, something is wrong.

If both files are absent, write them now:

```bash
mkdir -p ~/.gmail-mcp
cat > ~/.gmail-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.gmail-mcp/credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send"
}
EOF
chmod 600 ~/.gmail-mcp/gcp-oauth.keys.json ~/.gmail-mcp/credentials.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.gmail-mcp` must sit under an `allowedRoots` entry (e.g. `/home/<user>`). If it doesn't, tell the user to run `/manage-mounts` first or add their home directory.

### Link each target agent to the Gmail connection

Gmail credentials are injected via `agent_app_connections`, not `secretMode`. For each agent group that should have Gmail, find the OneCLI agent ID matching the group's `agentGroupId` and link it:

```bash
# Get the Gmail connection ID and OneCLI agent ID
docker exec onecli-postgres-1 psql -U onecli -d onecli -c "
SELECT ac.id AS connection_id, ac.provider, ac.status,
       a.id AS agent_id, a.name AS agent_name, aac.agent_id AS already_linked
FROM app_connections ac
LEFT JOIN agent_app_connections aac ON ac.id = aac.app_connection_id
LEFT JOIN agents a ON aac.agent_id = a.id
WHERE ac.provider = 'gmail';"
```

Cross-reference with `onecli agents list` to find the agent IDs for your target groups.

If the target agent is not already linked (no row in the join), insert it:

```bash
docker exec onecli-postgres-1 psql -U onecli -d onecli -c "
INSERT INTO agent_app_connections (agent_id, app_connection_id, updated_at)
VALUES ('<onecli-agent-id>', '<gmail-connection-id>', NOW())
ON CONFLICT DO NOTHING;"
```

Verify:

```bash
docker exec onecli-postgres-1 psql -U onecli -d onecli -c "
SELECT a.name, ac.provider, ac.status
FROM agent_app_connections aac
JOIN agents a ON aac.agent_id = a.id
JOIN app_connections ac ON aac.app_connection_id = ac.id
WHERE ac.provider = 'gmail';"
```

**Note:** `secretMode` (`all` vs `selective`) only controls *Secret* injection (API keys). It has no effect on AppConnection injection. You do not need to call `onecli agents set-secrets` for Gmail.

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'GMAIL_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Copy the skill's tests into the container tree

Both integration points this skill relies on live in the container (Bun) tree — the Dockerfile package install and the dynamic allow-pattern derivation in `claude.ts` — so the guards go there. `cp` overwrites, so re-running is safe.

```bash
S=.claude/skills/add-gmail-tool
cp $S/gmail-dockerfile.test.ts    container/agent-runner/src/providers/gmail-dockerfile.test.ts
cp $S/gmail-allow-pattern.test.ts container/agent-runner/src/providers/gmail-allow-pattern.test.ts
```

- `gmail-dockerfile.test.ts` asserts the `GMAIL_MCP_VERSION` ARG and the pinned `pnpm install -g` line are present — the `gmail-mcp` binary is a Dockerfile-installed CLI, not importable or typed, so this structural guard is what goes red if the install is dropped.
- `gmail-allow-pattern.test.ts` asserts `claude.ts` still spreads `Object.keys(this.mcpServers).map(mcpAllowPattern)` into `allowedTools` — the derivation that makes registering `gmail` (Phase 3) enough to expose `mcp__gmail__*`.

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block near the top:

```dockerfile
ARG CLAUDE_CODE_VERSION=2.1.154
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=52.2.1
ARG BUN_VERSION=1.3.12
```

Add a new line:

```dockerfile
ARG GMAIL_MCP_VERSION=1.1.11
```

Then find the last pnpm global-install `RUN` block (the one that installs `@anthropic-ai/claude-code`) and add a new block directly after it (before the `# ---- ncl CLI wrapper` section):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```

Pinned version matters — `minimumReleaseAge` in `pnpm-workspace.yaml` gates trunk installs, and CLAUDE.md requires a fixed ARG version for all Node CLIs installed into the image.

**Why the `zod-to-json-schema` pin:** `@gongrzhe/server-gmail-autoauth-mcp@1.1.11` has loose deps (`zod-to-json-schema: ^3.22.1`, `zod: ^3.22.4`). pnpm resolves `zod-to-json-schema` to the latest 3.25.x, which imports `zod/v3` — a subpath that only exists in `zod>=3.25`. But `zod` resolves to `3.24.x` (highest satisfying `^3.22.4` without breaking peer ranges). Result: `ERR_PACKAGE_PATH_NOT_EXPORTED` at import time. Pinning `zod-to-json-schema` to a pre-v3-subpath version avoids it. Re-check if you bump `GMAIL_MCP_VERSION`.

The Gmail allow-pattern is derived automatically. `container/agent-runner/src/providers/claude.ts` builds `allowedTools` from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `gmail` in Phase 3 exposes `mcp__gmail__*` to the agent.

### Rebuild the container image

```bash
./container/build.sh
```

Must complete cleanly. The new `pnpm install -g` layer is ~60s first time (cached on rebuild).

## Phase 3: Wire Per-Agent-Group

For each agent group that should have Gmail (ask the user — typically their personal DM and CLI agents, sometimes shared household agents), persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.gmail` entry and an `additionalMounts` entry for `.gmail-mcp`. Both flow through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### List groups, pick which ones get Gmail

```bash
ncl groups list
```

### Register the MCP server

For each chosen `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name gmail \
  --command gmail-mcp \
  --args '[]' \
  --env '{"GMAIL_OAUTH_PATH":"/workspace/extra/.gmail-mcp/gcp-oauth.keys.json","GMAIL_CREDENTIALS_PATH":"/workspace/extra/.gmail-mcp/credentials.json"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

### Add the `.gmail-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Until that ships, edit the DB directly via the in-tree wrapper (`scripts/q.ts` — `setup/verify.ts:5` codifies that NanoClaw avoids depending on the `sqlite3` CLI binary, so don't shell out to it):

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.gmail-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".gmail-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from your NanoClaw project root (where `data/v2.db` lives). The `$[#]` placeholder is SQLite JSON1's append-to-end notation; it's `\$`-escaped so bash doesn't arithmetic-expand it before sqlite sees it. `updated_at` is ISO-string everywhere else in the schema, so use `datetime('now')` — not `strftime('%s','now')`, which would silently mix epoch ints into a column of YYYY-MM-DD HH:MM:SS strings.

**Switch to `ncl groups config add-mount` once #2395 lands.** Update this skill at that time.

**Why the container path is relative:** `mount-security` rejects absolute `containerPath` values. Additional mounts are prefixed with `/workspace/extra/`, so `containerPath: ".gmail-mcp"` lands at `/workspace/extra/.gmail-mcp`. The MCP server's `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH` env vars point at that absolute location inside the container.

**Why this can't be `groups/<folder>/container.json`:** post-migration `014-container-configs`, `materializeContainerJson` in `src/container-config.ts` rewrites that file from the DB on every spawn. Anything hand-edited there is silently overwritten on next restart.

## Phase 4: Build, Validate, Restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/providers/gmail-dockerfile.test.ts src/providers/gmail-allow-pattern.test.ts)
```

All must be clean before proceeding. `gmail-dockerfile.test.ts` confirms the package install is wired into the image; `gmail-allow-pattern.test.ts` confirms the allow-pattern derivation that exposes `mcp__gmail__*`. A failure means one drifted.

Then restart the host service. **Stop fully before starting** — the webhook server binds port 3000, and if the dying process still holds the port when the new one starts, it crashes into the circuit-breaker loop:

```bash
# Linux
systemctl --user stop nanoclaw
# Wait for port 3000 to be released — the process must exit cleanly first
until ! lsof -i :3000 -t &>/dev/null; do sleep 1; done
systemctl --user start nanoclaw

# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
until ! lsof -i :3000 -t &>/dev/null; do sleep 1; done
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

If the service is already in a circuit-breaker loop (repeated `"Circuit breaker: delaying startup"` in the error log), delete the state file before starting (`resetCircuitBreaker()` in `src/circuit-breaker.ts` uses `unlinkSync` — `rm` is the canonical reset, not overwriting with `{}`):

```bash
# Linux
systemctl --user stop nanoclaw
kill $(lsof -i :3000 -t 2>/dev/null) 2>/dev/null
until ! lsof -i :3000 -t &>/dev/null; do sleep 1; done
rm -f data/circuit-breaker.json
systemctl --user start nanoclaw

# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
kill $(lsof -i :3000 -t 2>/dev/null) 2>/dev/null
until ! lsof -i :3000 -t &>/dev/null; do sleep 1; done
rm -f data/circuit-breaker.json
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Phase 5: Verify

### Test from the wired agent

Tell the user:

> In your `<agent-name>` chat, send: **"list my gmail labels"** or **"search my inbox for invoices from last month"**.
>
> The agent should use `mcp__gmail__list_labels` / `mcp__gmail__search`. The first call may take a second or two while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'gmail|mcp'
# Per-container logs — session-scoped:
ls data/v2-sessions/*/stderr.log | head
```

Common signals:
- `command not found: gmail-mcp` → image wasn't rebuilt or PATH doesn't include `/pnpm` (should — `ENV PATH="$PNPM_HOME:$PATH"` in Dockerfile).
- `ENOENT: no such file or directory, open '/workspace/extra/.gmail-mcp/credentials.json'` → mount is missing. Check `~/.config/nanoclaw/mount-allowlist.json` includes a parent of `~/.gmail-mcp`.
- `403 Insufficient Permission` from `gmail.googleapis.com` → scope mismatch. The OAuth connection was granted fewer scopes than the operation requires (e.g. connected with read-only but calling `send_email`). Disconnect and reconnect Gmail in the OneCLI web UI with the correct scopes, then re-run Phase 1 scope verification.
- `401 Unauthorized` from `gmail.googleapis.com` → OneCLI isn't injecting. Check the agent is linked to the Gmail connection:
  ```bash
  docker exec onecli-postgres-1 psql -U onecli -d onecli \
    -c "SELECT a.name, ac.status FROM agent_app_connections aac
        JOIN agents a ON aac.agent_id = a.id
        JOIN app_connections ac ON aac.app_connection_id = ac.id
        WHERE ac.provider = 'gmail';"
  ```
  If the agent isn't listed, re-run the "Link each target agent" step in Phase 1.
- Agent says "I don't have Gmail tools" → the `gmail` MCP server isn't registered in this group's `mcpServers` (re-run the `ncl groups config add-mcp-server` step in Phase 3 for that group and restart it), or the agent-runner image is stale (rebuild with `./container/build.sh`, with `--no-cache` if suspicious).

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure (delete the copied tests, unregister the MCP server per group, drop the mount, remove the Dockerfile install, rebuild, and optionally drop the stubs and disconnect OneCLI).

## Notes

- **Stub format is OneCLI-prescribed.** The `access_token: "onecli-managed"` pattern with `expiry_date: 99999999999999` tells the Google auth client the token is valid; OneCLI intercepts the outgoing Gmail API call and rewrites `Authorization: Bearer onecli-managed` to the real token. `expiry_date: 0` (refresh-interception) is an alternative the OneCLI docs describe — both work but OneCLI's own `migrate` command writes the far-future variant, which is what this skill assumes.
- **Gmail uses AppConnection, not Secret.** OneCLI stores Gmail OAuth tokens in `app_connections` (Postgres), separate from the `secrets` table used for API keys. The `onecli secrets list` command will not show Gmail. The `secretMode` setting on an agent (`all` vs `selective`) controls Secret injection only and has no effect on Gmail. What controls Gmail injection is the `agent_app_connections` row — if it's missing, OneCLI won't inject even if the app is connected.
- **OneCLI CLI version gap.** As of v1.1.1, the `onecli` CLI does not expose `apps` subcommands (`apps get`, `apps disconnect`). Use the web UI at http://127.0.0.1:10254 or query Postgres directly. If a future CLI version adds these commands, update this skill.
- **Scopes are set at OAuth connect time.** If the agent needs scopes beyond what's currently connected (e.g. the user later wants `calendar.readonly` for combined email/calendar workflows), disconnect and reconnect Gmail in the OneCLI web UI with the expanded scope set.
- **This is tool-only.** Inbound email as a channel (emails trigger the agent) is a separate piece of work — it needs a `src/channels/gmail.ts` adapter that polls the inbox and routes to a messaging group. The pre-v2 qwibitai skill had this; it has not been ported to v2's channel architecture as of v2.0.0.

## Credits & references

- **MCP server:** [`@gongrzhe/server-gmail-autoauth-mcp`](https://github.com/GongRzhe/Gmail-MCP-Server) by GongRzhe — MIT-licensed.
- **OneCLI credential stubs:** pattern documented at `https://onecli.sh/docs/guides/credential-stubs/gmail.md`.
- **Skill pattern:** modeled on [`add-atomic-chat-tool`](../add-atomic-chat-tool/SKILL.md) and [`add-vercel`](../add-vercel/SKILL.md).
- **Addresses:** [issue #1500](https://github.com/nanocoai/nanoclaw/issues/1500) (proxy Gmail/Calendar OAuth tokens through credential proxy) for the Gmail side.
- **Related PRs:** [#1810](https://github.com/nanocoai/nanoclaw/pull/1810) (pre-install Gmail/Notion MCP) overlaps on the "install the MCP server in the image" idea but bundles many unrelated changes; this skill is the focused OneCLI-native version.
