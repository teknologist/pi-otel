/**
 * LogRecord emission helpers + OTel diag→OTLP bridge.
 *
 * Pi-otel's OWN internal events do NOT use the global `diag` — they go
 * through the `notify` callback wired from index.ts (ctx.ui.notify), because
 * failing OTLP machinery cannot reliably report its own failures through
 * itself.
 */

import type { DiagLogger } from "@opentelemetry/api";
import {
  logs,
  SeverityNumber,
  type Logger,
  type LogAttributes,
} from "@opentelemetry/api-logs";

const LOGGER_NAME = "pi-otel";
const LOGGER_VERSION = "0.1.0";
const BRIDGE_LOGGER_NAME = "@opentelemetry/diag";

let logger: Logger | null = null;
let bridgeLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!logger) {
    logger = logs.getLogger(LOGGER_NAME, LOGGER_VERSION);
  }
  return logger;
}

function getBridgeLogger(): Logger {
  if (!bridgeLogger) {
    bridgeLogger = logs.getLogger(BRIDGE_LOGGER_NAME, LOGGER_VERSION);
  }
  return bridgeLogger;
}

export function resetLogHandles(): void {
  logger = null;
  bridgeLogger = null;
}

function emitLogRecord(
  log: Logger,
  severity: SeverityNumber,
  body: string,
  attributes: LogAttributes,
): void {
  try {
    log.emit({
      severityNumber: severity,
      severityText: SeverityNumber[severity],
      body,
      attributes,
    });
  } catch {
    // best-effort
  }
}

export function emitLifecycleLog(
  eventName: string,
  severity: SeverityNumber,
  body: string,
  attrs: LogAttributes = {},
): void {
  emitLogRecord(getLogger(), severity, body, { "event.name": eventName, ...attrs });
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// Drop per-export ticks from the OTLP exporter delegate — they fire every
// batch interval and drown signal in Aspire Structured Logs.
const BRIDGE_DROP = /^(?:items to be sent|OTLPExportDelegate|Export\()/i;

function emitBridge(severity: SeverityNumber, message: string, args: unknown[]): void {
  if (BRIDGE_DROP.test(message)) return;
  const attributes: LogAttributes =
    args.length > 0 ? { "diag.args": args.map(stringifyArg) } : {};
  emitLogRecord(getBridgeLogger(), severity, message, attributes);
}

export function buildBridgeDiagLogger(): DiagLogger {
  return {
    verbose: (message, ...args) => emitBridge(SeverityNumber.DEBUG, message, args),
    debug: (message, ...args) => emitBridge(SeverityNumber.DEBUG, message, args),
    info: (message, ...args) => emitBridge(SeverityNumber.INFO, message, args),
    warn: (message, ...args) => emitBridge(SeverityNumber.WARN, message, args),
    error: (message, ...args) => emitBridge(SeverityNumber.ERROR, message, args),
  };
}
