import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { env } from '../config/env';
import { badRequest } from './errors';

/** Tests and local development can allow private targets; production deployments should not. */
export const netConfig = { allowPrivate: env.REMEDIATION_WEBHOOK_ALLOW_PRIVATE };

const blocked = new BlockList();
// Loopback, private, link-local (incl. cloud metadata), carrier-grade NAT, unspecified, multicast
for (const [net, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8], ['224.0.0.0', 4]] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::1', 128], ['::', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(net, prefix, 'ipv6');

function isBlocked(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return blocked.check(mapped, 'ipv4');
  return blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Guards outbound requests to user-supplied URLs against server-side request forgery:
 * only http(s), no credentials in the URL, and every address the host resolves to must be public.
 * Call it when the URL is saved and again immediately before each request.
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('The URL is not valid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Only http and https URLs are allowed');
  if (url.username || url.password) throw badRequest('URLs with embedded credentials are not allowed');
  if (netConfig.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw badRequest(`The host "${host}" could not be resolved`);
  }
  if (!addresses.length || addresses.some(isBlocked)) {
    throw badRequest('That address is private, loopback or link-local. Webhooks must target a publicly routable host.');
  }
  return url;
}
