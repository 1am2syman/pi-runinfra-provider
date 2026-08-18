# RunInfra provider for pi

Adds the [`runinfra`](https://runinfra.ai) provider to pi with **API-key based login** —
it appears under "Sign in with an API key" in `/login`.

## Install

- **From this repo:** clone into your extensions dir, then reload pi
  (`/reload`):

  ```sh
  git clone https://github.com/1am2syman/pi-runinfra-provider.git \
    ~/.pi/agent/extensions/pi-runinfra-provider
  ```

- **Manual:** drop `index.ts` (and `package.json`) into
  `~/.pi/agent/extensions/runinfra-provider/` and run `/reload`.

Then continue with [Setup](#setup) below.

## Setup

1. Get a workspace API key from https://runinfra.ai/settings/api-keys
   (the `rp_...` key; a `runinfra login` CLI key cannot call the inference API).
2. Reload pi: `/reload`
3. Login: `/login runinfra` and paste the key, **or** set the environment
   variable `RUNINFRA_GATEWAY_KEY`.
4. Pick a model: `/model` → `runinfra/...`

## What it does

- **Endpoint:** `https://api.runinfra.ai/v1` — OpenAI-compatible chat completions.
- **Streaming:** uses pi's built-in `openai-completions` implementation; reasoning
  models stream on `delta.reasoning` and the answer on `delta.content`.
- **Thinking control:** sends standard `reasoning_effort` (`none`/`low`/`medium`/`high`).
  Models that cannot disable reasoning (`qwen3-8-2-4t-a95b`) are marked accordingly.
- **Live catalog:** after login, the model list is refreshed from `GET /v1/models`
  (per the RunInfra docs: never hard-code a model list). Context windows, max
  output tokens, and availability come straight from the gateway; paused models
  are filtered out. Unknown models fall back to conservative defaults.
- **Costs:** wired from each model's page on the RunInfra Model Library
  (USD/1M tokens, fetched 2026-08-18): deepseek-v4-flash `$0.13/0.01/0.27`,
  deepseek-v4-pro `$0.60/0.03/1.90`, qwen3-8-27b `$0.10/0.01/0.40`,
  qwen3-8-2-4t-a95b `$2.00/0.20/6.00` (input / cached input / output).
  Cache-hit tokens aren't reported by the API, so estimates price all input at
  the standard input rate. Nemotron is currently paused and has no published
  price (0).

## Baseline models

| Model | Reasoning | Notes |
|-------|-----------|-------|
| `deepseek-v4-flash` | yes | 1M context |
| `deepseek-v4-pro` | no | answers without reasoning |
| `qwen3-8-27b` | yes | |
| `qwen3-8-2-4t-a95b` | yes | reasoning cannot be turned off |
| `nemotron-3-5-lightning-30b` | yes | no tool calling |

The live `GET /v1/models` refresh replaces this list with whatever your key can
reach.

## Files

- `index.ts` — the extension (auto-discovered from `~/.pi/agent/extensions/*/index.ts`)
