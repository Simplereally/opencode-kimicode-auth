import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";

import {
  KIMI_API_BASE_URL,
  getKimiDeviceHeaders,
  getKimiUserAgent,
  setOAuthDeviceId,
} from "./constants";
import { authorizeKimi } from "./kimi/oauth";
import { accessTokenExpired, calculateTokenExpiry, isOAuthAuth } from "./plugin/auth";
import { promptAddAnotherAccount, promptLoginMode, promptRemoveAccount } from "./plugin/cli";
import {
  getLogFilePath,
  initializeDebug,
  isDebugEnabled,
  logToast,
  startKimicodeDebugRequest,
  logKimicodeDebugResponse,
  logResponseBody,
} from "./plugin/debug";
import { createLogger, initLogger } from "./plugin/logger";
import { createSessionRecoveryHook, getRecoverySuccessToast } from "./plugin/recovery";
import { createProactiveRefreshQueue, type ProactiveRefreshQueue } from "./plugin/refresh-queue";
import { initHealthTracker, initTokenTracker, getHealthTracker, getTokenTracker } from "./plugin/rotation";
import { resolveCachedAuth } from "./plugin/cache";
import { KimiTokenRefreshError, refreshAccessToken } from "./plugin/token";
import { AccountManager, parseRateLimitReason, type ManagedAccount } from "./plugin/accounts";
import { clearAccounts, loadAccounts, saveAccounts, saveAccountsReplace, type AccountMetadataV3 } from "./plugin/storage";
import { loadConfig, initRuntimeConfig, type KimicodeConfig } from "./plugin/config";
import { updateOpencodeConfig } from "./plugin/config/updater";
import { initKimicodeVersion } from "./plugin/version";
import type {
  AuthDetails,
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  OAuthCallbackResult,
  PluginClient,
  PluginContext,
  PluginEventPayload,
  PluginResult,
  Provider,
} from "./plugin/types";
import { generateFingerprint } from "./plugin/fingerprint";

const log = createLogger("plugin");

const MAX_OAUTH_ACCOUNTS = 10;

// Track if this plugin instance is running in a child session (subagent, background task)
// Used to filter toasts based on toast_scope config
let isChildSession = false;
let childSessionParentID: string | undefined = undefined;

// Debounce repeated rate-limit toasts to avoid spam during retry loops.
const rateLimitToastCooldowns = new Map<string, number>();
const RATE_LIMIT_TOAST_COOLDOWN_MS = 5000;
const MAX_TOAST_COOLDOWN_ENTRIES = 100;

const DUMMY_URL_BASE = "http://opencode.local";

// Stable per-plugin-instance session ID for Kimi server-side prompt caching.
// Mirrors kimi-cli's session.id passed as prompt_cache_key.
const PLUGIN_SESSION_ID = randomUUID();

const KIMICODE_MODEL_PREFIX = "kimicode-";

function resolveKimiModelAlias(requestedModel: string): string {
  // Both the base and thinking models map to the same Kimi API model.
  if (
    requestedModel === "kimicode-kimi-k2.5" ||
    requestedModel === "kimicode-kimi-k2.5-thinking"
  ) {
    return "kimi-for-coding";
  }

  if (requestedModel.startsWith(KIMICODE_MODEL_PREFIX)) {
    return requestedModel.slice(KIMICODE_MODEL_PREFIX.length);
  }

  return requestedModel;
}

/**
 * Whether the requested OpenCode model id asks for extended thinking.
 * Mirrors kimi-cli's `with_thinking("high")` vs `with_thinking("off")`.
 */
function isThinkingModel(requestedModel: string): boolean {
  return requestedModel === "kimicode-kimi-k2.5-thinking";
}

function extractKimiUserIdFromJwt(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as { user_id?: unknown };
    if (typeof payload.user_id === "string" && payload.user_id.length > 0) {
      return payload.user_id;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function cleanupToastCooldowns(): void {
  if (rateLimitToastCooldowns.size <= MAX_TOAST_COOLDOWN_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [key, time] of rateLimitToastCooldowns) {
    if (now - time > RATE_LIMIT_TOAST_COOLDOWN_MS * 2) {
      rateLimitToastCooldowns.delete(key);
    }
  }
}

function shouldShowRateLimitToast(message: string): boolean {
  cleanupToastCooldowns();
  const toastKey = message.replace(/\d+/g, "X");
  const lastShown = rateLimitToastCooldowns.get(toastKey) ?? 0;
  const now = Date.now();
  if (now - lastShown < RATE_LIMIT_TOAST_COOLDOWN_MS) {
    return false;
  }
  rateLimitToastCooldowns.set(toastKey, now);
  return true;
}

function toUrlString(input: RequestInfo): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function toAbsoluteUrlString(input: RequestInfo): string | null {
  const raw = toUrlString(input);
  try {
    return new URL(raw).toString();
  } catch {
    try {
      return new URL(raw, DUMMY_URL_BASE).toString();
    } catch {
      return null;
    }
  }
}

function makeRequest(input: RequestInfo, init?: RequestInit): Request | null {
  try {
    return new Request(input, init);
  } catch {
    const abs = toAbsoluteUrlString(input);
    if (!abs) return null;
    try {
      return new Request(abs, init);
    } catch {
      return null;
    }
  }
}

function rewriteToKimi(url: URL): URL {
  const base = KIMI_API_BASE_URL.replace(/\/+$/, "");
  const path = url.pathname;
  let nextPath = path;

  if (path === "/v1") {
    nextPath = "/";
  } else if (path.startsWith("/v1/")) {
    nextPath = path.slice("/v1".length);
  }

  if (!nextPath.startsWith("/")) {
    nextPath = `/${nextPath}`;
  }

  return new URL(`${base}${nextPath}${url.search}`);
}

function isHeadless(): boolean {
  return !!(
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.OPENCODE_HEADLESS
  );
}

function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs");
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

async function openBrowser(url: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
      return true;
    }
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
      return true;
    }
    if (isWSL()) {
      try {
        exec(`wslview "${url}"`);
        return true;
      } catch {}
    }
    exec(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
  }
}

