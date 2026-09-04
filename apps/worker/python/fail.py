#!/usr/bin/env python3
"""
Test fixture: a script that always fails with a plain (retryable) error.

Used by `apps/api/src/integration/retry-policy.integration.test.ts` to exercise
the per-node `retryPolicy` (roadmap B5). Its stderr deliberately avoids the
substrings `python-bridge.ts` treats as unrecoverable (SyntaxError,
ModuleNotFoundError, "No such file or directory", …) so BullMQ retries it.
"""
import sys
import json

# Consume the stdin payload so the bridge's write doesn't EPIPE.
sys.stdin.read()

sys.stderr.write("intentional retryable failure (B5 retry-policy fixture)\n")
sys.exit(1)
