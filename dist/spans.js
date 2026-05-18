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
import { context as otelContext, SpanStatusCode, trace, } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR_AGENT_NAME, ATTR_CACHE_CREATION_TOKENS, ATTR_CACHE_READ_TOKENS, ATTR_CACHE_WRITE_TOKENS, ATTR_CONVERSATION_ID, ATTR_ERROR_TYPE, ATTR_GEN_AI_INPUT_MESSAGES, ATTR_GEN_AI_OUTPUT_MESSAGES, ATTR_INPUT_TOKENS, ATTR_OPERATION_NAME, ATTR_OUTPUT_TOKENS, ATTR_PI_COST_USD, ATTR_PI_CWD, ATTR_PI_SESSION_ID, ATTR_PI_TOOL_CALL_ID, ATTR_PI_TOOL_COUNT, ATTR_PI_TOOL_INPUT, ATTR_PI_TOOL_IS_ERROR, ATTR_PI_TOOL_NAME, ATTR_PI_TOOL_OUTPUT, ATTR_PI_TURN_COUNT, ATTR_PI_TURN_INDEX, ATTR_PI_USER_PROMPT, ATTR_PI_USER_PROMPT_LENGTH, ATTR_PROVIDER_NAME, ATTR_REASONING_TOKENS, ATTR_REQUEST_MODEL, ATTR_RESPONSE_MODEL, ATTR_SESSION_ID, ATTR_SYSTEM, ATTR_TOKEN_TYPE, ATTR_TOOL_CALL_ARGUMENTS, ATTR_TOOL_CALL_ID, ATTR_TOOL_CALL_RESULT, ATTR_TOOL_NAME, clampAttr, EVENT_GEN_AI_ASSISTANT_MESSAGE, EVENT_GEN_AI_CHOICE, EVENT_GEN_AI_TOOL_MESSAGE, EVENT_GEN_AI_USER_MESSAGE, GEN_AI_SYSTEM_PI, SPAN_INTERACTION, SPAN_LLM_REQUEST, SPAN_TURN, spanToolName, } from "./attrs.js";
import { emitLifecycleLog } from "./otel/logs.js";
import { getCostCounter, getDurationHistogram, getInteractionsCounter, getTokenHistogram, getToolCallsHistogram, } from "./otel/metrics.js";
/**
 * Flatten pi AgentMessage `content` (string | content-part[]) into a single
 * text string. Non-text parts are skipped — tool_calls are surfaced via
 * extractToolCalls instead.
 */
function extractMessageText(content) {
    if (content == null)
        return "";
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const p of content) {
        if (!p || typeof p !== "object")
            continue;
        if (p.type === "text" && typeof p.text === "string")
            parts.push(p.text);
    }
    return parts.join("\n");
}
/**
 * Extract assistant tool_calls from AgentMessage content parts into the
 * OTel GenAI semconv shape: [{id, type:"function", function:{name, arguments}}].
 * `includeArguments=false` (no_tool_content) omits the arguments payload.
 */
