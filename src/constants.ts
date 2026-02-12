/**
 * Constants for Kimi Code OAuth flows and API integration.
 */

import { execSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  arch,
  hostname,
  platform,
  release,
  version as osVersion,
} from "node:os"

/**
 * OAuth client ID for Kimi Code (from kimi-cli).
 */
export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"

/**
 * OAuth host for Kimi authentication.
 * Env override: KIMI_CODE_OAUTH_HOST
 */
export const KIMI_OAUTH_HOST = process.env.KIMI_CODE_OAUTH_HOST || "https://auth.kimi.com"

/**
 * Device authorization endpoint.
 */
export const KIMI_DEVICE_AUTH_ENDPOINT = `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`

/**
 * Token endpoint (for both device code exchange and refresh).
 */
export const KIMI_TOKEN_ENDPOINT = `${KIMI_OAUTH_HOST}/api/oauth/token`

/**
 * Base URL for Kimi Code API.
 * Env override: KIMI_CODE_BASE_URL
 */
export const KIMI_API_BASE_URL = process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1"

/**
 * Chat completions endpoint (OpenAI-compatible).
 */
export const KIMI_CHAT_COMPLETIONS_ENDPOINT = `${KIMI_API_BASE_URL}/chat/completions`

/**
 * Models listing endpoint.
 */
export const KIMI_MODELS_ENDPOINT = `${KIMI_API_BASE_URL}/models`

/**
 * Grant type for device code token exchange.
 */
export const KIMI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

/**
 * Grant type for token refresh.
 */
export const KIMI_REFRESH_GRANT_TYPE = "refresh_token"

/**
 * Token refresh threshold in seconds (refresh when < 300s remaining).
 */
export const KIMI_REFRESH_THRESHOLD_SECONDS = 300

/**
 * Background token refresh interval in seconds.
 */
export const KIMI_REFRESH_INTERVAL_SECONDS = 60

/**
 * Provider identifier shared between the plugin loader and credential store.
 */
export const KIMI_PROVIDER_ID = "kimi"

/**
 * Emulated kimi-cli version for User-Agent and X-Msh-Version headers.
 * This should track a recent kimi-cli release to avoid server-side
 * version gating. Override with KIMI_CODE_CLI_VERSION env var.
 */
const KIMI_CLI_COMPAT_VERSION = "1.12.0"
let kimiPluginVersion = process.env.KIMI_CODE_CLI_VERSION || KIMI_CLI_COMPAT_VERSION
let versionLocked = !!process.env.KIMI_CODE_CLI_VERSION

export function getKimiPluginVersion(): string { return kimiPluginVersion }

export function setKimiPluginVersion(version: string): void {
  if (versionLocked) return
  kimiPluginVersion = version
  versionLocked = true
}

export function getKimiUserAgent(): string {
  // Kimi For Coding access is gated on known coding-agent user agents.
  // Mimic kimi-cli by default, but allow an escape hatch.
  return process.env.OPENCODE_KIMICODE_USER_AGENT || `KimiCLI/${getKimiPluginVersion()}`
}

/**
 * X-Msh-* device headers for Kimi API requests.
 * These mimic the headers sent by the official kimi-cli.
 */
export function getKimiDeviceHeaders(deviceId: string): Record<string, string> {
  return {
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": getKimiPluginVersion(),
    "X-Msh-Device-Name": asciiHeaderValue(getDeviceName()),
    "X-Msh-Device-Model": asciiHeaderValue(getDeviceModel()),
    "X-Msh-Os-Version": asciiHeaderValue(getOsVersion()),
    "X-Msh-Device-Id": deviceId,
  }
}

function getDeviceName(): string {
  try {
    return hostname()
  } catch {
    return "unknown"
  }
}

function getMacOsVersion(): string {
  try {
    return execSync("sw_vers -productVersion", { encoding: "utf8" }).trim()
  } catch {
    // Fallback: derive from Darwin kernel version (e.g. 23.x → 14.x)
    try {
      return release()
    } catch {
      return ""
    }
  }
}

function getWindowsRelease(): string {
  try {
    // os.release() returns e.g. "10.0.22621" on Windows
    const rel = release()
    const major = rel.split(".")[0]
    // Windows 11 is still NT 10.0 but with build >= 22000
    if (major === "10") {
      const build = parseInt(rel.split(".")[2] ?? "0", 10)
      if (build >= 22000) return "11"
    }
    return major ?? rel
  } catch {
    return ""
  }
}

function getDeviceModel(): string {
  const sys = platform()
  const a = arch()
  if (sys === "darwin") {
    const ver = getMacOsVersion()
    if (ver && a) return `macOS ${ver} ${a}`
    if (ver) return `macOS ${ver}`
    return `macOS ${a}`.trim()
  }
  if (sys === "win32") {
    const rel = getWindowsRelease()
    if (rel && a) return `Windows ${rel} ${a}`
    if (rel) return `Windows ${rel}`
    return `Windows ${a}`.trim()
  }
  if (sys) return `${sys} ${release()} ${a}`.trim()
  return "Unknown"
}

function getOsVersion(): string {
  try {
    return osVersion()
  } catch {
    try {
      return release()
    } catch {
      return "unknown"
    }
  }
}

/**
 * X-Msh-* headers for OAuth requests (device auth, token exchange, refresh).
 * Matches kimi-cli's _common_headers() which sends these on every OAuth call.
 * Uses a session-stable device ID generated at module load.
 */
export function getKimiOAuthHeaders(): Record<string, string> {
  return {
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": getKimiPluginVersion(),
    "X-Msh-Device-Name": asciiHeaderValue(getDeviceName()),
    "X-Msh-Device-Model": asciiHeaderValue(getDeviceModel()),
    "X-Msh-Os-Version": asciiHeaderValue(getOsVersion()),
    "X-Msh-Device-Id": getOrCreateOAuthDeviceId(),
  }
}

/**
 * Lazily-generated device ID for OAuth requests.
 * In kimi-cli this is persisted to ~/.kimi/device_id; here we generate once
 * per process and also allow the fingerprint module to override it later.
 */
let oauthDeviceId: string | null = null

function getOrCreateOAuthDeviceId(): string {
  if (!oauthDeviceId) {
    // Generate a 32-char lowercase hex string matching kimi-cli's uuid4().hex format
    oauthDeviceId = randomBytes(16).toString("hex")
  }
  return oauthDeviceId
}

export function setOAuthDeviceId(id: string): void {
  oauthDeviceId = id
}

function asciiHeaderValue(value: string, fallback = "unknown"): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value
  const sanitized = value
    .split("")
    .filter((ch) => ch.charCodeAt(0) < 128)
    .join("")
    .trim()
  return sanitized || fallback
}
