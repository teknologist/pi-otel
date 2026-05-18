# Spec: Sigil-style Grafana dashboard for pi-otel

**Status:** Proposed
**Author:** pi-otel maintainers
**Target:** stock Grafana (no custom plugin) shipped in the `grafana/otel-lgtm` image, fed by Prometheus (metrics) and Tempo (traces) over OTLP.

## 1. Goal

Reproduce the Usage / Cost views of [`grafana-sigil-app`](https://teknologista.grafana.net/a/grafana-sigil-app/analytics) — token totals, token-by-type breakdown, cost over time, top conversations — as a stock Grafana dashboard distributed alongside the `samples/lgtm/` stack. Per-conversation drill-down is delivered via a Tempo Explore deep-link from the "Highest token usage conversations" table, not a custom UI.

## 2. Non-goals

- **Conversation thread UI** (Sigil's `/conversations/<id>/explore` chat view). Stock Grafana panels cannot render a chat thread; we expose the same data via Tempo's built-in trace timeline reached through a per-row data link. A custom Grafana app plugin is a separate, much larger project.
- **AI analysis panels** (Sigil's "✨ AI analysis" blocks). Out of scope; the dashboard reserves a markdown panel slot that an operator can wire to their own LLM-summary tool later.
- **Evaluation tab**. pi-otel does not emit eval signals today.

## 3. pi-otel instrumentation changes

The current official metrics (`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, and `gen_ai.client.tool_calls_per_operation`) cover most of the Usage tab. v1 should stay aligned with official OTel GenAI / ECS field names where they exist. Cost and interaction counting are the v1 exceptions: OpenTelemetry does not currently define an official GenAI cost metric or a pi-specific interaction metric, and the dashboard needs reliable PromQL-backed cost panels, so pi-otel exposes pi-owned custom metrics for both.

| Gap | Cause | Resolution |
| --- | --- | --- |
| Per-agent split | This extension represents the Pi agent, while other clients may write to the same OTel sink with their own agent names | Set `gen_ai.agent.name = "pi"` for pi-otel metrics; never use `service.name` / `cfg.serviceName` as the agent name |
| Cost panels | OTel has no official GenAI cost metric, and span-only cost is not reliable enough for stock Grafana dashboard panels | Add pi-owned custom counter `pi.cost.usd`; document it as pi-otel-specific and migrate if OTel standardizes cost later |
| Avg cost / interaction | Cross-datasource arithmetic between Prometheus cost and Tempo interaction counts is brittle | Add pi-owned custom counter `pi.interactions`, incremented once per **Interaction** |
| Errors column / Errors tab | Errors are not available as a dedicated counter | Use official `error.type` on operation-duration metric records and/or span status in TraceQL; do not add `gen_ai.client.errors` |
| Tool calls | Existing `gen_ai.client.tool.calls` is nonstandard, but tool visibility by turn/session is still required | Remove the nonstandard counter; use `gen_ai.client.operation.duration` counts for aggregate tool panels and `pi.tool.<name>` spans for turn/session drilldown |
| LLM calls | Histogram count is available but less convenient in table joins | Prefer official operation-duration counts and TraceQL span counts; do not add a custom LLM calls counter unless an official semantic-convention counter appears |

### 3.1 Metric attribute discipline

All metric writes include stable low-cardinality attributes for the operation. For provider/model labels used by dashboard filters, use `unknown` fallback values when Pi cannot provide a value, so PromQL selectors do not silently drop datapoints. Attributes include:

- `gen_ai.system = "pi"`
- `gen_ai.operation.name`
- `gen_ai.provider.name` and `gen_ai.request.model` / `gen_ai.response.model`, using `unknown` fallback values when needed
- `gen_ai.token.type` for token metrics
- `gen_ai.tool.name` for tool execution metrics
- `error.type` on failed operation-duration records

`gen_ai.agent.name` is always set to `pi` by this extension. This identifies the top-level Pi **Agent** in shared OTel sinks where other clients may publish their own agent names. It must not be synthesized from `service.name`, `cfg.serviceName`, or the pi-otel process name.

### 3.2 LLM operation metrics

`recordLlmMetrics()` is updated only where needed to keep official attributes consistent:

- Duration / token / tool-call histograms include `gen_ai.agent.name = "pi"`.
- Failed model requests record `error.type` on `gen_ai.client.operation.duration`.
- Cost remains on spans as `pi.cost.usd` and is also recorded to the pi-owned `pi.cost.usd` metric for dashboard use.

### 3.3 Tool operation metrics

`endTool()` records official operation-duration metrics for tool executions:

- `gen_ai.operation.name = "execute_tool"`
- `gen_ai.tool.name = <tool name>`
- `error.type = <error type>` when the tool failed

Remove the nonstandard `gen_ai.client.tool.calls` counter. Aggregate dashboard panels use the Prometheus histogram count for `gen_ai.client.operation.duration{gen_ai_operation_name="execute_tool"}`. Per-turn/session tool visibility comes from Tempo queries over `pi.tool.<name>` spans.

### 3.4 Custom dashboard metrics

Add a pi-owned custom counter named `pi.cost.usd` for dashboard use. It exports to Prometheus as `pi_cost_usd_total`. Use lowercase `usd` for the OTel unit: it still denotes USD currency, and prevents the Prometheus exporter from appending a second uppercase unit suffix such as `_USD_total`.

```ts
export const getCostCounter = () =>
  getCounter("pi.cost.usd", {
    description: "Estimated cost observed by pi-otel in USD",
    unit: "usd",
  });
```

Record it once at `endLlmRequest`, after the final usage/cost is known, when a finite `pi.cost.usd` value is available from Pi usage data. If cost is missing or non-finite, skip the metric datapoint rather than emitting zero. Include low-cardinality attributes already used by official GenAI metrics. For `pi.cost.usd`, always set `gen_ai.provider.name` and `gen_ai.response.model`, using `unknown` when Pi cannot provide a value, so Grafana filters do not silently drop valid cost datapoints. Cost is total-only in v1: do not add `gen_ai.token.type` to `pi.cost.usd`, even if a provider exposes per-token-type costs.

Add a second pi-owned custom counter named `pi.interactions`. It exports to Prometheus as `pi_interactions_total`.

```ts
export const getInteractionsCounter = () =>
  getCounter("pi.interactions", {
    description: "Total number of pi interactions observed by pi-otel",
    unit: "{interaction}",
  });
```

Increment `pi.interactions` once per root `pi.interaction`. Include `gen_ai.agent.name` so shared sinks can compute per-agent averages. This is intentionally **Interaction**-scoped, not **Conversation**-scoped. Do not call it `gen_ai.client.conversations`.

Do not add fake official metrics such as `gen_ai.client.cost.usd`, `gen_ai.client.conversations`, `gen_ai.client.errors`, or `gen_ai.client.llm.calls` for v1. If a future OTel semantic convention standardizes equivalent cost or interaction metrics, migrate the dashboard and keep pi-owned metrics only through a documented compatibility window if needed.

## 4. Dashboard layout

File: `samples/lgtm/dashboard-usage.json`, provisioned alongside the existing `dashboard.json` via `samples/lgtm/grafana-dashboards.yaml`.

### 4.1 Variables

| Name | Type | Query / Source | Notes |
| --- | --- | --- | --- |
| `$agent` | Query (Prom) | `label_values(gen_ai_client_token_usage_count, gen_ai_agent_name)` | Multi-select with All available; default selection `pi`; pi-otel emits `pi`, other clients may emit other values |
| `$provider` | Query (Prom) | `label_values(gen_ai_client_token_usage_count{gen_ai_agent_name=~"$agent"}, gen_ai_provider_name)` | Multi-select; default All; model provider, not Pi runtime |
| `$model` | Query (Prom) | `label_values(gen_ai_client_token_usage_count{gen_ai_agent_name=~"$agent", gen_ai_provider_name=~"$provider"}, gen_ai_response_model)` | Multi-select; default All; primary reliable v1 filter |
| `$tempo_ds` | Datasource (Tempo) | constant | Used for data links |
| `$prom_ds` | Datasource (Prometheus) | constant | Default for all panels |

### 4.2 Stat row — "Tokens & Cost" (gridPos y=0, h=4)

| Panel | PromQL |
| --- | --- |
| **Total Tokens** | `sum(increase(gen_ai_client_token_usage_sum{gen_ai_agent_name=~"$agent", gen_ai_provider_name=~"$provider", gen_ai_response_model=~"$model"}[$__range]))` |
| **Input Tokens** | same with `gen_ai_token_type="input"` |
| **Output Tokens** | same with `gen_ai_token_type="output"` |
| **Cache Hit Rate** | `sum(increase(gen_ai_client_token_usage_sum{gen_ai_token_type="cache_read", …}[$__range])) / clamp_min(sum(increase(gen_ai_client_token_usage_sum{gen_ai_token_type=~"input\|cache_read", …}[$__range])), 1)` |
| **Estimated Cost** | `sum(increase(pi_cost_usd_total{gen_ai_agent_name=~"$agent", gen_ai_provider_name=~"$provider", gen_ai_response_model=~"$model"}[$__range]))` — unit USD |
| **Avg Cost / Interaction** | `sum(increase(pi_cost_usd_total{gen_ai_agent_name=~"$agent"}[$__range])) / clamp_min(sum(increase(pi_interactions_total{gen_ai_agent_name=~"$agent"}[$__range])), 1)` — scoped by `$agent`, intentionally not filtered by `$provider` or `$model` |

The "↑+xxxx%" delta badge from Sigil is achieved with stat-panel `reduceOptions.calcs = ["lastNotNull"]` plus a secondary query of `…offset $__range` for the comparison baseline, surfaced via a `Delta` panel transform.

### 4.3 Token series row

- **Tokens by type over time** — `timeseries`, `sum(increase(gen_ai_client_token_usage_sum{…}[$__rate_interval])) by (gen_ai_token_type)`, legend = `{{gen_ai_token_type}}`.
- **Tokens by type** — `bargauge`, `sum(increase(gen_ai_client_token_usage_sum{…}[$__range])) by (gen_ai_token_type)`, orientation=horizontal.
- **Tokens over time by model** — same as first but `by (gen_ai_response_model)`.
- **Tokens by model** — `stat`, `sum(increase(gen_ai_client_token_usage_sum{…}[$__range])) by (gen_ai_response_model)`.

Agent breakdown panels and the `$agent` filter use `gen_ai.agent.name`; for this extension the value is `pi`, while other clients writing to the same OTel sink may provide other values.

### 4.4 Cost row

Cost is metric-backed in v1 through the pi-owned `pi.cost.usd` counter.

- **Cost over time by model** — `timeseries`, `sum(increase(pi_cost_usd_total{gen_ai_agent_name=~"$agent", gen_ai_provider_name=~"$provider", gen_ai_response_model=~"$model"}[$__rate_interval])) by (gen_ai_response_model)`, unit USD.
- **Cost by model** — `stat`, `sum(increase(pi_cost_usd_total{gen_ai_agent_name=~"$agent", gen_ai_provider_name=~"$provider", gen_ai_response_model=~"$model"}[$__range])) by (gen_ai_response_model)`, unit USD.

### 4.5 Tool calls row

- **Tool calls over time** — `timeseries`, `sum(increase(gen_ai_client_operation_duration_count{gen_ai_agent_name=~"$agent", gen_ai_operation_name="execute_tool"}[$__rate_interval])) by (gen_ai_tool_name)`.
- **Tool calls by tool** — `bargauge`, `sum(increase(gen_ai_client_operation_duration_count{gen_ai_agent_name=~"$agent", gen_ai_operation_name="execute_tool"}[$__range])) by (gen_ai_tool_name)`.
- **Tool call drilldown** — no unscoped all-tools Explore link in v1; use the conversation table drilldown first, then inspect `pi.tool.*` spans within the selected conversation trace.

### 4.6 Highest token usage conversations table

**Datasource:** Tempo.

**Query (TraceQL metrics):**

```traceql
{ name = "pi.llm_request" }
  | by(span.gen_ai.conversation.id)
  | aggregate(
      total_tokens = sum_over_time(span.gen_ai.usage.input_tokens + span.gen_ai.usage.output_tokens),
      llm_calls    = count_over_time(),
      errors       = count_over_time({status=error}),
      last_seen    = max_over_time(end_time),
      models       = collect(span.gen_ai.response.model)
    )
```

The table starts from `pi.llm_request` because those spans carry token/model data. It intentionally includes only conversations with at least one LLM call; zero-LLM interactions are out of scope for a highest-token-usage table. `pi.interaction` remains the root span for interaction counting and drill-down context, not token aggregation.

Grafana renders this as a table; column order set via the **Organize fields** transform to: `conversation_id | total_tokens | llm_calls | models | errors | last_seen`.

> Note on TraceQL syntax: the exact aggregation grammar is still evolving in Tempo 2.x. If the multi-aggregate form above isn't supported by the deployed Tempo, fall back to separate panel queries joined via the **Merge** transform on `span.gen_ai.conversation.id`. The preferred `errors` value counts any `{status=error}` span in the **Conversation**, not only failed `pi.llm_request` spans; implement that as a separate all-span error query and merge it when the single-query form cannot express it.

**Data link** (per-row, opens Tempo Explore filtered by conversation id):

```
/explore?orgId=1&left={
  "datasource": "${tempo_ds}",
  "queries": [{
    "refId": "A",
    "queryType": "traceql",
    "query": "{ resource.gen_ai.conversation.id = \"${__data.fields.conversation_id}\" }"
  }],
  "range": { "from": "${__from}", "to": "${__to}" }
}
```

JSON-encoded into the `url` of a field-level data link on the `conversation_id` column. The drill-down lands in Grafana Explore showing the trace list; clicking a trace opens Tempo's timeline view, where pi-otel's `gen_ai.user.message` / `gen_ai.tool.message` / `gen_ai.assistant.message` span events render as the conversation thread. Not pretty, but functionally complete.

## 5. Configuration impact

None. The dashboard works with the existing `signals.metrics: true` + `signals.traces: true` configuration; the new instruments fire only when metrics are enabled.

## 6. Deliverables

| File | Change |
| --- | --- |
| `src/otel/metrics.ts` | Add pi-owned `pi.cost.usd` and `pi.interactions` counters; record official tool operation-duration metrics; do not add other custom dashboard counters |
| `src/attrs.ts` | Add only official/reused attribute constants needed for existing semantic-convention fields |
| `src/spans.ts` | Add official metric attributes consistently; keep cost span-side and record `pi.cost.usd`; increment `pi.interactions`; add `error.type` on failed operation-duration records |
| `src/index.ts` | Use fixed `gen_ai.agent.name = "pi"` for this extension; do not map `cfg.serviceName` to `gen_ai.agent.name` |
| `samples/lgtm/dashboard-usage.json` | New dashboard JSON |
| `samples/lgtm/grafana-dashboards.yaml` | Add second provider entry for the new dashboard file |
| `samples/lgtm/compose.yaml` | Mount `dashboard-usage.json` |
| `docs/specs/sigil-dashboard.md` | This document |

## 7. Verification

- `npm run typecheck` after instrumentation changes.
- Run pi against the LGTM stack; trigger several conversations with tool calls and a forced error (e.g. `/exec invalid-binary`).
- In Grafana, open the new dashboard, confirm:
  - Prometheus-backed token and cost stat cards populate within ~10 s.
  - "Highest token usage conversations" table shows one row per recent session.
  - Clicking a row lands in Tempo Explore with `resource.gen_ai.conversation.id = "<id>"` pre-filled.

## 8. Open questions

1. **Cost breakdown by token type.** v1 records only total `pi.cost.usd`. If providers expose reliable per-type cost later, consider a separate metric or explicit dashboard design that avoids double-counting totals.
2. **Sub-agent support.** `gen_ai.agent.name` is `pi` for this extension in v1. If Pi exposes sub-agent identity later, decide whether to replace or supplement the top-level `pi` value with that more specific identity.
3. **TraceQL aggregate grammar.** The single multi-aggregate query in §4.5 assumes Tempo ≥ 2.6. If `otel-lgtm` pins an older Tempo, fall back to the merged-queries variant noted inline.

## 9. Grill session decisions

- Use official OTel GenAI / ECS field names where they exist; do not invent new `gen_ai.*` names for dashboard convenience.
- **Conversation** means the long-lived Pi session/thread identified by `gen_ai.conversation.id`; **Interaction** means one user-prompt execution/root `pi.interaction`.
- `gen_ai.provider.name` means the model provider exposed by Pi for the model request, such as `openai`, `openai-codex`, or `anthropic`; it must not mean the Pi runtime.
- `gen_ai.agent.name` is `pi` for this extension, identifying the Pi agent in shared OTel sinks. Do not fall back to `cfg.serviceName`.
- OTel has no official GenAI cost metric today; v1 adds pi-owned custom counter `pi.cost.usd` for reliable Grafana dashboards. Do not call it `gen_ai.client.cost.usd`.
- V1 adds pi-owned custom counter `pi.interactions` so average cost per **Interaction** is pure PromQL. Do not call it `gen_ai.client.conversations`.
- `pi.interactions` includes `gen_ai.agent.name` so shared sinks can compute per-agent averages.
- Avg Cost / Interaction is scoped by `$agent`, but not provider/model-filtered, because one **Interaction** can use multiple providers/models.
- Conversation token aggregation starts from `pi.llm_request` spans because those spans carry token/model data; group them by **Conversation** id.
- Highest-token conversations table is LLM-only; zero-LLM interactions are omitted.
- Conversation table `errors` counts any error span in the **Conversation**, not only failed LLM requests.
- Errors remain trace/span-derived in v1; do not add a custom `pi.errors` counter.
- Cost panels in v1 are Prometheus-backed by `pi_cost_usd_total`, while traces keep the existing `pi.cost.usd` span attribute.
- `pi.cost.usd` is recorded once at LLM request end, after final usage/cost is known; do not emit per-chunk cost datapoints in v1.
- Missing cost means no `pi.cost.usd` datapoint; do not emit zero or estimate from a local pricing table in v1.
- `pi.cost.usd` is total-only in v1; do not label cost by `gen_ai.token.type`.
- `pi.cost.usd` always includes `gen_ai.provider.name` and `gen_ai.response.model`; use `unknown` fallback values when needed so dashboard filters do not drop valid cost.
- Official token/duration metrics also use `unknown` fallback values for provider/model labels so dashboard filters behave consistently.
- Errors should be represented through official `error.type` on `gen_ai.client.operation.duration` records and/or span status. Do not add `gen_ai.client.errors`.
- Remove the nonstandard `gen_ai.client.tool.calls` counter.
- Tool executions should record official `gen_ai.client.operation.duration` metrics with `gen_ai.operation.name = "execute_tool"`, `gen_ai.tool.name`, and `error.type` on failures.
- Tool-call visibility uses both views: Prometheus operation-duration counts for aggregate charts, Tempo `pi.tool.<name>` spans for scoped turn/session drilldown from a selected conversation. Do not add an unscoped all-tools Explore link in v1.
- V1 restores `$agent` using `gen_ai.agent.name` so shared OTel sinks can distinguish pi-otel (`pi`) from other GenAI clients.
- The provisioned dashboard defaults `$agent` to `pi`, with All/other values available for shared sinks.
- The provisioned dashboard defaults `$provider` and `$model` to All.
- V1 dashboard also includes `$provider` using `gen_ai.provider.name`; provider means model provider, not Pi runtime.
- `$model` remains the primary model-level filter, scoped by `$agent` and `$provider`.
- Add the usage dashboard alongside the existing sample dashboard; do not replace the current dashboard.
