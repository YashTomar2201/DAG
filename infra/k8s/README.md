# DAG Engine on Kubernetes (roadmap C3.1 + C3.2)

Fixed-replica manifests for the whole stack: `postgres` + `redis` + a one-shot
`dag-migrate` Job + `api` (1 replica) + `worker` (2 replicas) + `web`, plus a
`PodDisruptionBudget` and an optional `Ingress`.

No autoscaling yet — that's C3.3 (KEDA).

**Health & shutdown (C3.2).** Both `api` and `worker` expose:
- `/health/live` — process is up. Backs `livenessProbe`; never checks
  Postgres/Redis, so a transient dependency blip can't drive a restart loop.
- `/health/ready` — Postgres *and* Redis both reachable, and not mid-SIGTERM.
  Backs `readinessProbe`; a failure only pulls the pod from its Service /
  tells the PDB it isn't serving — no restart. On SIGTERM this flips to 503
  *first*, then the process drains, so Kubernetes stops routing here before
  connections close.

The worker has no Express app — its probe endpoints are a ~60-line
`node:http` server (`apps/worker/src/health-server.ts`) on
`WORKER_HEALTH_PORT` (3002). `worker.close()` on SIGTERM stops new-job polling
and lets in-flight jobs finish; `terminationGracePeriodSeconds: 3600` gives a
long training job time to complete before SIGKILL (raise toward 14400 —
`torch.train`'s 4h ceiling — for an environment that must never force-kill a
job on a drain). `minAvailable: 1` in `pdb.yaml` keeps a voluntary node drain
from evicting both workers at once.

## Two shapes

| | Nodes | Artifacts | RAM for Docker |
|---|---|---|---|
| **Single-node base** (default) | 1 | `fs` backend on one shared RWO PVC (`artifacts.yaml`) | ~2–3 GB |
| **Multi-node / S3** | 3 | `s3` backend against in-cluster MinIO (`minio.yaml`) | ~8 GB |

The single-node base is what fits on a memory-constrained box. Every pod lands
on the one node, so a `ReadWriteOnce` PVC mounted into api + both workers
behaves exactly like the compose stack's shared `artifact_data` volume.

The multi-node path is the roadmap's literal "workers on different nodes"
check — the api and worker pods land on different hosts with no shared disk,
so artifacts must go through object storage. That's roadmap C3's own
precondition ("Needs C1 first") and the shape a real cloud deployment uses.
The `fs`↔`s3` swap here mirrors how `docker-compose.s3.yml` overlays the
compose base.

---

## Single-node bring-up (kind)

```bash
# 1. A one-node cluster.
kind create cluster --name dag-engine --config infra/k8s/kind-cluster.yaml

# 2. Build the four images. `migrate` is Dockerfile.api's `build` stage
#    (it needs the Prisma CLI the runtime image strips).
docker build -f infra/Dockerfile.api                 -t dag-engine/api:local     .
docker build -f infra/Dockerfile.api --target build  -t dag-engine/migrate:local .
docker build -f infra/Dockerfile.worker              -t dag-engine/worker:local  .
docker build -f infra/Dockerfile.web \
  --build-arg VITE_API_URL=http://api.dag.localtest.me:8080 \
  -t dag-engine/web:local .

# 3. Load them into the cluster (kind nodes can't see the host Docker daemon).
kind load docker-image --name dag-engine \
  dag-engine/api:local dag-engine/migrate:local dag-engine/worker:local dag-engine/web:local

# 4. Apply everything.
kubectl apply -k infra/k8s

# 5. Watch it come up. api/worker sit in Init until dag-migrate completes.
kubectl -n dag-engine get pods -w
```

### Optional — the Ingress

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=180s
# then: http://web.dag.localtest.me:8080  and  http://api.dag.localtest.me:8080
```

`*.localtest.me` always resolves to 127.0.0.1, so no `/etc/hosts` edit is
needed. Without an ingress controller the Ingress object is inert and you
reach the api via a port-forward (below).

---

## Smoke test — the reference pipeline end-to-end

```bash
kubectl -n dag-engine get pods -o wide          # everything Running
kubectl -n dag-engine port-forward svc/api 3001:3001 &

