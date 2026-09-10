import { describe, it, expect } from 'vitest';
import {
  runTraceId,
  runContext,
  extractContext,
  injectContext,
  traceparentEnv,
  withSpan,
} from './index';
import { trace, context } from '@opentelemetry/api';

describe('@dag/otel helpers (tracing disabled — no SDK started)', () => {
  it('runTraceId is a deterministic 32-hex-char id', () => {
    const a = runTraceId('run_abc123');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(runTraceId('run_abc123')).toBe(a); // stable
    expect(runTraceId('run_def456')).not.toBe(a); // distinct per run
  });

  it('runContext pins the active span context to the run trace id', () => {
    const ctx = runContext('run_abc123');
    const sc = trace.getSpanContext(ctx);
    expect(sc?.traceId).toBe(runTraceId('run_abc123'));
    expect(sc?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('injectContext returns an empty carrier when no propagator/SDK is active', () => {
    expect(injectContext()).toEqual({});
  });

  it('extractContext(undefined | {}) returns the active context unchanged', () => {
    expect(extractContext(undefined)).toBe(context.active());
    expect(extractContext({})).toBe(context.active());
  });

  it('traceparentEnv is empty with nothing to propagate', () => {
    expect(traceparentEnv()).toEqual({});
  });

  it('withSpan runs the callback and returns its value with tracing off', async () => {
    const out = await withSpan('noop', {}, async () => 42);
    expect(out).toBe(42);
  });

  it('withSpan still rethrows the callback error', async () => {
    await expect(withSpan('boom', {}, async () => { throw new Error('x'); })).rejects.toThrow('x');
  });
});
