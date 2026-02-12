/**
 * Session recovery module for opencode-kimicode-auth.
 * 
 * Provides recovery from:
 * - tool_result_missing: Interrupted tool executions (provider-agnostic)
 * - thinking_block_order: Corrupted thinking blocks (Claude/Anthropic-specific; no-op for Kimi)
 * - thinking_disabled_violation: Thinking in non-thinking model (Claude/Anthropic-specific; no-op for Kimi)
 * 
 * Note: Kimi uses OpenAI-compatible error formats. The thinking_* patterns will never
 * match Kimi errors but are retained for completeness. To add Kimi-specific recovery,
 * extend detectErrorType() in recovery.ts with Kimi error patterns.
 */

export * from "./types";
export * from "./constants";
export * from "./storage";
