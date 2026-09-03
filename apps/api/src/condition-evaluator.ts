/**
 * B1.1 — Condition evaluator for conditional edges.
 *
 * An `EdgeDef.condition` is a structured `{ left, op, right }` triple (see
 * packages/contracts/src/graph.ts). `left` is resolved as a template against
 * completed parent `NodeRun.output` values — reusing the Phase-7
 * context-resolver — then `op` is applied against the literal `right`.
 *
 * Design invariant (matches `resolveNodeInputs`): an unresolved reference in
 * `left` **throws** (`UnresolvedTemplateError`). It must never silently
 * evaluate to false — a skipped branch would then look like a bug in the
 * user's graph rather than a bug in their config.
 */

import type { Condition, ConditionOp } from '@dag/contracts';
import type { NodeRun } from '@dag/db';
import { walkAndResolve } from './context-resolver';

/** Thrown when `op` is used on values it can't compare (e.g. `gt` on a string). */
export class ConditionTypeError extends Error {
  constructor(
    public readonly condition: Condition,
    public readonly detail: string,
  ) {
    super(
      `Cannot evaluate condition ${JSON.stringify(condition)}: ${detail}. ` +
        `Check the operator and the referenced output field.`,
    );
    this.name = 'ConditionTypeError';
  }
}

/**
 * Resolves `condition.left` (a template or literal string) against the run's
 * completed node outputs and compares it to `condition.right` with `condition.op`.
 *
 * @throws UnresolvedTemplateError if `left` references an output that isn't ready
 * @throws ConditionTypeError      if the operator can't be applied to the values
 */
export function evaluateCondition(
  condition: Condition,
  nodeRunMap: Map<string, NodeRun>,
  ownerNodeKey: string,
): boolean {
  const left = walkAndResolve(condition.left, nodeRunMap, ownerNodeKey);
  return applyOp(left, condition.op, condition.right, condition);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return NaN;
}

/** Cross-type-tolerant equality: 0.9 == "0.9", true == "true". */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') return false;
  return String(a) === String(b);
}

function applyOp(left: unknown, op: ConditionOp, right: unknown, condition: Condition): boolean {
  switch (op) {
    case 'eq':
      return looseEq(left, right);
    case 'ne':
      return !looseEq(left, right);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const l = toNumber(left);
      const r = toNumber(right);
      if (Number.isNaN(l) || Number.isNaN(r)) {
        throw new ConditionTypeError(
          condition,
          `${op} needs numbers but got left=${JSON.stringify(left)} right=${JSON.stringify(right)}`,
        );
      }
      return op === 'gt' ? l > r : op === 'gte' ? l >= r : op === 'lt' ? l < r : l <= r;
    }
    case 'in': {
      if (!Array.isArray(right)) {
        throw new ConditionTypeError(condition, `"in" needs an array on the right, got ${JSON.stringify(right)}`);
      }
      return right.some((v) => looseEq(v, left));
    }
    case 'contains': {
      if (Array.isArray(left)) return left.some((v) => looseEq(v, right));
      if (typeof left === 'string') return left.includes(String(right));
      throw new ConditionTypeError(
        condition,
        `"contains" needs an array or string on the left, got ${JSON.stringify(left)}`,
      );
    }
    default: {
      const _exhaustive: never = op;
      throw new ConditionTypeError(condition, `unknown operator "${String(_exhaustive)}"`);
    }
  }
}
