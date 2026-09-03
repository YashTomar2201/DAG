/**
 * Automation panel (roadmap B2) — cron schedules and webhook triggers for the
 * open workflow. A slide-in on the canvas, same shape as RunHistory.
 *
 * Schedules and webhooks both run the workflow's *latest saved version*, so the
 * panel only does anything once the workflow has been saved.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listTriggers,
  createTrigger,
  setTriggerEnabled,
  deleteTrigger,
  webhookUrl,
  ApiError,
  type Schedule,
  type Trigger,
  type TriggerWithSecret,
} from '../api/client';
import type { CSSProperties } from 'react';
import { IconClock, IconWebhook, IconClose, IconTrash, IconSpinner, IconCheck, IconAlert } from './icons';

/** A small text button — the app's `.btn-ghost` is a fixed 28px icon square, so
 *  text-labelled controls need their own style. */
const textBtn: CSSProperties = {
  font: 'inherit',
  fontSize: 11,
  padding: '3px 8px',
  border: 'none',
  background: 'transparent',
  color: 'var(--color-body)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
};

const chipBtn: CSSProperties = {
  ...textBtn,
  whiteSpace: 'nowrap',
  border: '1px solid var(--color-hairline)',
  borderRadius: 'var(--radius-md)',
  padding: '4px 10px',
};

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 02:00', cron: '0 2 * * *' },
  { label: 'Mon 09:00', cron: '0 9 * * 1' },
];

