/**
 * @file Tests for the shared SSRF guard on `api_url`. Mirrors the python SDK's
 * AGNT-PY-001 fix: always reject link-local / cloud-metadata addresses, gate
 * loopback/private/reserved behind `allowPrivateNetworks`, and ensure numeric
 * IPv4 encodings + IPv4-mapped IPv6 cannot bypass the guard. Hostnames are not
 * DNS-resolved.
 */
import { describe, it, expect } from 'vitest';
import { validateApiUrl } from '../validate-api-url.js';

describe('validateApiUrl', () => {
  it('allows public http(s) and unresolved hostnames (incl. localhost)', () => {
    expect(validateApiUrl('https://api.example.com')).toBe('https://api.example.com');
    expect(validateApiUrl('http://localhost:17350')).toBe('http://localhost:17350');
  });

  it('rejects non-http(s) scheme or missing host', () => {
    for (const bad of ['not-a-url', 'ftp://h/x', 'file:///etc/passwd']) {
      expect(() => validateApiUrl(bad)).toThrow();
    }
  });

  it('always rejects link-local / cloud-metadata, even with private allowed', () => {
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/x']) {
      expect(() => validateApiUrl(u, { allowPrivateNetworks: true })).toThrow();
    }
  });

  it('rejects numeric-encoded metadata (decimal/hex/octal) even with private allowed', () => {
    for (const u of ['http://2852039166/', 'http://0xA9FEA9FE/', 'http://0251.0376.0251.0376/']) {
      expect(() => validateApiUrl(u, { allowPrivateNetworks: true })).toThrow();
    }
  });

  it('rejects IPv4-mapped IPv6 metadata', () => {
    expect(() => validateApiUrl('http://[::ffff:169.254.169.254]/', { allowPrivateNetworks: true })).toThrow();
  });

  it('allows loopback/private by default (posture B — the SDK connects to local/private cores)', () => {
    expect(validateApiUrl('http://127.0.0.1:17350')).toBe('http://127.0.0.1:17350');
    expect(validateApiUrl('http://10.0.0.5/api')).toBe('http://10.0.0.5/api');
    expect(validateApiUrl('http://192.168.1.10:8080')).toBe('http://192.168.1.10:8080');
  });

  it('rejects loopback/private/reserved only when strict (allowPrivateNetworks=false); numeric encodings too', () => {
    for (const u of ['http://127.0.0.1:17350', 'http://10.0.0.5/api', 'http://172.16.0.1/x',
                     'http://[::1]:17350', 'http://2130706433/', 'http://127.1/', 'http://0/']) {
      expect(() => validateApiUrl(u, { allowPrivateNetworks: false })).toThrow();
    }
  });

  it('trims surrounding whitespace', () => {
    expect(validateApiUrl('  https://api.example.com  ')).toBe('https://api.example.com');
  });
});
