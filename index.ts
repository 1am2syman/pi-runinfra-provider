/**
 * RunInfra custom provider for pi
 *
 * Registers the "runinfra" provider (https://runinfra.ai) with API-key based
 * login, so it appears under "Sign in with an API key" in `/login`.
 *
 * - Base URL: https://api.runinfra.ai/v1 (OpenAI-compatible chat completions)
 * - Auth:     Authorization: Bearer <workspace API key> (rp_...)
 *             Stored via `/login runinfra`, or read from the
 *             RUNINFRA_GATEWAY_KEY environment variable.
 * - Models:   Baseline catalog from the RunInfra docs; once a key is
 *             configured, the list is refreshed live from GET /v1/models
 *             (context windows / max output tokens / availability come
 *             straight from the gateway, which the docs recommend over
 *             hard-coding).
 *
 * Usage:
 *   1. Reload: /reload
 *   2. Login:  /login runinfra  (API-key category), or export RUNINFRA_GATEWAY_KEY
 *   3. Select: /model  ->  runinfra/deepseek-v4-flash (or any live model id)
 */

import { createProvider } from "@earendil-works/pi-ai";
import type { Model, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "runinfra";
const PROVIDER_NAME = "RunInfra";
const BASE_URL = "https://api.runinfra.ai/v1";
const ENV_API_KEY = "RUNINFRA_GATEWAY_KEY";
const API = "openai-completions" as const;

// =============================================================================
// Baseline model catalog
// =============================================================================
//
// Sources: https://runinfra.ai/docs/api-reference/chat-completions (capability
// matrix) and the GET /v1/models response example. RunInfra hosts open-weight
// models; reasoning streams on `delta.reasoning`, the answer on
// `delta.content`, and `reasoning_effort` (including "none") is the documented
// way to control thinking. Context windows / max output for models without a
// published number are placeholders corrected by the live fetch below.

interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  /** Whether reasoning can be turned off with reasoning_effort "none". */
  canDisableReasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** USD per 1M tokens. Prices from https://runinfra.ai/inference-api/<model>. */
  cost: { input: number; cacheRead: number; output: number };
  /**
   * Per-model pi thinking level → RunInfra reasoning_effort. Values are
   * verified live against the gateway (2026-08): each model's upstream
   * accepts a different subset, so no shared map is safe. `null` hides the
   * level in pi; a missing key disables it for xhigh/max only.
   */
  effortMap?: ThinkingLevelMap;
}

const BASELINE_SPECS: ModelSpec[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    canDisableReasoning: true,
    contextWindow: 1_048_576, // documented: 1048576
    maxTokens: 32_768, // documented: 32768
    cost: { input: 0.13, cacheRead: 0.01, output: 0.27 },
    // Verified: accepts every effort value, so pass each pi level through
    // 1:1 (users selecting xhigh/max get the gateway's real top end).
    effortMap: {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: false, // "already off" — answers without reasoning
    canDisableReasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    cost: { input: 0.6, cacheRead: 0.03, output: 1.9 },
  },
  {
    id: "qwen3-8-27b",
    name: "Qwen3.8 27B",
    reasoning: true,
    canDisableReasoning: true,
    contextWindow: 131_072,
    maxTokens: 32_768,
    cost: { input: 0.1, cacheRead: 0.01, output: 0.4 },
    // Verified: accepts only none/low/medium/xhigh (xhigh is the default).
    // "high" is REJECTED with 400 — top pi levels map to xhigh.
    effortMap: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "xhigh",
      xhigh: "xhigh",
      max: "xhigh",
    },
  },
  {
    id: "qwen3-8-2-4t-a95b",
    name: "Qwen3.8 2.4T A95B",
    reasoning: true,
    canDisableReasoning: false, // gateway: "Disabling thinking is not supported"
    contextWindow: 131_072,
    maxTokens: 32_768,
    cost: { input: 2.0, cacheRead: 0.2, output: 6.0 },
    // Verified: accepts only low/medium/xhigh (xhigh is the default);
    // "none"/"minimal"/"max" are rejected.
    effortMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "xhigh",
      xhigh: "xhigh",
      max: "xhigh",
    },
  },
  {
    id: "nemotron-3-5-lightning-30b",
    name: "Nemotron 3.5 Lightning 30B",
    reasoning: true,
    canDisableReasoning: true,
    contextWindow: 262_144, // documented: 262144
    maxTokens: 32_768,
    cost: { input: 0, cacheRead: 0, output: 0 }, // currently paused; no published price
    // UNVERIFIED — model paused at probe time (2026-08-19 availability
    // check). Assuming OpenAI-style values; re-probe when it returns.
    effortMap: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    },
  },
];

