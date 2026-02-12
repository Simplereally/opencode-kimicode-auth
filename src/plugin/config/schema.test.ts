import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./schema";

describe("DEFAULT_CONFIG", () => {
  it("uses sane kimicode defaults", () => {
    expect(DEFAULT_CONFIG.quiet_mode).toBe(false);
    expect(DEFAULT_CONFIG.account_selection_strategy).toBe("hybrid");
    expect(DEFAULT_CONFIG.session_recovery).toBe(true);
  });

  it("defaults to root_only toasts (avoid subagent spam)", () => {
    expect(DEFAULT_CONFIG.toast_scope).toBe("root_only");
  });

  it("enables proactive token refresh by default", () => {
    expect(DEFAULT_CONFIG.proactive_token_refresh).toBe(true);
  });
});

