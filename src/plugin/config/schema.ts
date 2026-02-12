/**
 * Configuration schema for opencode-kimicode-auth plugin.
 * 
 * Config file locations (in priority order, highest wins):
 * - Project: .opencode/kimicode.json
 * - User: ~/.config/opencode/kimicode.json (Linux/Mac)
 *         %APPDATA%\opencode\kimicode.json (Windows)
 * 
 * Environment variables always override config file values.
 */

import { z } from "zod";

/**
 * Account selection strategy for distributing requests across accounts.
 * 
 * - `sticky`: Use same account until rate-limited. Preserves prompt cache.
 * - `round-robin`: Rotate to next account on every request. Maximum throughput.
 * - `hybrid` (default): Deterministic selection based on health score + token bucket + LRU freshness.
 */
export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'hybrid']);
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>;

/**
 * Toast notification scope for controlling which sessions show toasts.
 * 
 * - `root_only` (default): Only show toasts for root sessions (no parentID).
 *   Subagents and background tasks won't show toast notifications.
 * - `all`: Show toasts for all sessions including subagents and background tasks.
 */
export const ToastScopeSchema = z.enum(['root_only', 'all']);
export type ToastScope = z.infer<typeof ToastScopeSchema>;

/**
 * Scheduling mode for rate limit behavior.
 * 
 * - `cache_first`: Wait for same account to recover (preserves prompt cache). Default.
 * - `balance`: Switch account immediately on rate limit. Maximum availability.
 * - `performance_first`: Round-robin distribution for maximum throughput.
 */
export const SchedulingModeSchema = z.enum(['cache_first', 'balance', 'performance_first']);
export type SchedulingMode = z.infer<typeof SchedulingModeSchema>;

/**
 * Main configuration schema for the Kimi Code plugin.
 */
