/**
 * Error taxonomy for the DAG worker.
 *
 * Two classes:
 *
 * `RetryableError` — transient problems. BullMQ will retry the job up to
 *   the configured attempt limit using exponential-jitter backoff.
 *   Examples: network timeouts, Kaggle 429 rate-limit, transient FS lock.
 *
 * `UnrecoverableError` (re-exported from BullMQ) — permanent failures.
 *   BullMQ skips all remaining retries immediately and moves the job to
 *   the failed set. Examples: bad API credentials, Python SyntaxError,
 *   missing script file, schema validation failure.
 *
 * Why the distinction matters:
 *   If you classify a bad-credentials 403 as retryable, BullMQ retries it 3
 *   times with exponential backoff — taking ~14 s to eventually move the job
 *   to the failed set. Worse, if Kaggle rate-limits retry traffic, those
 *   retries eat quota. Classifying it as unrecoverable fails immediately,
 *   surfaces the real problem (fix your env var) instantly, and burns no
 *   quota on doomed requests.
 */

export { UnrecoverableError } from 'bullmq';

export class RetryableError extends Error {
  readonly taxonomy = 'retryable' as const;

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}
