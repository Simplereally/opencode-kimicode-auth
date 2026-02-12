/**
 * Kimi Device Authorization Grant (RFC 8628)
 *
 * Implements the device code flow used by kimi-cli:
 * 1. Request device code from auth.kimi.com
 * 2. User visits verification URL and enters code
 * 3. Plugin polls token endpoint until user completes auth
 */

import {
  KIMI_CLIENT_ID,
  KIMI_DEVICE_AUTH_ENDPOINT,
  KIMI_TOKEN_ENDPOINT,
  KIMI_DEVICE_CODE_GRANT_TYPE,
  getKimiOAuthHeaders,
} from "../constants"

// =============================================================================
// Types
// =============================================================================

export interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export interface KimiTokenExchangeResult {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  token_type: string
}

// =============================================================================
// Device Authorization
// =============================================================================

/**
 * Request a device code from Kimi's OAuth server.
 * Returns device_code, user_code, and verification_uri for the user.
 */
export async function requestDeviceAuthorization(): Promise<DeviceAuthorizationResponse> {
  const response = await fetch(KIMI_DEVICE_AUTH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getKimiOAuthHeaders(),
    },
    body: new URLSearchParams({
      client_id: KIMI_CLIENT_ID,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(
      `Device authorization failed (${response.status}): ${text}`
    )
  }

  return (await response.json()) as DeviceAuthorizationResponse
}

// =============================================================================
// Token Polling
// =============================================================================

export type PollResult =
  | { status: "success"; tokens: KimiTokenExchangeResult }
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "error"; message: string }

/**
 * Poll the token endpoint once for a device code exchange result.
 */
async function pollTokenEndpointOnce(deviceCode: string): Promise<PollResult> {
  const response = await fetch(KIMI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getKimiOAuthHeaders(),
    },
    body: new URLSearchParams({
      grant_type: KIMI_DEVICE_CODE_GRANT_TYPE,
      client_id: KIMI_CLIENT_ID,
      device_code: deviceCode,
    }),
  })

  if (response.ok) {
    const tokens = (await response.json()) as KimiTokenExchangeResult
    return { status: "success", tokens }
  }

  const body = await response.text().catch(() => "")
  let errorCode = ""
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string }
    errorCode = parsed.error ?? ""
  } catch {
    // not JSON
  }

  if (errorCode === "authorization_pending") {
    return { status: "pending" }
  }
  if (errorCode === "slow_down") {
    return { status: "slow_down", interval: 10 }
  }
  if (errorCode === "expired_token") {
    return { status: "expired" }
  }

  return { status: "error", message: `Token exchange failed (${response.status}): ${body}` }
}

/**
 * Poll the token endpoint until the user completes authorization.
 * Implements backoff on slow_down responses and respects expiration.
 *
 * @param deviceCode The device code from requestDeviceAuthorization
 * @param intervalSeconds Initial polling interval in seconds
 * @param expiresInSeconds Time until the device code expires
 * @param signal Optional AbortSignal to cancel polling
 */
export async function pollForToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  signal?: AbortSignal,
): Promise<KimiTokenExchangeResult> {
  const deadline = Date.now() + expiresInSeconds * 1000
  let interval = intervalSeconds

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Device authorization cancelled")
    }

    await sleep(interval * 1000)

    if (signal?.aborted) {
      throw new Error("Device authorization cancelled")
    }

    const result = await pollTokenEndpointOnce(deviceCode)

    switch (result.status) {
      case "success":
        return result.tokens
      case "pending":
        continue
      case "slow_down":
        interval = Math.max(interval + 5, result.interval)
        continue
      case "expired":
        throw new Error("Device code expired. Please restart the login flow.")
      case "error":
        throw new Error(result.message)
    }
  }

  throw new Error("Device code expired (timeout). Please restart the login flow.")
}

// =============================================================================
// High-Level Authorization
// =============================================================================

export interface KimiAuthorization {
  verificationUri: string
  userCode: string
  poll: (signal?: AbortSignal) => Promise<KimiTokenExchangeResult>
}

/**
 * Start the Kimi device authorization flow.
 * Returns the verification URL/code for the user, and a poll function
 * to await completion.
 */
export async function authorizeKimi(): Promise<KimiAuthorization> {
  const deviceAuth = await requestDeviceAuthorization()

  return {
    verificationUri: deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri,
    userCode: deviceAuth.user_code,
    poll: (signal?: AbortSignal) =>
      pollForToken(
        deviceAuth.device_code,
        deviceAuth.interval,
        deviceAuth.expires_in,
        signal,
      ),
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
