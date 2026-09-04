/**
 * Artifact storage abstraction (roadmap C1.1 / C1.2).
 *
 * Every executor writes/reads its outputs through this interface instead of
 * calling `fs` directly. `FsArtifactStore` (C1.1) is backed by the shared
 * Docker volume; `S3ArtifactStore` (C1.2) is backed by S3/MinIO, selected via
 * `ARTIFACT_BACKEND=s3` — workers on different Kubernetes nodes no longer
 * need to share a filesystem at all.
 *
 * `key` is always a `/`-joined path *relative* to the store's root, e.g.
 * `${runId}/${nodeKey}/result.json`. Every path-shaped field an executor
 * returns (`csvPath`, `trainPath`, `weightsPath`, ...) is one of these keys,
 * NOT a resolved local path — it has to be, because the node that reads it
 * next may run on a different worker (a different machine, under S3) than
 * the node that wrote it. Whoever needs the bytes calls `localPath()` (or
 * `resolveIfStored()`) at the point of use to get something a Python script
 * can actually open.
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ArtifactStore {
  put(key: string, body: Buffer | Readable): Promise<void>;
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /**
   * Returns a real, local filesystem path for `key` — downloading it first if
   * the backend is remote. Does not create anything on disk: callers that
   * need the path to exist as a directory (e.g. a Python script's
   * `outputDir`) rely on the script's own `os.makedirs(..., exist_ok=True)`,
   * and callers writing a single file go through `put()`, which creates its
   * own parent directory.
   */
  localPath(key: string): Promise<string>;
  /**
   * Runs `fn` against a local directory scoped to `prefix` and returns
   * whatever `fn` returns, with every string field that names a path inside
   * that directory rewritten to the corresponding store key (roadmap C1.2
   * step 3 — "the Node executor downloads inputs to a temp dir before
   * spawning and uploads outputs after"). `FsArtifactStore` hands `fn` the
   * real persistent directory and does no rewriting (byte-for-byte C1.1
   * behaviour); `S3ArtifactStore` hands `fn` a scratch temp dir, uploads
   * every file written into it under `prefix` once `fn` resolves, and
   * rewrites `fn`'s return value so downstream nodes see S3 keys instead of
   * a temp path that stops existing the moment this call returns.
   */
  withOutputDir<T>(prefix: string, fn: (localDir: string) => Promise<T>): Promise<T>;
  presignedUrl?(key: string): Promise<string>;
}

/** Joins key segments with `/`, independent of the host OS path separator. */
export function joinKey(...segments: string[]): string {
  return segments.join('/');
}

// ─── FsArtifactStore (roadmap C1.1) ─────────────────────────────────────────

export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    // `key` is always `/`-joined; path.join normalizes it to the host separator.
    return path.join(this.root, key);
  }

  async put(key: string, body: Buffer | Readable): Promise<void> {
    const target = this.resolve(key);
    const tmp = `${target}.tmp`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await fsp.writeFile(tmp, body);
    } else {
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        body.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        body.pipe(ws);
      });
    }
    // Atomic tmp → rename: a crash mid-write leaves only the `.tmp` file, and
    // the real key is untouched, so a retry re-runs cleanly (same guarantee
    // the old `atomicWriteJson` gave every executor).
    await fsp.rename(tmp, target);
  }

  async get(key: string): Promise<Readable> {
    return fs.createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async localPath(key: string): Promise<string> {
    return this.resolve(key);
  }

  async withOutputDir<T>(prefix: string, fn: (localDir: string) => Promise<T>): Promise<T> {
    // Already the persistent, shared-volume location — nothing to upload, but
    // the Python script's return value still names files by their absolute
    // path (it only knows the directory it was handed). Rewrite those back to
    // store keys so an executor's output is shaped the same way under every
    // backend — anything else means every *consumer* of that output would
    // need to know which backend produced it.
    const dir = this.resolve(prefix);
    const result = await fn(dir);
    return rewriteAbsolutePaths(result, dir, prefix) as T;
  }
}

/** Replaces `dir` itself, or any path nested under it, with the equivalent store key. */
function rewriteAbsolutePaths(value: unknown, dir: string, prefix: string): unknown {
  if (typeof value === 'string') {
    if (value === dir) return prefix;
    if (value.startsWith(dir + path.sep)) {
      const rel = path.relative(dir, value).split(path.sep).join('/');
      return joinKey(prefix, rel);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteAbsolutePaths(v, dir, prefix));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteAbsolutePaths(v, dir, prefix);
    return out;
  }
  return value;
}

// ─── S3ArtifactStore (roadmap C1.2) ─────────────────────────────────────────

