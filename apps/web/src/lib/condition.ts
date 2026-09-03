/**
 * Edge-condition helpers shared by the edge inspector (authoring) and the
 * canvas (dashed rendering + run-time colouring).
 *
 * The wire shape lives in `@dag/contracts` (`ConditionSchema`): a structured
 * `{ left, op, right }` triple — deliberately not an expression string. See
 * `knowledge_base/decisions_log.md` § B1.1.
 */

import type { Condition, ConditionOp } from '@dag/contracts';

/** The 8 operators, in the order they appear in the inspector's <select>. */
export const OP_OPTIONS: Array<{ value: ConditionOp; label: string }> = [
  { value: 'eq', label: '= equals' },
  { value: 'ne', label: '≠ not equal' },
  { value: 'gt', label: '> greater than' },
  { value: 'gte', label: '≥ at least' },
  { value: 'lt', label: '< less than' },
  { value: 'lte', label: '≤ at most' },
  { value: 'in', label: 'in (comma list)' },
  { value: 'contains', label: 'contains' },
];

/** Compact operator glyphs for the on-canvas edge label. */
const OP_GLYPH: Record<ConditionOp, string> = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  in: 'in', contains: '⊇',
};

/**
 * Strips a `{{ nodes.<key>.output.<path> }}` wrapper down to its trailing
 * segment so `{{ nodes.evaluate.output.accuracy }}` reads as `accuracy` on the
 * edge label. A plain literal is returned unchanged.
 */
export function shortenRef(ref: string): string {
  const m = /^\s*\{\{\s*(.+?)\s*\}\}\s*$/.exec(ref);
  const inner = m?.[1] ?? ref;
  const parts = inner.split('.');
  return parts[parts.length - 1] || ref;
}

/** One-line summary for the on-canvas edge label, e.g. `accuracy > 0.9`. */
export function summarizeCondition(c: Condition): string {
  const right = Array.isArray(c.right) ? `[${c.right.join(', ')}]` : String(c.right);
  return `${shortenRef(c.left)} ${OP_GLYPH[c.op]} ${right}`;
}

/**
 * Coerces the raw string the inspector's "right" input produces into the
 * concrete type the engine compares against — mirrors `sanitizeConfig`'s
 * numeric coercion for node config. `in` splits on commas into an array;
 * everything else tries number → boolean → string.
 */
export function coerceRightValue(
  raw: unknown,
  op: ConditionOp,
): string | number | boolean | unknown[] {
  if (op === 'in') {
    if (Array.isArray(raw)) return raw;
    return String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(coerceScalar);
  }
  if (typeof raw !== 'string') {
    // already a number / boolean / array from a loaded graph
    return raw as string | number | boolean | unknown[];
  }
  return coerceScalar(raw);
}

function coerceScalar(raw: string): string | number | boolean {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  return raw;
}

/**
 * Normalises a store-held condition for the `Graph` wire format: trims `left`,
 * coerces `right`. Returns `null` when `left` is blank — an incomplete
 * condition is treated as "no condition" rather than sent to the API to be
 * rejected.
 */
export function serializeCondition(c: Condition | undefined | null): Condition | null {
  if (!c) return null;
  const left = c.left.trim();
  if (!left) return null;
  return { left, op: c.op, right: coerceRightValue(c.right, c.op) };
}
