# opencode-kimicode-auth

OpenCode auth plugin that adds **Kimi Code OAuth** (kmi-cli style device-code flow) under the **Moonshot AI** provider (`moonshotai`).

It lets you bring your own Kimi subscription via OAuth, manages a multi-account pool (rotation + proactive refresh), and routes Moonshot `/v1/*` requests to Kimi Code:

- `https://api.kimi.com/coding/v1/*`

## Models

This plugin adds Kimi Code OAuth models **additively** under `provider.moonshotai.models`.

- `moonshotai/kimicode-kimi-k2.5` (maps to Kimi Code `kimi-for-coding`)

Existing `moonshotai/*` models intended for API-key auth are not modified.

## Usage

1. Ensure the plugin is installed and listed in your OpenCode config.
2. Run `opencode auth login`
3. Select **Moonshot AI**
4. Select **OAuth (Kimi Code / kimi-cli)**

The OAuth menu supports adding multiple accounts and removing accounts from the pool.

## Files Written

- OpenCode credential store (OpenCode-owned):
  - `~/.local/share/opencode/auth.json` (`moonshotai` entry of type `oauth`)
- Account pool (plugin-owned):
  - `~/.config/opencode/kimicode-accounts.json`

## Configuration

Optional config files (JSON):

- User-level: `~/.config/opencode/kimicode.json`
- Project-level: `<project>/.opencode/kimicode.json`

Environment variables are also supported (see `src/plugin/config/loader.ts`).

## Debugging

Set `OPENCODE_KIMICODE_DEBUG=1` (or `verbose`) to write request/response logs under:

- `~/.config/opencode/kimicode-logs/`

