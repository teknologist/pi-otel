# pi-otel Observability Context

This context defines the product language used to describe pi-otel telemetry and dashboards.

## Language

**Conversation**:
A long-lived Pi session or thread that can contain many user prompts and shares one conversation identifier.
_Avoid_: Interaction, prompt

**Interaction**:
A single user-prompt execution within a conversation.
_Avoid_: Conversation, session

**Model Provider**:
The backend provider that served a model request, using Pi's provider identity such as openai, openai-codex, or anthropic.
_Avoid_: Agent, runtime, pi

**Agent**:
A named GenAI actor that performs work, with `pi` identifying this extension's top-level Pi actor in shared telemetry.
_Avoid_: Service, process, runtime

## Relationships

- A **Conversation** contains one or more **Interactions**.
- An **Interaction** belongs to exactly one **Conversation**.
- A **Model Provider** serves model requests made during an **Interaction**.
- An **Agent** may perform work during an **Interaction**.
- The pi-otel extension emits `pi` as its **Agent** name so shared telemetry sinks can distinguish it from other GenAI clients.

## Example dialogue

> **Dev:** "Should this dashboard show average cost per **Conversation** or per **Interaction**?"
> **Domain expert:** "Per **Interaction** for prompt-level cost, because a **Conversation** can span many prompts."

## Flagged ambiguities

- "conversation" was used for both the long-lived Pi thread and the per-prompt root span — resolved: **Conversation** is the long-lived thread, **Interaction** is one user-prompt execution.
- `gen_ai.provider.name` was at risk of meaning the Pi runtime — resolved: **Model Provider** means Pi's provider for the model, not Pi itself.
- `gen_ai.agent.name` was at risk of meaning OTel service identity — resolved: **Agent** is `pi` for this extension and must not be `service.name` or the pi-otel process name.
