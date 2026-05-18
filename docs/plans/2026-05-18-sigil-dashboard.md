# Plan: Sigil-style Grafana dashboard

Spec: `docs/specs/sigil-dashboard.md`

## Dependency graph

- `src/index.ts` extracts Pi event/provider/usage data and feeds `SpanTracker`.
- `src/spans.ts` owns interaction/turn/LLM/tool lifecycle and records metrics via `src/otel/metrics.ts`.
- `src/attrs.ts` centralizes OTel attribute names used by spans and metric labels.
- `src/otel/metrics.ts` creates/reset lazy instruments used by `SpanTracker` and reset by SDK shutdown.
- `samples/lgtm/compose.yaml` mounts dashboards; `samples/lgtm/grafana-dashboards.yaml` provisions them; `samples/lgtm/dashboard-usage.json` is the new user-facing dashboard.

## Checkpoint 1: Metrics contract ready

Confirm pi-otel emits the labels and counters the dashboard depends on before building panels.

## Task 1: Add dashboard metric instruments

- [x] Implemented
- [x] Verified
- [x] Reviewed

### Acceptance criteria

- `src/otel/metrics.ts` exposes `getCostCounter()` for `pi.cost.usd` with unit `usd` (USD currency, lowercase to keep Prometheus export as `pi_cost_usd_total`).
- `src/otel/metrics.ts` exposes `getInteractionsCounter()` for `pi.interactions` with unit `{interaction}`.
- Nonstandard `getToolCallsCounter()` / `gen_ai.client.tool.calls` is removed.
- `resetMetricHandles()` still clears all cached instruments.

### Verification

- Run `npm run typecheck`.
- Inspect generated metric names in Prometheus after a sample run: `pi_cost_usd_total`, `pi_interactions_total`; no new `gen_ai_client_tool_calls_total` datapoints.

## Task 2: Normalize GenAI metric attributes

- [x] Implemented
- [x] Verified
- [x] Reviewed

### Acceptance criteria

- Official LLM duration/token/tool-call metrics include `gen_ai.agent.name="pi"`, `gen_ai.system="pi"`, `gen_ai.operation.name="chat"`, provider, request model, and response model labels.
- Provider/model metric labels use `unknown` fallback when Pi omits values.
- Failed LLM operation-duration records include `error.type`.
- `gen_ai.agent.name` is never derived from `service.name` or `cfg.serviceName`.

### Verification

- Run `npm run typecheck`.
- Trigger one successful and one failed model request; confirm Prometheus labels contain `gen_ai_agent_name="pi"` and failed duration records include `error_type`.

## Task 3: Record interaction and cost counters

- [x] Implemented
- [x] Verified
- [x] Reviewed

### Acceptance criteria

- `pi.interactions` increments exactly once per root `pi.interaction`.
- `pi.cost.usd` increments once at LLM request end only when finite final cost exists.
- Missing/non-finite cost emits no datapoint, not zero.
- Cost labels include `gen_ai.agent.name`, `gen_ai.provider.name`, and `gen_ai.response.model`; cost has no `gen_ai.token.type` label.
- Existing span-side `pi.cost.usd` attribute remains unchanged.

### Verification

- Run `npm run typecheck`.
- Run two Pi interactions with at least one LLM call; confirm `increase(pi_interactions_total[...]) == 2` and cost totals match known usage-bearing spans.

## Checkpoint 2: Tool aggregate path ready

Verify aggregate tool charts can be powered by official operation-duration metrics before removing old assumptions from dashboard work.

## Task 4: Emit official tool operation metrics

- [x] Implemented
- [x] Verified
- [x] Reviewed

### Acceptance criteria

- `endTool()` records `gen_ai.client.operation.duration` for each tool execution.
- Tool metric labels include `gen_ai.agent.name="pi"`, `gen_ai.system="pi"`, `gen_ai.operation.name="execute_tool"`, and `gen_ai.tool.name`.
- Failed tool records include `error.type` and tool spans keep ERROR status.
- Tool spans remain children of `pi.turn`/`pi.interaction`, not `pi.llm_request`.

### Verification

- Run `npm run typecheck`.
- Trigger successful and failing tool calls; confirm Prometheus `gen_ai_client_operation_duration_count{gen_ai_operation_name="execute_tool"}` increments by tool name.

## Checkpoint 3: Dashboard provisioned

Only build the dashboard after metric names/labels are stable.

## Task 5: Add usage dashboard JSON

- [x] Implemented
- [x] Verified
- [x] Reviewed

### Acceptance criteria

- `samples/lgtm/dashboard-usage.json` defines variables `$agent`, `$provider`, `$model`, `$tempo_ds`, and `$prom_ds`.
- Stat row includes total/input/output tokens, cache hit rate, estimated cost, and avg cost/interaction.
- Token, cost, and tool-call rows use the PromQL from the spec with correct label filters.
- Highest-token conversations table uses Tempo/TraceQL with a `conversation_id` data link to Explore.
- Dashboard defaults `$agent` to `pi` and provider/model to All.

### Verification

- Start `samples/lgtm` stack and open Grafana.
- Confirm the dashboard imports without JSON/provisioning errors.
- Confirm Prometheus-backed panels populate within ~10 seconds after sample traffic.

## Task 6: Provision the usage dashboard in LGTM sample

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- `samples/lgtm/compose.yaml` mounts `dashboard-usage.json` read-only into the container.
- `samples/lgtm/grafana-dashboards.yaml` provisions the new dashboard alongside the existing dashboard, not instead of it.
- Existing `samples/lgtm/dashboard.json` remains available.

### Verification

- Run `docker compose -f samples/lgtm/compose.yaml up`.
- Confirm Grafana lists both dashboards after startup.

## Checkpoint 4: End-to-end validation

Use real Pi traffic to verify the complete metrics-to-dashboard-to-trace-drilldown path.

## Task 7: Validate dashboard behavior end to end

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- A live LGTM stack receives traces and metrics from pi-otel with `signals.metrics` and `signals.traces` enabled.
- Sample traffic includes multiple conversations, tool calls, and one forced tool error.
- Token/cost stat cards and model breakdowns populate.
- Highest-token conversations table shows one row per recent conversation with LLM usage.
- Clicking a conversation id opens Tempo Explore filtered by that conversation id and exposes the trace timeline.

### Verification

- Record the exact PromQL/TraceQL spot checks used.
- Capture any Tempo TraceQL grammar fallback needed for the shipped `grafana/otel-lgtm` version.
- Run final `npm run typecheck`.
