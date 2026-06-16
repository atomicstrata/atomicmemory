/**
 * @file Shared `api_url` SSRF guard for every SDK client/provider config.
 *
 * Port of the python SDK's `atomicmemory/core/url.py` (AGNT-PY-001). An
 * `api_url` must be an http(s) URL with a host. Link-local addresses — the
 * cloud metadata endpoint `169.254.169.254` (`169.254.0.0/16`) and IPv6
 * `fe80::/10` — are ALWAYS rejected. Loopback / private / reserved literals
 * (incl. the `100.64.0.0/10` CGN range) are ALLOWED BY DEFAULT, since the SDK
 * routinely connects to local and self-hosted cores; pass
 * `allowPrivateNetworks: false` to reject those too (posture B).
 *
 * `URL` normalizes the legacy IPv4 encodings the OS resolver still accepts —
 * decimal (`http://2852039166/`), hex, octal, and short forms — to dotted-quad,
 * so they cannot slip through as hostnames. IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * is reclassified by its embedded IPv4. Genuine hostnames (incl. the `localhost`
 * default and `metadata.google.internal`) are intentionally NOT DNS-resolved
 * here — config-time resolution is racy and still bypassable via DNS rebinding;
 * deployments that must defend against hostname-based metadata access should pin
 * `api_url` to a vetted host.
 */
import { isIP } from 'node:net';

export interface ValidateApiUrlOptions {
  /**
   * Permit loopback / private / reserved IP literals (self-hosted / local dev).
   * Defaults to `true`: the SDK routinely connects to private/local cores, so
   * the security floor is the always-on link-local / cloud-metadata block. Set
   * `false` to also reject loopback/private/reserved (stricter, e.g. a hosted
   * multi-tenant deployment). Matches the python SDK's posture.
   */
  allowPrivateNetworks?: boolean;
}

interface IpClass {
  /** Link-local / cloud-metadata — always rejected regardless of the opt-in. */
  linkLocal: boolean;
  /** Loopback / private / reserved / multicast / unspecified — gated by the opt-in. */
  blockedByDefault: boolean;
}

type Octets = [number, number, number, number];

/** 169.254.0.0/16 — AWS/GCP/Azure instance metadata (IMDS); always blocked. */
function isLinkLocalIpv4([a, b]: Octets): boolean {
  return a === 169 && b === 254;
}

/** RFC 1918 + 100.64.0.0/10 CGN (e.g. Alibaba metadata). */
function isPrivateIpv4([a, b]: Octets): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Loopback, "this network", broadcast, reserved, and multicast ranges. */
function isSpecialIpv4([a, b, c, d]: Octets): boolean {
  const loopback = a === 127; // 127.0.0.0/8
  const unspecified = a === 0; // 0.0.0.0/8 "this network"
  const broadcast = a === 255 && b === 255 && c === 255 && d === 255;
  const reserved = (a === 192 && b === 0 && c === 0) || a >= 240; // 192.0.0.0/24, 240.0.0.0/4
  const multicast = a >= 224 && a <= 239; // 224.0.0.0/4
  return loopback || unspecified || broadcast || reserved || multicast;
}

function classifyIpv4(host: string): IpClass {
  const octets = host.split('.').map(Number) as Octets;
  return {
    linkLocal: isLinkLocalIpv4(octets),
    blockedByDefault: isPrivateIpv4(octets) || isSpecialIpv4(octets),
  };
}

function mappedIpv4(host: string): string | null {
  const rest = host.toLowerCase().match(/^::ffff:(.+)$/)?.[1];
  if (rest === undefined) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  const pair = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!pair) return null;
  const hi = parseInt(pair[1], 16);
  const lo = parseInt(pair[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function classifyIpv6(host: string): IpClass {
  const mapped = mappedIpv4(host);
  if (mapped) return classifyIpv4(mapped);
  const lower = host.toLowerCase();
  return {
    linkLocal: /^fe[89ab]/.test(lower), // fe80::/10
    blockedByDefault: lower === '::1' || lower === '::' || /^f[cd]/.test(lower), // loopback, unspecified, fc00::/7 ULA
  };
}

/**
 * Validate and normalize an `api_url`, guarding against SSRF.
 *
 * @param value - The candidate URL.
 * @param options - `allowPrivateNetworks` permits loopback/private/reserved IP
 *   literals; link-local / cloud-metadata addresses are rejected regardless.
 * @returns The whitespace-trimmed URL.
 * @throws Error if the scheme is not http(s), the host is missing, or the host
 *   is a disallowed IP literal.
 */
export function validateApiUrl(value: string, options: ValidateApiUrlOptions = {}): string {
  const stripped = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    throw new Error('api_url must be an http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('api_url must be an http(s) URL');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('api_url must include a host');

  const kind = isIP(host);
  if (kind === 0) return stripped; // hostname — intentionally not DNS-resolved

  const ipClass = kind === 4 ? classifyIpv4(host) : classifyIpv6(host);
  if (ipClass.linkLocal) {
    throw new Error('api_url must not target a link-local or cloud-metadata address');
  }
  const allowPrivate = options.allowPrivateNetworks ?? true;
  if (!allowPrivate && ipClass.blockedByDefault) {
    throw new Error(
      'api_url must not target a loopback, private, or reserved address; ' +
        'set allowPrivateNetworks=true to permit it',
    );
  }
  return stripped;
}
