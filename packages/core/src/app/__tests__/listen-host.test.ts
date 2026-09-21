/**
 * Bind-address helper tests. Localhost HTTP is not enough to detect wildcard
 * listeners — these assertions inspect the constructed options and the
 * listening socket address.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildListenOptions, formatListenUrl } from '../listen-options.js';

describe('listen host', () => {
  it('omits host when LISTEN_HOST is unset', () => {
    expect(buildListenOptions(17350)).toEqual({ port: 17350 });
    expect(formatListenUrl(17350)).toBe('http://localhost:17350');
  });

  it('includes an explicit host when set', () => {
    expect(buildListenOptions(17350, '127.0.0.1')).toEqual({
      port: 17350,
      host: '127.0.0.1',
    });
    expect(formatListenUrl(17350, '127.0.0.1')).toBe('http://127.0.0.1:17350');
  });

  it('binds the listening socket to 127.0.0.1 when host is set', async () => {
    const app = express();
    const server = app.listen(buildListenOptions(0, '127.0.0.1'));
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
