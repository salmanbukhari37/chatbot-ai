/** A parsed source document, before chunking. */
export interface ParsedDocument {
  /** URL path relative to the portal root, e.g. "guides/intro". The portal root page is "index". */
  slug: string;
  /** Top-level area of the portal the page belongs to: "api/<spec>", "guides", "sdks", ... */
  section: string;
  title: string;
  description: string;
  /** Absolute public URL of the page (portal base URL + slug) */
  url: string;
  /** Clean markdown (frontmatter and JSX removed) */
  content: string;
  /** sha256 of title + description + content, used to skip unchanged pages */
  contentHash: string;
  lastModified: Date;
  sourcePath: string;
}

export interface ChunkMetadata {
  title: string;
  slug: string;
  section: string;
  /** Heading the chunk belongs to (H2/H3), or the page title for the intro section */
  heading: string;
  url: string;
  contentHash: string;
  lastModified: Date;
}

export interface Chunk extends ChunkMetadata {
  /** Deterministic id derived from portal + slug + content hash */
  id: string;
  /** Position of the chunk inside its page */
  chunkIndex: number;
  /** Chunk text, prefixed with "<title> > <heading>" */
  content: string;
  tokenCount: number;
  hasCode: boolean;
}

export interface SearchResult {
  content: string;
  title: string;
  slug: string;
  url: string;
  score: number;
  heading?: string;
}

/** Internal candidate carried through hybrid fusion. */
export interface Candidate extends SearchResult {
  id: string;
  vectorScore: number;
  bm25Score: number;
}

export interface SearchOptions {
  topK?: number;
  /** Restrict to chunks that contain fenced code blocks */
  codeOnly?: boolean;
}

export interface Source {
  url: string;
  title: string;
}

/** Server-sent events emitted by POST /v1/chat/stream */
export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; tool: string }
  | { type: 'sources'; data: Source[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const SDK_LANGUAGES = ['csharp', 'typescript', 'python'] as const;
export type SdkLanguage = (typeof SDK_LANGUAGES)[number];

export type PortalStatus = 'active' | 'disabled';

/** A tenant's documentation portal. Key hashes never leave the data layer. */
export interface Portal {
  id: string;
  name: string;
  /** APIMatic account (tenant) that owns the portal */
  tenantId: string;
  /** Public base URL of the deployed portal (e.g. https://example.com/docs); citation links are built from it */
  baseUrl: string;
  /** Browser origins allowed to call the chat API with this portal's public key */
  allowedOrigins: string[];
  status: PortalStatus;
  /** Overrides DEFAULT_PORTAL_RATE_LIMIT_PER_MINUTE when set */
  rateLimitPerMinute: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Hono context variables set by middleware. */
export interface AppEnv {
  Variables: {
    requestId: string;
    /** Set by portal-auth middleware on tenant-scoped routes */
    portal: Portal;
  };
}
