# Add pi-owned dashboard metrics for cost and interactions

pi-otel prefers official OpenTelemetry GenAI semantic conventions, but OTel does not currently define a GenAI cost metric or a Pi interaction-count metric. We will emit pi-owned counters `pi.cost.usd` and `pi.interactions` so the stock Grafana usage dashboard can compute cost and average cost per interaction reliably in PromQL, while avoiding fake official names such as `gen_ai.client.cost.usd` or `gen_ai.client.conversations`.
