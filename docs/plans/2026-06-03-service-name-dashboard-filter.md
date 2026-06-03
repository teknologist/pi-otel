# Plan: `service_name` filter dropdown on the usage dashboard

Dashboard: `samples/lgtm/dashboard-usage.json` (uid `pi-otel-usage`, "pi-otel Usage & Cost").
Related: `docs/plans/2026-05-18-provider-agent-labels.md`, `docs/plans/2026-05-18-sigil-dashboard.md`, `docs/specs/sigil-dashboard.md`.

## Problem

The usage dashboard has cascading filters **Agent → Provider → Model**
(`$agent`, `$provider`, `$model`) but **no `service_name` filter**. That is the
one dimension a viewer actually needs to separate distinct pi-consuming
services, and it is missing.

The existing `$agent` variable filters on `gen_ai_agent_name`, which the v1
contract pins to the constant `"pi"` for **all** telemetry this extension emits
(`docs/plans/2026-05-18-provider-agent-labels.md`: *"`gen_ai.agent.name` is never
derived from `service.name`"*; `src/spans.ts` `commonAttrs()` sets
`[ATTR_AGENT_NAME]: GEN_AI_SYSTEM_PI`). So `$agent` collapses every consumer
into a single `pi` value and cannot tell, say, an embedding application's usage
apart from an interactive session.

The dimension that *does* separate consumers is the OTel resource
`service.name` → Prometheus label `service_name`, set per-consumer from
`cfg.serviceName` (`src/otel/sdk.ts:111`, `[ATTR_SERVICE_NAME]: cfg.serviceName`).
`service_name` is present on every emitted series (it is a resource attribute),
so a `label_values(..., service_name)` variable will always populate.

Representative shapes observed in Prometheus (all under one `service_name`,
indistinguishable on the current dashboard):

```text
gen_ai_client_token_usage_sum{service_name="pi",                gen_ai_agent_name="pi", gen_ai_response_model="gpt-5.5", gen_ai_token_type="input"}
gen_ai_client_token_usage_sum{service_name="auto-review-agent", gen_ai_agent_name="pi", gen_ai_response_model="gpt-5.5", gen_ai_token_type="input"}
```

Both rows share `gen_ai_agent_name="pi"` → the `$agent` dropdown shows one entry
(`pi`) and the two services' cost/tokens are summed together with no way to
split them. Filtering by `service_name` is the fix.

**Goal:** add a `$service` template variable (multi-select, includes All) as the
**first** link in the cascade (service → agent → provider → model) and thread
`service_name=~"$service"` through every variable query, PromQL panel, and the
Tempo panel. Default `All` so existing dashboard behavior is unchanged when the
filter is untouched.

## Dependency graph

- `src/otel/sdk.ts` sets the resource `service.name` from `cfg.serviceName`; this
  is the source of the `service_name` Prometheus label the new variable reads.
  (No code change — documents where the label originates.)
- `samples/lgtm/dashboard-usage.json` owns the `templating.list` variables and
  the 15 panels' PromQL/TraceQL targets — the file this plan edits.
- `samples/lgtm/grafana-dashboards.yaml` + `samples/lgtm/compose.yaml` provision
  and mount the dashboard (no change; used for end-to-end verification).
- `samples/lgtm/verify-dashboard.mjs` asserts dashboard invariants — extend it to
  cover the new variable and the threaded label matcher.
- `docs/specs/sigil-dashboard.md` is the dashboard spec — update the variable and
  query-filter contract to include `$service`.

## Checkpoint 1: Variable contract ready

Confirm `service_name` is a stable, always-present label on the metrics the
dashboard queries before wiring a variable to it.

## Task 1: Add the `$service` template variable

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- `samples/lgtm/dashboard-usage.json` `templating.list` gains a `service`
  variable, ordered **before** `agent` (so the cascade reads service → agent →
  provider → model) and after the `prom_ds`/`tempo_ds` datasource variables.
- The variable mirrors `$agent`'s shape: `type: "query"`, `label: "Service"`,
  `multi: true`, `includeAll: true`, `allValue: ".*"`, `refresh: 1`, `sort: 1`,
  datasource `{ "type": "prometheus", "uid": "$prom_ds" }`.
- Query: `label_values(gen_ai_client_token_usage_count, service_name)`.
- Default `current` is **All** (`{"text":"All","value":"$__all","selected":true}`)
  so untouched dashboards behave exactly as before.

### Verification

- `node samples/lgtm/verify-dashboard.mjs` passes.
- In Grafana, the **Service** dropdown lists every distinct `service_name`
  (e.g. `pi`, `auto-review-agent`) and defaults to `All`.

## Task 2: Cascade the existing variables off `$service`

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- The `agent` variable query is scoped:
  `label_values(gen_ai_client_token_usage_count{service_name=~"$service"}, gen_ai_agent_name)`.
- The `provider` variable query adds the same matcher alongside the existing
  `gen_ai_agent_name=~"$agent"`.
