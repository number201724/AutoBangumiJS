/**
 * socks-proxy-agent v9 ships types under an "exports" map that the backend's
 * legacy "node" moduleResolution cannot see; declare the surface we use.
 */
declare module 'socks-proxy-agent' {
  import { Agent } from 'node:http';
  export class SocksProxyAgent extends Agent {
    constructor(uri: string, opts?: Record<string, unknown>);
  }
}
