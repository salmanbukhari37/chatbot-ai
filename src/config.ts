import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Admin API (portal management, ingest for any portal). Unset disables it entirely.
  ADMIN_API_KEY: optionalString
    .refine((value) => value === undefined || value.length >= 32, {
      message: 'ADMIN_API_KEY must be at least 32 characters',
    })
    .refine((value) => !value?.startsWith('change-me'), {
      message: 'ADMIN_API_KEY is still the .env.example placeholder; generate one with `openssl rand -base64 48`',
    }),
  // Per client IP, per portal
  RATE_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(60),
  // Ceiling for a whole portal, unless the portal row overrides it
  DEFAULT_PORTAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  // Only enable behind a proxy you control: X-Forwarded-For is trusted for client IPs
  TRUST_PROXY: bool,
  INGEST_MAX_BODY_MB: z.coerce.number().positive().max(200).default(50),

  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  CHAT_MODEL: z.string().default('gpt-4o'),
  FAST_MODEL: z.string().default('gpt-4o-mini'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(256).max(4000).default(3072),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  TYPESENSE_HOST: z.string().default('localhost'),
  TYPESENSE_PORT: z.coerce.number().int().positive().default(8108),
  TYPESENSE_PROTOCOL: z.enum(['http', 'https']).default('http'),
  TYPESENSE_API_KEY: z.string().min(1, 'TYPESENSE_API_KEY is required'),
  TYPESENSE_COLLECTION: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('portal_chunks'),

  COHERE_API_KEY: optionalString,
  COHERE_RERANK_MODEL: z.string().default('rerank-v3.5'),

  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  LANGFUSE_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://cloud.langfuse.com'),
});

export type Config = z.infer<typeof EnvSchema>;

function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = loadConfig();
