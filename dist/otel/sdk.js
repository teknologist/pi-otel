/**
 * OTel SDK bootstrap. One global SDK per process — pi loads us per session
 * but the SDK is shared across sessions in the same process.
 */
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { diag, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter as LogGrpcExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as LogHttpExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as LogProtoExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as MetricGrpcExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as MetricHttpExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as MetricProtoExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME, } from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_PI_CWD } from "../attrs.js";
import { buildBridgeDiagLogger, resetLogHandles } from "./logs.js";
import { resetMetricHandles } from "./metrics.js";
let sdk = null;
let initOnce = false;
export function probeTcp(host, port, timeoutMs = 300) {
    return new Promise((resolve) => {
        const sock = createConnection({ port, host });
        const done = (ok) => {
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs);
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false));
        sock.once("error", () => done(false));
    });
}
// Used at session_start to avoid wiring exporters at a dead endpoint —
// otherwise the metric reader / log processor begin retrying immediately and
// those failures get buffered and flushed once the endpoint comes online.
export function probeEndpoint(endpoint, timeoutMs = 300) {
    let u;
    try {
        u = new URL(endpoint);
    }
    catch {
        return Promise.resolve(false);
    }
    // OTLP endpoints always carry an explicit port; refuse to fall back to
    // 80/443, which could silently green-light an unrelated service.
    if (!u.port)
        return Promise.resolve(false);
    return probeTcp(u.hostname || "127.0.0.1", Number(u.port), timeoutMs);
}
function pickByProtocol(cfg, ctors) {
    const opts = { url: cfg.endpoint, headers: cfg.headers };
    if (cfg.protocol === "http/protobuf")
        return new ctors.proto(opts);
    if (cfg.protocol === "http/json")
        return new ctors.http(opts);
    return new ctors.grpc(opts);
}
export function initSdk(cfg, notify, opts = {}) {
    if (!cfg.enabled || !cfg.signals.traces)
        return null;
    if (initOnce)
        return sdk;
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
    const sampler = cfg.sampleRatio < 1.0
        ? new ParentBasedSampler({
            root: new TraceIdRatioBasedSampler(cfg.sampleRatio),
        })
        : undefined;
    const sdkOpts = {
        resource,
        spanProcessor,
        ...(sampler ? { sampler } : {}),
    };
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
    sdk = new NodeSDK(sdkOpts);
    try {
        sdk.start();
    }
    catch (err) {
        const e = err;
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
    if (!opts.silentSuccess) {
        notify?.(`pi-otel: OTLP wired to ${cfg.endpoint} (${cfg.protocol})`, "info");
    }
    return sdk;
}
export async function shutdownSdk() {
    if (!sdk)
        return;
    try {
        await sdk.shutdown();
    }
    catch {
        // swallow — silent-drop policy (SPEC §7)
    }
    finally {
        // Reset state first so a subsequent initSdk() can proceed even if the
        // cleanup calls below throw. The global Tracer/Logger/Meter APIs refuse
        // to replace an already-registered provider — without disabling all
        // three, a re-init silently keeps the dead providers.
        sdk = null;
        initOnce = false;
        trace.disable();
        metrics.disable();
        logs.disable();
        diag.disable();
        resetMetricHandles();
        resetLogHandles();
    }
}
//# sourceMappingURL=sdk.js.map