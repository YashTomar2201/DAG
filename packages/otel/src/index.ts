/**
 * `@dag/otel` — one place for OpenTelemetry setup and the DAG-specific tracing
 * helpers (roadmap C4 step 4).
 *
 * The goal: one trace per run, spanning API dispatch → queue wait → worker
 * execution → Python subprocess. Two ideas make that work across three
 * processes with no shared span object:
 *
 *  1. **The run id IS the trace id.** `runTraceId(runId)` is a deterministic
 *     16-byte id derived from the run id, so every span for a run lands in the
 *     same trace and you can jump straight to it from a run id
 *     (`traceId = sha256(runId)[:32]`) — no lookup table.
 *  2. **W3C context on the job.** The API injects `traceparent` into the BullMQ
 *     job payload; the worker extracts it so its span is a real child of the
 *     dispatch span. The worker then passes `TRACEPARENT` in the Python child's
 *     env so an instrumented script continues the same trace.
 *
 * All of this is **opt-in**: with no `OTEL_EXPORTER_OTLP_ENDPOINT` (and
 * `OTEL_ENABLED` unset) `startTracing()` is a no-op, `withSpan()` just runs its
 * callback, and the inject/extract helpers return empty carriers. The base
 * dev/compose/test setup is unchanged; the observability overlay turns it on.
 */
import { createHash } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import {
  trace,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Context,
  type Attributes,
} from '@opentelemetry/api';

export { SpanKind, SpanStatusCode, type Span };

const TRACER_NAME = '@dag/otel';

let sdk: NodeSDK | undefined;

/** Endpoint base, e.g. `http://jaeger:4318` — the `/v1/traces` path is appended. */
function otlpEndpoint(): string | undefined {
  const raw = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!raw) return undefined;
  // Accept both the base and a full signal URL.
  return raw.replace(/\/v1\/traces\/?$/, '').replace(/\/$/, '');
}

/**
 * Start the Node SDK. Safe to call once per process; a second call is ignored.
 * No-ops unless an OTLP endpoint is configured (opt-in).
 *
 * Call this **before** anything imports express / pg / ioredis for the
 * auto-instrumentations to patch them — i.e. from a module that the process
 * entrypoint imports on its very first line.
 */
export function startTracing(serviceName: string): void {
  if (sdk) return;
  const endpoint = otlpEndpoint();
  const enabled = endpoint !== undefined; // presence of the endpoint is the switch
  if (!enabled) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env['OTEL_SERVICE_VERSION'] ?? '1.0.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new IORedisInstrumentation(),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
}

/** Flush and stop the SDK — call from the process's SIGTERM handler. */
export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* never let trace shutdown block process exit */
  }
  sdk = undefined;
}

// ─── Run ↔ trace identity ────────────────────────────────────────────────────

/** Deterministic 32-hex-char (16-byte) trace id for a run. The run id is the key. */
export function runTraceId(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 32);
}

/** Deterministic 16-hex-char (8-byte) id for a run's synthetic root span. */
function runRootSpanId(runId: string): string {
  return createHash('sha256').update(`${runId}:root`).digest('hex').slice(0, 16);
}

/**
 * A context whose active span is a non-recording remote parent pinned to the
 * run's deterministic trace id. Start the dispatch span in this context and the
 * whole run's spans share one trace, keyed by the run id.
 */
export function runContext(runId: string): Context {
  return trace.setSpanContext(context.active(), {
    traceId: runTraceId(runId),
    spanId: runRootSpanId(runId),
    traceFlags: 1, // sampled
    isRemote: true,
  });
}

// ─── Spans ───────────────────────────────────────────────────────────────────

export interface SpanOptions {
  /** Parent context — defaults to the active one. */
  parent?: Context;
  kind?: SpanKind;
  attributes?: Attributes;
}

/**
 * Run `fn` inside a span. Records the exception + ERROR status on throw, always
 * ends the span. When tracing is disabled this is just `fn(noopSpan)`.
 */
export async function withSpan<T>(
  name: string,
  opts: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const parent = opts.parent ?? context.active();
  return tracer.startActiveSpan(
    name,
    { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes },
    parent,
    async (span) => {
      try {
        const result = await fn(span);
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ─── Cross-process propagation ───────────────────────────────────────────────

/** W3C carrier (`traceparent` / `tracestate`) for the active context. */
export function injectContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Turn a carrier from `injectContext()` back into a Context to parent a span. */
export function extractContext(carrier: Record<string, string> | undefined | null): Context {
  if (!carrier || Object.keys(carrier).length === 0) return context.active();
  return propagation.extract(context.active(), carrier);
}

/**
 * `{ TRACEPARENT, TRACESTATE }` env for a child process (the Python bridge),
 * from the active context. Empty object when there's nothing to propagate.
 */
export function traceparentEnv(): Record<string, string> {
  const carrier = injectContext();
  const env: Record<string, string> = {};
  if (carrier['traceparent']) env['TRACEPARENT'] = carrier['traceparent'];
  if (carrier['tracestate']) env['TRACESTATE'] = carrier['tracestate'];
  return env;
}