- The `model` variable query adds the same matcher alongside the existing
  `gen_ai_agent_name`/`gen_ai_provider_name` matchers.
- Selecting a single service narrows the Agent/Provider/Model dropdowns to that
  service's label values; `All` reproduces today's lists.

### Verification

- `node samples/lgtm/verify-dashboard.mjs` passes.
- In Grafana, pick one `service_name` and confirm the downstream dropdowns
  repopulate; reset to `All` and confirm they return to the full set.

## Checkpoint 2: Panels honor the filter

All metric panels must respect `$service` so the stat cards and breakdowns
reflect the selected service(s).

## Task 3: Thread `service_name=~"$service"` into every PromQL panel

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- Every PromQL target in panels **#1–#14** gains a `service_name=~"$service"`
  matcher inside each metric selector, alongside the existing
  `gen_ai_agent_name=~"$agent"` etc. This includes:
  - #1 Total / #2 Input / #3 Output Tokens, #4 Cache Hit Rate, #5 Estimated Cost.
  - #6 Avg Cost / Interaction — add the matcher to **both** the
    `pi_cost_usd_total` and `pi_interactions_total` selectors (it currently
    filters by `$agent` only).
  - #7/#8 Tokens by type, #9–#12 token/cost by model (add the matcher to **both**
    `label_replace` legs of each query), #13/#14 tool-call panels (add alongside
    the existing `gen_ai_operation_name="execute_tool"` matcher).
- No panel drops or renames an existing label matcher; the change is purely
  additive.
- With `$service = All` (`.*`) every panel returns identical values to before
  this change.

### Verification

- `node samples/lgtm/verify-dashboard.mjs` passes (extend it per Task 5 to assert
  no #1–#14 PromQL target is missing `service_name=~"$service"`).
- Spot-check `grep -c 'service_name=~\"$service\"'` against the count of PromQL
  targets in #1–#14.
- In Grafana with two services emitting, confirm a single-service selection shows
  strictly less-or-equal cost/tokens than `All`, and that two distinct services
  sum to the `All` total.

## Task 4: Filter the Tempo "Highest token usage conversations" panel

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- Panel **#15** (`type: table`, Tempo, `queryType: traceql`) constrains by service
  via `resource.service.name`, e.g.
  `{ name = "pi.llm_request" && resource.service.name =~ "$service" } | sum_over_time(span.gen_ai.usage.input_tokens) by (span.gen_ai.conversation.id)`.
- The `conversation_id` → Tempo Explore data link continues to work.
- If the shipped `grafana/otel-lgtm` Tempo build rejects the `=~` regex or
  `resource.service.name` in this position, document the working grammar fallback
  inline in the panel and in the spec (mirrors the TraceQL fallback note in
  `docs/plans/2026-05-18-sigil-dashboard.md` Task 7).

### Verification

- Open the panel with `$service` set to a single service; confirm rows are
  limited to that service's conversations.
- Record the exact TraceQL used (and any fallback) in the spec.

## Checkpoint 3: Contract + guard updated

Lock the new contract into the spec and the verify script so it cannot silently
regress.

## Task 5: Update spec and `verify-dashboard.mjs`

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- `docs/specs/sigil-dashboard.md` documents the `$service` variable, its place at
  the head of the cascade, the `All` default, and the rule that PromQL panels
  carry `service_name=~"$service"` and the Tempo panel carries
  `resource.service.name =~ "$service"`.
- `samples/lgtm/verify-dashboard.mjs` asserts: (a) a `service` variable exists
  with the expected query and ordering before `agent`; (b) every #1–#14 PromQL
  target contains `service_name=~"$service"`; (c) panel #15's TraceQL references
  `resource.service.name`.

### Verification

- `node samples/lgtm/verify-dashboard.mjs` passes on the edited dashboard and
  **fails** on a deliberately reverted copy (confirm the guard bites).
- `npm run typecheck` (if the verify script is TS-checked in CI).

## Checkpoint 4: End-to-end validation

Prove the filter against real traffic from more than one service.

## Task 6: Validate with two distinct `service_name`s

- [ ] Implemented
- [ ] Verified
- [ ] Reviewed

### Acceptance criteria

- A live `samples/lgtm` stack receives pi-otel metrics from **two** services with
  different `cfg.serviceName` (e.g. `pi` and `auto-review-agent`).
- The **Service** dropdown lists both; selecting each shows only that service's
  cost/tokens/tool calls; `All` shows the combined totals.
- Switching Service repopulates Agent/Provider/Model correctly.

### Verification

- Record the exact PromQL spot checks, e.g.
  `sum(increase(pi_cost_usd_total{service_name="auto-review-agent"}[$__range]))`
  vs the Estimated Cost stat card with `$service=auto-review-agent`.
- Confirm the dashboard imports without JSON/provisioning errors
  (`docker compose -f samples/lgtm/compose.yaml up`, both dashboards listed).
