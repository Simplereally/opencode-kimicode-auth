# Technical Specification: opencode-kimicode-auth

Reference document for the plugin's architecture, data flow, API wire format,
and known gaps. Avoids redundant file discovery across sessions.

---

## 1. Request Data Flow

```
User types in OpenCode TUI
  → OpenCode constructs OpenAI-compatible request to provider URL
    (e.g. POST /v1/chat/completions with model "kimicode-kimi-k2.5")
  → Plugin intercepts fetch() call
    → rewriteToKimi(): rewrites URL to https://api.kimi.com/coding/v1/chat/completions
    → resolveKimiModelAlias(): "kimicode-kimi-k2.5" → "kimi-for-coding"
    → Injects headers: Authorization (Bearer), User-Agent (KimiCLI/<ver>), X-Msh-* device headers
    → Body sent essentially UNMODIFIED (OpenAI-compatible JSON)
  → Response streamed back to OpenCode
```

### Key Files in the Chain

| File | Role |
|------|------|
| `src/plugin.ts` | Main fetch interceptor, URL rewrite, auth, retry loop |
| `src/constants.ts` | API URLs, device headers, User-Agent, OAuth endpoints |
| `src/plugin/accounts.ts` | Account rotation, rate limits, cooldowns |
| `src/plugin/token.ts` | OAuth token refresh |
| `src/plugin/config/models.ts` | Model definitions written to opencode.json |
| `src/plugin/config/updater.ts` | Writes model defs to ~/.config/opencode/opencode.json |

### URL Rewriting (`rewriteToKimi`)

- `/v1/chat/completions` → `https://api.kimi.com/coding/v1/chat/completions`
- `/v1/models` → `https://api.kimi.com/coding/v1/models`
- Generic: strips `/v1` prefix, prepends `KIMI_API_BASE_URL`

### Model Alias Resolution (`resolveKimiModelAlias`)

- `"kimicode-kimi-k2.5"` → `"kimi-for-coding"` (hardcoded)
- Any `"kimicode-<X>"` → `"<X>"` (prefix strip)
- All other names pass through unchanged

### Headers Applied Per Request

```
Authorization: Bearer <access_token>
User-Agent: KimiCLI/<version>          (default 1.12.0, env: KIMI_CODE_CLI_VERSION)
X-Msh-Platform: kimi_cli
X-Msh-Version: <version>
X-Msh-Device-Name: <hostname>
X-Msh-Device-Model: macOS <ver> <arch>
X-Msh-Os-Version: <os.version()>
X-Msh-Device-Id: <per-account fingerprint or generated>
```

---

## 2. Kimi API Wire Format (from kimi-cli source)

Source: `kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py`

The Kimi API is **OpenAI-compatible**. kimi-cli uses the `openai` Python SDK
(`AsyncOpenAI`) with these parameters:

### Request Body (chat/completions)

```json
{
  "model": "kimi-for-coding",
  "messages": [...],
  "tools": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 32000,
  "reasoning_effort": "high",
  "extra_body": {
    "thinking": { "type": "enabled" }
  },
  "prompt_cache_key": "<session-id>"
}
```

### Generation Parameters (kimi-cli defaults)

| Parameter | Default | Notes |
|-----------|---------|-------|
| `max_tokens` | **32000** | Hard default in kimi.py |
| `stream` | `true` | Always streams |
| `stream_options` | `{ "include_usage": true }` | Only when streaming |
| `temperature` | Not set | Env: `KIMI_MODEL_TEMPERATURE` |
| `top_p` | Not set | Env: `KIMI_MODEL_TOP_P` |
| `prompt_cache_key` | session_id | Enables Kimi's prompt caching |

### Thinking / Reasoning Control

kimi-cli sends **two parameters simultaneously** via `with_thinking()`:

1. **`reasoning_effort`** (top-level body field, legacy):
   - `"low"` / `"medium"` / `"high"` / `null` (off)

2. **`extra_body.thinking`** (new mechanism):
   - `{ "type": "enabled" }` or `{ "type": "disabled" }`

Both are sent together. The `with_thinking(effort)` method:
```python
# effort = "high" → reasoning_effort="high", thinking.type="enabled"
# effort = "off"  → reasoning_effort=None, thinking.type="disabled"
```

### Response Format

- Text content: standard `choices[0].delta.content`
- **Thinking content**: `choices[0].delta.reasoning_content` (NOT Anthropic-style thinking blocks)
- Tool calls: standard OpenAI format
- Usage: `usage.prompt_tokens`, `usage.completion_tokens`, `usage.cached_tokens` (Kimi-specific)

### Model Capabilities (from kimi-cli)

For `kimi-for-coding` / `kimi-code`:
- `thinking` (toggleable on/off)
- `image_in` (image input)
- `video_in` (video input)

Context length: reported by `/models` endpoint `context_length` field (currently 262144).

---

## 3. OpenCode Model Configuration

### Model Definitions (src/plugin/config/models.ts)

