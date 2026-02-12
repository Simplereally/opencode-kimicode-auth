# OpenCode Kimi Code Auth

OpenCode plugin for **Kimi Code OAuth** under the **Moonshot AI** provider.

Authenticates via device-code OAuth (same flow as kimi-cli), manages multi-account rotation, and routes requests to the Kimi Code API.

## Models

| OpenCode model | Mode | Kimi API model |
|---|---|---|
| `moonshotai/kimicode-kimi-k2.5` | Thinking off | `kimi-for-coding` |
| `moonshotai/kimicode-kimi-k2.5-thinking` | Thinking on | `kimi-for-coding` |

Both models use 262k context and 32k output. Existing `moonshotai/*` API-key models are unaffected.

## Install

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@itssimplereally/opencode-kimicode-auth@latest"
  ]
}
```

Then authenticate:

```bash
opencode auth login
```

In the picker, select **Moonshot AI** → **OAuth (Kimi Code / kimi-cli)**.

A browser window opens for Kimi device authorization. After approval, the plugin stores your tokens locally. You can add multiple accounts for rotation.

Verify:

```bash
opencode models moonshotai
```

## Troubleshooting

- **Only seeing "Enter your API key"** — Ensure `"@itssimplereally/opencode-kimicode-auth@latest"` is in your plugin array, then re-run `opencode auth login`.
- **Auth errors after working setup** — Your refresh token may have expired. Re-run `opencode auth login`.

## For LLMs

Copy this prompt into your coding agent to set up the plugin:

```text
Configure OpenCode on this machine to use Kimi Code OAuth via the published plugin.

Goal:
- Use Kimi Code OAuth in OpenCode for moonshotai/kimicode-* models.

Rules:
- Never print credential values.
- Only modify config fields required for this setup.

Steps:
1. Validate tools:
   - Run: opencode --version
2. Update OpenCode config:
   - File: ~/.config/opencode/opencode.json
   - Ensure the plugin array includes: "@itssimplereally/opencode-kimicode-auth@latest"
   - Preserve all other existing plugin entries.
3. Verify OpenCode starts cleanly:
   - Run: opencode auth list
   - If plugin install/import errors occur, fix the plugin entry first.
4. **Do not attempt interactive auth in this session.**
   - Ask the human to run: opencode auth login
   - Ask the human to choose provider "Moonshot AI" and method "OAuth (Kimi Code / kimi-cli)".
   - Wait for the human to confirm they completed authorization.
5. After human confirmation, verify:
   - Run: opencode auth list
   - Run: opencode models moonshotai
   - Confirm output includes moonshotai/kimicode-kimi-k2.5 and moonshotai/kimicode-kimi-k2.5-thinking.
6. Return a concise report of changes and verification results.
```

## License

MIT
