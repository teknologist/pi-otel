# Plan: reliable GenAI agent and provider labels

## Problem

The Grafana usage dashboard currently behaves differently for `Agent = pi` and
`Agent = All`:

- Some main-agent `gpt-5.5` Prometheus series are visible only when `Agent = All`.
- Those series have `gen_ai_request_model="gpt-5.5"` and
  `gen_ai_response_model="gpt-5.5"`, but are missing `gen_ai_agent_name` and
  `gen_ai_provider_name`.
- Newer/subagent-looking series do have `gen_ai_agent_name="pi"`, but their
  provider is `gen_ai_provider_name="unknown"`.

Representative PromQL investigation:

```promql
sum(increase(gen_ai_client_token_usage_sum[30m]))
  by (service_name, job, gen_ai_agent_name, gen_ai_provider_name,
      gen_ai_request_model, gen_ai_response_model)
```

Observed shapes:

```text
# newer shape
gen_ai_agent_name="pi"
gen_ai_provider_name="unknown"
gen_ai_request_model="claude-opus-4-7"
gen_ai_response_model="claude-opus-4-7"
service_name="pi"

# older/main-agent gpt-5.5 shape
gen_ai_request_model="gpt-5.5"
gen_ai_response_model="gpt-5.5"
service_name="pi"
# missing gen_ai_agent_name and gen_ai_provider_name
```

## Current code findings

### `gen_ai.agent.name`

`src/spans.ts` centralizes span identity in `commonAttrs()` and currently sets:

```ts
[ATTR_AGENT_NAME]: GEN_AI_SYSTEM_PI
```

`recordLlmMetrics()`, `startInteraction()`, and `endTool()` also set
`ATTR_AGENT_NAME` on metric records. This is the intended v1 contract: the
extension-level GenAI agent is always `pi`, not the model provider and not
`service.name`.

This requirement applies to **all telemetry emitted by this extension**:

- spans/traces: every `pi.interaction`, `pi.turn`, `pi.llm_request`, and
  `pi.tool.<name>` span must carry `gen_ai.agent.name="pi"`.
- metrics: every pi-otel metric point, including token/duration/cost/tool-call
  and interaction counters, must carry `gen_ai.agent.name="pi"` unless the
  metric is intentionally provider/runtime-only and documented as such.
- logs: every lifecycle/diagnostic LogRecord emitted by pi-otel should carry
  `gen_ai.agent.name="pi"` alongside `gen_ai.system="pi"` where the log record is
  about pi-otel/pi agent activity.

Do not use subagent names, model names, provider names, or `service.name` as
`gen_ai.agent.name` for this extension. If we later want subagent breakdowns,
add a separate Pi-specific attribute rather than changing this label's meaning.

The missing `gen_ai_agent_name` on existing `gpt-5.5` series is therefore most
likely historical data from an older loaded extension generation or from a path
that recorded metrics before the current `SpanTracker` label contract. Do not
paper over that in the dashboard; fix/verify emission going forward.

### `gen_ai.provider.name`

`src/index.ts` currently tries to infer provider during
`before_provider_request` from event/payload fields:

```ts
const provider = firstString(
  e?.provider,
  e?.providerName,
  e?.modelProvider,
  payload?.provider,
  payload?.providerName,
  payload?.modelProvider,
  payload?.provider?.name,
);
```

But Pi's extension API type for `BeforeProviderRequestEvent` is only:

```ts
interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  payload: unknown;
}
```

The event does **not** formally include model/provider. The provider request is
emitted from Pi core with the model available internally, but the extension event
only receives `payload` today.

However, the handler's second argument is `ExtensionContext`, and Pi exposes the
current model there:

```ts
interface ExtensionContext {
  model: Model<any> | undefined;
}
```

Pi's `Model` type has the reliable provider field:

```ts
interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  // ...
}
```

So provider should come from Pi's current model (`ctx.model.provider`) rather
than best-effort request payload guessing.

