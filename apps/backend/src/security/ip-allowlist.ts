/**
 * CIDR-based IP allowlist — 1:1 port of module/security/ip_allowlist.py.
 * Shared by the login guard and the MCP middleware.
 */
import { Logger } from '@nestjs/common';
import ipaddr from 'ipaddr.js';

const logger = new Logger('IpAllowlist');

const NETWORK_CACHE_MAX = 128;

interface ParsedNetwork {
  addr: ipaddr.IPv4 | ipaddr.IPv6;
  prefix: number;
}

const parsedNetworks = new Map<string, ParsedNetwork | null>();

function parseNetwork(cidr: string): ParsedNetwork | null {
  if (parsedNetworks.has(cidr)) return parsedNetworks.get(cidr)!;
  let parsed: ParsedNetwork | null = null;
  try {
    const [addr, prefix] = ipaddr.parseCIDR(cidr);
    parsed = { addr, prefix };
  } catch {
    logger.warn(`Invalid CIDR in whitelist: ${cidr}`);
  }
  // LRU-ish bound
  if (parsedNetworks.size >= NETWORK_CACHE_MAX) parsedNetworks.clear();
  parsedNetworks.set(cidr, parsed);
  return parsed;
}

function parseAddr(host: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    return ipaddr.parse(host);
  } catch {
    return null;
  }
}

/** Return True if *host* falls within any CIDR range in *whitelist*. */
export function isAllowed(host: string, whitelist: string[]): boolean {
  const addr = parseAddr(host);
  if (!addr) return false;
  for (const cidr of whitelist) {
    const net = parseNetwork(cidr);
    if (!net) continue;
    // ipaddr.js match requires the same address family
    if (addr.kind() !== net.addr.kind()) continue;
    if (addr.match([net.addr, net.prefix])) return true;
  }
  return false;
}

/** Clear the parsed network cache (call after config reload). */
export function clearNetworkCache(): void {
  parsedNetworks.clear();
}