export const KimicodeConfigSchema = z.object({
  /** JSON Schema reference for IDE support */
  $schema: z.string().optional(),
  
  // =========================================================================
  // General Settings
  // =========================================================================
  
  /** 
   * Suppress most toast notifications (rate limit, account switching, etc.)
   * Recovery toasts are always shown regardless of this setting.
   * Env override: OPENCODE_KIMICODE_QUIET=1
   * @default false
   */
  quiet_mode: z.boolean().default(false),
  
  /**
   * Control which sessions show toast notifications.
   * 
   * - `root_only` (default): Only root sessions show toasts.
   *   Subagents and background tasks will be silent (less spam).
   * - `all`: All sessions show toasts including subagents and background tasks.
   * 
   * Debug logging captures all toasts regardless of this setting.
   * Env override: OPENCODE_KIMICODE_TOAST_SCOPE=all
   * @default "root_only"
   */
  toast_scope: ToastScopeSchema.default('root_only'),
  
  /**
   * Enable debug logging to file.
   * Env override: OPENCODE_KIMICODE_DEBUG=1
   * @default false
   */
  debug: z.boolean().default(false),
  
  /**
   * Custom directory for debug logs.
   * Env override: OPENCODE_KIMICODE_LOG_DIR=/path/to/logs
   * @default OS-specific config dir + "/kimicode-logs"
   */
  log_dir: z.string().optional(),
  
  // =========================================================================
  // Session Recovery
  // =========================================================================
  
  /**
   * Enable automatic session recovery from tool_result_missing errors.
   * When enabled, shows a toast notification when recoverable errors occur.
   * 
   * @default true
   */
  session_recovery: z.boolean().default(true),
  
  /**
   * Automatically send a "continue" prompt after successful recovery.
   * Only applies when session_recovery is enabled.
   * 
   * When false: Only shows toast notification, user must manually continue.
   * When true: Automatically sends "continue" to resume the session.
   * 
   * @default false
   */
  auto_resume: z.boolean().default(false),
  
  /**
   * Custom text to send when auto-resuming after recovery.
   * Only used when auto_resume is enabled.
   * 
   * @default "continue"
   */
  resume_text: z.string().default("continue"),
  
  // =========================================================================
  // Proactive Token Refresh
  // =========================================================================
  
  /**
   * Enable proactive background token refresh.
   * When enabled, tokens are refreshed in the background before they expire,
   * ensuring requests never block on token refresh.
   * 
   * @default true
   */
  proactive_token_refresh: z.boolean().default(true),
  
  /**
   * Seconds before token expiry to trigger proactive refresh.
   * Default is 30 minutes (1800 seconds).
   * 
   * @default 1800
   */
  proactive_refresh_buffer_seconds: z.number().min(60).max(7200).default(1800),
  
  /**
   * Interval between proactive refresh checks in seconds.
   * Default is 5 minutes (300 seconds).
   * 
   * @default 300
   */
  proactive_refresh_check_interval_seconds: z.number().min(30).max(1800).default(300),
  
  // =========================================================================
  // Rate Limiting
  // =========================================================================
  
  /**
   * Maximum time in seconds to wait when all accounts are rate-limited.
   * If the minimum wait time across all accounts exceeds this threshold,
   * the plugin fails fast with an error instead of hanging.
   * 
   * Set to 0 to disable (wait indefinitely).
   * 
   * @default 300 (5 minutes)
   */
  max_rate_limit_wait_seconds: z.number().min(0).max(3600).default(300),
  
  /**
   * Strategy for selecting accounts when making requests.
   * Env override: OPENCODE_KIMICODE_ACCOUNT_SELECTION_STRATEGY
   * @default "hybrid"
   */
  account_selection_strategy: AccountSelectionStrategySchema.default('hybrid'),
  
  /**
   * Enable PID-based account offset for multi-session distribution.
   * 
   * When enabled, different sessions (PIDs) will prefer different starting
   * accounts, which helps distribute load when running multiple parallel agents.
   * 
   * When disabled (default), accounts start from the same index.
   * 
   * Env override: OPENCODE_KIMICODE_PID_OFFSET_ENABLED=1
   * @default false
   */
  pid_offset_enabled: z.boolean().default(false),
   
  /**
   * Switch to another account immediately on first rate limit (after 1s delay).
   * When disabled, retries same account first, then switches on second rate limit.
   * 
   * @default true
   */
  switch_on_first_rate_limit: z.boolean().default(true),
    
  /**
   * Scheduling mode for rate limit behavior.
   * 
   * - `cache_first`: Wait for same account to recover (preserves prompt cache). Default.
   * - `balance`: Switch account immediately on rate limit. Maximum availability.
   * - `performance_first`: Round-robin distribution for maximum throughput.
   * 
   * Env override: OPENCODE_KIMICODE_SCHEDULING_MODE
   * @default "cache_first"
   */
  scheduling_mode: SchedulingModeSchema.default('cache_first'),
    
  /**
   * Maximum seconds to wait for same account in cache_first mode.
   * If the account's rate limit reset time exceeds this, switch accounts.
   * 
   * @default 60
   */
  max_cache_first_wait_seconds: z.number().min(5).max(300).default(60),
    
  /**
   * TTL in seconds for failure count expiration.
   * After this period of no failures, consecutiveFailures resets to 0.
   * This prevents old failures from permanently penalizing an account.
   * 
   * @default 3600 (1 hour)
   */
  failure_ttl_seconds: z.number().min(60).max(7200).default(3600),
   
  /**
   * Default retry delay in seconds when API doesn't return a retry-after header.
   * Lower values allow faster retries but may trigger more 429 errors.
   * 
   * @default 60
   */
  default_retry_after_seconds: z.number().min(1).max(300).default(60),
   
  /**
   * Maximum backoff delay in seconds for exponential retry.
   * This caps how long the exponential backoff can grow.
   * 
   * @default 60
   */
  max_backoff_seconds: z.number().min(5).max(300).default(60),
   
  /**
   * Maximum random delay in milliseconds before each API request.
   * Adds timing jitter to break predictable request cadence patterns.
   * Set to 0 to disable request jitter.
   * 
   * @default 0
   */
  request_jitter_max_ms: z.number().min(0).max(5000).default(0),
   
  // =========================================================================
  // Health Score (used by hybrid strategy)
  // =========================================================================
  
  health_score: z.object({
    initial: z.number().min(0).max(100).default(70),
    success_reward: z.number().min(0).max(10).default(1),
    rate_limit_penalty: z.number().min(-50).max(0).default(-10),
    failure_penalty: z.number().min(-100).max(0).default(-20),
    recovery_rate_per_hour: z.number().min(0).max(20).default(2),
    min_usable: z.number().min(0).max(100).default(50),
    max_score: z.number().min(50).max(100).default(100),
  }).optional(),
  
  // =========================================================================
  // Token Bucket (for hybrid strategy)
  // =========================================================================
  
  token_bucket: z.object({
    max_tokens: z.number().min(1).max(1000).default(50),
    regeneration_rate_per_minute: z.number().min(0.1).max(60).default(6),
    initial_tokens: z.number().min(1).max(1000).default(50),
  }).optional(),
  
  // =========================================================================
  // Auto-Update
  // =========================================================================
  
  /**
   * Enable automatic plugin updates.
   * @default true
   */
  auto_update: z.boolean().default(true),

});

export type KimicodeConfig = z.infer<typeof KimicodeConfigSchema>;

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: KimicodeConfig = {
  quiet_mode: false,
  toast_scope: 'root_only',
  debug: false,
  session_recovery: true,
  auto_resume: true,
  resume_text: "continue",
  proactive_token_refresh: true,
  proactive_refresh_buffer_seconds: 1800,
  proactive_refresh_check_interval_seconds: 300,
  max_rate_limit_wait_seconds: 300,
  account_selection_strategy: 'hybrid',
  pid_offset_enabled: false,
  switch_on_first_rate_limit: true,
  scheduling_mode: 'cache_first',
  max_cache_first_wait_seconds: 60,
  failure_ttl_seconds: 3600,
  default_retry_after_seconds: 60,
  max_backoff_seconds: 60,
  request_jitter_max_ms: 0,
  auto_update: true,
  health_score: {
    initial: 70,
    success_reward: 1,
    rate_limit_penalty: -10,
    failure_penalty: -20,
    recovery_rate_per_hour: 2,
    min_usable: 50,
    max_score: 100,
  },
  token_bucket: {
    max_tokens: 50,
    regeneration_rate_per_minute: 6,
    initial_tokens: 50,
  },
};
