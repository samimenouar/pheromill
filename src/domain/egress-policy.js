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

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
];

function parseV4(address) {
  const parts = address.split('.');
  // No leading zero: some resolvers read "010" as octal, and an address read two ways is not trusted.
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

/** Expand an IPv6 address to its eight 16-bit groups, or null when it is not one. */
function parseV6(address) {
  let text = address.toLowerCase();
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (embedded) {
    const v4 = parseV4(embedded[2]);
    if (v4 === null) return null;
    text = `${embedded[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return all.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? all.map((group) => Number.parseInt(group, 16)) : null;
}

/**
 * True for every address that is not public unicast: loopback, private,
 * link-local, metadata, documentation, benchmarking, transition and
 * multicast ranges. Anything that cannot be parsed counts as private.
 */
export function isPrivateAddress(address) {
  const v4 = parseV4(address);
  if (v4 !== null) {
    return BLOCKED_V4.some(([base, bits]) => Math.floor(v4 / 2 ** (32 - bits)) === Math.floor(parseV4(base) / 2 ** (32 - bits)));
  }
  const g = parseV6(String(address));
  if (g === null) return true;
  // IPv4-mapped: judge the embedded address.
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) {
    return isPrivateAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (g[0] >> 13 !== 1) return true; // only 2000::/3 is global unicast
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23: Teredo, benchmarking and other protocol assignments
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation
  return false;
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
