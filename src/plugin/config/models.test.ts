import { describe, expect, it } from "vitest"

import { OPENCODE_MODEL_DEFINITIONS } from "./models"

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("includes the full set of configured models", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort()

    expect(modelNames).toEqual([
      "kimicode-kimi-k2.5",
      "kimicode-kimi-k2.5-thinking",
    ])
  })

  it("defines correct limits for each model", () => {
    for (const [id, definition] of Object.entries(OPENCODE_MODEL_DEFINITIONS)) {
      expect(definition.limit.context).toBeGreaterThan(0)
      expect(definition.limit.output).toBeGreaterThan(0)
    }
  })
})
