/**
 * Constants for Kimi Code OAuth flows and API integration.
 */

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
 * Version fallback for plugin identification.
 */
const KIMI_PLUGIN_VERSION_FALLBACK = "0.1.0"
let kimiPluginVersion = KIMI_PLUGIN_VERSION_FALLBACK
let versionLocked = false

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

function getDeviceModel(): string {
  const sys = platform()
  const a = arch()
  if (sys === "darwin") return `macOS ${a}`.trim()
  if (sys === "win32") return `Windows ${a}`.trim()
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

function asciiHeaderValue(value: string, fallback = "unknown"): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value
  const sanitized = value
    .split("")
    .filter((ch) => ch.charCodeAt(0) < 128)
    .join("")
    .trim()
  return sanitized || fallback
}
