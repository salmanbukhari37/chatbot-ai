import { Langfuse } from 'langfuse';
import { config } from '../config';

/**
 * Optional Langfuse observability. When LANGFUSE_* keys are unset every hook is a no-op,
 * so call sites never need to check whether tracing is enabled.
 */
const langfuse =
  config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY
    ? new Langfuse({
        publicKey: config.LANGFUSE_PUBLIC_KEY,
        secretKey: config.LANGFUSE_SECRET_KEY,
        baseUrl: config.LANGFUSE_BASE_URL,
      })
    : undefined;

export interface Span {
  end(output?: unknown, metadata?: Record<string, unknown>): void;
}

export interface Generation {
  end(output: string, usage?: { input?: number; output?: number }): void;
}

export interface Trace {
  id?: string;
  span(name: string, input?: unknown): Span;
  generation(name: string, model: string, input: unknown): Generation;
  end(output?: unknown): void;
}

const noopSpan: Span = { end: () => undefined };
const noopTrace: Trace = {
  span: () => noopSpan,
  generation: () => ({ end: () => undefined }),
  end: () => undefined,
};

export function startTrace(name: string, input: unknown, sessionId?: string): Trace {
  if (!langfuse) return noopTrace;
  const trace = langfuse.trace({ name, input, sessionId });
  return {
    id: trace.id,
    span(spanName, spanInput) {
      const span = trace.span({ name: spanName, input: spanInput });
      return { end: (output, metadata) => void span.end({ output, metadata }) };
    },
    generation(genName, model, genInput) {
      const generation = trace.generation({ name: genName, model, input: genInput });
      return {
        end: (output, usage) =>
          void generation.end({ output, usage: usage ? { input: usage.input, output: usage.output } : undefined }),
      };
    },
    end(output) {
      trace.update({ output });
    },
  };
}

export async function flushTracing(): Promise<void> {
  await langfuse?.shutdownAsync();
}
