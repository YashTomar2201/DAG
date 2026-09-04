/**
 * Roadmap C1.1/C1.2 — ArtifactStore unit tests.
 *
 * `FsArtifactStore` is exercised against a real temp directory (it's just a
 * thin `fs` wrapper — no value in mocking the filesystem). `S3ArtifactStore`
 * is exercised against a mocked `S3Client` (`aws-sdk-client-mock`) since a
 * real MinIO/S3 endpoint isn't available in the unit-test environment; the
 * `ARTIFACT_BACKEND=s3` end-to-end path is verified separately against a real
 * MinIO container (see decisions_log.md, C1.2).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  FsArtifactStore,
  S3ArtifactStore,
  readJson,
  writeJson,
  sha256,
  resolveIfStored,
  joinKey,
} from './artifact-store';

function toReadable(s: string): Readable {
  return Readable.from([Buffer.from(s)]);
}

// ─── FsArtifactStore ────────────────────────────────────────────────────────

describe('FsArtifactStore', () => {
  let root: string;
  let store: FsArtifactStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-fs-store-test-'));
    store = new FsArtifactStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('put/get/exists round-trip, and no leftover .tmp file', async () => {
    await store.put('a/b/file.json', Buffer.from('{"x":1}'));
    expect(await store.exists('a/b/file.json')).toBe(true);
    expect(await store.exists('a/b/missing.json')).toBe(false);
    expect(fs.existsSync(path.join(root, 'a/b/file.json.tmp'))).toBe(false);

    const stream = await store.get('a/b/file.json');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"x":1}');
  });

  it('localPath resolves under root without creating anything', async () => {
    const p = await store.localPath('x/y/z.txt');
    expect(p).toBe(path.join(root, 'x', 'y', 'z.txt'));
    expect(fs.existsSync(p)).toBe(false); // pure resolver, no side effects
  });

  it('withOutputDir hands back the real persistent directory, and rewrites absolute paths in the result back to keys', async () => {
    const result = await store.withOutputDir('run1/nodeA', async (dir) => {
      expect(dir).toBe(path.join(root, 'run1', 'nodeA'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'out.txt'), 'hello');
      return { outPath: path.join(dir, 'out.txt'), outputDir: dir };
    });
    // The file is written straight to its final location (no upload step)...
    expect(fs.readFileSync(path.join(root, 'run1', 'nodeA', 'out.txt'), 'utf8')).toBe('hello');
    // ...but the RETURNED value is shaped the same way S3ArtifactStore shapes
    // it: keys, not absolute paths, so a consumer never needs to know which
    // backend produced this output.
    expect(result).toEqual({ outPath: 'run1/nodeA/out.txt', outputDir: 'run1/nodeA' });
  });

  it('readJson/writeJson/sha256 helpers work against the store', async () => {
    await writeJson(store, 'k.json', { a: 1 });
    expect(await readJson(store, 'k.json')).toEqual({ a: 1 });
    const hash = await sha256(store, 'k.json');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('resolveIfStored returns the local path for a real key, and passes through a literal value unchanged', async () => {
    await writeJson(store, 'run1/extract/data.csv', 'ignored');
    const resolved = await resolveIfStored(store, 'run1/extract/data.csv');
    expect(resolved).toBe(path.join(root, 'run1', 'extract', 'data.csv'));

    const literal = await resolveIfStored(store, 'my_own_data.csv');
    expect(literal).toBe('my_own_data.csv'); // not a key we hold — pass through

    expect(await resolveIfStored(store, undefined)).toBeUndefined();
  });
});

// ─── S3ArtifactStore ────────────────────────────────────────────────────────

describe('S3ArtifactStore', () => {
  const s3Mock = mockClient(S3Client);
  // S3ArtifactStore's local download cache lives at a fixed os.tmpdir() path
  // (by design — it's meant to survive across calls within one process). That
  // means it also survives across test runs unless each test's keys are
  // unique, or the cache is wiped — wipe it so tests can reuse plain keys
  // like "run1/node/file.txt" without leaking state between them.
  const cacheDir = path.join(os.tmpdir(), 'dag-artifact-cache');
  let store: S3ArtifactStore;

  beforeEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    s3Mock.reset();
    s3Mock.on(HeadBucketCommand).resolves({});
    store = new S3ArtifactStore({ bucket: 'test-bucket', endpoint: 'http://localhost:9000' });
  });

  it('put uploads via PutObjectCommand to the configured bucket/key', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await store.put('run1/node/result.json', Buffer.from('{}'));

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({ Bucket: 'test-bucket', Key: 'run1/node/result.json' });
  });

  it('exists() reflects HeadObjectCommand success/failure', async () => {
    s3Mock.on(HeadObjectCommand, { Key: 'present.json' }).resolves({});
    s3Mock.on(HeadObjectCommand, { Key: 'absent.json' }).rejects(new Error('NotFound'));

    expect(await store.exists('present.json')).toBe(true);
    expect(await store.exists('absent.json')).toBe(false);
  });

  it('localPath downloads once and caches locally on the second call', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: toReadable('hello world') as never });

    const p1 = await store.localPath(joinKey('run1', 'node', 'file.txt'));
    expect(fs.readFileSync(p1, 'utf8')).toBe('hello world');
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);

    // Second call hits the local cache — no second GetObjectCommand.
    const p2 = await store.localPath(joinKey('run1', 'node', 'file.txt'));
    expect(p2).toBe(p1);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });

  it('put() invalidates a stale cached copy', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: toReadable('v1') as never });
    const key = joinKey('run1', 'node', 'v.txt');
    const p1 = await store.localPath(key);
    expect(fs.readFileSync(p1, 'utf8')).toBe('v1');

    s3Mock.on(PutObjectCommand).resolves({});
    await store.put(key, Buffer.from('v2'));

    s3Mock.on(GetObjectCommand).resolves({ Body: toReadable('v2') as never });
    const p2 = await store.localPath(key);
    expect(fs.readFileSync(p2, 'utf8')).toBe('v2');
  });

  it('withOutputDir uploads every file written into the scratch dir and rewrites path fields to keys', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const result = await store.withOutputDir('run1/train', async (dir) => {
      const weightsPath = path.join(dir, 'model.pt');
      fs.writeFileSync(weightsPath, 'binary-weights');
      return { weightsPath, outputDir: dir, epochs: 10 };
    });

    expect(result).toEqual({
      weightsPath: 'run1/train/model.pt',
      outputDir: 'run1/train',
      epochs: 10,
    });

    const puts = s3Mock.commandCalls(PutObjectCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.args[0].input).toMatchObject({ Bucket: 'test-bucket', Key: 'run1/train/model.pt' });
  });

  it('withOutputDir cleans up the scratch directory afterward', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    let capturedDir = '';
    await store.withOutputDir('run1/node', async (dir) => {
      capturedDir = dir;
      fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    });
    expect(fs.existsSync(capturedDir)).toBe(false);
  });
});