## Success criteria

1. Every new LLM metric series emitted by pi-otel includes:
   - `gen_ai_agent_name="pi"`
   - `gen_ai_provider_name=<ctx.model.provider>` when available
   - `gen_ai_request_model=<ctx.model.id or payload model>`
   - `gen_ai_response_model=<assistant message model or request model>`
2. No new normal request should fall back to `gen_ai_provider_name="unknown"`
   when `ctx.model?.provider` exists.
3. Dashboard variables should show actual provider IDs such as `openai`,
   `openai-codex`, `anthropic`, `google`, etc., not just `unknown`.
4. Selecting `Agent = pi` should include the main working model's new traffic.
   Historical unlabeled series may remain visible only under `Agent = All` until
   they age out of the dashboard time range.
5. Tool, cost, interaction, token, and duration metrics all carry the same
   agent/provider/model contract where applicable.
6. Every trace span and pi-otel lifecycle log emitted by this extension carries
   `gen_ai.agent.name="pi"` where semantically applicable, so traces, metrics,
   and logs use the same agent identity.

## Implementation plan

### Task 1: Add focused label extraction helpers in `src/index.ts`

Add helpers that normalize Pi model/provider data from `ExtensionContext` before
falling back to payload inspection.

Proposed behavior:

- `modelIdFromContext(ctx.model)` returns `ctx.model.id` if present.
- `providerFromContext(ctx.model)` returns `ctx.model.provider` if present.
- `modelFromPayload(payload)` remains as a fallback for custom providers or
  future Pi event shapes.
- `providerFromPayload(payload/event)` remains only as a fallback; it must not
  override `ctx.model.provider`.

Ordering for provider:

1. `ctx.model.provider`
2. `modelSelectRef?.provider` fallback, if maintained
3. explicit event/payload provider fields, if present
4. `undefined` so `SpanTracker` uses `unknown`

Ordering for request model:

1. payload model-like field (`payload.model`, `payload.modelId`,
   `payload.modelName`) because this is what was actually sent
2. `ctx.model.id`
3. `modelSelectRef?.id`

### Task 2: Use `ExtensionContext` in `before_provider_request`

Change the handler from ignoring context to using it:

```ts
pi.on("before_provider_request", async (event, ctx) => {
  const payload = event.payload;
  const requestModel = modelFromPayload(payload) ?? modelIdFromContext(ctx.model);
  const provider = providerFromContext(ctx.model) ?? providerFromPayload(event, payload);
  // start span + set attrs
});
```

This should eliminate `unknown` provider for normal Pi model requests.

### Task 3: Track `model_select` as a defensive fallback

Subscribe to `model_select` and store the current selected model in a local ref:

```ts
let currentModelRef: Model<any> | undefined;

pi.on("model_select", async (event) => {
  currentModelRef = event.model;
});
```

Also initialize/update this ref opportunistically from any handler context where
`ctx.model` is present, especially `session_start` and `before_provider_request`.

Rationale: if some future provider request path has a stale/missing context
model but Pi emitted model selection earlier, provider can still come from Pi's
model object rather than payload guessing.

### Task 4: Make trace/metric/log agent labeling harder to bypass

In `src/spans.ts`, keep the existing `commonAttrs()` and metric `baseAttrs`, but
review every span/log/metric write.

Trace/span checks:

- `commonAttrs()` includes `ATTR_AGENT_NAME = "pi"` and every span constructor
  uses `commonAttrs()`.
- Any future span outside `SpanTracker` must also use the same helper or a
  shared constant.

Metric checks:

- `getDurationHistogram().record()` for chat
- `getTokenHistogram().record()` for input/output/cache/reasoning
- `getToolCallsHistogram().record()`
- `getCostCounter().add()`
- `getInteractionsCounter().add()`
- tool execution `getDurationHistogram().record()`

