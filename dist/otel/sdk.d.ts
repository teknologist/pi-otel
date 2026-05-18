/**
 * OTel SDK bootstrap. One global SDK per process — pi loads us per session
 * but the SDK is shared across sessions in the same process.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { OtelConfig } from "../config.js";
export type NotifySeverity = "info" | "warning" | "error";
export type Notify = (msg: string, severity?: NotifySeverity) => void;
export declare function probeTcp(host: string, port: number, timeoutMs?: number): Promise<boolean>;
export declare function probeEndpoint(endpoint: string, timeoutMs?: number): Promise<boolean>;
export declare function initSdk(cfg: OtelConfig, notify?: Notify, opts?: {
    silentSuccess?: boolean;
}): NodeSDK | null;
export declare function shutdownSdk(): Promise<void>;
