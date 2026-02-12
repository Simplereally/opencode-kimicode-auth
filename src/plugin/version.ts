/**
 * Kimicode version resolver.
 *
 * The emulated kimi-cli version (used in User-Agent and X-Msh-Version) is
 * configured in constants.ts and tracks a recent kimi-cli release.
 * This module logs the active version at startup for debugging.
 */

import { getKimiPluginVersion } from "../constants";
import { createLogger } from "./logger";

/**
 * Log the active emulated kimi-cli version.
 * The version itself is configured in constants.ts (KIMI_CLI_COMPAT_VERSION)
 * and can be overridden via the KIMI_CODE_CLI_VERSION env var.
 */
export async function initKimicodeVersion(): Promise<void> {
  const log = createLogger("version");
  const version = getKimiPluginVersion();
  log.debug("kimicode-emulated-version", { version });
}