export interface S3ArtifactStoreOptions {
  bucket: string;
  region?: string;
  /** MinIO / any S3-compatible endpoint. Unset ⇒ real AWS S3. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * S3/MinIO-backed store. Every method streams straight to/from the bucket —
 * the only local disk it touches is a per-key download cache (so a run that
 * reads the same input twice doesn't re-fetch it) and the scratch directories
 * `withOutputDir` hands to Python.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly cacheDir: string;
  private bucketReady: Promise<void> | null = null;

  constructor(opts: S3ArtifactStoreOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region ?? 'us-east-1',
      endpoint: opts.endpoint,
      forcePathStyle: !!opts.endpoint, // MinIO requires path-style addressing
      credentials:
        opts.accessKeyId && opts.secretAccessKey
          ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
          : undefined,
    });
    this.cacheDir = path.join(os.tmpdir(), 'dag-artifact-cache');
  }

  /** Creates the bucket on first use if it doesn't exist yet. Idempotent, safe under races. */
  private async ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch {
          try {
            await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          } catch (err) {
            const name = (err as { name?: string }).name ?? '';
            // Another worker won the race to create it first — that's a success, not an error.
            if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
          }
        }
      })();
    }
    return this.bucketReady;
  }

  async put(key: string, body: Buffer | Readable): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
    // Invalidate any cached copy so a later localPath() doesn't serve stale bytes.
    await fsp.rm(this.cachePath(key), { force: true });
  }

  async get(key: string): Promise<Readable> {
    await this.ensureBucket();
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureBucket();
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  private cachePath(key: string): string {
    // `key` is `/`-joined and may contain nested "directories" (runId/nodeKey/file) —
    // splitting on `/` and rejoining with path.join gives a correct host-native path.
    return path.join(this.cacheDir, ...key.split('/'));
  }

  async localPath(key: string): Promise<string> {
    const target = this.cachePath(key);
    if (await this.pathExistsLocally(target)) return target;

    const tmp = `${target}.tmp`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const stream = await this.get(key);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      stream.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      stream.pipe(ws);
    });
    await fsp.rename(tmp, target);
    return target;
  }

  private async pathExistsLocally(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async withOutputDir<T>(prefix: string, fn: (localDir: string) => Promise<T>): Promise<T> {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dag-artifact-out-'));
    try {
      const result = await fn(tmpDir);
      const uploaded = await this.uploadTree(tmpDir, prefix);
      return this.rewriteOutputPaths(result, tmpDir, prefix, uploaded) as T;
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Uploads every file under `localDir` to `${keyPrefix}/<relative path>`. Returns a map of absolute local path → uploaded key. */
  private async uploadTree(localDir: string, keyPrefix: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const entries = await fsp.readdir(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(localDir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.uploadTree(abs, joinKey(keyPrefix, entry.name));
        for (const [k, v] of nested) map.set(k, v);
      } else {
        const key = joinKey(keyPrefix, entry.name);
        await this.put(key, await fsp.readFile(abs));
        map.set(abs, key);
      }
    }
    return map;
  }

  /** Replaces any string in `value` that names an uploaded local path (or the scratch dir itself) with its store key. */
  private rewriteOutputPaths(value: unknown, tmpDir: string, prefix: string, uploaded: Map<string, string>): unknown {
    if (typeof value === 'string') {
      if (uploaded.has(value)) return uploaded.get(value)!;
      if (value === tmpDir) return prefix;
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.rewriteOutputPaths(v, tmpDir, prefix, uploaded));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.rewriteOutputPaths(v, tmpDir, prefix, uploaded);
      }
      return out;
    }
    return value;
  }

  async presignedUrl(key: string): Promise<string> {
    await this.ensureBucket();
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: 900 }); // 15 minutes
  }
}

// ─── Convenience helpers built on the interface ────────────────────────────

export async function readJson<T = unknown>(store: ArtifactStore, key: string): Promise<T> {
  const stream = await store.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

export async function readText(store: ArtifactStore, key: string): Promise<string> {
  const stream = await store.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function writeJson(store: ArtifactStore, key: string, data: unknown): Promise<void> {
  await store.put(key, Buffer.from(JSON.stringify(data, null, 2)));
}

/** SHA-256 of an artifact already stored under `key`. */
export async function sha256(store: ArtifactStore, key: string): Promise<string> {
  const stream = await store.get(key);
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * If `value` is a key this store actually holds, resolves it to a real local
 * path (downloading it first, if remote). Otherwise returns `value`
 * unchanged — some config fields (`pandas.preprocess`'s own `csvPath`, e.g.)
 * accept either a template ref to an upstream artifact OR a literal path the
 * Python script resolves itself (relative to its own `python/` directory, or
 * the bundled dataset). Trying the store first and falling through covers
 * both without the executor needing to know which one it got.
 */
export async function resolveIfStored(store: ArtifactStore, value: unknown): Promise<unknown> {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (await store.exists(value)) return store.localPath(value);
  return value;
}

export type ArtifactBackend = 'fs' | 's3';

export interface ArtifactStoreEnv {
  ARTIFACT_BACKEND: ArtifactBackend;
  ARTIFACT_DIR: string;
  ARTIFACT_S3_BUCKET?: string;
  ARTIFACT_S3_ENDPOINT?: string;
  ARTIFACT_S3_REGION?: string;
  ARTIFACT_S3_ACCESS_KEY_ID?: string;
  ARTIFACT_S3_SECRET_ACCESS_KEY?: string;
}

export function createArtifactStore(env: ArtifactStoreEnv): ArtifactStore {
  switch (env.ARTIFACT_BACKEND) {
    case 'fs':
      return new FsArtifactStore(env.ARTIFACT_DIR);
    case 's3':
      if (!env.ARTIFACT_S3_BUCKET) {
        throw new Error('ARTIFACT_BACKEND=s3 requires ARTIFACT_S3_BUCKET to be set');
      }
      return new S3ArtifactStore({
        bucket: env.ARTIFACT_S3_BUCKET,
        region: env.ARTIFACT_S3_REGION,
        endpoint: env.ARTIFACT_S3_ENDPOINT,
        accessKeyId: env.ARTIFACT_S3_ACCESS_KEY_ID,
        secretAccessKey: env.ARTIFACT_S3_SECRET_ACCESS_KEY,
      });
    default: {
      const exhaustive: never = env.ARTIFACT_BACKEND;
      throw new Error(`Unknown ARTIFACT_BACKEND: ${String(exhaustive)}`);
    }
  }
}
