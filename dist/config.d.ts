/**
 * Resolve pi-otel configuration from `.pi/settings.json` + env vars.
 *
 * Precedence: env vars (OTEL_* / PI_OTEL_*) override settings.json `otel.*`.
 */
import { DiagLogLevel } from "@opentelemetry/api";
import type { ContentCapture } from "./attrs.js";
export interface OtelConfig {
    enabled: boolean;
    endpoint: string;
    protocol: "grpc" | "http/protobuf" | "http/json";
    headers: Record<string, string>;
    serviceName: string;
    captureContent: ContentCapture;
    sampleRatio: number;
    signals: {
        traces: boolean;
        metrics: boolean;
        logs: boolean;
    };
    resourceAttributes: Record<string, string>;
    logLevel: DiagLogLevel;
    cwd: string;
}
export declare function resolveConfig(cwd: string): OtelConfig;
