import type { Context } from 'hono';
import type { ZodError } from 'zod';

/** Uniform 400 response for schema validation failures. */
export function validationError(c: Context, error: ZodError): Response {
  return c.json(
    {
      error: 'invalid_request',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
    400,
  );
}
