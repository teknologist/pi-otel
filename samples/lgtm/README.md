# Grafana LGTM (otel-lgtm)

Start the stack:

```bash
docker compose up
# or
podman compose up
```

Then connect pi-otel to it:

```
/otel connect http://localhost:4317
```

| Endpoint | URL |
|---|---|
| OTLP gRPC | `http://localhost:4317` |
| OTLP HTTP | `http://localhost:4318` |
| Grafana UI | <http://localhost:3000> |

Traces → Tempo · Metrics → Mimir · Logs → Loki. All pre-wired in the `otel-lgtm` image.