function retryAfterMsFromResponse(response: Response, defaultRetryMs: number): number {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }

  return defaultRetryMs;
}

async function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type ParsedErrorInfo = {
  message?: string;
  reason?: string;
  retryDelayMs?: number | null;
  rawText?: string;
};

async function parseErrorInfo(response: Response): Promise<ParsedErrorInfo> {
  try {
    const text = await response.clone().text();
    if (!text) return {};

    try {
      const parsed = JSON.parse(text) as any;
      const err = parsed?.error;

      if (typeof err === "string") {
        return { reason: err, rawText: text };
      }

      if (err && typeof err === "object") {
        const message =
          typeof err.message === "string"
            ? err.message
            : typeof parsed.message === "string"
              ? parsed.message
              : undefined;
        const reason =
          typeof err.type === "string"
            ? err.type
            : typeof err.code === "string"
              ? err.code
              : typeof parsed.code === "string"
                ? parsed.code
                : undefined;

        const retryDelayMs =
          typeof err.retry_delay_ms === "number"
            ? err.retry_delay_ms
            : typeof parsed.retry_delay_ms === "number"
              ? parsed.retry_delay_ms
              : null;

        return { message, reason, retryDelayMs, rawText: text };
      }

      return { rawText: text };
    } catch {
      return { rawText: text };
    }
  } catch {
    return {};
  }
}

function authSuccessFromTokens(tokens: { access_token: string; refresh_token: string; expires_in: number }): OAuthCallbackResult {
  const now = Date.now();
  return {
    type: "success",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: calculateTokenExpiry(now, tokens.expires_in),
  };
}

function toExistingAccountsForMenu(stored: { accounts: AccountMetadataV3[]; activeIndex?: number } | null): Array<{
  email?: string;
  index: number;
  addedAt?: number;
  lastUsed?: number;
  status?: "active" | "rate-limited" | "cooling-down" | "disabled" | "expired";
  isCurrentAccount?: boolean;
  enabled?: boolean;
}> {
  if (!stored?.accounts?.length) return [];
  const now = Date.now();
  return stored.accounts.map((acc, idx) => {
    let status: "active" | "rate-limited" | "cooling-down" | "disabled" | "expired" = "active";
    if (acc.enabled === false && acc.cooldownReason === "auth-failure") {
      status = "expired";
    } else if (acc.enabled === false) {
      status = "disabled";
    } else if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
      status = "cooling-down";
    } else if (acc.rateLimitResetTimes) {
      const isRateLimited = Object.values(acc.rateLimitResetTimes).some(
        (resetTime) => typeof resetTime === "number" && resetTime > now,
      );
      status = isRateLimited ? "rate-limited" : "active";
    }

    return {
      email: acc.email,
      index: idx,
      addedAt: acc.addedAt,
      lastUsed: acc.lastUsed,
      status,
      isCurrentAccount: idx === (stored.activeIndex ?? 0),
      enabled: acc.enabled !== false,
    };
  });
}

