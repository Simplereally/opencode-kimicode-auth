/**
 * Configuration module for opencode-kimicode-auth plugin.
 * 
 * @example
 * ```typescript
 * import { loadConfig, type KimicodeConfig } from "./config";
 * 
 * const config = loadConfig(directory);
 * if (config.session_recovery) {
 *   // Enable session recovery
 * }
 * ```
 */

export {
  KimicodeConfigSchema,
  DEFAULT_CONFIG,
  type KimicodeConfig,
} from "./schema";

export {
  loadConfig,
  getUserConfigPath,
  getProjectConfigPath,
  getDefaultLogsDir,
  configExists,
  initRuntimeConfig,
} from "./loader";
