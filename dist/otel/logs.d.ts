/**
 * LogRecord emission helpers + OTel diag→OTLP bridge.
 *
 * Pi-otel's OWN internal events do NOT use the global `diag` — they go
 * through the `notify` callback wired from index.ts (ctx.ui.notify), because
 * failing OTLP machinery cannot reliably report its own failures through
 * itself.
 */
import type { DiagLogger } from "@opentelemetry/api";
import { type LogAttributes, type Logger, SeverityNumber } from "@opentelemetry/api-logs";
export declare function getLogger(): Logger;
export declare function resetLogHandles(): void;
export declare function emitLifecycleLog(eventName: string, severity: SeverityNumber, body: string, attrs?: LogAttributes): void;
export declare function buildBridgeDiagLogger(): DiagLogger;
