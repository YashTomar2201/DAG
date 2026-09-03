/**
 * B1.1 — condition-evaluator unit tests.
 *
 * No DB: `evaluateCondition` takes a plain Map<nodeKey, NodeRun-ish>. We only
 * populate the fields `walkAndResolve` reads (`status`, `output`).
 */
import { describe, it, expect } from 'vitest';
import type { NodeRun } from '@dag/db';
import type { Condition } from '@dag/contracts';
import { evaluateCondition, ConditionTypeError } from './condition-evaluator';
import { UnresolvedTemplateError } from './context-resolver';

function nrMap(outputs: Record<string, unknown>): Map<string, NodeRun> {
  const m = new Map<string, NodeRun>();
  for (const [key, output] of Object.entries(outputs)) {
    m.set(key, { status: 'SUCCEEDED', output } as unknown as NodeRun);
  }
  return m;
}

const evalOut = nrMap({ evaluate: { accuracy: 0.83, label: 'good', tags: ['prod', 'v2'] } });

function cond(op: Condition['op'], left: string, right: Condition['right']): Condition {
  return { left, op, right };
}

describe('evaluateCondition — numeric ops', () => {
  const acc = '{{ nodes.evaluate.output.accuracy }}';
  it('gt / gte / lt / lte on a resolved number', () => {
    expect(evaluateCondition(cond('gt', acc, 0.9), evalOut, 'evaluate')).toBe(false);
    expect(evaluateCondition(cond('gt', acc, 0.8), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('gte', acc, 0.83), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('lt', acc, 0.9), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('lte', acc, 0.83), evalOut, 'evaluate')).toBe(true);
  });

  it('coerces a numeric-string right-hand side', () => {
    expect(evaluateCondition(cond('gt', acc, '0.8' as unknown as number), evalOut, 'evaluate')).toBe(true);
  });

  it('throws ConditionTypeError when a side is not numeric', () => {
    expect(() => evaluateCondition(cond('gt', '{{ nodes.evaluate.output.label }}', 1), evalOut, 'evaluate'))
      .toThrow(ConditionTypeError);
  });
});

describe('evaluateCondition — equality / membership', () => {
  it('eq / ne with loose cross-type compare', () => {
    expect(evaluateCondition(cond('eq', '{{ nodes.evaluate.output.label }}', 'good'), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('ne', '{{ nodes.evaluate.output.label }}', 'bad'), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('eq', '{{ nodes.evaluate.output.accuracy }}', '0.83' as unknown as number), evalOut, 'evaluate')).toBe(true);
  });

  it('in — membership of the left value in the right array', () => {
    expect(evaluateCondition(cond('in', '{{ nodes.evaluate.output.label }}', ['good', 'great']), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('in', '{{ nodes.evaluate.output.label }}', ['bad']), evalOut, 'evaluate')).toBe(false);
  });

  it('contains — left array holds right, or left string includes right', () => {
    expect(evaluateCondition(cond('contains', '{{ nodes.evaluate.output.tags }}', 'prod'), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('contains', '{{ nodes.evaluate.output.label }}', 'oo'), evalOut, 'evaluate')).toBe(true);
    expect(evaluateCondition(cond('contains', '{{ nodes.evaluate.output.tags }}', 'dev'), evalOut, 'evaluate')).toBe(false);
  });
});

describe('evaluateCondition — unresolved reference', () => {
  it('throws UnresolvedTemplateError (never silently false)', () => {
    expect(() => evaluateCondition(cond('gt', '{{ nodes.evaluate.output.missing }}', 1), evalOut, 'x'))
      .toThrow(UnresolvedTemplateError);
    expect(() => evaluateCondition(cond('eq', '{{ nodes.nope.output.x }}', 1), evalOut, 'x'))
      .toThrow(UnresolvedTemplateError);
  });

  it('a plain literal left (no template) compares as-is', () => {
    expect(evaluateCondition(cond('eq', 'ready', 'ready'), new Map(), 'x')).toBe(true);
  });
});