async function persistAccountPool(
  results: Array<{ refresh: string }>,
  replaceAll: boolean,
): Promise<void> {
  if (results.length === 0) return;

  const now = Date.now();

  const stored = replaceAll ? null : await loadAccounts();
  const accounts: AccountMetadataV3[] = stored?.accounts ? [...stored.accounts] : [];

  const indexByRefreshToken = new Map<string, number>();
  const indexByUserId = new Map<string, number>();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const token = acc?.refreshToken;
    if (typeof token === "string" && token.length > 0) {
      indexByRefreshToken.set(token, i);
    }
    const userId = acc?.email;
    if (typeof userId === "string" && userId.length > 0) {
      indexByUserId.set(userId, i);
    }
  }

  for (const result of results) {
    const refreshToken = result.refresh;
    if (!refreshToken) continue;

    const userId = extractKimiUserIdFromJwt(refreshToken);

    const existingIndex = indexByRefreshToken.get(refreshToken);
    if (existingIndex !== undefined) {
      const existing = accounts[existingIndex];
      if (!existing) continue;
      accounts[existingIndex] = {
        ...existing,
        email: existing.email ?? userId,
        refreshToken,
        lastUsed: now,
        enabled: existing.enabled !== false,
        fingerprint: existing.fingerprint ?? generateFingerprint(),
      };
      if (userId) {
        indexByUserId.set(userId, existingIndex);
      }
      continue;
    }

    // If the refresh token rotated, merge by user id to keep stable account pools.
    if (userId) {
      const byUserIndex = indexByUserId.get(userId);
      if (byUserIndex !== undefined) {
        const existing = accounts[byUserIndex];
        if (existing) {
          if (existing.refreshToken) {
            indexByRefreshToken.delete(existing.refreshToken);
          }
          const updated: AccountMetadataV3 = {
            ...existing,
            email: existing.email ?? userId,
            refreshToken,
            lastUsed: now,
            enabled: true,
            fingerprint: existing.fingerprint ?? generateFingerprint(),
          };
          accounts[byUserIndex] = updated;
          indexByRefreshToken.set(refreshToken, byUserIndex);
          indexByUserId.set(userId, byUserIndex);
          continue;
        }
      }
    }

    const newIndex = accounts.length;
    indexByRefreshToken.set(refreshToken, newIndex);
    if (userId) {
      indexByUserId.set(userId, newIndex);
    }
    accounts.push({
      email: userId,
      refreshToken,
      addedAt: now,
      lastUsed: now,
      enabled: true,
      fingerprint: generateFingerprint(),
    });
  }

  if (accounts.length === 0) return;

  const activeIndex =
    replaceAll
      ? 0
      : typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex)
        ? stored.activeIndex
        : 0;

  const payload = {
    version: 1 as const,
    accounts,
    activeIndex: Math.max(0, Math.min(activeIndex, accounts.length - 1)),
    activeIndexByFamily: {
      kimi: Math.max(0, Math.min(activeIndex, accounts.length - 1)),
    },
  };

  // persistAccountPool already merges/deduplicates. Avoid a second merge layer.
  await saveAccountsReplace(payload);
}

async function removeAccountFromPool(removeIndex: number): Promise<boolean> {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) return false;
  if (!Number.isFinite(removeIndex) || removeIndex < 0 || removeIndex >= stored.accounts.length) {
    return false;
  }

  const nextAccounts = stored.accounts.filter((_, idx) => idx !== removeIndex);

  if (nextAccounts.length === 0) {
    await clearAccounts().catch(() => {});
    return true;
  }

  const previousActiveIndex =
    typeof stored.activeIndex === "number" && Number.isFinite(stored.activeIndex)
      ? stored.activeIndex
      : 0;

  let nextActiveIndex = previousActiveIndex;
  if (removeIndex < previousActiveIndex) {
    nextActiveIndex = Math.max(0, previousActiveIndex - 1);
  }
  nextActiveIndex = Math.max(0, Math.min(nextActiveIndex, nextAccounts.length - 1));

  const payload = {
    version: 1 as const,
    accounts: nextAccounts,
    activeIndex: nextActiveIndex,
    activeIndexByFamily: {
      kimi: nextActiveIndex,
    },
  };

  await saveAccountsReplace(payload);
  return true;
}

