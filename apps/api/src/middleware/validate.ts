import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema} from 'zod';
import { ZodError } from 'zod';

/**
 * Factory that returns an Express middleware which parses and validates
 * `req.body` against the given Zod schema.
 *
 * On success: replaces `req.body` with the parsed (typed, coerced) value.
 * On failure: calls `next(zodError)` → the central error handler returns 400.
 *
 * Usage:
 *   router.post('/workflows', validateBody(CreateWorkflowSchema), handler)
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(result.error);
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Factory that validates `req.params` against a Zod schema.
 * Useful for ensuring route params like `:id` are non-empty strings.
 */
export function validateParams<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(new ZodError(result.error.issues));
      return;
    }
    next();
  };
}
