/**
 * Icon set — a small, consistent family of line icons drawn on a 24×24 grid
 * with a 1.75px stroke and round caps/joins. Replaces the emoji that used to
 * stand in for node types and controls.
 *
 * Every icon takes an optional `size` (px) and inherits colour from
 * `currentColor`, so callers style them with plain CSS `color`.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 20, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  };
}

// ─── Brand mark ──────────────────────────────────────────────────────────────
// A source node fanning out into two — the smallest possible picture of a DAG.
export function LogoMark({ size = 28, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" {...props}>
      <path
        d="M9 16 C 15 16, 16 9, 22 9"
        stroke="var(--color-ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M9 16 C 15 16, 16 23, 22 23"
        stroke="var(--color-ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="16" r="4.5" fill="var(--color-primary)" />
      <circle cx="23" cy="9" r="3.4" fill="var(--color-ink)" />
      <circle cx="23" cy="23" r="3.4" fill="var(--color-ink)" />
    </svg>
  );
}

// ─── Node-type icons ─────────────────────────────────────────────────────────

export function IconDownload(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function IconTransform(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M9.5 4.5v15" />
    </svg>
  );
}

export function IconTrain(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}

export function IconEvaluate(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 20V10M10 20V4M16 20v-6M22 20H2" />
    </svg>
  );
}

export function IconDeploy(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 20V8" />
      <path d="m6 13 6-6 6 6" />
      <path d="M5 4h14" />
    </svg>
  );
}

export function IconNode(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ─── Control icons ───────────────────────────────────────────────────────────

export function IconPlay(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" />
    </svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconTrash(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconAlert(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 9v5M12 17.5v.5" />
    </svg>
  );
}

export function IconHistory(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

export function IconRetry(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 12a9 9 0 1 1 2.6 6.3M3 20v-5h5" />
    </svg>
  );
}

export function IconSpinner({ size = 18, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="spin"
      {...props}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Node-type → icon map ────────────────────────────────────────────────────

export const NODE_ICON: Record<string, (p: IconProps) => JSX.Element> = {
  'kaggle.download': IconDownload,
  'pandas.preprocess': IconTransform,
  'torch.train': IconTrain,
  'model.evaluate': IconEvaluate,
  'registry.deploy': IconDeploy,
};
