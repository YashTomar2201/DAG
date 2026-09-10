/**
 * OpenTelemetry bootstrap for the API process (roadmap C4 step 4).
 *
 * Imported on the FIRST line of `index.ts` so the SDK patches http / express /
 * pg / ioredis before anything else pulls them in. No-ops unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set — see `@dag/otel`.
 */
import { startTracing } from '@dag/otel';

startTracing(process.env['OTEL_SERVICE_NAME'] ?? 'dag-api');
