---
'@composio/cli': minor
---

Add `composio setup` to authenticate human or browserless agent identities and idempotently install the Composio marketplace, plugin, and CLI skill for Claude Code and Codex. Agent binary installs now delegate to setup when a supported host is detected and retain an identity-only fallback on hostless machines.
