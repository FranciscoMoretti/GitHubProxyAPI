// Test-only upstream injection, deliberately not available in the installed CLI.
import { activationFd } from '../../src/activation.js';
import { loadConfig } from '../../src/config.js';
import { startProxy } from '../../src/proxy.js';
const config = await loadConfig();
config.socketPath = process.env.GHPA_SOCKET_PATH!;
const proxy = await startProxy(config, {
  listenFd: activationFd(), generation: process.env.GHPA_GENERATION,
  upstreams: { 'api.github.com': process.env.FIXTURE_UPSTREAM! },
});
process.once('SIGTERM', () => { void proxy.close(); });
