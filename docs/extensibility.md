# Extensibility

When `signals.logs` is enabled, pi-otel registers a global OTel `LoggerProvider`. Other pi packages can route their own log records into the same OTLP stream — no dependency on pi-otel required.

## OTel API (recommended)

Add `@opentelemetry/api-logs` as a dependency and call the global provider directly. The call is a safe no-op if pi-otel isn't loaded or logs are disabled.

```ts
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const logger = logs.getLogger("my-package", "1.0.0");

logger.emit({
  severityNumber: SeverityNumber.DEBUG,
  body: "cache hit for tool bash",
  attributes: { "tool.name": "bash", "cache.key": "abc123" },
});
```

Records appear in Aspire Structured Logs under your own instrumentation scope (`my-package`), alongside pi-otel's lifecycle events.

## `pi-otel:log` event bus

If you're already in a pi extension and don't want to add an OTel dependency, emit on pi's shared event bus:

```ts
pi.events.emit("pi-otel:log", {
  eventName: "my-package.cache-hit",  // becomes the event.name attribute
  severity: "debug",                  // "debug" | "info" | "warn" | "error"
  body: "cache hit for tool bash",
  attributes: { "tool.name": "bash", "cache.key": "abc123" },
});
```

Records land under the `pi-otel` instrumentation scope. No-op if `signals.logs` is disabled.

## Comparison

| | OTel API | `pi-otel:log` event bus |
|---|---|---|
| Dependency | `@opentelemetry/api-logs` | none |
| Instrumentation scope | your package name | `pi-otel` |
| Works without pi context | yes | no (needs `pi.events`) |
| No-op when logs disabled | yes | yes |
