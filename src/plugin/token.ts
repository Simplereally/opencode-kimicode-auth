import { KIMI_CLIENT_ID, KIMI_TOKEN_ENDPOINT, getKimiOAuthHeaders } from "../constants"
import { calculateTokenExpiry } from "./auth"
import { clearCachedAuth, storeCachedAuth } from "./cache"
import { createLogger } from "./logger"
import type { OAuthAuthDetails, PluginClient } from "./types"

const log = createLogger("token")

interface OAuthErrorPayload {
  error?: string | { code?: string; status?: string; message?: string }
  error_description?: string
}

function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) return {}

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload
    if (!payload || typeof payload !== "object") return { description: text }

    let code: string | undefined
    if (typeof payload.error === "string") {
      code = payload.error
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message }
      }
    }

    const description = payload.error_description
    if (description) return { code, description }
    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message }
    }

    return { code }
  } catch {
    return { description: text }
  }
}

export class KimiTokenRefreshError extends Error {
  code?: string
  description?: string
  status: number
  statusText: string

  constructor(options: {
    message: string
    code?: string
    description?: string
    status: number
    statusText: string
  }) {
    super(options.message)
    this.name = "KimiTokenRefreshError"
    this.code = options.code
    this.description = options.description
    this.status = options.status
    this.statusText = options.statusText
  }
}

/**
 * Refreshes a Kimi OAuth access token using the refresh_token grant.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  _client: PluginClient,
  _providerId: string,
): Promise<OAuthAuthDetails | undefined> {
  const refreshToken = auth.refresh
  if (!refreshToken) return undefined

  try {
    const startTime = Date.now()
    const response = await fetch(KIMI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...getKimiOAuthHeaders(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: KIMI_CLIENT_ID,
      }),
    })

    if (!response.ok) {
      let errorText: string | undefined
      try {
        errorText = await response.text()
      } catch {
        errorText = undefined
      }

      const { code, description } = parseOAuthErrorPayload(errorText)
      const details = [code, description ?? errorText].filter(Boolean).join(": ")
      const baseMessage = `Kimi token refresh failed (${response.status} ${response.statusText})`
      const message = details ? `${baseMessage} - ${details}` : baseMessage
      log.warn("Token refresh failed", { status: response.status, code, details })

      if (code === "invalid_grant" || response.status === 401 || response.status === 403) {
        log.warn("Kimi revoked the stored refresh token - reauthentication required")
        clearCachedAuth(auth.refresh)
      }

      throw new KimiTokenRefreshError({
        message,
        code,
        description: description ?? errorText,
        status: response.status,
        statusText: response.statusText,
      })
    }

    const payload = (await response.json()) as {
      access_token: string
      expires_in: number
      refresh_token?: string
    }

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: calculateTokenExpiry(startTime, payload.expires_in),
      refresh: payload.refresh_token ?? refreshToken,
    }

    storeCachedAuth(updatedAuth)
    return updatedAuth
  } catch (error) {
    if (error instanceof KimiTokenRefreshError) throw error
    log.error("Unexpected token refresh error", { error: String(error) })
    return undefined
  }
}
