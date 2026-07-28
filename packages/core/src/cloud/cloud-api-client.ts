/**
 * Shared outbound POST helper for Cloud API calls (traces, heartbeat).
 */

export interface CloudApiPostOptions {
  apiUrl: string;
  apiKey: string;
  path: string;
  body: unknown;
  timeoutMs?: number;
}

export async function cloudApiPost(options: CloudApiPostOptions): Promise<Response> {
  const base = options.apiUrl.replace(/\/+$/, '');
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
}
