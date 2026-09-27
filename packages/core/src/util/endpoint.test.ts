import { describe, expect, it } from 'vitest';
import { endpointProblem, isPrivateHost } from './endpoint.js';

describe('endpoints (§4.10)', () => {
  it('recognises loopback, link-local and private literals', () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '172.16.1.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '[::1]', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', 'localhost', 'relay.localhost']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['8.8.8.8', '172.32.0.1', 'relay-1.test', '2001:db8::1', 'example.com']) expect(isPrivateHost(h), h).toBe(false);
  });

  it('requires https / wss unless the lab flag allows private endpoints', () => {
    expect(endpointProblem('wss://relay.example', 'ws')).toBeUndefined();
    expect(endpointProblem('https://esplora.example', 'http')).toBeUndefined();
    expect(endpointProblem('ws://relay.example', 'ws')).toMatch(/only wss/);
    expect(endpointProblem('http://esplora.example', 'http')).toMatch(/only https/);
    expect(endpointProblem('wss://192.168.1.2', 'ws')).toMatch(/private/);
    expect(endpointProblem('https://user:pw@x.example', 'http')).toMatch(/credentials/);
    expect(endpointProblem('not a url', 'http')).toMatch(/not a URL/);
    expect(endpointProblem('ws://relay:8080', 'ws', { allowPrivate: true })).toBeUndefined();
    expect(endpointProblem('http://127.0.0.1:3000', 'http', { allowPrivate: true })).toBeUndefined();
    expect(endpointProblem('ftp://x.example', 'http', { allowPrivate: true })).toMatch(/only https/);
  });
});
