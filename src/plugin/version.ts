/**
 * Local Kimicode version resolver.
 *
 * Resolves the plugin version from the nearest package.json found by walking
 * up the directory tree from this file. This is used to populate X-Msh-Version
 * headers and avoid stale hardcoded values.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getKimiPluginVersion, setKimiPluginVersion } from "../constants";
import { createLogger } from "./logger";

type VersionSource = "package.json" | "fallback";

function tryResolveVersionFromPackageJson(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const pkgPath = join(dir, "package.json");
    try {
      const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
      if (typeof raw.version === "string" && raw.version.trim().length > 0) {
        return raw.version.trim();
      }
    } catch {
      // ignore and keep walking up
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Fetch the latest kimicode version and update the global constant.
 * Safe to call before logger is initialized (will silently skip logging).
 */
export async function initKimicodeVersion(): Promise<void> {
  const log = createLogger("version");
  const fallback = getKimiPluginVersion();
  const resolved = tryResolveVersionFromPackageJson();
  const version = resolved ?? fallback;
  const source: VersionSource = resolved ? "package.json" : "fallback";

  if (version !== fallback) {
    log.info("version-updated", { version, source, previous: fallback });
  } else {
    log.debug("version-unchanged", { version, source });
  }

  setKimiPluginVersion(version);
}
