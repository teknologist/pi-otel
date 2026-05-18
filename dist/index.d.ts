/**
 * pi-otel — OpenTelemetry traces for pi-coding-agent.
 *
 * Wires pi lifecycle events into an OTel span tree:
 *   pi.interaction (per user prompt)
 *   ├─ pi.llm_request
 *   └─ pi.tool.<name>
 *
 * See `_plans/SPEC.md` for the full design.
 *
 * The `/otel` command (Aspire launcher) is registered below via
 * `registerOtelCommand`. We also expose `pi.events` channels
 * (`pi-otel:status`, `pi-otel:trace-active`) for future consumers.
 *
 * ## pi-otel:log — extensibility API for other pi packages
 *
 * Any pi extension can route structured log records through pi-otel by emitting:
 *
 *   pi.events.emit("pi-otel:log", {
 *     eventName: "my-package.something",   // lands as event.name attribute
 *     severity: "info",                    // "debug" | "info" | "warn" | "error"
 *     body: "human-readable message",
 *     attributes: { "key": "value" },      // optional; string | number | boolean values
 *   });
 *
 * No-op if signals.logs is disabled or the OTel SDK is not yet initialized.
 * pi-otel uses this channel internally for its own lifecycle events.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void;
