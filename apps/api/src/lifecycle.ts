/**
 * Process lifecycle flag, shared between `index.ts` (which owns the SIGTERM
 * handler) and `app.ts`'s `/health/ready` route (roadmap C3.2).
 *
 * Kubernetes sends SIGTERM, then keeps routing traffic to the pod for a
 * short window while endpoints propagate. If `/health/ready` kept returning
 * 200 during that window, the load balancer would send requests to a process
 * that's already draining its connections. Flipping this flag on the first
 * SIGTERM makes readiness fail immediately, so the pod is pulled from the
 * Service's endpoints before `server.close()` starts refusing connections.
 */
let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