function extractToolCalls(content, includeArguments) {
    if (!Array.isArray(content))
        return [];
    const calls = [];
    for (const p of content) {
        if (!p || typeof p !== "object")
            continue;
        const isToolCall = p.type === "toolCall" || p.type === "tool_call" || p.type === "tool_use";
        if (!isToolCall)
            continue;
        const id = p.id ?? p.toolCallId ?? p.tool_call_id ?? p.toolUseId;
        const name = p.name ?? p.toolName ?? p.tool_name;
        const args = p.arguments ?? p.input ?? p.args;
        const fn = { name };
        if (includeArguments && args !== undefined) {
            fn.arguments = typeof args === "string" ? args : JSON.stringify(args);
        }
        calls.push({ id, type: "function", function: fn });
    }
    return calls;
}
function agentAttrs() {
    return {
        [ATTR_AGENT_NAME]: GEN_AI_SYSTEM_PI,
        [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
    };
}
export class SpanTracker {
    opts;
    interaction = null;
    turn = null;
    llm = null;
    tools = new Map();
    turnCount = 0;
    toolCount = 0;
    // user/toolResult messages can land before the next llm_request opens; buffer
    // them and flush as gen_ai.*.message events when the LLM span starts.
    pendingMessages = [];
    constructor(opts) {
        this.opts = opts;
    }
    commonAttrs() {
        const sid = this.opts.sessionId();
        const attrs = {
            ...agentAttrs(),
            [ATTR_PI_CWD]: this.opts.cwd,
        };
        if (sid) {
            attrs[ATTR_PI_SESSION_ID] = sid;
            attrs[ATTR_SESSION_ID] = sid;
            attrs[ATTR_CONVERSATION_ID] = sid;
        }
        return attrs;
    }
    startInteraction(prompt) {
        if (this.interaction)
            return; // already open — defensive
        this.turnCount = 0;
        this.toolCount = 0;
        const attrs = this.commonAttrs();
        if (typeof prompt === "string") {
            attrs[ATTR_PI_USER_PROMPT_LENGTH] = prompt.length;
            if (this.opts.captureContent === "full") {
                attrs[ATTR_PI_USER_PROMPT] = clampAttr(prompt);
            }
        }
        const span = this.opts.tracer.startSpan(SPAN_INTERACTION, {
            attributes: attrs,
        });
        const ctx = trace.setSpan(otelContext.active(), span);
        this.interaction = { span, ctx };
        try {
            getInteractionsCounter().add(1, {
                ...agentAttrs(),
            });
        }
        catch {
            // Metrics are best-effort — never block span lifecycle.
        }
    }
    endInteraction(error) {
        if (!this.interaction)
            return;
        const { span } = this.interaction;
        span.setAttribute(ATTR_PI_TURN_COUNT, this.turnCount);
        span.setAttribute(ATTR_PI_TOOL_COUNT, this.toolCount);
        if (error) {
            span.setAttribute(ATTR_ERROR_TYPE, error?.name ?? "Error");
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error?.message ?? error),
            });
        }
        // Close stragglers defensively.
        if (this.llm) {
            this.llm.span.end();
            this.llm = null;
        }
        for (const slot of this.tools.values())
            slot.span.end();
        this.tools.clear();
        if (this.turn) {
            this.turn.span.end();
            this.turn = null;
        }
        span.end();
        this.interaction = null;
        this.pendingMessages = [];
    }
    startTurn(turnIndex) {
        if (!this.interaction)
            return;
        if (this.turn) {
            // Defensive: a previous turn never closed — close it.
            this.turn.span.end();
            this.turn = null;
        }
        const idx = typeof turnIndex === "number" ? turnIndex : this.turnCount;
        const attrs = this.commonAttrs();
        attrs[ATTR_PI_TURN_INDEX] = idx;
        const span = this.opts.tracer.startSpan(SPAN_TURN, { attributes: attrs }, this.interaction.ctx);
        const ctx = trace.setSpan(this.interaction.ctx, span);
        this.turn = { span, ctx, index: idx };
        this.turnCount += 1;
    }
    endTurn(error) {
        if (!this.turn)
            return;
        if (error) {
            this.turn.span.setAttribute(ATTR_ERROR_TYPE, error?.name ?? "Error");
            this.turn.span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error?.message ?? error),
            });
        }
        this.turn.span.end();
        this.turn = null;
    }
    startLlmRequest(model) {
        if (this.llm) {
            // Should not happen — defensive close.
            this.llm.span.end();
            this.llm = null;
        }
        const parentCtx = this.turn?.ctx ?? this.interaction?.ctx ?? otelContext.active();
        const attrs = this.commonAttrs();
        attrs[ATTR_OPERATION_NAME] = "chat";
        if (model)
            attrs[ATTR_REQUEST_MODEL] = model;
        const span = this.opts.tracer.startSpan(SPAN_LLM_REQUEST, { attributes: attrs }, parentCtx);
        const ctx = trace.setSpan(parentCtx, span);
        this.llm = {
            span,
            ctx,
            startNs: process.hrtime.bigint(),
            requestModel: model,
        };
        this.currentInputMessages = [];
        this.flushPendingMessages();
    }
    // Accumulated input messages for the current LLM request, kept in the
    // GenAI semconv "messages" shape ({role, parts:[{type,...}]}) so we can
    // serialize to `gen_ai.input.messages` at the end. Aspire 9.x reads this
    // attribute, not the span events.
    currentInputMessages = [];
    flushPendingMessages() {
        if (!this.llm || this.pendingMessages.length === 0)
            return;
        if (this.opts.captureContent === "metadata_only") {
            this.pendingMessages = [];
            return;
        }
        const allowTool = this.opts.captureContent === "full";
        for (const m of this.pendingMessages) {
            if (m.kind === "user") {
                const attrs = {
                    [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
                    role: "user",
                    content: clampAttr(m.content),
                };
                this.llm.span.addEvent(EVENT_GEN_AI_USER_MESSAGE, attrs);
                this.currentInputMessages.push({
                    role: "user",
                    parts: [{ type: "text", content: m.content }],
                });
            }
            else if (m.kind === "tool" && allowTool) {
                const attrs = {
                    [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
                    role: "tool",
                    id: m.toolCallId,
                    ...(m.toolName ? { name: m.toolName } : {}),
                    content: clampAttr(m.content),
                };
                this.llm.span.addEvent(EVENT_GEN_AI_TOOL_MESSAGE, attrs);
                this.currentInputMessages.push({
                    role: "tool",
                    parts: [
                        {
                            type: "tool_call_response",
                            id: m.toolCallId,
                            ...(m.toolName ? { name: m.toolName } : {}),
                            response: m.content,
                        },
                    ],
                });
            }
        }
        this.pendingMessages = [];
    }
    /**
     * Buffer a user-role message; flushed as a gen_ai.user.message event on the
     * next LLM span (or the current one if already open).
     */
    noteUserMessage(content) {
        if (this.opts.captureContent === "metadata_only")
            return;
        const text = extractMessageText(content);
        if (!text)
            return;
        this.pendingMessages.push({ kind: "user", content: text });
        if (this.llm)
            this.flushPendingMessages();
    }
    /**
     * Buffer a toolResult message; flushed as a gen_ai.tool.message event on the
     * next LLM span (only when captureContent === "full").
     */
    noteToolResultMessage(msg) {
        if (this.opts.captureContent !== "full")
            return;
        if (!msg.toolCallId)
            return;
        const text = extractMessageText(msg.content);
        this.pendingMessages.push({
            kind: "tool",
            content: text,
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
        });
        if (this.llm)
            this.flushPendingMessages();
    }
    /**
     * Emit gen_ai.assistant.message + gen_ai.choice events on the active LLM
     * span. Called from message_end before endLlmRequest.
     */
    noteAssistantMessage(message) {
        if (!this.llm)
            return;
        if (typeof message?.model === "string")
            this.llm.responseModel = message.model;
        const allowTool = this.opts.captureContent === "full";
        const toolCalls = extractToolCalls(message?.content, allowTool);
        this.llm.toolCallCount = toolCalls.length;
        if (this.opts.captureContent === "metadata_only")
            return;
        const text = extractMessageText(message?.content);
        const assistantAttrs = {
            [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
            role: "assistant",
        };
        if (text)
            assistantAttrs.content = clampAttr(text);
        if (toolCalls.length)
            assistantAttrs.tool_calls = clampAttr(toolCalls);
        this.llm.span.addEvent(EVENT_GEN_AI_ASSISTANT_MESSAGE, assistantAttrs);
        const finish = message?.stopReason ??
            message?.finishReason ??
            message?.finish_reason ??
            "stop";
        const choiceMessage = { role: "assistant" };
        if (text)
            choiceMessage.content = text;
        if (toolCalls.length)
            choiceMessage.tool_calls = toolCalls;
        const finishReasonStr = typeof finish === "string" ? finish : "stop";
        this.llm.span.addEvent(EVENT_GEN_AI_CHOICE, {
            [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
            index: 0,
            finish_reason: finishReasonStr,
            message: clampAttr(choiceMessage),
        });
        // Aspire 9.x AI panel reads these JSON-stringified attributes on the
        // LLM span. The span events above are for older readers / log-pipeline
        // consumers — keep both.
        const outputParts = [];
        if (text)
            outputParts.push({ type: "text", content: text });
        if (allowTool) {
            for (const tc of toolCalls) {
                outputParts.push({
                    type: "tool_call",
                    id: tc.id,
                    name: tc.function?.name,
                    arguments: tc.function?.arguments,
                });
            }
        }
        const outputMessages = [
            { role: "assistant", parts: outputParts, finish_reason: finishReasonStr },
        ];
        if (this.currentInputMessages.length > 0) {
            this.llm.span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, clampAttr(this.currentInputMessages));
        }
        this.llm.span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, clampAttr(outputMessages));
    }
    setLlmAttrs(attrs) {
        if (!this.llm)
            return;
        const respModel = attrs[ATTR_RESPONSE_MODEL];
        if (typeof respModel === "string")
            this.llm.responseModel = respModel;
        const providerName = attrs[ATTR_PROVIDER_NAME];
        if (typeof providerName === "string")
            this.llm.providerName = providerName;
        const reqModel = attrs[ATTR_REQUEST_MODEL];
        if (typeof reqModel === "string")
            this.llm.requestModel = reqModel;
        const costUsd = attrs[ATTR_PI_COST_USD];
        if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
            this.llm.costUsd = costUsd;
        }
        const inTok = attrs[ATTR_INPUT_TOKENS];
        if (typeof inTok === "number")
            this.llm.inputTokens = inTok;
        const outTok = attrs[ATTR_OUTPUT_TOKENS];
        if (typeof outTok === "number")
            this.llm.outputTokens = outTok;
        const cacheReadTok = attrs[ATTR_CACHE_READ_TOKENS];
        if (typeof cacheReadTok === "number")
            this.llm.cacheReadTokens = cacheReadTok;
        const cacheWriteTok = attrs[ATTR_CACHE_WRITE_TOKENS];
        if (typeof cacheWriteTok === "number")
            this.llm.cacheWriteTokens = cacheWriteTok;
        const cacheCreationTok = attrs[ATTR_CACHE_CREATION_TOKENS];
        if (typeof cacheCreationTok === "number")
            this.llm.cacheCreationTokens = cacheCreationTok;
        const reasoningTok = attrs[ATTR_REASONING_TOKENS];
        if (typeof reasoningTok === "number")
            this.llm.reasoningTokens = reasoningTok;
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null)
                continue;
            // OTel SDK requires primitive or primitive[] values.
            if (typeof v === "string" ||
                typeof v === "number" ||
                typeof v === "boolean") {
                this.llm.span.setAttribute(k, v);
            }
            else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
                this.llm.span.setAttribute(k, v);
            }
            else {
                this.llm.span.setAttribute(k, clampAttr(v));
            }
        }
    }
    endLlmRequest(error) {
        if (!this.llm)
            return;
        if (error) {
            const errName = error?.name ?? "Error";
            const errMsg = String(error?.message ?? error);
            this.llm.span.setAttribute(ATTR_ERROR_TYPE, errName);
            this.llm.span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
            const attrs = {
                ...agentAttrs(),
                [ATTR_ERROR_TYPE]: errName,
                "exception.message": errMsg,
            };
            if (this.llm.requestModel)
                attrs[ATTR_REQUEST_MODEL] = this.llm.requestModel;
            if (this.llm.responseModel)
                attrs[ATTR_RESPONSE_MODEL] = this.llm.responseModel;
            const stack = error?.stack;
            if (typeof stack === "string")
                attrs["exception.stacktrace"] = stack;
            emitLifecycleLog("pi.llm_request.error", SeverityNumber.ERROR, `LLM request failed: ${errMsg}`, attrs);
        }
        this.recordLlmMetrics(error);
        this.llm.span.end();
        this.llm = null;
        this.currentInputMessages = [];
    }
    recordLlmMetrics(error) {
        if (!this.llm)
            return;
        const elapsedSec = Number(process.hrtime.bigint() - this.llm.startNs) / 1e9;
        const baseAttrs = {
            ...agentAttrs(),
            [ATTR_OPERATION_NAME]: "chat",
            [ATTR_PROVIDER_NAME]: this.llm.providerName ?? "unknown",
            [ATTR_REQUEST_MODEL]: this.llm.requestModel ?? "unknown",
            [ATTR_RESPONSE_MODEL]: this.llm.responseModel ?? "unknown",
        };
        if (error)
            baseAttrs[ATTR_ERROR_TYPE] = error?.name ?? "Error";
        try {
            getDurationHistogram().record(elapsedSec, baseAttrs);
            if (typeof this.llm.inputTokens === "number") {
                getTokenHistogram().record(this.llm.inputTokens, {
                    ...baseAttrs,
                    [ATTR_TOKEN_TYPE]: "input",
                });
            }
            if (typeof this.llm.outputTokens === "number") {
                getTokenHistogram().record(this.llm.outputTokens, {
                    ...baseAttrs,
                    [ATTR_TOKEN_TYPE]: "output",
                });
            }
            if (typeof this.llm.cacheReadTokens === "number") {
                getTokenHistogram().record(this.llm.cacheReadTokens, {
                    ...baseAttrs,
                    [ATTR_TOKEN_TYPE]: "cache_read",
                });
            }
            const cacheWriteTokens = (this.llm.cacheWriteTokens ?? 0) + (this.llm.cacheCreationTokens ?? 0);
            if (cacheWriteTokens > 0) {
                getTokenHistogram().record(cacheWriteTokens, {
                    ...baseAttrs,
                    [ATTR_TOKEN_TYPE]: "cache_write",
                });
            }
            if (typeof this.llm.reasoningTokens === "number") {
                getTokenHistogram().record(this.llm.reasoningTokens, {
                    ...baseAttrs,
                    [ATTR_TOKEN_TYPE]: "reasoning",
                });
            }
            getToolCallsHistogram().record(this.llm.toolCallCount ?? 0, baseAttrs);
            if (typeof this.llm.costUsd === "number") {
                getCostCounter().add(this.llm.costUsd, {
                    ...agentAttrs(),
                    [ATTR_PROVIDER_NAME]: this.llm.providerName ?? "unknown",
                    [ATTR_RESPONSE_MODEL]: this.llm.responseModel ?? "unknown",
                });
            }
        }
        catch {
            // Metrics are best-effort — never block span lifecycle.
        }
    }
    startTool(toolCallId, toolName, input) {
        // Tool spans are siblings of pi.llm_request under pi.turn (SPEC §5).
        // Parenting under the LLM span would imply the tool ran *during* the model
        // call; tools actually execute after it.
        const parentCtx = this.turn?.ctx ?? this.interaction?.ctx ?? otelContext.active();
        const attrs = this.commonAttrs();
        attrs[ATTR_PI_TOOL_NAME] = toolName;
        attrs[ATTR_PI_TOOL_CALL_ID] = toolCallId;
        attrs[ATTR_TOOL_NAME] = toolName;
        attrs[ATTR_TOOL_CALL_ID] = toolCallId;
        if (this.opts.captureContent === "full" && input !== undefined) {
            const clamped = clampAttr(input);
            attrs[ATTR_PI_TOOL_INPUT] = clamped;
            attrs[ATTR_TOOL_CALL_ARGUMENTS] = clamped;
        }
        const span = this.opts.tracer.startSpan(spanToolName(toolName), { attributes: attrs }, parentCtx);
        const ctx = trace.setSpan(parentCtx, span);
        this.tools.set(toolCallId, {
            span,
            ctx,
            name: toolName,
            startNs: process.hrtime.bigint(),
        });
        this.toolCount += 1;
    }
    endTool(toolCallId, args) {
        const slot = this.tools.get(toolCallId);
        if (!slot)
            return;
        if (args.isError) {
            slot.span.setAttribute(ATTR_PI_TOOL_IS_ERROR, true);
            slot.span.setStatus({ code: SpanStatusCode.ERROR });
            const attrs = {
                ...agentAttrs(),
                [ATTR_TOOL_NAME]: slot.name,
                [ATTR_TOOL_CALL_ID]: toolCallId,
            };
            if (this.opts.captureContent === "full" && args.result !== undefined) {
                attrs[ATTR_TOOL_CALL_RESULT] = clampAttr(args.result);
            }
            emitLifecycleLog("pi.tool.error", SeverityNumber.ERROR, `tool ${slot.name} failed`, attrs);
        }
        else {
            slot.span.setAttribute(ATTR_PI_TOOL_IS_ERROR, false);
        }
        if (this.opts.captureContent === "full" && args.result !== undefined) {
            const clamped = clampAttr(args.result);
            slot.span.setAttribute(ATTR_PI_TOOL_OUTPUT, clamped);
            slot.span.setAttribute(ATTR_TOOL_CALL_RESULT, clamped);
        }
        try {
            const elapsedSec = Number(process.hrtime.bigint() - slot.startNs) / 1e9;
            const metricAttrs = {
                ...agentAttrs(),
                [ATTR_OPERATION_NAME]: "execute_tool",
                [ATTR_TOOL_NAME]: slot.name,
            };
            if (args.isError)
                metricAttrs[ATTR_ERROR_TYPE] = "tool_error";
            getDurationHistogram().record(elapsedSec, metricAttrs);
        }
        catch {
            // Metrics are best-effort — never block span lifecycle.
        }
        slot.span.end();
        this.tools.delete(toolCallId);
    }
    /**
     * Drop any buffered user/tool messages — used when an interaction ends
     * without ever opening an LLM span (e.g., user prompt cancelled).
     */
    clearPending() {
        this.pendingMessages = [];
    }
    /**
     * Hook for the launcher / external code to read the active interaction
     * trace id (e.g. for surfacing in UI).
     */
    activeTraceId() {
        const sc = this.interaction?.span.spanContext();
        return sc?.traceId;
    }
}
//# sourceMappingURL=spans.js.map