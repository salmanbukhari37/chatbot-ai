import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { logger } from '../logger';
import { answerOnePass } from '../services/rag';
import { SDK_LANGUAGES, type AppEnv, type StreamEvent } from '../types';
import { validationError } from './validation';

const ChatRequestSchema = z
  .object({
    message: z.string().trim().min(1, 'message is required').max(4000),
    sessionId: z
      .string()
      .trim()
      .min(1, 'sessionId is required')
      .max(128)
      .regex(/^[\w-]+$/, 'sessionId may only contain letters, numbers, "_" and "-"'),
    /** SDK language the reader has selected in the portal, to prefer matching code samples */
    language: z.enum(SDK_LANGUAGES).optional(),
  })
  .strict();

/** Mounted behind requirePortal: `c.get('portal')` is the authenticated tenant. */
export const chatRoutes = new Hono<AppEnv>();

chatRoutes.post('/stream', async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error);

  const portal = c.get('portal');
  const { message, sessionId, language } = parsed.data;
  const requestId = c.get('requestId');

  c.header('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => {
      abort.abort();
    });
    const send = (event: StreamEvent) => stream.writeSSE({ data: JSON.stringify(event) });

    try {
      for await (const event of answerOnePass({ portal, message, sessionId, language, signal: abort.signal })) {
        if (abort.signal.aborted) break;
        await send(event);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        logger.error({ err, requestId, portalId: portal.id }, 'chat stream failed');
        await send({ type: 'error', message: 'The assistant failed to generate a response. Please try again.' });
      }
    } finally {
      if (!abort.signal.aborted) await send({ type: 'done' });
    }
  });
});
