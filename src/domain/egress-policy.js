/**
 * Egress policy: exact host names per role, nothing else. No wildcard, no IP
 * literal, port 443 only. A role that is not listed has no network at all.
 */

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** @param {string} host */
export function isHostName(host) {
  return HOST.test(host);
}

/**
 * @param {Record<string, string[]>} egress role -> exact hosts
 * @param {string} role
 * @param {string} host
 * @param {number} port
 * @returns {{allowed: boolean, reason: string}}
 */
export function decideEgress(egress, role, host, port) {
  const normalized = String(host).toLowerCase().replace(/\.$/, '');
  if (!isHostName(normalized)) return { allowed: false, reason: 'not_a_host_name' };
  if (port !== 443) return { allowed: false, reason: 'port_not_443' };
  const hosts = egress[role];
  if (!hosts) return { allowed: false, reason: 'role_has_no_network' };
  if (!hosts.includes(normalized)) return { allowed: false, reason: 'host_not_listed' };
  return { allowed: true, reason: 'listed' };
}

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(address) {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    // Only global unicast (2000::/3) is public, minus the ranges that embed or tunnel IPv4.
    return !/^[23]/.test(lower) || lower.startsWith('2002:') || lower.startsWith('2001:db8:') || lower.startsWith('2001:0:');
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Egress configuration problems; empty when valid. */
export function validateEgress(egress) {
  const problems = [];
  for (const [role, hosts] of Object.entries(egress)) {
    if (!Array.isArray(hosts)) {
      problems.push(`egress.${role} must be a list of host names.`);
      continue;
    }
    for (const host of hosts) {
      if (typeof host !== 'string' || !isHostName(host)) {
        problems.push(`egress.${role}: "${host}" is not an exact lower-case host name.`);
      }
    }
  }
  return problems;
}