const SPEC_BY_ID = new Map(BASELINE_SPECS.map((spec) => [spec.id, spec]));

/** Fallback for reasoning models without a verified per-model map. */
const EFFORT_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

function thinkingLevelMap(spec: ModelSpec): ThinkingLevelMap | undefined {
  if (!spec.reasoning) return undefined;
  return spec.effortMap ?? EFFORT_MAP;
}

function compatFor(spec: ModelSpec) {
  return {
    supportsStore: false, // no store parameter
    supportsDeveloperRole: false, // open-weight models expect "system"
    supportsReasoningEffort: spec.reasoning,
    supportsUsageInStreaming: true, // stream_options.include_usage frame
    maxTokensField: "max_tokens", // RunInfra uses max_tokens, not max_completion_tokens
  } as const;
}

function modelFromSpec(spec: ModelSpec): Model<typeof API> {
  return {
    id: spec.id,
    name: spec.name,
    api: API,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: spec.reasoning,
    thinkingLevelMap: thinkingLevelMap(spec),
    input: ["text"],
    // Per-model pricing (USD/1M tokens) from each model's page on the
    // RunInfra Model Library (https://runinfra.ai/inference-api).
    cost: {
      input: spec.cost.input,
      output: spec.cost.output,
      cacheRead: spec.cost.cacheRead,
      cacheWrite: 0, // no separate cache-write price on Model APIs
    },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    compat: compatFor(spec),
  };
}

// =============================================================================
// Live model discovery — GET /v1/models
// =============================================================================

interface LiveModel {
  id: string;
  availability?: string;
  context_window?: number;
  max_output_tokens?: number;
}

async function fetchRunInfraModels(
  context: RefreshModelsContext,
): Promise<readonly Model<typeof API>[]> {
  const key = context.credential?.key ?? process.env[ENV_API_KEY];
  if (!key) return []; // keep the previous catalog

  const response = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: context.signal,
  });
  if (!response.ok) {
    throw new Error(
      `RunInfra GET /v1/models failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as { data?: LiveModel[] };
  return (payload.data ?? [])
    .filter((m) => m.availability === undefined || m.availability === "available")
    .map((m) => {
      const spec = SPEC_BY_ID.get(m.id);
      const base: Model<typeof API> = spec
        ? modelFromSpec(spec)
        : {
            // Unknown model served by the gateway: use conservative defaults.
            id: m.id,
            name: m.id,
            api: API,
            provider: PROVIDER_ID,
            baseUrl: BASE_URL,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // unknown model: no published price
            contextWindow: m.context_window ?? 131_072,
            maxTokens: m.max_output_tokens ?? 16_384,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsUsageInStreaming: true,
              maxTokensField: "max_tokens",
            },
          };
      return {
        ...base,
        contextWindow: m.context_window ?? base.contextWindow,
        maxTokens: m.max_output_tokens ?? base.maxTokens,
      };
    });
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerProvider(
    createProvider({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      baseUrl: BASE_URL,
      auth: {
        apiKey: {
          name: "RunInfra API key",
          async login(interaction) {
            const key = await interaction.prompt({
              type: "secret",
              message:
                "Enter your RunInfra workspace API key (rp_...). Create one at https://runinfra.ai/settings/api-keys — note that a `runinfra login` CLI key cannot call the inference API.",
              placeholder: "rp_...",
            });
            return { type: "api_key", key };
          },
          async resolve({ ctx, credential }) {
            const key = credential?.key ?? (await ctx.env(ENV_API_KEY));
            return key
              ? {
                  auth: { apiKey: key },
                  source: credential?.key ? "stored API key" : `${ENV_API_KEY} env var`,
                }
              : undefined;
          },
        },
      },
      models: BASELINE_SPECS.map(modelFromSpec),
      fetchModels: fetchRunInfraModels,
      api: openAICompletionsApi(),
    }),
  );
}
