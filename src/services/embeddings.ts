import { config } from '../config';
import { openai } from './openai';

const BATCH_SIZE = 96;

async function embedBatch(inputs: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: config.EMBEDDING_MODEL,
    input: inputs,
    dimensions: config.EMBEDDING_DIMENSIONS,
    encoding_format: 'float',
  });
  // The API returns items with an explicit index; don't rely on ordering
  const out = new Array<number[]>(inputs.length);
  for (const item of response.data) out[item.index] = item.embedding;
  return out;
}

/** Embed many texts, batching requests to stay well under the API's per-request limits. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    results.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
  }
  return results;
}

export async function embedQuery(query: string): Promise<number[]> {
  const [embedding] = await embedBatch([query]);
  if (!embedding) throw new Error('Embedding API returned no vector');
  return embedding;
}
