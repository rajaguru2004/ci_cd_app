/**
 * The agent's settings, from its environment (the Mac's .env, through docker-compose.yml).
 *
 *   SERVER_URL      the console, as the Mac reaches it: http://192.168.0.189:7080, https://releases.example.com
 *   RUNNER_TOKEN    rcr_…, made in the console (Runners → Add a Mac), shown once
 *   EXECUTOR        ssh (default, from a container) or local (the agent runs on the Mac itself)
 *   MAC_HOST        where the Mac's sshd is, from the container (host.docker.internal)
 *   MAC_PORT        22
 *   MAC_USER        the macOS account builds run as (its keychain, its Xcode, its Flutter)
 *   MAC_WORK_DIR    the agent's folder on the Mac (~/release-console-runner/work)
 *   MAC_PATH_PREFIX folders put first on PATH for every step (when the login shell does not set them)
 *   DATA_DIR        the agent's own keys and state (/data, a volume)
 *   KEEP_WORK       1 keeps a run's folder on the Mac after it ends (to look at a failure)
 */

export interface AgentConfig {
  serverUrl: string;
  token: string;
  executor: 'ssh' | 'local';
  macHost: string;
  macPort: number;
  macUser: string;
  /** May start with ~ (the Mac user's home). */
  workDir: string;
  pathPrefix: string;
  dataDir: string;
  keepWork: boolean;
  version: string;
}

export class ConfigError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv = process.env, needServer = true): AgentConfig {
  const read = (k: string) => (env[k] ?? '').trim();
  const serverUrl = read('SERVER_URL').replace(/\/+$/, '').replace(/\/api$/, '');
  const token = read('RUNNER_TOKEN');
  if (needServer) {
    if (!/^https?:\/\/[^\s/]+/.test(serverUrl)) {
      throw new ConfigError('SERVER_URL must be the console’s address as this Mac reaches it, e.g. http://192.168.0.189:7080 (set it in .env).');
    }
    if (!/^rcr_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new ConfigError('RUNNER_TOKEN must be the token the console showed when this Mac was added (Runners → Add a Mac); set it in .env.');
    }
  }
  const executor = read('EXECUTOR') === 'local' ? 'local' : 'ssh';
  const macUser = read('MAC_USER') || (executor === 'local' ? read('USER') : '');
  if (needServer && executor === 'ssh' && !/^[A-Za-z0-9._-]{1,64}$/.test(macUser)) {
    throw new ConfigError('MAC_USER must be the macOS account builds run as (whoami on the Mac); set it in .env.');
  }
  const port = Number(read('MAC_PORT') || 22);
  return {
    serverUrl,
    token,
    executor,
    macHost: read('MAC_HOST') || 'host.docker.internal',
    macPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    macUser,
    workDir: read('MAC_WORK_DIR') || '~/release-console-runner/work',
    pathPrefix: read('MAC_PATH_PREFIX'),
    dataDir: read('DATA_DIR') || '/data',
    keepWork: read('KEEP_WORK') === '1',
    version: read('RUNNER_VERSION') || 'dev',
  };
}
