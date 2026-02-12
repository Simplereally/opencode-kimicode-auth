import { promises as fs } from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { createLogger } from "./logger";

const log = createLogger("storage");

/**
 * Files/directories that should be gitignored in the config directory.
 * These contain sensitive data or machine-specific state.
 */
export const GITIGNORE_ENTRIES = [
  ".gitignore",
  "kimicode-accounts.json",
  "kimicode-accounts.json.*.tmp",
  "kimicode-logs/",
];

/**
 * Ensures a .gitignore file exists in the config directory with entries
 * for sensitive files. Creates the file if missing, or appends missing
 * entries if it already exists.
 */
export async function ensureGitignore(configDir: string): Promise<void> {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    try {
      content = await fs.readFile(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    );

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      await fs.writeFile(
        gitignorePath,
        missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await fs.appendFile(
        gitignorePath,
        suffix + missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}

/**
 * Synchronous version of ensureGitignore for use in sync code paths.
 */
export function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } else {
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    );

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      writeFileSync(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(
        gitignorePath,
        suffix + missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}

export type ModelFamily = "kimi";

/**
 * Header style for API requests.
 * Kimi uses a single header style matching kimi-cli.
 */
export type HeaderStyle = "kimi-cli";

export interface RateLimitState {
  kimi?: number;
  [key: string]: number | undefined;
}

export type CooldownReason = "auth-failure" | "network-error" | "project-error" | "validation-required";

export interface AccountMetadata {
  email?: string;
  refreshToken: string;
  addedAt: number;
  lastUsed: number;
  enabled?: boolean;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: import("./fingerprint").Fingerprint;
  fingerprintHistory?: import("./fingerprint").FingerprintVersion[];
  /** Cached soft quota data */
  cachedQuota?: Record<string, { remainingFraction?: number; resetTime?: string; modelCount: number }>;
  cachedQuotaUpdatedAt?: number;
}

export interface AccountStorage {
  version: 1;
  accounts: AccountMetadata[];
  activeIndex: number;
  activeIndexByFamily?: {
    kimi?: number;
  };
}

/**
 * @deprecated Aliases retained so existing imports compile during migration.
 * New code should use AccountMetadata / AccountStorage / RateLimitState directly.
 */
export type AccountMetadataV3 = AccountMetadata;
export type AccountStorageV4 = AccountStorage;
export type RateLimitStateV3 = RateLimitState;

/**
 * Gets the legacy Windows config directory (%APPDATA%\opencode).
 * Used for migration from older plugin versions.
 */
function getLegacyWindowsConfigDir(): string {
  return join(
    process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
    "opencode",
  );
}

/**
 * Gets the config directory path, with the following precedence:
 * 1. OPENCODE_CONFIG_DIR env var (if set)
 * 2. ~/.config/opencode (all platforms, including Windows)
 *
 * On Windows, also checks for legacy %APPDATA%\opencode path for migration.
 */
function getConfigDir(): string {
  // 1. Check for explicit override via env var
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }

  // 2. Use ~/.config/opencode on all platforms (including Windows)
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Migrates config from legacy Windows location to the new path.
 * Moves the file if legacy exists and new doesn't.
 * Returns true if migration was performed.
 */
function migrateLegacyWindowsConfig(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const newPath = join(getConfigDir(), "kimicode-accounts.json");
  const legacyPath = join(
    getLegacyWindowsConfigDir(),
    "kimicode-accounts.json",
  );

  // Only migrate if legacy exists and new doesn't
  if (!existsSync(legacyPath) || existsSync(newPath)) {
    return false;
  }

  try {
    // Ensure new config directory exists
    const newConfigDir = getConfigDir();

    mkdirSync(newConfigDir, { recursive: true });

    // Try rename first (atomic, but fails across filesystems)
    try {
      renameSync(legacyPath, newPath);
      log.info("Migrated Windows config via rename", { from: legacyPath, to: newPath });
    } catch {
      // Fallback: copy then delete (for cross-filesystem moves)
      copyFileSync(legacyPath, newPath);
      unlinkSync(legacyPath);
      log.info("Migrated Windows config via copy+delete", { from: legacyPath, to: newPath });
    }

    return true;
  } catch (error) {
    log.warn("Failed to migrate legacy Windows config, will use legacy path", {
      legacyPath,
      newPath,
      error: String(error),
    });
    return false;
  }
}

/**
 * Gets the storage path, migrating from legacy Windows location if needed.
 * On Windows, attempts to move legacy config to new path for alignment.
 */
function getStoragePathWithMigration(): string {
  const newPath = join(getConfigDir(), "kimicode-accounts.json");

  // On Windows, attempt to migrate legacy config to new location
  if (process.platform === "win32") {
    migrateLegacyWindowsConfig();

    // If migration failed and legacy still exists, fall back to it
    if (!existsSync(newPath)) {
      const legacyPath = join(
        getLegacyWindowsConfigDir(),
        "kimicode-accounts.json",
      );
      if (existsSync(legacyPath)) {
        log.info("Using legacy Windows config path (migration failed)", {
          legacyPath,
          newPath,
        });
        return legacyPath;
      }
    }
  }

  return newPath;
}

export function getStoragePath(): string {
  return getStoragePathWithMigration();
}

/**
 * Gets the config directory path. Exported for use by other modules.
 */
export { getConfigDir };

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2,
  },
};

/**
 * Ensures the file has secure permissions (0600) on POSIX systems.
 * This is a best-effort operation and ignores errors on Windows/unsupported FS.
 */
async function ensureSecurePermissions(path: string): Promise<void> {
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // Ignore errors (e.g. Windows, file doesn't exist, FS doesn't support chmod)
  }
}

