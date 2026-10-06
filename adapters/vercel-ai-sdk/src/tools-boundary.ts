/** One safe execution boundary for every model-facing memory operation. */
import type { z } from 'zod/v3';

function safeAbort(): Error {
  const error = new Error('Memory tool aborted.');
  error.name = 'AbortError';
  return error;
}

/** Validate direct execution arguments and replace every error with a safe rejection. */
export async function executeMemoryTool<S extends z.ZodTypeAny, R>(
  schema: S,
  input: unknown,
  signal: AbortSignal | undefined,
  run: (input: z.output<S>) => Promise<R>,
): Promise<R> {
  try {
    if (signal?.aborted) throw safeAbort();
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error('Memory tool input is invalid.');
    return await run(parsed.data);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw safeAbort();
    }
    // Never retain SDK errors, validation details, or an arbitrary abort reason.
    throw new Error('Memory tool failed.');
  }
}
