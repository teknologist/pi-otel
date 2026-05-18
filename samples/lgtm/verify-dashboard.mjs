#!/usr/bin/env node
import { trace } from "@opentelemetry/api";
import {
  ATTR_INPUT_TOKENS,
  ATTR_OUTPUT_TOKENS,
  ATTR_PI_COST_USD,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_MODEL,
} from "../../dist/attrs.js";
import { initSdk, shutdownSdk } from "../../dist/otel/sdk.js";
import { SpanTracker } from "../../dist/spans.js";

const grafanaUrl = process.env.GRAFANA_URL ?? "http://localhost:3000";
const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4317";
const serviceName = `pi-otel-dashboard-e2e-${Date.now()}`;
const provider = "dashboard-e2e-provider";
const model = "dashboard-e2e-model";
const started = Math.floor(Date.now() / 1000) - 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, params = {}) {
  const u = new URL(url, grafanaUrl);
  for (const [key, value] of Object.entries(params))
    u.searchParams.set(key, value);
  const res = await fetch(u);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return JSON.parse(text);
}

async function queryPrometheus(query) {
  return getJson("/api/datasources/proxy/uid/prometheus/api/v1/query", {
    query,
  });
}

async function queryTempoSearch(query, limit = "20") {
  return getJson("/api/datasources/proxy/uid/tempo/api/search", {
    q: query,
    limit,
  });
}

async function queryTempoMetrics(query) {
  const end = Math.floor(Date.now() / 1000) + 60;
  return getJson("/api/datasources/proxy/uid/tempo/api/metrics/query_range", {
    q: query,
    start: String(started),
    end: String(end),
    step: "30s",
  });
}

function metricValue(prometheusResponse) {
  return Number(prometheusResponse.data?.result?.[0]?.value?.[1] ?? 0);
}

function emitConversation(
  tracer,
  id,
  { inputTokens, outputTokens, costUsd, failedTool = false },
) {
  const conversationId = `${serviceName}-conversation-${id}`;
  const tracker = new SpanTracker({
    tracer,
    captureContent: "metadata_only",
    cwd: process.cwd(),
    sessionId: () => conversationId,
  });

  tracker.startInteraction(`dashboard e2e ${id}`);
  tracker.startTurn(0);
  tracker.startLlmRequest(model);
  tracker.setLlmAttrs({
    [ATTR_PROVIDER_NAME]: provider,
    [ATTR_REQUEST_MODEL]: model,
    [ATTR_RESPONSE_MODEL]: model,
    [ATTR_INPUT_TOKENS]: inputTokens,
    [ATTR_OUTPUT_TOKENS]: outputTokens,
    [ATTR_PI_COST_USD]: costUsd,
  });
  tracker.endLlmRequest();

  tracker.startTool(`tool-${id}-ok`, "dashboard_e2e_tool", { id });
  tracker.endTool(`tool-${id}-ok`, { isError: false, result: "ok" });
  if (failedTool) {
    tracker.startTool(`tool-${id}-error`, "dashboard_e2e_tool", {
      id,
      fail: true,
    });
    tracker.endTool(`tool-${id}-error`, {
      isError: true,
      result: "forced dashboard e2e error",
    });
  }

  tracker.endTurn();
  tracker.endInteraction();
  return conversationId;
}

