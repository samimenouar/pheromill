/**
 * Sandbox specification: turns a step into the exact arguments of a hardened,
 * disposable container. Pure function, so the hardening itself is testable.
 *
 * Invariants enforced here, not left to configuration:
 * one fresh container per step, pinned image, closed environment list, no
 * forge credential, non-root user, read-only root filesystem, no capability,
 * no privilege escalation, bounded CPU, memory, processes and duration, and
 * no access to the container daemon.
 */

const PINNED_IMAGE = /^(?:[a-z0-9][\w./:-]*@)?sha256:[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FORBIDDEN_MOUNT = /docker\.sock|containerd\.sock|podman\.sock|^\/(?:proc|sys|dev|etc|root|var\/run|run)(?:\/|$)/;

export class SandboxSpecError extends Error {}

function fail(message) {
  throw new SandboxSpecError(message);
}

/**
 * @param {{
 *   runId: string, step: string, image: string, command: string[],
 *   env: Record<string, string>, allowedEnv: string[],
 *   mounts: Array<{source: string, target: string, readOnly: boolean}>,
 *   network: string|null,
 *   limits: {cpus: number, memoryMb: number, pids: number, seconds: number, tmpMb: number},
 *   user: string,
 * }} input
 * @returns {{name: string, args: string[], env: Record<string, string>, timeoutMs: number}}
 */
export function buildSandboxSpec(input) {
  if (!PINNED_IMAGE.test(input.image)) fail(`Image must be pinned by digest: ${input.image}`);
  if (!SAFE_ID.test(input.runId) || !SAFE_ID.test(input.step)) fail('Run and step identifiers must be lower-case slugs.');
  if (!/^[1-9]\d*:[1-9]\d*$/.test(input.user)) fail('The container user must be a non-root uid:gid.');
  if (!Array.isArray(input.command) || input.command.length === 0) fail('A command is required.');
  if (input.network !== null && !SAFE_ID.test(input.network)) fail('Invalid network name.');
  if (['host', 'bridge', 'default'].includes(input.network)) fail('Sandboxes never join a default or host network.');

  const { cpus, memoryMb, pids, seconds, tmpMb } = input.limits;
  for (const [name, value] of Object.entries({ cpus, memoryMb, pids, seconds, tmpMb })) {
    if (!(typeof value === 'number' && value > 0 && Number.isFinite(value))) fail(`Limit ${name} must be a positive number.`);
  }

  const name = `pheromill-${input.runId}-${input.step}`;
  const args = [
    'run', '--rm', '--pull', 'never', '--name', name,
    '--label', 'pheromill.sandbox=true',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', input.user,
    '--pids-limit', String(pids),
    '--memory', `${memoryMb}m`,
    '--memory-swap', `${memoryMb}m`,
    '--cpus', String(cpus),
    '--network', input.network ?? 'none',
    '--ipc', 'none',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${tmpMb}m`,
    '--workdir', '/workspace',
  ];

  for (const mount of input.mounts) {
    if (!mount.source.startsWith('/') || !mount.target.startsWith('/')) fail('Mount paths must be absolute.');
    if (/[,=]/.test(mount.source) || /[,=]/.test(mount.target)) fail('Mount paths must not contain "," or "=".');
    if (FORBIDDEN_MOUNT.test(mount.source) || mount.source.split('/').includes('..')) {
      fail(`Forbidden mount source: ${mount.source}`);
    }
    args.push('--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`);
  }

  for (const [key, value] of Object.entries(input.env)) {
    if (!ENV_NAME.test(key)) fail(`Invalid environment variable name: ${key}`);
    if (!input.allowedEnv.includes(key)) fail(`Environment variable not on the closed list: ${key}`);
    if (typeof value !== 'string' || /[\n\r\0]/.test(value)) fail(`Invalid value for environment variable ${key}`);
    // Name only: the value travels in the launcher's environment, never on a command line.
    args.push('--env', key);
  }

  args.push(input.image, ...input.command);
  return { name, args, env: { ...input.env }, timeoutMs: seconds * 1000 };
}
