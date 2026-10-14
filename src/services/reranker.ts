import { CohereClientV2 } from 'cohere-ai';
import { config } from '../config';
import type { Candidate } from '../types';
import { logger } from '../logger';

const cohere = config.COHERE_API_KEY ? new CohereClientV2({ token: config.COHERE_API_KEY }) : undefined;

export const rerankerEnabled = cohere !== undefined;

/**
 * Rerank candidates with Cohere. If Cohere is not configured or the call fails,
 * fall back to the incoming (fusion-score) order so search still works.
 */
export async function rerank(query: string, candidates: Candidate[], topN: number): Promise<Candidate[]> {
  if (!cohere || candidates.length <= 1) return candidates.slice(0, topN);

  try {
    const response = await cohere.rerank(
      {
        model: config.COHERE_RERANK_MODEL,
        query,
        documents: candidates.map((c) => c.content),
        topN: Math.min(topN, candidates.length),
      },
      { timeoutInSeconds: 10, maxRetries: 1 },
    );
    return response.results.flatMap((result) => {
      const candidate = candidates[result.index];
      return candidate ? [{ ...candidate, score: result.relevanceScore }] : [];
    });
  } catch (err) {
    logger.warn({ err }, 'cohere rerank failed, using fusion order');
    return candidates.slice(0, topN);
  }
}