async function main() {
  await getJson("/api/health");

  initSdk({
    enabled: true,
    endpoint: otlpEndpoint,
    protocol: "grpc",
    headers: {},
    serviceName,
    captureContent: "metadata_only",
    sampleRatio: 1,
    signals: { traces: true, metrics: true, logs: false },
    resourceAttributes: {},
    logLevel: 30,
    cwd: process.cwd(),
  });

  const tracer = trace.getTracer("pi-otel-dashboard-e2e", "0.1.0");
  const conversations = [
    emitConversation(tracer, 1, {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.1,
      failedTool: true,
    }),
  ];
  await sleep(11_000);
  conversations.push(
    emitConversation(tracer, 2, {
      inputTokens: 150,
      outputTokens: 75,
      costUsd: 0.15,
      failedTool: true,
    }),
    emitConversation(tracer, 3, {
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.2,
    }),
  );
  await sleep(11_000);
  await shutdownSdk();

  const filter = `service_name="${serviceName}", gen_ai_agent_name=~"pi", gen_ai_provider_name=~"${provider}", gen_ai_response_model=~"${model}"`;
  const promql = {
    totalTokens: `sum(increase(gen_ai_client_token_usage_sum{${filter}}[5m]))`,
    inputTokens: `sum(increase(gen_ai_client_token_usage_sum{${filter}, gen_ai_token_type="input"}[5m]))`,
    outputTokens: `sum(increase(gen_ai_client_token_usage_sum{${filter}, gen_ai_token_type="output"}[5m]))`,
    cost: `sum(increase(pi_cost_usd_total{${filter}}[5m]))`,
    modelBreakdown: `sum(increase(gen_ai_client_token_usage_sum{${filter}}[5m])) by (gen_ai_response_model)`,
    toolCalls: `sum(increase(gen_ai_client_operation_duration_seconds_count{service_name="${serviceName}", gen_ai_agent_name=~"pi", gen_ai_operation_name="execute_tool", gen_ai_tool_name="dashboard_e2e_tool"}[5m])) by (gen_ai_tool_name)`,
    toolErrors: `sum(increase(gen_ai_client_operation_duration_seconds_count{service_name="${serviceName}", gen_ai_agent_name=~"pi", gen_ai_operation_name="execute_tool", gen_ai_tool_name="dashboard_e2e_tool", error_type="tool_error"}[5m])) by (gen_ai_tool_name)`,
  };

  const checks = {};
  for (const [name, query] of Object.entries(promql)) {
    const result = await queryPrometheus(query);
    checks[name] = {
      query,
      resultCount: result.data?.result?.length ?? 0,
      value: metricValue(result),
    };
  }

  const unsupportedDashboardTraceql =
    '{ name = "pi.llm_request" } | by(span.gen_ai.conversation.id) | aggregate(total_tokens = sum_over_time(span.gen_ai.usage.input_tokens + span.gen_ai.usage.output_tokens), llm_calls = count_over_time())';
  const fallbackTraceql =
    '{ name = "pi.llm_request" } | sum_over_time(span.gen_ai.usage.input_tokens) by (span.gen_ai.conversation.id)';
  const llmCallsTraceql =
    '{ name = "pi.llm_request" } | count_over_time() by (span.gen_ai.conversation.id)';
  const tempoFallback = await queryTempoMetrics(fallbackTraceql);
  const tempoCalls = await queryTempoMetrics(llmCallsTraceql);
  const exploreFilterTraceql = `{ span.gen_ai.conversation.id = "${conversations[1]}" }`;
  const exploreFilter = await queryTempoSearch(exploreFilterTraceql, "5");

  const dashboardSearch = await getJson("/api/search", { type: "dash-db" });
  const dashboardTitles = dashboardSearch.map((item) => item.title).sort();

  const failures = [];
  if (
    !dashboardTitles.includes("pi-otel") ||
    !dashboardTitles.includes("pi-otel Usage & Cost")
  )
    failures.push("Grafana did not list both dashboards");
  for (const [name, check] of Object.entries(checks)) {
    if (check.resultCount < 1 || !(check.value > 0))
      failures.push(`PromQL check ${name} returned no positive data`);
  }
  if ((tempoFallback.series?.length ?? 0) < 2)
    failures.push("TraceQL fallback did not return multiple conversations");
  if ((tempoCalls.series?.length ?? 0) < 2)
    failures.push(
      "TraceQL call-count fallback did not return multiple conversations",
    );
  if ((exploreFilter.traces?.length ?? 0) < 1)
    failures.push("Tempo Explore conversation-id filter returned no traces");

  const report = {
    serviceName,
    conversations,
    dashboards: dashboardTitles,
    promql,
    traceql: {
      unsupportedDashboardTraceql,
      fallbackTraceql,
      llmCallsTraceql,
      exploreFilterTraceql,
      fallbackSeries: tempoFallback.series?.length ?? 0,
      llmCallSeries: tempoCalls.series?.length ?? 0,
      exploreFilterTraces: exploreFilter.traces?.length ?? 0,
    },
    checks,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(failures.join("; "));
}

main().catch(async (err) => {
  try {
    await shutdownSdk();
  } catch {}
  console.error(err);
  process.exitCode = 1;
});