export const createKimicodePlugin = (providerId: string) => async (
  { client, directory }: PluginContext,
): Promise<PluginResult> => {
  const config = loadConfig(directory);
  initRuntimeConfig(config);

  // Initialize debug + structured logger for TUI integration.
  initializeDebug(config);
  initLogger(client);

  // Resolve plugin version for X-Msh-Version headers (best-effort).
  await initKimicodeVersion();

  // Sync model definitions to opencode.json on every load (best-effort).
  await updateOpencodeConfig().catch(() => {});

  // Initialize trackers (hybrid strategy).
  if (config.health_score) {
    initHealthTracker({
      initial: config.health_score.initial,
      successReward: config.health_score.success_reward,
      rateLimitPenalty: config.health_score.rate_limit_penalty,
      failurePenalty: config.health_score.failure_penalty,
      recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
      minUsable: config.health_score.min_usable,
      maxScore: config.health_score.max_score,
    });
  }

  if (config.token_bucket) {
    initTokenTracker({
      maxTokens: config.token_bucket.max_tokens,
      regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
      initialTokens: config.token_bucket.initial_tokens,
    });
  }

  const sessionRecovery = createSessionRecoveryHook({ client, directory }, config);

  const eventHandler = async (payload: PluginEventPayload) => {
    if (payload.event.type === "session.created") {
      const props = payload.event.properties as { info?: { parentID?: string } } | undefined;
      if (props?.info?.parentID) {
        isChildSession = true;
        childSessionParentID = props.info.parentID;
        log.debug("child-session-detected", { parentID: props.info.parentID });
      } else {
        isChildSession = false;
        childSessionParentID = undefined;
        log.debug("root-session-detected", {});
      }
    }

    if (sessionRecovery && payload.event.type === "session.error") {
      const props = payload.event.properties as Record<string, unknown> | undefined;
      const sessionID = props?.sessionID as string | undefined;
      const messageID = props?.messageID as string | undefined;
      const error = props?.error;

      if (sessionRecovery.isRecoverableError(error)) {
        const recovered = await sessionRecovery.handleSessionRecovery({
          id: messageID,
          role: "assistant" as const,
          sessionID,
          error,
        });

        if (recovered && sessionID && config.auto_resume) {
          await client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text: config.resume_text }] },
            query: { directory },
          }).catch(() => {});

          const toast = getRecoverySuccessToast();
          if (!(config.toast_scope === "root_only" && isChildSession)) {
            await client.tui.showToast({
              body: {
                title: toast.title,
                message: toast.message,
                variant: "success",
              },
            }).catch(() => {});
          }
        }
      }
    }
  };

  // Cached getAuth function for potential tool access.
  let cachedGetAuth: GetAuth | null = null;

  return {
    event: eventHandler,
    auth: {
      provider: providerId,
      loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> => {
        cachedGetAuth = getAuth;

        const auth = await getAuth();
        if (!isOAuthAuth(auth)) {
          return {};
	        }

	        const accountManager = await AccountManager.loadFromDisk(auth);

	        // Seed the OAuth device ID from the first account's fingerprint so that
	        // OAuth requests (refresh, etc.) use a consistent device identity,
	        // mirroring kimi-cli's persistent ~/.kimi/device_id.
	        try {
	          const firstAccount = accountManager.getAccounts()[0];
	          if (firstAccount?.fingerprint?.deviceId) {
	            setOAuthDeviceId(firstAccount.fingerprint.deviceId);
	          }
	        } catch {
	          // best-effort
	        }

	        // Self-heal: older versions could disable valid accounts due to 403 gating.
	        // Re-enable accounts disabled for "auth-failure" so they can be retried/refreshed.
	        try {
	          for (const acc of accountManager.getAccounts()) {
	            if (acc.enabled === false && acc.cooldownReason === "auth-failure") {
	              accountManager.setAccountEnabled(acc.index, true);
	              accountManager.clearAccountCooldown(acc);
	            }
	          }
	        } catch {
	          // best-effort
	        }

	        // Start proactive refresh queue (best-effort).
	        let refreshQueue: ProactiveRefreshQueue | null = null;
	        if (config.proactive_token_refresh && accountManager.getAccountCount() > 0) {
	          refreshQueue = createProactiveRefreshQueue(client, providerId, {
	            enabled: config.proactive_token_refresh,
            bufferSeconds: config.proactive_refresh_buffer_seconds,
            checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
          });
          refreshQueue.setAccountManager(accountManager);
          refreshQueue.start();
        }

        if (isDebugEnabled()) {
          const logPath = getLogFilePath();
          if (logPath) {
            await client.tui.showToast({
              body: { message: `Debug log: ${logPath}`, variant: "info" },
            }).catch(() => {});
          }
        }

        // Optional: ensure costs are zeroed (avoid misleading pricing).
        if (provider.models) {
          for (const model of Object.values(provider.models)) {
            if (model) {
              model.cost = { input: 0, output: 0 };
            }
          }
        }

        const quietMode = config.quiet_mode;
        const toastScope = config.toast_scope;

        const showToast = async (message: string, variant: "info" | "warning" | "success" | "error") => {
          logToast(message, variant);
          if (quietMode) return;
          if (toastScope === "root_only" && isChildSession) return;

          await client.tui.showToast({
            body: { message, variant },
          }).catch(() => {});
        };

        return {
          apiKey: "",
          async fetch(input, init) {
            const originalRequest = makeRequest(input, init);
            if (!originalRequest) {
              return fetch(input, init);
            }

            // Normalize the request once and buffer the body so we can retry safely.
            const originalUrl = new URL(originalRequest.url);
            const urlString = toUrlString(input);
            const method = originalRequest.method || "GET";
            const abortSignal = init?.signal ?? null;

            let bodyBuffer: ArrayBuffer | null = null;
            let canRetry = true;
            if (method !== "GET" && method !== "HEAD") {
              try {
                bodyBuffer = await originalRequest.clone().arrayBuffer();
              } catch {
                // If we cannot buffer the body, we still do one attempt but disable retries.
                bodyBuffer = null;
                canRetry = false;
              }
            }

            const baseHeaders = new Headers(originalRequest.headers);
            const rewrittenUrl = rewriteToKimi(originalUrl);
            const isChatCompletions = rewrittenUrl.pathname.endsWith("/chat/completions");

            // Kimi Code uses OpenAI-compatible bodies. For our kimicode-* models,
            // rewrite the model name to the actual Kimi API model id.
            let bodyForAttempts: ArrayBuffer | Uint8Array | null = bodyBuffer;
            if (isChatCompletions && bodyBuffer) {
              const contentType = baseHeaders.get("content-type") ?? "";
              const maybeJson =
                contentType.includes("application/json") ||
                contentType.includes("+json") ||
                contentType.trim() === "";

              if (maybeJson) {
                try {
                  const rawBody = new TextDecoder().decode(bodyBuffer);
                  const parsed = JSON.parse(rawBody) as any;
	                  const requestedModel = parsed?.model;

	                  if (typeof requestedModel === "string" && requestedModel.length > 0) {
	                    const isKimicodeModel = requestedModel.startsWith(KIMICODE_MODEL_PREFIX);

	                    if (!isKimicodeModel) {
	                      throw new Error(
	                        `Moonshot AI OAuth (Kimi Code) only supports models with the '${KIMICODE_MODEL_PREFIX}' prefix. ` +
	                        `Use moonshotai/kimicode-kimi-k2.5 or moonshotai/kimicode-kimi-k2.5-thinking, ` +
	                        `or re-run 'opencode auth login' and choose API Key to use moonshotai/${requestedModel}.`,
	                      );
	                    }

                    const effectiveModel = resolveKimiModelAlias(requestedModel);
                    const wantsThinking = isThinkingModel(requestedModel);

                    // Always rewrite: model alias + thinking parameters.
                    parsed.model = effectiveModel;

                    // Inject thinking parameters matching kimi-cli wire format.
                    // Thinking ON:  reasoning_effort="high", thinking={type:"enabled"}
                    // Thinking OFF: remove reasoning_effort,  thinking={type:"disabled"}
                    if (wantsThinking) {
                      parsed.reasoning_effort = "high";
                      parsed.thinking = { type: "enabled" };
                    } else {
                      delete parsed.reasoning_effort;
                      parsed.thinking = { type: "disabled" };
                    }

                    // Enable Kimi server-side prompt caching (mirrors kimi-cli).
                    parsed.prompt_cache_key = PLUGIN_SESSION_ID;

                    bodyForAttempts = Buffer.from(JSON.stringify(parsed), "utf8");
                    // Body length may have changed; let fetch() compute it.
                    baseHeaders.delete("content-length");
                  }
                } catch (e) {
                  // If we can't parse JSON, fall back to sending the buffered body unmodified.
                  if (!(e instanceof SyntaxError)) {
                    throw e;
                  }
                }
              }
            }

            // Retry loop with account rotation/backoff.
            const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 0) > 0
              ? (config.max_rate_limit_wait_seconds * 1000)
              : 0;

            const FAMILY = "kimi" as const;
            const HEADER_STYLE = "kimi-cli" as const;

            let capacityRetryCount = 0;
            let attemptedRefreshForAccount = false;
            let lastAccountIndex: number | null = null;

            while (true) {
              if (abortSignal?.aborted) {
                throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Aborted");
              }

              const account = accountManager.getCurrentOrNextForFamily(
                FAMILY,
                undefined,
                config.account_selection_strategy,
                HEADER_STYLE,
                config.pid_offset_enabled,
              );

              if (!account) {
                const minWait = accountManager.getMinWaitTimeForFamily(FAMILY, undefined, HEADER_STYLE, true);
                if (maxWaitMs > 0 && minWait > maxWaitMs) {
                  throw new Error(
                    `All Kimi accounts are rate-limited. Minimum wait is ${Math.ceil(minWait / 1000)}s ` +
                    `which exceeds max_rate_limit_wait_seconds=${config.max_rate_limit_wait_seconds}s.`,
                  );
                }
                if (!quietMode && shouldShowRateLimitToast("All accounts rate-limited")) {
                  await showToast(
                    `All accounts rate-limited. Waiting ${Math.ceil(minWait / 1000)}s...`,
                    "warning",
                  );
                }
                await sleep(Math.max(1000, minWait), abortSignal);
                continue;
              }

              if (lastAccountIndex !== account.index) {
                attemptedRefreshForAccount = false;
                capacityRetryCount = 0;
                lastAccountIndex = account.index;
              }

	              // Resolve/refresh the account's access token.
	              let accountAuth = resolveCachedAuth(accountManager.toAuthDetails(account));
	              if (accessTokenExpired(accountAuth)) {
	                try {
	                  const refreshed = await refreshAccessToken(accountAuth, client, providerId);
	                  if (refreshed) {
	                    accountAuth = refreshed;
	                    accountManager.updateFromAuth(account, refreshed);
	                    accountManager.requestSaveToDisk();
	                  }
	                } catch (e) {
	                  // Token refresh failed; disable or cool down this account.
	                  const err = e instanceof Error ? e.message : String(e);
	                  if (
	                    e instanceof KimiTokenRefreshError &&
	                    (e.code === "invalid_grant" || e.status === 401 || e.status === 403)
	                  ) {
	                    // Refresh token revoked/invalid. Disable so we don't keep retrying it.
	                    accountManager.setAccountEnabled(account.index, false);
	                    accountManager.markAccountCoolingDown(account, 5 * 60_000, "auth-failure");
	                    accountManager.requestSaveToDisk();
	                    await showToast(`Account ${account.index + 1} refresh token invalid. Disabled.`, "warning");
	                  } else {
	                    accountManager.markAccountCoolingDown(account, 60_000, "auth-failure");
	                    accountManager.requestSaveToDisk();
	                    await showToast(`Account ${account.index + 1} auth failed. Switching...`, "warning");
	                  }
	                  log.warn("token-refresh-failed", { accountIndex: account.index, error: err });
	                  continue;
	                }
	              }

              const accessToken = accountAuth.access;
              if (!accessToken) {
                // If we still have no access token, the refresh flow failed silently.
                accountManager.markAccountCoolingDown(account, 60_000, "auth-failure");
                accountManager.requestSaveToDisk();
                await showToast(`Account ${account.index + 1} missing access token. Switching...`, "warning");
                continue;
              }

              // Apply request jitter (optional).
              if (config.request_jitter_max_ms && config.request_jitter_max_ms > 0) {
                const jitterMs = Math.floor(Math.random() * config.request_jitter_max_ms);
                if (jitterMs > 0) {
                  await sleep(jitterMs, abortSignal);
                }
              }

              const headers = new Headers(baseHeaders);
              headers.set("authorization", `Bearer ${accessToken}`);
              headers.set("user-agent", getKimiUserAgent());

              const deviceId = account.fingerprint?.deviceId ?? generateFingerprint().deviceId;
              const deviceHeaders = getKimiDeviceHeaders(deviceId);
              for (const [k, v] of Object.entries(deviceHeaders)) {
                headers.set(k, v);
              }

              const attemptBody =
                bodyForAttempts
                  ? bodyForAttempts instanceof ArrayBuffer
                    ? bodyForAttempts.slice(0)
                    : bodyForAttempts.slice()
                  : null;

              const requestInit: RequestInit = {
                method,
                headers,
                body: attemptBody,
                signal: abortSignal ?? undefined,
              };

              const attemptRequest = new Request(rewrittenUrl.toString(), requestInit);

              const debugContext = startKimicodeDebugRequest({
                originalUrl: urlString,
                resolvedUrl: rewrittenUrl.toString(),
                method,
                headers,
                body: attemptBody ? "[buffered]" : undefined,
                streaming: false,
              });

              // Consume token for hybrid strategy (refund on failure).
              let tokenConsumed = false;
              if (config.account_selection_strategy === "hybrid") {
                tokenConsumed = getTokenTracker().consume(account.index);
              }

              try {
                const response = await fetch(attemptRequest);

                logKimicodeDebugResponse(debugContext, response, { note: `account=${account.index}` });

                if (response.ok) {
                  if (config.account_selection_strategy === "hybrid" && tokenConsumed) {
                    // Token consumed successfully; keep it consumed.
                  }
                  getHealthTracker().recordSuccess(account.index);
                  accountManager.markRequestSuccess(account);
                  accountManager.markAccountUsed(account.index);
                  accountManager.requestSaveToDisk();
                  return response;
                }

                // Read response body for debug + error parsing (clone to preserve original response if we return it).
                const responseBodyText = await logResponseBody(debugContext, response, response.status);

	                // Handle auth errors: try refreshing once per selected account.
	                if ((response.status === 401 || response.status === 403) && canRetry) {
	                  const info = await parseErrorInfo(response);

	                  // If Kimi says access is terminated for non-CLI agents, rotating accounts won't help.
	                  if (
	                    response.status === 403 &&
	                    (info.reason === "access_terminated_error" ||
	                      (info.message && /kimi\s+cli|coding\s+agents/i.test(info.message)))
	                  ) {
	                    const details = [info.reason, info.message].filter(Boolean).join(": ");
	                    throw new Error(
	                      `Kimi Code denied access (${response.status}). ` +
	                      `This usually means the request is missing a Kimi CLI user-agent. ` +
	                      `If needed, set OPENCODE_KIMICODE_USER_AGENT=KimiCLI/<version>. ` +
	                      `${details ? `Details: ${details}` : ""}`.trim(),
	                    );
	                  }

	                  if (!attemptedRefreshForAccount) {
	                    attemptedRefreshForAccount = true;
	                    if (tokenConsumed) {
	                      getTokenTracker().refund(account.index);
                      tokenConsumed = false;
                    }

	                    try {
	                      const refreshed = await refreshAccessToken(accountAuth, client, providerId);
	                      if (refreshed) {
	                        accountManager.updateFromAuth(account, refreshed);
	                        accountManager.requestSaveToDisk();
	                        continue; // retry same request with updated access token
	                      }
	                    } catch (e) {
	                      if (
	                        e instanceof KimiTokenRefreshError &&
	                        (e.code === "invalid_grant" || e.status === 401 || e.status === 403)
	                      ) {
	                        accountManager.setAccountEnabled(account.index, false);
	                        accountManager.markAccountCoolingDown(account, 5 * 60_000, "auth-failure");
	                        accountManager.requestSaveToDisk();
	                        getHealthTracker().recordFailure(account.index);
	                        await showToast(
	                          `Account ${account.index + 1} refresh token invalid. Disabled and switching...`,
	                          "warning",
	                        );
	                        continue;
	                      }
	                    }
	                  }

	                  // Refresh didn't help -> cool down and switch (don't permanently disable).
	                  accountManager.markAccountCoolingDown(account, 60_000, "auth-failure");
	                  accountManager.requestSaveToDisk();
	                  getHealthTracker().recordFailure(account.index);
	                  if (tokenConsumed) {
	                    getTokenTracker().refund(account.index);
	                    tokenConsumed = false;
	                  }
	                  await showToast(`Account ${account.index + 1} unauthorized. Switching...`, "warning");
	                  continue;
	                }

                // Rate limit / overload handling.
                if (response.status === 429 || response.status === 503 || response.status === 529) {
                  if (tokenConsumed) {
                    getTokenTracker().refund(account.index);
                    tokenConsumed = false;
                  }

                  const defaultRetryMs = (config.default_retry_after_seconds ?? 60) * 1000;
                  const headerRetryMs = retryAfterMsFromResponse(response, defaultRetryMs);
                  const info = await parseErrorInfo(response);

                  const retryAfterMs = info.retryDelayMs ?? headerRetryMs;
                  const reason = parseRateLimitReason(info.reason, info.message, response.status);

                  // Capacity/server errors: exponential backoff, retry same account.
                  if (reason === "MODEL_CAPACITY_EXHAUSTED" || reason === "SERVER_ERROR") {
                    if (!canRetry) {
                      return response;
                    }

                    const baseDelayMs = 1000;
                    const maxDelayMs = 8000;
                    const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, capacityRetryCount), maxDelayMs);
                    const jitter = exponentialDelay * (0.9 + Math.random() * 0.2);
                    const waitMs = Math.round(jitter);

                    capacityRetryCount = Math.min(capacityRetryCount + 1, 10);
                    if (shouldShowRateLimitToast(`capacity-${response.status}`)) {
                      await showToast(
                        `Server busy (${response.status}). Retrying in ${Math.ceil(waitMs / 1000)}s...`,
                        "warning",
                      );
                    }
                    await sleep(waitMs, abortSignal);
                    continue;
                  }

                  // Normal rate limit: mark account limited and switch.
                  getHealthTracker().recordRateLimit(account.index);
                  const failureTtlMs = (config.failure_ttl_seconds ?? 3600) * 1000;
                  const backoffMs = accountManager.markRateLimitedWithReason(
                    account,
                    FAMILY,
                    HEADER_STYLE,
                    undefined,
                    reason,
                    retryAfterMs,
                    failureTtlMs,
                  );
                  accountManager.requestSaveToDisk();

                  if (shouldShowRateLimitToast(`${reason}-${response.status}`)) {
                    await showToast(
                      `Rate limited (${response.status}, ${reason}). Switching accounts (wait ${Math.ceil(backoffMs / 1000)}s).`,
                      "warning",
                    );
                  }

                  continue;
                }

                // For other errors: if we can't retry (streaming/unbuffered), just return the response.
                if (!canRetry) {
                  return response;
                }

                // Non-rate-limit failures: penalize health and briefly cool down.
                getHealthTracker().recordFailure(account.index);
                accountManager.markAccountCoolingDown(account, 15_000, "network-error");
                accountManager.requestSaveToDisk();

                if (!quietMode && response.status >= 500 && shouldShowRateLimitToast(`server-${response.status}`)) {
                  await showToast(`Server error (${response.status}). Retrying with another account...`, "warning");
                }

                // Avoid infinite tight loops on persistent errors.
                await sleep(1000, abortSignal);
                continue;
              } catch (error) {
                logKimicodeDebugResponse(debugContext, new Response(null, { status: 0, statusText: "network-error" }), { error });

                if (config.account_selection_strategy === "hybrid" && tokenConsumed) {
                  getTokenTracker().refund(account.index);
                  tokenConsumed = false;
                }

                getHealthTracker().recordFailure(account.index);
                accountManager.markAccountCoolingDown(account, 15_000, "network-error");
                accountManager.requestSaveToDisk();

                // Backoff slightly to prevent hammering on transient network errors.
                if (!quietMode && shouldShowRateLimitToast("network-error")) {
                  await showToast("Network error. Retrying...", "warning");
                }
                await sleep(1000, abortSignal);
                continue;
              }
            }
          },
        };
      },
      methods: [
        {
          label: "OAuth (Kimi Code / kimi-cli)",
          type: "oauth",
          authorize: async (inputs?: Record<string, string>) => {
            const noBrowser = inputs?.noBrowser === "true" || inputs?.["no-browser"] === "true";

            // CLI flow (`opencode auth login`) passes an inputs object.
            if (inputs) {
              const results: Array<Extract<OAuthCallbackResult, { type: "success" }>> = [];

              let startFresh = false;
              let existingStorage = await loadAccounts();

              if (existingStorage && existingStorage.accounts.length > 0) {
                while (true) {
                  const existingAccounts = toExistingAccountsForMenu(existingStorage);
                  const menu = await promptLoginMode(existingAccounts);

                  if (menu.mode === "configure-models") {
                    // promptLoginModeFallback performs the update and then loops.
                    continue;
                  }

                  if (menu.mode === "remove") {
                    const removeIndex = await promptRemoveAccount(existingAccounts);
                    if (removeIndex === null) {
                      existingStorage = await loadAccounts();
                      continue;
                    }

                    const removed = await removeAccountFromPool(removeIndex).catch(() => false);
                    if (!removed) {
                      console.log("\n✗ Failed to remove account\n");
                    } else {
                      console.log("\n✓ Account removed\n");
                    }

                    existingStorage = await loadAccounts();
                    if (!existingStorage || existingStorage.accounts.length === 0) {
                      // No accounts left, proceed to auth flow.
                      startFresh = true;
                      break;
                    }
                    continue;
                  }

                  if (menu.mode === "cancel") {
                    return {
                      url: "",
                      instructions: "Authentication cancelled",
                      method: "auto",
                      callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
                    };
                  }

                  if (menu.mode === "fresh") {
                    startFresh = true;
                    await clearAccounts().catch(() => {});
                    existingStorage = null;
                  }

                  break;
                }
              }

              while (results.length < MAX_OAUTH_ACCOUNTS) {
                const authorization = await authorizeKimi();

                const url = authorization.verificationUri;
                const code = authorization.userCode;

                console.log("\nKimi device authorization");
                console.log(`  URL:  ${url}`);
                console.log(`  Code: ${code}`);
                console.log("  Expires: 30 minutes");
                console.log("");

                if (!noBrowser && !isHeadless()) {
                  await openBrowser(url).catch(() => {});
                }

                const tokens = await authorization.poll();
                const result = authSuccessFromTokens(tokens);
                if (result.type === "failed") {
                  if (results.length === 0) {
                    return {
                      url: "",
                      instructions: `Authentication failed: ${result.error}`,
                      method: "auto",
                      callback: async () => result,
                    };
                  }
                  break;
                }

                results.push(result);

                try {
                  await client.tui.showToast({
                    body: {
                      message: `Account ${results.length} authenticated`,
                      variant: "success",
                    },
                  });
                } catch {}

                // Persist the refresh token in the pool file.
                try {
                  const isFirstAccount = results.length === 1;
                  await persistAccountPool([{ refresh: result.refresh }], isFirstAccount && startFresh);
                } catch {}

                // Ask user if they want to add another account.
                let currentAccountCount = results.length;
                try {
                  const currentStorage = await loadAccounts();
                  if (currentStorage) {
                    currentAccountCount = currentStorage.accounts.length;
                  }
                } catch {}

                const addAnother = await promptAddAnotherAccount(currentAccountCount);
                if (!addAnother) break;
              }

              const primary = results[0];
              if (!primary) {
                return {
                  url: "",
                  instructions: "Authentication cancelled",
                  method: "auto",
                  callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
                };
              }

              let actualAccountCount = results.length;
              try {
                const finalStorage = await loadAccounts();
                if (finalStorage) {
                  actualAccountCount = finalStorage.accounts.length;
                }
              } catch {}

              return {
                url: "",
                instructions: `Multi-account setup complete (${actualAccountCount} account(s)).`,
                method: "auto",
                callback: async () => primary,
              };
            }

            // TUI flow: single-account only (no prompts).
            const authorization = await authorizeKimi();
            const url = authorization.verificationUri;
            const code = authorization.userCode;

            if (!noBrowser && !isHeadless()) {
              await openBrowser(url).catch(() => {});
            }

            return {
              url,
              instructions: `Open the URL and enter code: ${code}`,
              method: "auto",
              callback: async () => {
                const tokens = await authorization.poll();
                const result = authSuccessFromTokens(tokens);
                if (result.type === "success") {
                  await persistAccountPool([{ refresh: result.refresh }], false).catch(() => {});
                }
                return result;
              },
            };
          },
        },
        {
          label: "API Key",
          type: "api",
        },
      ],
    },
  };
};

export const KimicodeCLIOAuthPlugin = createKimicodePlugin("moonshotai");

// Convenience alias.
export const MoonshotAIOAuthPlugin = KimicodeCLIOAuthPlugin;
