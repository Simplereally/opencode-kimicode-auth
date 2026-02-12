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

/**
 * Generate a device identity with a unique device ID.
 */
export function generateFingerprint(): Fingerprint {
  return {
    // kimi-cli uses uuid4().hex (32 lowercase hex chars, no dashes).
    deviceId: crypto.randomBytes(16).toString("hex"),
    createdAt: Date.now(),
  };
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
