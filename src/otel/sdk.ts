/**
 * OTel SDK bootstrap. One global SDK per process — pi loads us per session
 * but the SDK is shared across sessions in the same process.
 */

import { randomBytes } from "node:crypto";
import { diag, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { buildBridgeDiagLogger } from "./logs.js";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_INSTANCE_ID,
} from "@opentelemetry/semantic-conventions/incubating";
import { OTLPTraceExporter as GrpcExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPTraceExporter as HttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter as MetricGrpcExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as MetricProtoExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPMetricExporter as MetricHttpExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter as LogGrpcExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as LogProtoExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPLogExporter as LogHttpExporter } from "@opentelemetry/exporter-logs-otlp-http";
import type { OtelConfig } from "../config.js";
import { ATTR_PI_CWD } from "../attrs.js";
import { resetMetricHandles } from "./metrics.js";
import { resetLogHandles } from "./logs.js";

export type NotifySeverity = "info" | "warning" | "error";
export type Notify = (msg: string, severity?: NotifySeverity) => void;

let sdk: NodeSDK | null = null;
let initOnce = false;

type ExporterCtor<T> = new (opts: { url: string; headers: Record<string, string> }) => T;

function pickByProtocol<T>(
  cfg: OtelConfig,
  ctors: { grpc: ExporterCtor<T>; proto: ExporterCtor<T>; http: ExporterCtor<T> },
): T {
  const opts = { url: cfg.endpoint, headers: cfg.headers };
  if (cfg.protocol === "http/protobuf") return new ctors.proto(opts);
  if (cfg.protocol === "http/json") return new ctors.http(opts);
  return new ctors.grpc(opts);
}

export function initSdk(cfg: OtelConfig, notify?: Notify): NodeSDK | null {
  if (!cfg.enabled || !cfg.signals.traces) return null;
  if (initOnce) return sdk;
  initOnce = true;

  const instanceId = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const resource = new Resource({
    ...cfg.resourceAttributes,
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_INSTANCE_ID]: instanceId,
    [ATTR_PI_CWD]: cfg.cwd,
  });

  const traceExporter = pickByProtocol(cfg, {
    grpc: GrpcExporter,
    proto: ProtoExporter,
    http: HttpExporter,
  });
  const spanProcessor = new BatchSpanProcessor(traceExporter);

  const sdkOpts: Record<string, unknown> = { resource, spanProcessor };
  if (cfg.signals.metrics) {
    const metricExporter = pickByProtocol(cfg, {
      grpc: MetricGrpcExporter,
      proto: MetricProtoExporter,
      http: MetricHttpExporter,
    });
    sdkOpts.metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 10_000,
    });
  }
  if (cfg.signals.logs) {
    const logExporter = pickByProtocol(cfg, {
      grpc: LogGrpcExporter,
      proto: LogProtoExporter,
      http: LogHttpExporter,
    });
    sdkOpts.logRecordProcessors = [new BatchLogRecordProcessor(logExporter)];
  }

  sdk = new NodeSDK(sdkOpts as ConstructorParameters<typeof NodeSDK>[0]);

  try {
    sdk.start();
  } catch (err) {
    const e = err as Error;
    notify?.(`pi-otel: SDK start failed — ${e.message}`, "error");
    sdk = null;
    initOnce = false;
    return null;
  }

  // Install bridge AFTER sdk.start() — LoggerProvider must exist first.
  if (cfg.signals.logs) {
    diag.setLogger(buildBridgeDiagLogger(), {
      logLevel: cfg.logLevel,
      suppressOverrideMessage: true,
    });
  }

  notify?.(`pi-otel: OTLP wired to ${cfg.endpoint} (${cfg.protocol})`, "info");
  return sdk;
}

export async function shutdownSdk(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // swallow — silent-drop policy (SPEC §7)
  } finally {
    // NodeSDK.start() registers a global TracerProvider; the global API
    // refuses to replace an already-registered provider, so a subsequent
    // initSdk() would silently keep the shut-down one and tracers would
    // emit into the void. Unregister explicitly before re-init.
    trace.disable();
    diag.disable();
    resetMetricHandles();
    resetLogHandles();
    sdk = null;
    initOnce = false;
  }
}
