/**
 * Device Identity Module
 *
 * Generates unique device identifiers for Kimi Code API requests.
 * Used for device fingerprinting in X-Msh-Device-Id headers.
 */

import * as crypto from "node:crypto";

export interface Fingerprint {
  deviceId: string;
  createdAt: number;
}

/**
 * Fingerprint version for history tracking.
 * Stores a snapshot of a fingerprint with metadata about when/why it was saved.
 */
export interface FingerprintVersion {
  fingerprint: Fingerprint;
  timestamp: number;
  reason: 'initial' | 'regenerated' | 'restored';
}

/** Maximum number of fingerprint versions to keep per account */
export const MAX_FINGERPRINT_HISTORY = 5;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeDeviceIdToHex32(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(trimmed)) {
    return trimmed;
  }

  // Allow legacy UUID v4 strings and normalize to kimi-cli style (uuid4().hex).
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
    const hex = trimmed.replace(/-/g, "");
    return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
  }

  return null;
}

function generateDeviceIdHex32(): string {
  // Prefer randomUUID when available, but always normalize to 32 lowercase hex chars.
  try {
    const uuid = crypto.randomUUID();
    const normalized = normalizeDeviceIdToHex32(uuid);
    if (normalized) return normalized;
  } catch {
    // ignore
  }

  return crypto.randomBytes(16).toString("hex");
}

/**
 * Generate a device identity with a unique device ID.
 */
export function generateFingerprint(): Fingerprint {
  return {
    // kimi-cli uses uuid4().hex (32 lowercase hex chars, no dashes).
    deviceId: generateDeviceIdHex32(),
    createdAt: Date.now(),
  };
}

/**
 * Best-effort coercion of stored fingerprints.
 * Keeps existing device ids when valid, normalizes legacy UUIDs, and regenerates when missing/corrupt.
 */
export function coerceFingerprint(value: unknown): Fingerprint {
  const now = Date.now();
  if (!value || typeof value !== "object") {
    return generateFingerprint();
  }

  const v = value as Partial<Fingerprint> & { device_id?: unknown; created_at?: unknown };
  const deviceIdCandidate =
    typeof v.deviceId === "string"
      ? v.deviceId
      : typeof v.device_id === "string"
        ? v.device_id
        : "";
  const normalized = deviceIdCandidate ? normalizeDeviceIdToHex32(deviceIdCandidate) : null;
  const createdAtCandidate =
    isFiniteNumber(v.createdAt) ? v.createdAt : isFiniteNumber(v.created_at) ? v.created_at : now;

  if (normalized) {
    return { deviceId: normalized, createdAt: createdAtCandidate };
  }

  // Missing/invalid device id: regenerate.
  return { deviceId: generateDeviceIdHex32(), createdAt: createdAtCandidate };
}

/**
 * Session-level fingerprint instance.
 * Generated once at module load, persists for the lifetime of the process.
 */
let sessionFingerprint: Fingerprint | null = null;

/**
 * Get or create the session fingerprint.
 * Returns the same fingerprint for all calls within a session.
 */
export function getSessionFingerprint(): Fingerprint {
  if (!sessionFingerprint) {
    sessionFingerprint = generateFingerprint();
  }
  return sessionFingerprint;
}

/**
 * Regenerate the session fingerprint.
 * Call this to get a fresh identity (e.g., after rate limiting).
 */
export function regenerateSessionFingerprint(): Fingerprint {
  sessionFingerprint = generateFingerprint();
  return sessionFingerprint;
}
