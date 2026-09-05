/**
 * Roadmap C1.2 — download links for node-run artifacts.
 *
 * A NodeRun's `output` holds artifact-store KEYS (`{runId}/{nodeKey}/file`),
 * not paths a browser can fetch directly — under the S3 backend they live in
 * a private bucket, and under the fs backend they live on a volume only the
 * API/worker containers can reach. This resolves one such key into something
 * the run-detail UI can put behind a "Download" link: a presigned S3 URL to
 * redirect to, or (fs backend) a direct file stream.
 */

import * as fs from 'fs';
import * as path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma, runBelongsToTenant } from '@dag/db';
import { env } from '../env';
import { NotFoundError, ValidationError } from '../errors';

// Signing uses a separate client pointed at the PUBLIC endpoint (see the doc
// comment on ARTIFACT_S3_PUBLIC_ENDPOINT) — the host embedded in a presigned
// URL comes from the client's own configured endpoint, and a browser can
// never reach MinIO's internal Docker service name.
let presignClient: S3Client | null = null;
function getPresignClient(): S3Client {
  if (!presignClient) {
    const endpoint = env.ARTIFACT_S3_PUBLIC_ENDPOINT ?? env.ARTIFACT_S3_ENDPOINT;
    presignClient = new S3Client({
      region: env.ARTIFACT_S3_REGION,
      endpoint,
      forcePathStyle: !!endpoint,
      credentials:
        env.ARTIFACT_S3_ACCESS_KEY_ID && env.ARTIFACT_S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.ARTIFACT_S3_ACCESS_KEY_ID, secretAccessKey: env.ARTIFACT_S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  return presignClient;
}

export type ArtifactDownload =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; absolutePath: string; filename: string };

/**
 * Resolves `output[field]` on the given NodeRun into a download descriptor.
 *
 * Roadmap A3: `tenantId` must own the run, checked the same way every other
 * run route checks it (`runBelongsToTenant`) — 404, not 403, on a mismatch.
 * Independently, it also checks that the requested key's own `{runId}/...`
 * prefix matches the run being queried, so the route can't be used to fetch
 * an arbitrary key by guessing a field name even within the right tenant.
 */
export async function resolveArtifactDownload(
  runId: string,
  nodeKey: string,
  field: string,
  tenantId: string,
): Promise<ArtifactDownload> {
  if (!(await runBelongsToTenant(runId, tenantId))) throw new NotFoundError('Run', runId);

  const nodeRun = await prisma.nodeRun.findFirst({
    where: { runId, nodeKey },
    select: { output: true },
  });
  if (!nodeRun) throw new NotFoundError('NodeRun', `${runId}/${nodeKey}`);

  const output = nodeRun.output as Record<string, unknown> | null;
  const key = output?.[field];
  if (typeof key !== 'string' || key.length === 0) {
    throw new NotFoundError('Artifact', `${runId}/${nodeKey}/${field}`);
  }
  if (key.split('/')[0] !== runId) {
    // Defense in depth: every key this store ever hands out is prefixed with
    // its own runId, so a mismatch means the field doesn't actually name a
    // store-managed artifact (e.g. a literal user-typed config value).
    throw new ValidationError(`"${field}" on this node is not a downloadable artifact reference`);
  }

  if (env.ARTIFACT_BACKEND === 's3') {
    if (!env.ARTIFACT_S3_BUCKET) throw new Error('ARTIFACT_BACKEND=s3 requires ARTIFACT_S3_BUCKET');
    const cmd = new GetObjectCommand({ Bucket: env.ARTIFACT_S3_BUCKET, Key: key });
    const url = await getSignedUrl(getPresignClient(), cmd, { expiresIn: 900 });
    return { kind: 'redirect', url };
  }

  const absolutePath = path.join(env.ARTIFACT_DIR, key);
  if (!fs.existsSync(absolutePath)) {
    throw new NotFoundError('Artifact', key);
  }
  return { kind: 'stream', absolutePath, filename: path.basename(absolutePath) };
}
