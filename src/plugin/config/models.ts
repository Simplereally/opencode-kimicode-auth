import type { ProviderModel } from "../types"

export interface ModelLimit {
  context: number
  output: number
}

export type ModelModality = "text" | "image"

export interface ModelModalities {
  input: ModelModality[]
  output: ModelModality[]
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string
  limit: ModelLimit
  modalities: ModelModalities
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>

const TEXT_ONLY: ModelModalities = {
  input: ["text"],
  output: ["text"],
}

const MULTIMODAL: ModelModalities = {
  input: ["text", "image"],
  output: ["text"],
}

export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  // Kimi Code OAuth models are additive-only under the Moonshot provider.
  // Prefix with "kimicode-" to keep them distinct from Moonshot API-key models.
  //
  // Two modes matching the kimi-cli / web GUI: thinking off and thinking on.
  // kimi-cli default max_tokens is 32000; context reported by /models is 262144.
  "kimicode-kimi-k2.5": {
    name: "Kimi Code (K2.5)",
    limit: { context: 262144, output: 32000 },
    modalities: MULTIMODAL,
  },
  "kimicode-kimi-k2.5-thinking": {
    name: "Kimi Code (K2.5) Thinking",
    limit: { context: 262144, output: 32000 },
    modalities: MULTIMODAL,
  },
}
