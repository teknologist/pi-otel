/**
 * Span lifecycle tracker.
 *
 * Owns one `pi.interaction` root span per user prompt. Children:
 *   - `pi.llm_request` per provider request
 *   - `pi.tool.<name>` per tool invocation (parallel-safe via Map<toolCallId, …>)
 *
 * Active provider span is single-slot — pi serializes provider requests
 * per session, but parallel tool calls overlap, so tools key on toolCallId.
 */
import { type Tracer } from "@opentelemetry/api";
import { type ContentCapture } from "./attrs.js";
export interface SpanTrackerOpts {
    tracer: Tracer;
    captureContent: ContentCapture;
    sessionId: () => string | undefined;
    cwd: string;
}
export declare class SpanTracker {
    private opts;
    private interaction;
    private turn;
    private llm;
    private tools;
    private turnCount;
    private toolCount;
    private pendingMessages;
    constructor(opts: SpanTrackerOpts);
    private commonAttrs;
    startInteraction(prompt: string | undefined): void;
    endInteraction(error?: unknown): void;
    startTurn(turnIndex: number | undefined): void;
    endTurn(error?: unknown): void;
    startLlmRequest(model?: string): void;
    private currentInputMessages;
    private flushPendingMessages;
    /**
     * Buffer a user-role message; flushed as a gen_ai.user.message event on the
     * next LLM span (or the current one if already open).
     */
    noteUserMessage(content: unknown): void;
    /**
     * Buffer a toolResult message; flushed as a gen_ai.tool.message event on the
     * next LLM span (only when captureContent === "full").
     */
    noteToolResultMessage(msg: {
        toolCallId: string;
        toolName?: string;
        content: unknown;
    }): void;
    /**
     * Emit gen_ai.assistant.message + gen_ai.choice events on the active LLM
     * span. Called from message_end before endLlmRequest.
     */
    noteAssistantMessage(message: any): void;
    setLlmAttrs(attrs: Record<string, unknown>): void;
    endLlmRequest(error?: unknown): void;
    private recordLlmMetrics;
    startTool(toolCallId: string, toolName: string, input: unknown): void;
    endTool(toolCallId: string, args: {
        isError?: boolean;
        result?: unknown;
    }): void;
    /**
     * Drop any buffered user/tool messages — used when an interaction ends
     * without ever opening an LLM span (e.g., user prompt cancelled).
     */
    clearPending(): void;
    /**
     * Hook for the launcher / external code to read the active interaction
     * trace id (e.g. for surfacing in UI).
     */
    activeTraceId(): string | undefined;
}
