/**
 * Builds Express listen options so Core can bind a host when LISTEN_HOST is set.
 *
 * Hosted/Docker leave LISTEN_HOST unset and keep Node's all-interfaces default.
 * The macOS embedded launcher sets LISTEN_HOST=127.0.0.1.
 */

export interface CoreListenOptions {
  port: number;
  host?: string;
}

/**
 * Returns listen options for `app.listen`. Omits `host` when unset so the
 * process keeps current hosted bind behavior.
 */
export function buildListenOptions(port: number, listenHost?: string): CoreListenOptions {
  if (listenHost && listenHost.length > 0) {
    return { port, host: listenHost };
  }
  return { port };
}

/**
 * Formats the boot log URL. Uses the bound host when present.
 */
export function formatListenUrl(port: number, listenHost?: string): string {
  const host = listenHost && listenHost.length > 0 ? listenHost : 'localhost';
  return `http://${host}:${port}`;
}
