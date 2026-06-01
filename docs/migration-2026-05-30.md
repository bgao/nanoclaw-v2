# v1 → v2 Migration — 2026-05-30

## Summary

Migrated NanoClaw v1 (`/home/bgao/repos/nanoclaw`, v2.0.71) to v2 on 2026-05-30.

`migrate-v2.sh` ran all deterministic steps successfully (all steps: success). `/migrate-from-v1` skill completed the manual phases.

## What was migrated

- **Channel**: Telegram (`bgao824_openclaw_bot`)
- **Groups ported**: `main`, `dm-with-bo` (Ta), `cli-with-bo` (Terminal Agent)
- **Sessions**: Conversation history and Claude Code memory copied with continuity
- **Scheduled tasks**: Ported from v1
- **Container image**: Built fresh for v2

## Configuration applied

| Item | Value |
|------|-------|
| Owner | `telegram:1336785161` (Bo Gao) |
| Access policy | `member` (known users only) |
| Members | `telegram:1336785161` |
| Agent group (active) | `ag-1780171867929-e8scn3` (main) |
| Messaging group | `mg-1780171867930-g9wqx7` (telegram:1336785161) |

## CLAUDE.local.md changes

- `groups/main/CLAUDE.local.md` — stripped all v1 boilerplate; kept identity only
- `groups/dm-with-bo/CLAUDE.local.md` — migration had accidentally copied the compose header; restored correct `# Ta` identity + memory file index from v1's CLAUDE.local.md
- `groups/cli-with-bo/CLAUDE.local.md` — already correct, no change

## Container configs

All `additionalMounts` host paths verified valid:
- `/home/bgao/repos/nanoclaw/mcp-servers/mcp-finnhub` (cli-with-bo, dm-with-bo)
- `/home/bgao/.gmail-mcp` (dm-with-bo)
- `/home/bgao/repos/synapse-matrix` (main)

Note: Finnhub API key is hardcoded in `container.json` for both groups — consider moving to OneCLI vault.

## Fork customizations

v1 had commits ahead of upstream. All meaningful customizations were already ported by the migration:
- Telegram adapter: `maxTextLength: 4000`, `resolveChannelName` via getChat API, pairing confirmation message ✓
- MCP Finnhub server: wired in container.json for cli-with-bo and dm-with-bo ✓
- Gmail MCP: wired in container.json for dm-with-bo ✓

A2A routing fix commits (`323ba12`, `04f03e9`) were upstream contributions, not user customizations — not ported.

## Final verify

```
SERVICE: running
CONTAINER_RUNTIME: docker
CREDENTIALS: configured
CONFIGURED_CHANNELS: telegram
CHANNEL_AUTH: {"telegram":"configured"}
REGISTERED_GROUPS: 1
MOUNT_ALLOWLIST: configured
STATUS: success
```