If worthwhile, extract tiny private helpers such as `agentMetricAttrs()` and
`llmMetricAttrs()` so future metric additions cannot omit `ATTR_AGENT_NAME` by
accident. Keep this surgical; do not refactor span lifecycle.

Log checks:

- `pi.session.start` / `pi.session.end` logs include `gen_ai.agent.name="pi"`.
- `pi.llm_request.error` and `pi.tool.error` logs include
  `gen_ai.agent.name="pi"`.
- `emitLifecycleLog()` should stamp `gen_ai.agent.name="pi"` and
  `gen_ai.system="pi"` at the emission boundary so every lifecycle record sent
  through pi-otel carries this identity consistently.
- The OpenTelemetry diag bridge should also stamp `gen_ai.agent.name="pi"` and
  `gen_ai.system="pi"` because those diagnostic LogRecords are emitted by this
  extension's logging pipeline.

### Task 5: Add regression coverage with a fake tracer/meter or exported helper tests

There is currently no test suite. For this change, either:

1. Add a minimal unit test harness for pure helper extraction (`model.provider`,
   payload fallbacks), or
2. Add a small verification script under `samples/lgtm/` that uses `SpanTracker`
   as `verify-dashboard.mjs` already does and asserts Prometheus labels.

Minimum assertions:

- Given a context model `{ id: "gpt-5.5", provider: "openai-codex" }`, the LLM
  duration/token/cost metrics have `gen_ai_agent_name="pi"` and
  `gen_ai_provider_name="openai-codex"`.
- Given payload model different from context model, request model records the
  payload value while provider still records `ctx.model.provider`.
- Given no provider anywhere, provider is `unknown` and agent is still `pi`.
- Pi-otel lifecycle/error logs include `gen_ai.agent.name="pi"`.

### Task 6: Validate against live LGTM

After implementation and restart:

Run a fresh main-agent prompt using `gpt-5.5`, then query:

```promql
sum(increase(gen_ai_client_token_usage_sum[5m]))
  by (gen_ai_agent_name, gen_ai_provider_name,
      gen_ai_request_model, gen_ai_response_model)
```

Expected new row shape:

```text
gen_ai_agent_name="pi"
gen_ai_provider_name="<actual pi model provider>"
gen_ai_request_model="gpt-5.5"
gen_ai_response_model="gpt-5.5"
```

Also query tool and cost paths:

```promql
sum(increase(gen_ai_client_operation_duration_seconds_count[5m]))
  by (gen_ai_agent_name, gen_ai_operation_name, gen_ai_tool_name)

sum(increase(pi_cost_usd_total[5m]))
  by (gen_ai_agent_name, gen_ai_provider_name, gen_ai_response_model)
```

Dashboard checks:

- `Agent = pi` includes fresh main-agent `gpt-5.5` traffic.
- Provider dropdown includes the actual provider instead of only `unknown`.
- `Agent = All` and `Agent = pi` differ only by historical unlabeled traffic or
  non-pi clients, not by current main-agent traffic.

## Non-goals

- Do not rewrite historical Prometheus series or dashboard around missing legacy
  labels.
- Do not change the meaning of `gen_ai.agent.name`; for this extension it remains
  `pi`.
- Do not let subagent identity, selected model, or provider override
  `gen_ai.agent.name` on telemetry emitted by pi-otel.
- Do not use `service.name` as a substitute for `gen_ai.agent.name`.
- Do not modify the installed checkout under
  `~/.pi/agent/git/github.com/teknologist/pi-otel` while implementing this plan;
  update source first, then reinstall/restart explicitly when ready.

## Open questions

1. Should `gen_ai.agent.name` eventually distinguish subagent names, e.g.
   `pi.subagent.<name>`, or should that be a separate Pi-specific attribute such
   as `pi.agent.name` while `gen_ai.agent.name` stays `pi`?
2. Should the Pi extension API include model/provider directly on
   `before_provider_request` to avoid relying on `ctx.model` freshness? If so,
   pi-otel can use that once available, but `ctx.model.provider` is the best
   current source.
