"""
otel_trace.py — best-effort OpenTelemetry span for an executor script
(roadmap C4 step 4).

The Node worker passes `TRACEPARENT` (W3C trace context) and
`OTEL_EXPORTER_OTLP_ENDPOINT` in this process's environment. `traced(name)`
opens one span as a child of the worker's `python <script>` span and exports it
over OTLP/HTTP, so a run's trace reaches all the way into the Python subprocess.

Everything here is optional:
  - no TRACEPARENT / no endpoint  → the context manager is a plain no-op
  - opentelemetry packages absent → same, and a one-line note on stderr

so `preprocess.py` / `train.py` / `evaluate.py` behave identically when tracing
is off, and nothing new is required to run them by hand.
"""

from __future__ import annotations

import os
import sys
from contextlib import contextmanager


@contextmanager
def traced(span_name: str):
    traceparent = os.environ.get("TRACEPARENT")
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not traceparent or not endpoint:
        yield
        return

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.trace.propagation.tracecontext import (
            TraceContextTextMapPropagator,
        )
    except Exception as exc:  # noqa: BLE001 - tracing must never break the script
        print(f"[otel] tracing libs unavailable ({exc}); continuing untraced", file=sys.stderr)
        yield
        return

    base = endpoint.rstrip("/")
    if base.endswith("/v1/traces"):
        traces_url = base
    else:
        traces_url = base + "/v1/traces"

    provider = TracerProvider(
        resource=Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "dag-python")})
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=traces_url)))

    parent_ctx = TraceContextTextMapPropagator().extract({"traceparent": traceparent})
    tracer = provider.get_tracer("dag.python")

    try:
        with tracer.start_as_current_span(span_name, context=parent_ctx):
            yield
    finally:
        try:
            provider.force_flush(timeout_millis=3000)
            provider.shutdown()
        except Exception:  # noqa: BLE001
            pass