KEY=dev-key-local-only
WF=$(curl -s -XPOST localhost:3001/workflows -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{
    "name":"k8s-smoke",
    "graph":{"nodes":[
      {"key":"extract","type":"data.source","label":"E","position":{"x":0,"y":0},"config":{}},
      {"key":"preprocess","type":"pandas.preprocess","label":"P","position":{"x":200,"y":0},"config":{"scriptPath":"preprocess.py"}},
      {"key":"train","type":"torch.train","label":"T","position":{"x":400,"y":0},"config":{"scriptPath":"train.py","epochs":2}},
      {"key":"evaluate","type":"model.evaluate","label":"V","position":{"x":600,"y":0},"config":{"scriptPath":"evaluate.py"}}
    ],"edges":[
      {"from":"extract","to":"preprocess"},{"from":"preprocess","to":"train"},{"from":"train","to":"evaluate"}
    ]}}')
VID=$(echo "$WF" | grep -o '"versionId":"[^"]*"' | cut -d'"' -f4)
RUN=$(curl -s -XPOST localhost:3001/runs -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d "{\"workflowVersionId\":\"$VID\"}")
RID=$(echo "$RUN" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# Poll to SUCCEEDED:
curl -s localhost:3001/runs/$RID -H "Authorization: Bearer $KEY"

# Which worker replica ran each node (both replicas share the queues):
kubectl -n dag-engine logs -l app=worker --prefix --tail=-1 | grep "$RID"
```

### C3.2 checks — probes + graceful shutdown

```bash
# 1. Readiness reflects dependency health. Kill Redis and watch api/worker
#    go NotReady (no restart — liveness still passes), then recover.
kubectl -n dag-engine scale statefulset/redis --replicas=0
kubectl -n dag-engine get pods -w        # api + workers -> READY 0/1, STATUS still Running
kubectl -n dag-engine scale statefulset/redis --replicas=1   # -> READY 1/1 again

# 2. `kubectl delete pod <worker>` mid-run doesn't fail the run. Start a run
#    with a slow train (epochs: 400), then delete the worker holding it:
kubectl -n dag-engine delete pod <the-worker-pod> --grace-period=3600 &
#    -> the pod goes Terminating but keeps running its in-flight job until it
#       finishes (worker.close() drains); the run still reaches SUCCEEDED, and
#       the replacement pod picks up the rest.

# 3. The PDB blocks a double eviction:
kubectl -n dag-engine drain <node> --dry-run=server --ignore-daemonsets   # would evict 1 worker, not 2
```

---

## Multi-node / S3

```bash
kind delete cluster --name dag-engine
kind create cluster --name dag-engine --config infra/k8s/kind-cluster-multinode.yaml
# build + load images as above, then:

#  a) add minio to the kustomization
#     (edit infra/k8s/kustomization.yaml: add `- minio.yaml` to resources,
#      remove `- artifacts.yaml`)
#  b) flip the artifact backend
kubectl -n dag-engine create configmap dag-config --from-literal=... # or edit config.yaml:
#       ARTIFACT_BACKEND: s3
#       ARTIFACT_S3_BUCKET: dag-artifacts
#       ARTIFACT_S3_ENDPOINT: http://minio:9000
#       ARTIFACT_S3_PUBLIC_ENDPOINT: http://api.dag.localtest.me:8080   (or a real endpoint)
#       ARTIFACT_S3_REGION: us-east-1
#  c) the S3 creds are already in secret.yaml (ARTIFACT_S3_ACCESS_KEY_ID /
#     _SECRET_ACCESS_KEY) — add them as env to api.yaml + worker.yaml from
#     that secret, and drop the `artifacts` volume/volumeMount from both.

kubectl apply -k infra/k8s
kubectl -n dag-engine get pods -o wide -l app=worker   # the 2 replicas on different nodes
```

The anti-affinity rule in `worker.yaml` is `preferred`, so on the multi-node
cluster the two worker replicas land on the two worker nodes; run the smoke
test above and confirm from `logs -o wide` that `preprocess` and `train` ran
on different nodes yet each found the other's artifact (proving cross-node
data flow through S3).

---

## Tear down

```bash
kind delete cluster --name dag-engine
```
