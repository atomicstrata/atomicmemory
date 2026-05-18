/**
 * @file Single-shot stdin reader. The CLI consumes process.stdin at
 * most once per invocation; multiple call sites (api-key resolution,
 * --stdin content for add/ingest/import) share the same cached
 * buffer.
 */

export interface StdinReader {
  read(): Promise<string>;
}

export function makeStdinReader(): StdinReader {
  let cached: string | null = null;
  return {
    async read() {
      if (cached !== null) return cached;
      if (process.stdin.isTTY) {
        cached = '';
        return '';
      }
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      cached = Buffer.concat(chunks).toString('utf8');
      return cached;
    },
  };
}