/** Best-effort plain-English gloss for the common cron shapes. */
function cronHint(cron: string): string {
  const preset = CRON_PRESETS.find((p) => p.cron === cron);
  if (preset) return preset.label.toLowerCase();
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'custom schedule';
  const [min, hr, dom, mon, dow] = parts;
  if (min === '*' ) return 'every minute';
  if (hr === '*' && dom === '*' && mon === '*' && dow === '*') return `at :${min!.padStart(2, '0')} every hour`;
  if (dom === '*' && mon === '*' && dow === '*') return `daily at ${hr!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
  return 'custom schedule';
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60_000);
  const h = Math.round(abs / 3_600_000);
  const d = Math.round(abs / 86_400_000);
  const rel = m < 1 ? 'just now' : m < 60 ? `${m}m` : h < 48 ? `${h}h` : `${d}d`;
  if (rel === 'just now') return rel;
  return diff >= 0 ? `in ${rel}` : `${rel} ago`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard blocked — the value is on screen to copy by hand */
  }
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.toDisplayMessage();
  if (err instanceof Error) return err.message;
  return String(err);
}

export function AutomationPanel({ workflowId }: { workflowId: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cronDraft, setCronDraft] = useState('0 2 * * *');
  const [newSecret, setNewSecret] = useState<TriggerWithSecret | null>(null);

  const refresh = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, t] = await Promise.all([listSchedules(workflowId), listTriggers(workflowId)]);
      setSchedules(s);
      setTriggers(t);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isOpen) {
    const count = schedules.length + triggers.length;
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="btn-secondary"
        style={{
          position: 'absolute',
          bottom: 20,
          right: 20,
          zIndex: 10,
          fontSize: 13,
          background: 'var(--color-canvas)',
          boxShadow: '0 4px 14px rgba(20,20,19,0.12)',
        }}
      >
        <IconClock size={15} />
        Automation{count > 0 ? ` · ${count}` : ''}
      </button>
    );
  }

  return (
    <div
      className="animate-in"
      style={{
        position: 'absolute',
        top: 20,
        right: 20,
        width: 420,
        maxHeight: 'calc(100% - 40px)',
        background: 'var(--color-canvas)',
        border: '1px solid var(--color-hairline)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 16px 44px rgba(20,20,19,0.16)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 11,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 14px 20px',
          borderBottom: '1px solid var(--color-hairline)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--color-ink)', fontWeight: 600, fontSize: 15 }}>
          <IconClock size={16} />
          Automation
        </span>
        <button className="btn-ghost" onClick={() => setIsOpen(false)} aria-label="Close">
          <IconClose size={15} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 24 }}>
        {!workflowId ? (
          <div className="body-md" style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 32 }}>
            Save the workflow first to schedule it or add a webhook.
          </div>
        ) : (
          <>
            {error && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                  background: 'var(--color-error-soft)',
                  color: 'var(--color-error)',
                  border: '1px solid color-mix(in srgb, var(--color-error) 30%, transparent)',
                  borderRadius: 'var(--radius-md)',
                  padding: '9px 12px',
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-line',
                }}
              >
                <IconAlert size={14} />
                {error}
              </div>
            )}

            {/* ── Schedules ─────────────────────────────────────────────── */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="caption-uppercase" style={{ color: 'var(--color-muted-soft)', fontSize: 10, letterSpacing: '1.2px' }}>
                Cron schedules
              </div>

              {loading && schedules.length === 0 ? (
                <div style={{ color: 'var(--color-muted)', fontSize: 12 }}>Loading…</div>
              ) : schedules.length === 0 ? (
                <div className="body-sm" style={{ color: 'var(--color-muted)' }}>No schedules yet.</div>
              ) : (
                schedules.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      border: '1px solid var(--color-hairline)',
                      borderRadius: 'var(--radius-md)',
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      opacity: s.enabled ? 1 : 0.55,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <code style={{ fontSize: 12, color: 'var(--color-ink)', fontWeight: 600 }}>{s.cron}</code>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--color-muted)', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            disabled={busy}
                            onChange={(e) => void run(() => updateSchedule(s.id, { enabled: e.target.checked }))}
                          />
                          {s.enabled ? 'on' : 'off'}
                        </label>
                        <button
                          className="btn-ghost"
                          style={{ color: 'var(--color-error)', width: 24, height: 24 }}
                          disabled={busy}
                          onClick={() => void run(() => deleteSchedule(s.id))}
                          aria-label="Delete schedule"
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                      {cronHint(s.cron)} · {s.timezone}
                      {s.enabled && s.nextFireAt ? ` · next ${relTime(s.nextFireAt)}` : ''}
                      {s.lastFiredAt ? ` · last fired ${relTime(s.lastFiredAt)}` : ''}
                    </div>
                  </div>
                ))
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                {CRON_PRESETS.map((p) => (
                  <button key={p.cron} style={chipBtn} onClick={() => setCronDraft(p.cron)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={cronDraft}
                  onChange={(e) => setCronDraft(e.target.value)}
                  spellCheck={false}
                  placeholder="min hour dom mon dow"
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-code)',
                    fontSize: 12,
                    padding: '7px 10px',
                    border: '1px solid var(--color-hairline)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-surface)',
                    color: 'var(--color-ink)',
                  }}
                />
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12 }}
                  disabled={busy || !cronDraft.trim()}
                  onClick={() => void run(async () => {
                    await createSchedule(workflowId, cronDraft.trim());
                  })}
                >
                  {busy ? <IconSpinner size={13} /> : null}
                  Add schedule
                </button>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--color-muted-soft)' }}>
                Standard 5-field cron, evaluated in UTC. Each fire runs the latest saved version.
              </div>
            </section>

            <div style={{ borderTop: '1px solid var(--color-hairline)' }} />

            {/* ── Webhooks ──────────────────────────────────────────────── */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="caption-uppercase" style={{ color: 'var(--color-muted-soft)', fontSize: 10, letterSpacing: '1.2px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconWebhook size={13} /> Webhook triggers
              </div>

              {triggers.length === 0 ? (
                <div className="body-sm" style={{ color: 'var(--color-muted)' }}>No webhooks yet.</div>
              ) : (
                triggers.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      border: '1px solid var(--color-hairline)',
                      borderRadius: 'var(--radius-md)',
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      opacity: t.enabled ? 1 : 0.55,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <code style={{ fontSize: 11, color: 'var(--color-ink)' }}>
                        …/triggers/{t.token.slice(0, 6)}<span style={{ color: 'var(--color-muted-soft)' }}>••••</span>
                      </code>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button style={textBtn} onClick={() => void copy(webhookUrl(t.token))}>
                          Copy URL
                        </button>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--color-muted)', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={t.enabled}
                            disabled={busy}
                            onChange={(e) => void run(() => setTriggerEnabled(t.id, e.target.checked))}
                          />
                          {t.enabled ? 'on' : 'off'}
                        </label>
                        <button
                          className="btn-ghost"
                          style={{ color: 'var(--color-error)', width: 24, height: 24 }}
                          disabled={busy}
                          onClick={() => void run(() => deleteTrigger(t.id))}
                          aria-label="Delete webhook"
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>
                    </div>
                    {t.lastFiredAt && (
                      <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>last fired {relTime(t.lastFiredAt)}</div>
                    )}
                  </div>
                ))
              )}

              <button
                className="btn-secondary"
                style={{ fontSize: 12, alignSelf: 'flex-start' }}
                disabled={busy}
                onClick={() => void run(async () => {
                  const created = await createTrigger(workflowId);
                  setNewSecret(created);
                })}
              >
                {busy ? <IconSpinner size={13} /> : null}
                Add webhook
              </button>

              {newSecret && (
                <div
                  style={{
                    border: '1px solid color-mix(in srgb, var(--color-success) 40%, transparent)',
                    background: 'var(--color-success-soft)',
                    borderRadius: 'var(--radius-md)',
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    fontSize: 11.5,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#3a7a48', fontWeight: 600 }}>
                    <IconCheck size={13} /> Webhook created — copy the secret now, it won't be shown again.
                  </div>
                  <RevealRow label="URL" value={webhookUrl(newSecret.token)} />
                  <RevealRow label="Secret" value={newSecret.secret} />
                  <div style={{ color: 'var(--color-muted)', lineHeight: 1.5 }}>
                    Sign the request body with HMAC-SHA256 and send it as
                    {' '}<code>X-Signature-256: sha256=&lt;hex&gt;</code>.
                  </div>
                  <button style={{ ...textBtn, alignSelf: 'flex-start', fontWeight: 600 }} onClick={() => setNewSecret(null)}>
                    Done
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function RevealRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--color-muted)', minWidth: 44 }}>{label}</span>
      <code
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          background: 'var(--color-canvas)',
          border: '1px solid var(--color-hairline)',
          borderRadius: 6,
          padding: '3px 6px',
          fontSize: 11,
        }}
      >
        {value}
      </code>
      <button style={textBtn} onClick={() => void copy(value)}>
        Copy
      </button>
    </div>
  );
}