async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({ version: 1, accounts: [], activeIndex: 0 }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(path);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch (unlockError) {
        log.warn("Failed to release lock", { error: String(unlockError) });
      }
    }
  }
}

function mergeAccountStorage(
  existing: AccountStorage,
  incoming: AccountStorage,
): AccountStorage {
  const accountMap = new Map<string, AccountMetadata>();

  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc);
    }
  }

  for (const acc of incoming.accounts) {
    if (acc.refreshToken) {
      const existingAcc = accountMap.get(acc.refreshToken);
      if (existingAcc) {
        accountMap.set(acc.refreshToken, {
          ...existingAcc,
          ...acc,
          rateLimitResetTimes: {
            ...existingAcc.rateLimitResetTimes,
            ...acc.rateLimitResetTimes,
          },
          lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        });
      } else {
        accountMap.set(acc.refreshToken, acc);
      }
    }
  }

  return {
    version: 1,
    accounts: Array.from(accountMap.values()),
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily,
  };
}

export function deduplicateAccountsByEmail<
  T extends { email?: string; lastUsed?: number; addedAt?: number },
>(accounts: T[]): T[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (!acc) continue;

    if (!acc.email) {
      indicesToKeep.add(i);
      continue;
    }

    const existingIndex = emailToNewestIndex.get(acc.email);
    if (existingIndex === undefined) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    const existing = accounts[existingIndex];
    if (!existing) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    const currLastUsed = acc.lastUsed || 0;
    const existLastUsed = existing.lastUsed || 0;
    const currAddedAt = acc.addedAt || 0;
    const existAddedAt = existing.addedAt || 0;

    const isNewer =
      currLastUsed > existLastUsed ||
      (currLastUsed === existLastUsed && currAddedAt > existAddedAt);

    if (isNewer) {
      emailToNewestIndex.set(acc.email, i);
    }
  }

  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }

  const result: T[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (indicesToKeep.has(i)) {
      const acc = accounts[i];
      if (acc) {
        result.push(acc);
      }
    }
  }

  return result;
}

export async function loadAccounts(): Promise<AccountStorage | null> {
  try {
    const path = getStoragePath();
    await ensureSecurePermissions(path);

    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AccountStorage;

    if (!Array.isArray(data.accounts)) {
      log.warn("Invalid storage format, ignoring");
      return null;
    }

    if (data.version !== 1) {
      log.warn("Unknown storage version, ignoring", {
        version: (data as { version?: unknown }).version,
      });
      return null;
    }

    const validAccounts = data.accounts.filter(
      (a): a is AccountMetadata => {
        return (
          !!a &&
          typeof a === "object" &&
          typeof (a as AccountMetadata).refreshToken === "string"
        );
      },
    );

    const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts);

    let activeIndex =
      typeof data.activeIndex === "number" &&
      Number.isFinite(data.activeIndex)
        ? data.activeIndex
        : 0;
    if (deduplicatedAccounts.length > 0) {
      activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1);
      activeIndex = Math.max(activeIndex, 0);
    } else {
      activeIndex = 0;
    }

    return {
      version: 1,
      accounts: deduplicatedAccounts,
      activeIndex,
      activeIndexByFamily: data.activeIndexByFamily,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const existing = await loadAccountsUnsafe();
    const merged = existing ? mergeAccountStorage(existing, storage) : storage;

    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(merged, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors (file may not exist)
      }
      throw error;
    }
  });
}

/**
 * Save accounts storage by replacing the entire file (no merge).
 * Use this for destructive operations like delete where we need to
 * remove accounts that would otherwise be merged back from existing storage.
 */
export async function saveAccountsReplace(storage: AccountStorage): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(storage, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  });
}

async function loadAccountsUnsafe(): Promise<AccountStorage | null> {
  try {
    const path = getStoragePath();
    await ensureSecurePermissions(path);

    const content = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(content) as AccountStorage;

    if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      return null;
    }

    return {
      ...parsed,
      accounts: deduplicateAccountsByEmail(parsed.accounts),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function clearAccounts(): Promise<void> {
  try {
    const path = getStoragePath();
    await fs.unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("Failed to clear account storage", { error: String(error) });
    }
  }
}
