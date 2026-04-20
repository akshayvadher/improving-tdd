import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

// Synchronous best-effort probe for a container runtime (Docker OR Podman).
// Used to skip integration suites cleanly when no daemon is reachable.
// If Podman is detected, exports DOCKER_HOST + TESTCONTAINERS_RYUK_DISABLED so
// testcontainers-node can talk to the Podman socket without extra setup.
export function dockerIsAvailable(): boolean {
  if (process.env.DOCKER_HOST) {
    return true;
  }
  if (socketExists('/var/run/docker.sock')) {
    return true;
  }
  if (dockerCliReports()) {
    return true;
  }
  if (wirePodman()) {
    return true;
  }
  return false;
}

function socketExists(path: string): boolean {
  try {
    if (!existsSync(path)) {
      return false;
    }
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function dockerCliReports(): boolean {
  return cliOk('docker', ['version', '--format', '{{.Server.Version}}']);
}

function podmanCliReports(): boolean {
  return cliOk('podman', ['version', '--format', '{{.Server.Version}}']);
}

function cliOk(cmd: string, args: string[]): boolean {
  try {
    const result = spawnSync(cmd, args, { timeout: 2000, stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

// If Podman is running, point testcontainers at it. Ryuk (the container reaper)
// misbehaves with Podman, so it's disabled — the Postgres containers still stop
// via the explicit `container.stop()` call in afterAll.
function wirePodman(): boolean {
  if (!podmanCliReports()) {
    return false;
  }
  const socket = detectPodmanSocket();
  if (!socket) {
    return false;
  }
  process.env.DOCKER_HOST = socket;
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  // Podman runs in WSL on Windows and exposes containers on 0.0.0.0 inside
  // the VM. Ports are forwarded to the Windows host on localhost, so override
  // the host testcontainers advertises so our clients connect to localhost.
  process.env.TESTCONTAINERS_HOST_OVERRIDE ??= 'localhost';
  return true;
}

function detectPodmanSocket(): string | null {
  if (process.platform === 'win32') {
    const pipe = readPodmanPipe();
    return pipe ? `npipe://${pipe.replaceAll('\\', '/')}` : null;
  }
  const unixPath = readPodmanUnixSocket();
  return unixPath ? `unix://${unixPath}` : null;
}

function readPodmanPipe(): string | null {
  try {
    const result = spawnSync(
      'podman',
      ['machine', 'inspect', '--format', '{{.ConnectionInfo.PodmanPipe.Path}}'],
      {
        timeout: 2000,
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      return null;
    }
    const pipe = result.stdout.trim();
    return pipe.length > 0 ? pipe : null;
  } catch {
    return null;
  }
}

function readPodmanUnixSocket(): string | null {
  try {
    const result = spawnSync('podman', ['info', '--format', '{{.Host.RemoteSocket.Path}}'], {
      timeout: 2000,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      return null;
    }
    const path = result.stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export const DOCKER_UNAVAILABLE_MESSAGE =
  'No container runtime detected (Docker or Podman). Skipping integration tests. Start Docker Desktop, or run `podman machine start`, and re-run `pnpm test:integration`.';
