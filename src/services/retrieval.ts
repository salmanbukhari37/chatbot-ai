import { config } from '../config';
import { HALFVEC_EXPR, toVectorParam, withTransaction } from '../db/postgres';
import { chunkCollection, portalFilter } from '../db/typesense';
import type { Candidate, SearchOptions, SearchResult } from '../types';
import { embedQuery } from './embeddings';
import { rerank } from './reranker';
import { logger } from '../logger';

const CANDIDATES_PER_RETRIEVER = 20;
const RERANK_POOL = 20;
const DEFAULT_TOP_K = 5;
const VECTOR_WEIGHT = 0.6;
const BM25_WEIGHT = 0.4;

const DIMS = config.EMBEDDING_DIMENSIONS;

interface RawHit {
  id: string;
  portal_id: string;
  slug: string;
  title: string;
  heading: string;
  url: string;
  content: string;
  score: number;
}

async function vectorSearch(portalId: string, query: string, options: SearchOptions): Promise<RawHit[]> {
  const embedding = await embedQuery(query);
  return withTransaction(async (client) => {
    // HNSW filters *after* the index scan, so a small tenant in a large index could get too few rows.
    // pgvector >= 0.8 iterative scans keep walking the graph until LIMIT rows pass the portal filter.
    await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
    await client.query('SET LOCAL hnsw.ef_search = 100');
    const { rows } = await client.query<RawHit>(
      `SELECT id, portal_id, slug, title, heading, url, content,
              1 - (${HALFVEC_EXPR} <=> $2::halfvec(${DIMS})) AS score
         FROM chunks
        WHERE portal_id = $1 AND ($4::boolean IS FALSE OR has_code)
        ORDER BY ${HALFVEC_EXPR} <=> $2::halfvec(${DIMS})
        LIMIT $3`,
      [portalId, toVectorParam(embedding), CANDIDATES_PER_RETRIEVER, options.codeOnly ?? false],
    );
    return rows;
  });
}

async function keywordSearch(portalId: string, query: string, options: SearchOptions): Promise<RawHit[]> {
  const response = await chunkCollection()
    .documents()
    .search({
      q: query,
      query_by: 'title,heading,content',
      query_by_weights: '2,3,1',
      per_page: CANDIDATES_PER_RETRIEVER,
      num_typos: 1,
      drop_tokens_threshold: 1,
      prioritize_exact_match: true,
      filter_by: options.codeOnly ? portalFilter(portalId, 'has_code:=true') : portalFilter(portalId),
    });
  return (response.hits ?? []).map((hit) => ({
    id: hit.document.id,
    portal_id: hit.document.portal_id,
    slug: hit.document.slug,
    title: hit.document.title,
    heading: hit.document.heading,
    url: hit.document.url,
    content: hit.document.content,
    score: hit.text_match,
  }));
}

/** Min-max normalise scores into [0, 1] so the two retrievers are comparable. */
function normalise(hits: RawHit[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (hits.length === 0) return scores;
  const values = hits.map((h) => h.score);
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const hit of hits) {
    scores.set(hit.id, max === min ? 1 : (hit.score - min) / (max - min));
  }
  return scores;
}

/**
 * Weighted score fusion (0.6 * vector + 0.4 * BM25) over chunk ids, then de-duplicated by
 * slug, keeping each page's highest-scoring chunk.
 */
export function fuse(vectorHits: RawHit[], keywordHits: RawHit[]): Candidate[] {
  const vectorScores = normalise(vectorHits);
  const keywordScores = normalise(keywordHits);
  const byId = new Map<string, RawHit>();
  for (const hit of [...vectorHits, ...keywordHits]) if (!byId.has(hit.id)) byId.set(hit.id, hit);

  const fused: Candidate[] = [...byId.values()].map((hit) => {
    const vectorScore = vectorScores.get(hit.id) ?? 0;
    const bm25Score = keywordScores.get(hit.id) ?? 0;
    return {
      id: hit.id,
      slug: hit.slug,
      title: hit.title,
      heading: hit.heading,
      url: hit.url,
      content: hit.content,
      vectorScore,
      bm25Score,
      score: VECTOR_WEIGHT * vectorScore + BM25_WEIGHT * bm25Score,
    };
  });

  const bestPerSlug = new Map<string, Candidate>();
  for (const candidate of fused) {
    const existing = bestPerSlug.get(candidate.slug);
    if (!existing || candidate.score > existing.score) bestPerSlug.set(candidate.slug, candidate);
  }
  return [...bestPerSlug.values()].sort((a, b) => b.score - a.score);
}

/** Defence in depth: both stores already filter by portal, but never let a foreign row through. */
function ownHits(portalId: string, hits: RawHit[], retriever: string): RawHit[] {
  const own = hits.filter((hit) => hit.portal_id === portalId);
  if (own.length !== hits.length) {
    logger.error({ portalId, retriever, dropped: hits.length - own.length }, 'cross-portal rows returned by search');
  }
  return own;
}

/**
 * Hybrid search within one portal: pgvector cosine + Typesense keyword search, fused and reranked.
 * If one retriever fails, results from the other are still used; throws only if both fail.
 */
export async function hybridSearch(
  portalId: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const topK = Math.min(Math.max(options.topK ?? DEFAULT_TOP_K, 1), 20);
  const [vector, keyword] = await Promise.allSettled([
    vectorSearch(portalId, query, options),
    keywordSearch(portalId, query, options),
  ]);

  if (vector.status === 'rejected' && keyword.status === 'rejected') {
    throw new AggregateError([vector.reason, keyword.reason], 'Both vector and keyword search failed');
  }
  if (vector.status === 'rejected') logger.warn({ err: vector.reason }, 'vector search failed');
  if (keyword.status === 'rejected') logger.warn({ err: keyword.reason }, 'keyword search failed');

  const candidates = fuse(
    vector.status === 'fulfilled' ? ownHits(portalId, vector.value, 'vector') : [],
    keyword.status === 'fulfilled' ? ownHits(portalId, keyword.value, 'keyword') : [],
  ).slice(0, RERANK_POOL);

  const ranked = await rerank(query, candidates, topK);
  return ranked.map(({ content, title, slug, url, score, heading }) => ({ content, title, slug, url, score, heading }));
}
