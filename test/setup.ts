// Unit tests must not depend on a developer's .env: pin every value config validates.
// dotenv never overrides variables that are already set, so these win over .env.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_API_KEY = '';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.TYPESENSE_API_KEY = 'test';
