/**
 * GenAI client histograms — sigil-aligned per OTel semconv. Lazy so this
 * module is safe to import when metrics are disabled (global MeterProvider
 * is then no-op).
 */
import { type Counter, type Histogram } from "@opentelemetry/api";
export declare const getDurationHistogram: () => Histogram<import("@opentelemetry/api").Attributes>;
export declare const getTokenHistogram: () => Histogram<import("@opentelemetry/api").Attributes>;
export declare const getToolCallsHistogram: () => Histogram<import("@opentelemetry/api").Attributes>;
export declare const getCostCounter: () => Counter<import("@opentelemetry/api").Attributes>;
export declare const getInteractionsCounter: () => Counter<import("@opentelemetry/api").Attributes>;
export declare function resetMetricHandles(): void;
