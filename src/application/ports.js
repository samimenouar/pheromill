/**
 * Ports: everything the application needs from the outside world. Adapters
 * implement them; the application never imports an adapter. Swapping forge,
 * harness, runner or host means writing an adapter, not touching the rules.
 *
 * @typedef {object} Forge the issue tracker and change-request side of a forge
 * @property {(label: string) => Promise<Array<{id: string, title: string, body: string, labels: string[], milestone: string|null}>>} listTickets
 * @property {(id: string, state: string, note: string) => Promise<void>} setTicketState
 * @property {(ticket: {title: string, body: string, labels: string[]}) => Promise<{id: string}>} createTicket
 * @property {(change: {ticketId: string, branch: string, title: string, body: string, labels: string[]}) => Promise<{id: string}>} openChange
 * @property {(changeId: string, body: string) => Promise<void>} comment
 * @property {(changeId: string, labels: string[]) => Promise<void>} setLabels
 * @property {() => Promise<string[]>} approvedChanges change requests a person approved for the merge queue
 *
 * @typedef {object} Vcs version control, run in the control zone only
 * @property {(ref: string) => Promise<string>} head commit of a branch
 * @property {(input: {base: string, patches: string[]}) => Promise<{patch: string, entries: Array<{path: string, status: string, oldMode: string, newMode: string}>}>} canonicalize apply patches and report what git says they do
 * @property {(input: {base: string, branch: string, patches: string[], message: string}) => Promise<string>} publish apply patches on base, push the branch, return its commit
 * @property {(input: {parent: string, changes: Array<{id: string, sha: string}>, ref: string}) => Promise<{sha: string}|{conflict: string}>} buildCandidate merge reviewed commits on top of parent and push under ref
 * @property {(ancestor: string, descendant: string) => Promise<boolean>} isAncestor
 * @property {(trunk: string, sha: string) => Promise<void>} fastForward move the trunk to a tested candidate
 *
 * @typedef {object} Checks the result of the project's verify command on a commit
 * @property {(sha: string) => Promise<{status: 'pass'|'fail', signature: string|null}>} wait
 * @property {(sha: string) => Promise<'pending'|'pass'|'fail'>} status
 *
 * @typedef {object} StepRunner runs one agent step in a fresh sandbox (execution zone)
 * @property {(job: {
 *   runId: string, step: string, route: {harness: string, model: string, family: string},
 *   base: string, patches: string[], hidePaths: string[], readOnly: boolean,
 *   input: object}) => Promise<{patch: string, report: any, seconds: number, tokens: number|null}>} run
 *
 * @typedef {object} PackageRegistry trusted lookup of package metadata
 * @property {(request: {ecosystem: string, name: string, version: string}) => Promise<object|null>} metadata
 *
 * @typedef {object} Ledger append-only, hash-chained record
 * @property {(type: string, data: object) => Promise<void>} append
 *
 * @typedef {object} Clock
 * @property {() => Date} now
 */

export {};