Two separate models (no OpenCode variants), matching kimi-cli / web GUI modes:

```ts
"kimicode-kimi-k2.5": {
  name: "Kimi Code (K2.5)",
  limit: { context: 262144, output: 32000 },
  modalities: { input: ["text", "image"], output: ["text"] },
},
"kimicode-kimi-k2.5-thinking": {
  name: "Kimi Code (K2.5) Thinking",
  limit: { context: 262144, output: 32000 },
  modalities: { input: ["text", "image"], output: ["text"] },
}
```

Both map to `model: "kimi-for-coding"` on the wire. The plugin detects which
model was requested and injects the corresponding thinking parameters.

### Thinking Parameter Injection (src/plugin.ts)

The plugin rewrites the JSON request body for `/chat/completions`:

**kimicode-kimi-k2.5** (thinking OFF):
```json
{ "model": "kimi-for-coding", "thinking": { "type": "disabled" } }
```

**kimicode-kimi-k2.5-thinking** (thinking ON):
```json
{ "model": "kimi-for-coding", "reasoning_effort": "high", "thinking": { "type": "enabled" } }
```

This precisely mirrors kimi-cli's `with_thinking("off")` / `with_thinking("high")`.

### Why Two Models Instead of Variants

The antigravity plugin uses OpenCode's variant system (providerOptions.google)
because it serves multiple model families (Gemini, Claude) with varying thinking
mechanisms. Kimi has exactly two modes — thinking on / off — matching the web GUI.
Two separate models is simpler, avoids variant plumbing, and makes model selection
explicit in the OpenCode TUI.

---

## 4. Resolved Gaps

All identified gaps between this plugin and kimi-cli have been addressed.

| Gap | Description | Resolution |
|-----|-------------|------------|
| Thinking controls | kimi-cli sends `reasoning_effort` + `thinking.type`; plugin didn't | Two models surface thinking on/off; plugin injects parameters. See §3. |
| Output limit | Plugin had `output: 16384`; kimi-cli uses `max_tokens: 32000` | Both models now define `output: 32000`. |
| Prompt cache key | kimi-cli sends `prompt_cache_key: <session_id>` for server-side caching | Plugin generates a stable per-instance UUID (`PLUGIN_SESSION_ID`) and injects `prompt_cache_key` into every request body. |
| "I'm Claude" identity | Model responds as Claude | Not a plugin issue — `kimi-for-coding` model behavior. No plugin fix needed. |
| Video input | kimi-cli reports `video_in` capability | OpenCode does not support video input modality. Non-actionable. |

### Prompt Cache Key Details

kimi-cli passes `session.id` as `prompt_cache_key` — a top-level field in the
chat completions JSON body. This tells the Kimi API to cache prompt tokens for
the given key, avoiding re-processing of earlier messages across turns.

OpenCode's plugin interface does not expose a conversation-level session ID to
the fetch interceptor. The `session.created` event provides `info.parentID`
(for subagent detection) but not the session ID itself.

The plugin generates a stable `randomUUID()` at module load time
(`PLUGIN_SESSION_ID` in `src/plugin.ts`). This mirrors the antigravity plugin's
approach (`PLUGIN_SESSION_ID = crypto.randomUUID()`). The UUID is stable for
the lifetime of the OpenCode process, enabling prompt caching across all turns
within a session.

---

## 5. OAuth Flow

### Endpoints

| Endpoint | URL |
|----------|-----|
| Device Authorization | `https://auth.kimi.com/api/oauth/device_authorization` |
| Token Exchange | `https://auth.kimi.com/api/oauth/token` |
| API Base | `https://api.kimi.com/coding/v1` |

### Flow

1. **Device Auth**: POST to device_authorization with `client_id` + `scope=kimi_for_coding`
2. **User Approval**: User visits verification URL and authorizes
3. **Token Exchange**: Poll token endpoint with device_code until approved
4. **Access Token**: JWT containing `user_id`, used as Bearer token
5. **Refresh**: POST to token endpoint with `grant_type=refresh_token`

### Key Constants

- Client ID: `17e5f671-d194-4dfb-9706-5516cb48c098`
- Compat Version: `1.12.0` (overridable via `KIMI_CODE_CLI_VERSION`)
- Refresh Threshold: 300s before expiry
- Max Accounts: 10

---

## 6. Account Storage

Single-version JSON at `~/.config/opencode/kimicode-accounts.json`:

```json
{
  "version": 1,
  "accounts": [{
    "email": "user@example.com",
    "refreshToken": "...",
    "addedAt": 1234567890,
    "lastUsed": 1234567890,
    "enabled": true,
    "rateLimitResetTimes": { "kimi": 1234567890 },
    "fingerprint": { "deviceId": "..." },
    "fingerprintHistory": []
  }],
  "activeIndex": 0,
  "activeIndexByFamily": { "kimi": 0 }
}
```

File uses `proper-lockfile` for concurrent access safety.
Atomic writes via temp file + rename.
Permissions: 0600 on POSIX.
