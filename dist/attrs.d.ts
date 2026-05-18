/**
 * gen_ai.* attribute and metric constants.
 *
 * Names follow the OTel GenAI semantic conventions:
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export declare const ATTR_CONVERSATION_ID = "gen_ai.conversation.id";
export declare const ATTR_AGENT_NAME = "gen_ai.agent.name";
export declare const ATTR_AGENT_VERSION = "gen_ai.agent.version";
export declare const ATTR_USER_ID = "user.id";
export declare const ATTR_ERROR_TYPE = "error.type";
export declare const ATTR_OPERATION_NAME = "gen_ai.operation.name";
export declare const ATTR_SYSTEM = "gen_ai.system";
export declare const ATTR_PROVIDER_NAME = "gen_ai.provider.name";
export declare const ATTR_REQUEST_MODEL = "gen_ai.request.model";
export declare const ATTR_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export declare const ATTR_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export declare const ATTR_REQUEST_TOP_P = "gen_ai.request.top_p";
export declare const ATTR_RESPONSE_ID = "gen_ai.response.id";
export declare const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
export declare const ATTR_FINISH_REASONS = "gen_ai.response.finish_reasons";
export declare const ATTR_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export declare const ATTR_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export declare const ATTR_TOKEN_TYPE = "gen_ai.token.type";
export declare const ATTR_CACHE_READ_TOKENS = "gen_ai.usage.cache_read_input_tokens";
export declare const ATTR_CACHE_WRITE_TOKENS = "gen_ai.usage.cache_write_input_tokens";
export declare const ATTR_CACHE_CREATION_TOKENS = "gen_ai.usage.cache_creation_input_tokens";
export declare const ATTR_REASONING_TOKENS = "gen_ai.usage.reasoning_tokens";
export declare const ATTR_TOOL_NAME = "gen_ai.tool.name";
export declare const ATTR_TOOL_CALL_ID = "gen_ai.tool.call.id";
export declare const ATTR_TOOL_TYPE = "gen_ai.tool.type";
export declare const ATTR_TOOL_DESCRIPTION = "gen_ai.tool.description";
export declare const ATTR_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export declare const ATTR_TOOL_CALL_RESULT = "gen_ai.tool.call.result";
export declare const ATTR_PI_SESSION_ID = "pi.session.id";
export declare const ATTR_SESSION_ID = "session.id";
export declare const ATTR_PI_CWD = "pi.cwd";
export declare const ATTR_PI_TURN_COUNT = "pi.turn_count";
export declare const ATTR_PI_TURN_INDEX = "pi.turn_index";
export declare const ATTR_PI_TOOL_COUNT = "pi.tool_count";
export declare const ATTR_PI_TOOL_NAME = "pi.tool.name";
export declare const ATTR_PI_TOOL_CALL_ID = "pi.tool.call_id";
export declare const ATTR_PI_TOOL_IS_ERROR = "pi.tool.is_error";
export declare const ATTR_PI_TOOL_INPUT = "pi.tool.input";
export declare const ATTR_PI_TOOL_OUTPUT = "pi.tool.output";
export declare const ATTR_PI_COST_USD = "pi.cost.usd";
export declare const ATTR_PI_USER_PROMPT = "pi.user_prompt";
export declare const ATTR_PI_USER_PROMPT_LENGTH = "pi.user_prompt_length";
export declare const ATTR_HTTP_STATUS_CODE = "http.response.status_code";
export declare const ATTR_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export declare const ATTR_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
export declare const EVENT_GEN_AI_USER_MESSAGE = "gen_ai.user.message";
export declare const EVENT_GEN_AI_TOOL_MESSAGE = "gen_ai.tool.message";
export declare const EVENT_GEN_AI_ASSISTANT_MESSAGE = "gen_ai.assistant.message";
export declare const EVENT_GEN_AI_CHOICE = "gen_ai.choice";
export declare const SPAN_INTERACTION = "pi.interaction";
export declare const SPAN_LLM_REQUEST = "pi.llm_request";
export declare const SPAN_TURN = "pi.turn";
export declare const spanToolName: (name: string) => string;
export declare const GEN_AI_SYSTEM_PI = "pi";
export type ContentCapture = "metadata_only" | "no_tool_content" | "full";
export declare function clampAttr(value: unknown): string;
/**
 * Pull token + cost data off a pi assistant message.usage object onto a span attributes record.
 * Tolerant of missing fields — pi providers differ in what they populate.
 */
export declare function applyUsageAttrs(attrs: Record<string, unknown>, usage: unknown): void;
