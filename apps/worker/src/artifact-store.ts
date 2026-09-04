/**
 * Artifact storage abstraction (roadmap C1.1).
 *
 * Every executor writes/reads its outputs through this interface instead of
 * calling `fs` directly. Today there is exactly one implementation
 * (`FsArtifactStore`, backed by the shared Docker volume) so behaviour is
 * byte-for-byte identical to before this refactor — but the seam means a
 * future `S3ArtifactStore` (roadmap C1.2) is a drop-in swap: workers on
 * different Kubernetes nodes stop needing to share a filesystem at all.
 *
 * `key` is always a `/`-joined path *relative* to the store's root, e.g.
 * `${runId}/${nodeKey}/result.json`.
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Readable } from 'stream';

export interface ArtifactStore {
  put(key: string, body: Buffer | Readable): Promise<void>;
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /**
   * Returns a real, local filesystem path for `key` — downloading it first if
   * the backend is remote (S3, in C1.2). Does not create anything on disk:
   * callers that need the path to exist as a directory (e.g. a Python
   * script's `outputDir`) rely on the script's own `os.makedirs(..., exist_ok=True)`,
   * and callers writing a single file go through `put()`, which creates its
   * own parent directory.
   */
  localPath(key: string): Promise<string>;
  presignedUrl?(key: string): Promise<string>;
}

/** Joins key segments with `/`, independent of the host OS path separator. */
export function joinKey(...segments: string[]): string {
  return segments.join('/');
}

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
 * SHA-256 of an arbitrary absolute local path — used only where an executor
 * checksums a path handed to it by *upstream input* (e.g. `registry.deploy`
 * checksumming another node's `weightsPath`), not a key this store allocated.
 * Kept in this module so `fs` stays out of `executors.ts` entirely.
 */
export async function sha256OfPath(absolutePath: string): Promise<string> {
  const stream = fs.createReadStream(absolutePath);
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

/** Does an arbitrary absolute local path exist? Same rationale as `sha256OfPath`. */
export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export type ArtifactBackend = 'fs';

export function createArtifactStore(backend: ArtifactBackend, root: string): ArtifactStore {
  switch (backend) {
    case 'fs':
      return new FsArtifactStore(root);
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unknown ARTIFACT_BACKEND: ${String(exhaustive)}`);
    }
  }
}
