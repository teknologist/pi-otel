/**
 * GenAI client histograms — sigil-aligned per OTel semconv. Lazy so this
 * module is safe to import when metrics are disabled (global MeterProvider
 * is then no-op).
 */

import { metrics, type Histogram, type MetricOptions } from "@opentelemetry/api";

const METER_NAME = "pi-otel";
const METER_VERSION = "0.1.0";

const cache = new Map<string, Histogram>();

function getHistogram(name: string, opts: MetricOptions): Histogram {
  let h = cache.get(name);
  if (!h) {
    h = metrics.getMeter(METER_NAME, METER_VERSION).createHistogram(name, opts);
    cache.set(name, h);
  }
  return h;
}

export const getDurationHistogram = () =>
  getHistogram("gen_ai.client.operation.duration", {
    description: "Duration of GenAI client operations",
    unit: "s",
  });

export const getTokenHistogram = () =>
  getHistogram("gen_ai.client.token.usage", {
    description: "Number of tokens used in GenAI client operations",
    unit: "{token}",
  });

export const getToolCallsHistogram = () =>
  getHistogram("gen_ai.client.tool_calls_per_operation", {
    description: "Number of tool calls per GenAI client operation",
    unit: "{call}",
  });

export function resetMetricHandles(): void {
  cache.clear();
}
