import { fstatSync } from 'node:fs';

/** Called only by managed-serve: ordinary serve never consumes activation metadata. */
export function activationFd(env = process.env, pid = process.pid, platform = process.platform): number {
  const valid = platform === 'darwin'
    ? env.GHPA_LAUNCH_FD === '3'
    : platform === 'linux' && env.LISTEN_PID === String(pid) && env.LISTEN_FDS === '1' && env.LISTEN_FDNAMES === 'ghpa';
  delete env.GHPA_LAUNCH_FD;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;
  if (!valid) throw new Error('Managed listener missing or invalid; use enable-gh to install or repair the service');
  if (!fstatSync(3).isSocket()) throw new Error('Managed descriptor is not a socket');
  return 3;
}
