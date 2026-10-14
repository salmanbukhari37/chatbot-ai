import pino from 'pino';
import { config } from './config';

interface SafeError {
  type: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string;
  cause?: SafeError;
  errors?: SafeError[];
}

/**
 * Serialize errors from an allow-list of fields only. HTTP client errors (axios, used by the
 * Typesense SDK; fetch-based SDKs) carry request config including auth headers, and the default
 * serializer would copy every enumerable property — API keys included — into the logs.
 */
export function serializeError(err: unknown, depth = 0): SafeError {
  if (!(err instanceof Error)) return { type: typeof err, message: String(err) };
  const record = err as Error & { code?: unknown; status?: unknown; httpStatus?: unknown; statusCode?: unknown };
  const status = [record.status, record.httpStatus, record.statusCode].find((v) => typeof v === 'number');
  const safe: SafeError = {
    type: err.name,
    message: err.message,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    ...(config.NODE_ENV === 'production' ? {} : { stack: err.stack }),
  };
  if (depth < 3) {
    if (err.cause !== undefined) safe.cause = serializeError(err.cause, depth + 1);
    if (err instanceof AggregateError) safe.errors = err.errors.map((e) => serializeError(e, depth + 1));
  }
  return safe;
}

/**
 * Structured JSON logs in production; pretty output in development.
 * Errors go through `serializeError`; known secret-bearing paths are redacted as a second line of defence.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'chatbot-ai' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie', '*.apiKey', '*.token'],
    censor: '[redacted]',
  },
  serializers: { err: serializeError },
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
});

export type Logger = typeof logger;
