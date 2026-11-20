/**
 * The ticket pipeline: a fixed sequence of deterministic gates around agent
 * steps. Agents write and review; they never decide whether their own work
 * passes. Every decision is appended to the ledger.
 *
 *   specify -> implement -> patch gate -> risk -> publish -> checks -> review(s)
 *           -> refutation -> correction round (bounded) -> autonomy -> queue
 */
import { mayMergeAlone, requiredGates } from '../domain/autonomy.js';
import { arbitrate, budgetFor, detectLoop, returnedFinding } from '../domain/budget.js';
import { evaluateDependency, parseDependencyRequest } from '../domain/dependency-gate.js';
import { diffStats, parseUnifiedDiff, reconcile } from '../domain/diff.js';
import { parseFindings, parseVerdicts, triage } from '../domain/findings.js';
import { matchesAny, mayFallUnder } from '../domain/glob.js';
import { checkPatch } from '../domain/patch-policy.js';
import { classifyRisk, LEVELS, maxLevel } from '../domain/risk.js';
import { assertIndependentReview, families, RoutingError, selectRoute } from '../domain/routing.js';
import { detectWeakening, touchesExistingTests } from '../domain/test-guard.js';
import { randomBytes } from 'node:crypto';
import { closure, survivesRendering, validateTicket } from '../domain/ticket.js';

const MAX_CHILDREN = 5;

/** Raised to stop the pipeline and hand the ticket to the owner. */
class Halt extends Error {}

/** Raised when the owner halted the factory: the ticket stops where it is and starts again later. */
class Interrupted extends Error {}

/** Risk level expected from the files a ticket says it will touch. */
export function predictLevel(ticket, config) {
  const mayTouch = (globs) => ticket.likelyFiles.some((file) => mayFallUnder(file, globs));
  if (mayTouch(config.paths.reserved)) return 'CRITICAL';
  if (mayTouch([...config.paths.core, ...config.paths.manifests])) return 'HIGH';
  return 'LOW';
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : []);

/**
 * @param {ReturnType<import('../domain/ticket.js').parseTicket> & {escalations?: number}} ticket
 * @param {ReturnType<import('../domain/config.js').defaultConfig>} config
 * @param {{runner: import('./ports.js').StepRunner, vcs: import('./ports.js').Vcs, forge: import('./ports.js').Forge,
 *   checks: import('./ports.js').Checks, registry: import('./ports.js').PackageRegistry,
 *   ledger: import('./ports.js').Ledger, clock: import('./ports.js').Clock,
 *   externalReview?: (input: {sha: string, patch: string}) => Promise<{findings: object[]}>,
 *   halted?: () => Promise<boolean>}} ports
 * @returns {Promise<{outcome: 'queued'|'needs_owner'|'rework'|'split'|'invalid'|'halted', reason: string, level?: string,
 *   changeId?: string, sha?: string, gatesPassed?: boolean, children?: object[]}>}
 */
export async function runTicket(ticket, config, ports) {
  const { runner, vcs, forge, checks, registry, ledger, clock } = ports;
  const log = (type, data) => ledger.append(type, { ticket: ticket.id, ...data });

  const problems = validateTicket(ticket, config);
  if (problems.length > 0) {
    await log('ticket_invalid', { problems });
    return { outcome: 'invalid', reason: problems.join(' ') };
  }

  const budget = budgetFor(ticket, config);
  const routeLevel = maxLevel(predictLevel(ticket, config), ticket.level ?? 'LOW');
  const run = {
    steps: [],
    counters: { commits: 0, comments: 0, fixRounds: 0, externalToolPasses: 0, ciRuns: 0, sandboxSeconds: 0, tokens: 0 },
    changedLines: 0,
    points: ticket.points,
    refutedFingerprints: [],
    raisedFingerprints: [],
  };
  let escalations = ticket.escalations ?? 0;
  let excludedAuthors = [];
  let authors = new Set();
  let lastAttempt = null; // the last patch this author produced, accepted or not
  let standing = new Map(); // patches of this author on which findings were confirmed, with those findings
  let changeId = null;
  let stepCount = 0;
  const base = await vcs.head(config.project.trunk);
  const branch = `factory/t${ticket.id}`;
  // Unique per run of the pipeline: a ticket that starts again never shares a
  // workspace or a container name with a step of its earlier run still ending.
  const runId = `t${ticket.id}-${clock.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`.toLowerCase();

  const unlessHalted = async () => {
    if (await ports.halted?.()) throw new Interrupted('The factory was halted by its owner.');
  };

  const agentStep = async (step, route, job) => {
    await unlessHalted();
    stepCount += 1;
    const result = await runner.run({ runId: `${runId}-${stepCount}`, step, route, base, patches: [], hidePaths: [], readOnly: true, ...job });
    run.counters.sandboxSeconds += result.seconds;
    if (typeof result.tokens === 'number' && run.counters.tokens !== null) run.counters.tokens += result.tokens;
    else run.counters.tokens = null; // unknown stays unknown
    await log('step', { step, harness: route.harness, model: route.model, family: route.family, seconds: result.seconds, tokens: result.tokens, error: result.report?.error ?? null });
    await unlessHalted(); // a step that ended during a halt, perhaps killed, decides nothing
    return result;
  };

  /** A step other than implement that crashed or timed out proves nothing: stop. */
  const mustSucceed = (step, result) => {
    if (result.report?.error) throw new Halt(`The ${step} step did not complete (${result.report.error}).`);
    return result;
  };

  const stop = async (outcome, reason, extra = {}) => {
    await log('ticket_outcome', { outcome, reason, counters: run.counters, level: extra.level ?? null });
    return { outcome, reason, changeId: changeId ?? undefined, ...extra };
  };

  const sendBack = async (lines) => {
    run.counters.fixRounds += 1;
    if (changeId) {
      run.counters.comments += 1;
      await forge.comment(changeId, ['Sent back to the author:', ...lines.map((line) => `- ${line}`)].join('\n'));
    }
    return lines;
  };

  /** Apply a patch on the base and read back what git says it does. Null when it does not apply. */
  const inspect = async (patch) => {
    if (patch.trim() === '') return { patch: '', files: [] };
    let canonical;
    try {
      canonical = await vcs.canonicalize({ base, patches: [patch] });
    } catch {
      return null;
    }
    return { patch: canonical.patch, files: reconcile(parseUnifiedDiff(canonical.patch), canonical.entries) };
  };

  const escalate = async (loop) => {
    const otherFamilyAvailable = families(config).some((family) => !authors.has(family) && !excludedAuthors.includes(family));
    let proposal = null;
    if (escalations === 0) {
      const route = selectRoute(config, { step: 'arbitrate', level: routeLevel });
      const limits = { ...config.limits, maxChildren: MAX_CHILDREN };
      const { report } = await agentStep('arbitrate', route, { input: { ticket, loop, limits } });
      proposal = report?.error ? null : report; // an arbiter that crashed proposed nothing
    }
    const decision = arbitrate({ trigger: loop.trigger, escalations, otherFamilyAvailable, proposal: proposal?.action });
    escalations += 1;
    await log('arbitration', { trigger: loop.trigger, detail: loop.detail, action: decision.action });
    return { decision, proposal };
  };

  /**
   * A route outside `hard` families and, as far as the configuration allows,
   * outside `soft` families too. `soft` is ordered: the last ones are given up first.
   */
  const routeFor = (query, hard, soft) => {
    for (let kept = soft.length; kept > 0; kept -= 1) {
      try {
        return selectRoute(config, { ...query, excludeFamilies: [...hard, ...soft.slice(0, kept)] });
      } catch (error) {
        if (!(error instanceof RoutingError)) throw error;
      }
    }
    return selectRoute(config, { ...query, excludeFamilies: hard });
  };

  try {
    // Hidden scenarios are written first, by a step that never sees the implementation.
    // They may only add files: existing scenarios are changed through tickets of their own.
    const specifyRoute = selectRoute(config, { step: 'specify', level: routeLevel });
    const specified = mustSucceed('specify', await agentStep('specify', specifyRoute, { readOnly: false, input: { ticket } }));
    const holdout = await inspect(specified.patch);
    const holdoutOk =
      holdout !== null &&
      checkPatch(holdout.files, config, { allowHoldout: true }).ok &&
      holdout.files.every((file) => file.status === 'added' && matchesAny(file.path, config.paths.holdout));
    if (!holdoutOk) return await stop('needs_owner', 'The specify step did not produce a patch that only adds holdout scenarios.');
    const specifier = specifyRoute.family;
    const holdoutLines = diffStats(holdout.files).changedLines;
    const assumedInterfaces = strings(specified.report?.assumedInterfaces);

    let feedback = [];
    let previous = null; // the last patch of this author that applied, carried into a correction round

    // A loop trigger stops the author. Returns the final outcome, or null to start over with another family.
    const onLoop = async (loop) => {
      const { decision, proposal } = await escalate(loop);
      if (decision.action === 'reassign') {
        excludedAuthors = [...excludedAuthors, ...authors];
        authors = new Set();
        previous = null;
        lastAttempt = null;
        standing = new Map();
        run.steps = [];
        run.changedLines = 0;
        run.raisedFingerprints = [];
        run.refutedFingerprints = []; // another author writes another change: nothing is settled about it
        run.counters = { ...run.counters, fixRounds: 0, ciRuns: 0, commits: 0 };
        return null;
      }
      if (decision.action === 'split') {
        const proposed = Array.isArray(proposal?.tickets) ? proposal.tickets.slice(0, MAX_CHILDREN) : [];
        const titled = (entry) => String(entry?.title ?? '').trim().toLowerCase();
        // A child must be a valid ticket, survive its own rendering, and be neither a copy of its parent nor of a sibling.
        const children = proposed.filter(
          (child, index) =>
            validateTicket(child, config).length === 0 &&
            survivesRendering(child) &&
            titled(child) !== titled(ticket) &&
            proposed.findIndex((other) => titled(other) === titled(child)) === index,
        );
        if (children.length < 2) return stop('needs_owner', 'A split was decided but no valid set of smaller tickets was proposed.');
        return stop('split', decision.reason, { children });
      }
      return stop('needs_owner', `${decision.reason} ${loop.detail}`);
    };

    /**
     * Refutation: by a family that did not write the change, with an explicit
     * verdict for every finding. A finding that comes back after it was refuted
     * is never dropped and never argued again: it is a loop, and the arbiter decides.
     * @returns {Promise<{loop: object}|{blocking: object[]}>}
     */
    const judge = async (findings, level, patches) => {
      run.raisedFingerprints = findings.map((finding) => finding.fingerprint);
      const returned = returnedFinding(run);
      if (returned) return { loop: { trigger: 'refuted_finding_returned', detail: returned } };
      run.raisedFingerprints = [];
      if (findings.length === 0) return { blocking: [] };
      const route = routeFor({ step: 'refute', level }, [...authors], [specifier]);
      const refuted = mustSucceed('refute', await agentStep('refute', route, { patches, input: { findings } }));
      const parsed = parseVerdicts(refuted.report, findings);
      if (parsed.errors.length > 0) throw new Halt(`The refute report is incomplete: ${parsed.errors[0]}`);
      const sorted = triage(findings, parsed.verdicts);
      run.refutedFingerprints = [...new Set([...run.refutedFingerprints, ...sorted.refuted.map((finding) => finding.fingerprint)])];
      for (const finding of sorted.debt) await log('debt_finding', { category: finding.category, path: finding.path, message: finding.message });
      return { blocking: sorted.blocking };
    };

    const describe = (finding) => `${finding.category} in ${finding.path}: ${finding.message}`;

    for (;;) {
      const loop = detectLoop(run, budget, config.limits);
      if (loop) {
        const handled = await onLoop(loop);
        if (handled) return handled;
        feedback = [];
        continue;
      }

      // Implement, or correct on top of the previous attempt, without ever seeing the hidden scenarios.
      // The family that wrote the scenarios is preferred, so that another family is left to review both.
      const others = families(config).filter((family) => family !== specifier);
      const authorRoute = routeFor({ step: 'implement', level: routeLevel }, excludedAuthors, others);
      authors.add(authorRoute.family);
      const produced = await agentStep('implement', authorRoute, {
        readOnly: false,
        hidePaths: config.paths.holdout,
        patches: previous ? [previous] : [],
        input: { ticket, feedback, assumedInterfaces, limits: { changedLines: Math.max(0, config.limits.midFlightChangedLines - holdoutLines) } },
      });
      const record = { errorSignature: null, changedFiles: 0 };
      run.steps.push(record);
      if (produced.report?.error) {
        record.errorSignature = `step:${produced.report.error}`;
        record.changedFiles = 1; // a crash is an error, not "no change"
        feedback = await sendBack([`The implement step did not complete (${produced.report.error}).`]);
        continue;
      }
      const conflicts = strings(produced.report?.conflicts);
      if (conflicts.length > 0) return await stop('needs_owner', `The author reports a conflict it must not resolve alone: ${conflicts.join('; ')}`);

      // From here on, only what git says the patch does is trusted.
      const change = await inspect(produced.patch);
      if (change === null) {
        record.errorSignature = 'gate:does_not_apply';
        record.changedFiles = 1;
        await log('patch_refused', { rules: ['does_not_apply'] });
        feedback = await sendBack(['The patch does not apply on the trunk.']);
        continue;
      }
      const files = change.files;
      record.changedFiles = change.patch === lastAttempt ? 0 : files.length; // the same patch again is no change
      lastAttempt = change.patch;
      run.changedLines = holdoutLines + diffStats(files).changedLines; // the size of what would be published
      const outgrown = detectLoop(run, budget, config.limits);
      if (outgrown) {
        const handled = await onLoop(outgrown);
        if (handled) return handled;
        feedback = [];
        continue;
      }
      // What was confirmed on a patch stays confirmed on the same patch: a second,
      // more lenient review of unchanged work must not be what lets it through.
      if (standing.has(change.patch)) {
        record.errorSignature = 'review:unchanged_after_findings';
        feedback = await sendBack(['This patch was already reviewed, and what was confirmed about it still stands.', ...standing.get(change.patch)]);
        continue;
      }

      // Deterministic patch gate. The size limit applies to the change as published, scenarios included.
      const gate = checkPatch(files, config, { carriedLines: holdoutLines });
      const requestFile = files.find((file) => file.path === config.dependencies.requestFile);
      const dependencyProblems = [];
      if (requestFile) {
        let parsed = { requests: [], errors: ['The dependency request must be a new file containing valid JSON.'] };
        if (requestFile.status === 'added') {
          try {
            parsed = parseDependencyRequest(JSON.parse(requestFile.added.join('\n')));
          } catch {
            // keep the error above
          }
        }
        dependencyProblems.push(...parsed.errors);
        for (const request of parsed.requests) {
          const verdict = evaluateDependency(request, await registry.metadata(request), config.dependencies, clock.now());
          if (!verdict.approved) dependencyProblems.push(...verdict.reasons.map((reason) => `${request.name}: ${reason}`));
        }
      }
      if (!gate.ok || dependencyProblems.length > 0) {
        const rules = [...gate.violations.map((v) => v.rule), ...(dependencyProblems.length > 0 ? ['dependency_refused'] : [])];
        record.errorSignature = `gate:${[...new Set(rules)].sort().join(',')}`;
        await log('patch_refused', { rules });
        feedback = await sendBack([...gate.violations.map((v) => `${v.rule}: ${v.detail}`), ...dependencyProblems]);
        continue;
      }
      previous = change.patch; // only a patch that passed the gate is built upon

      // Risk is decided by what the whole change touches, hidden scenarios included.
      const everything = [...holdout.files, ...files];
      const weakening = detectWeakening(everything, config);
      const testsTouched = touchesExistingTests(everything, config);
      const risk = classifyRisk(everything, config, { weakeningSignals: weakening, dependencyRequest: Boolean(requestFile) });
      await log('risk', { level: risk.level, reasons: risk.reasons });
      if (LEVELS.indexOf(risk.level) > LEVELS.indexOf(routeLevel)) {
        return await stop('rework', `The change is ${risk.level} but the ticket was routed as ${routeLevel}.`, { level: risk.level });
      }

      // Publish and prove.
      const patches = [holdout.patch, change.patch];
      await unlessHalted();
      const sha = await vcs.publish({ base, branch, patches, message: `${ticket.title} (ticket ${ticket.id})` });
      run.counters.commits += 1;
      const labels = [`risk:${risk.level.toLowerCase()}`];
      if (!changeId) {
        changeId = (await forge.openChange({ ticketId: ticket.id, branch, title: ticket.title, body: risk.reasons.join('\n'), labels })).id;
      } else {
        await forge.setLabels(changeId, labels);
      }
      run.counters.ciRuns += 1;
      const verdict = await checks.wait(sha);
      if (verdict.status !== 'pass') {
        record.errorSignature = `checks:${verdict.signature ?? 'unknown'}`;
        feedback = await sendBack([`Checks failed: ${verdict.signature ?? 'no signature available'}`]);
        continue;
      }

      // Independent reviews: never a family that wrote the implementation and, when a
      // third party exists, not the family that wrote the scenarios either.
      const gates = requiredGates(risk.level, { weakeningSignals: weakening.length, testsTouched, externalTool: Boolean(ports.externalReview) });
      const reviewSteps = ['review'];
      if (gates.includes('security_review')) reviewSteps.push('security_review');
      if (gates.includes('test_guard_review')) reviewSteps.push('test_guard_review');
      const raised = [];
      const unmet = new Set();
      const reviewerFamilies = new Set();
      const authorReport = { summary: produced.report?.summary ?? null, embeddedInstructions: strings(produced.report?.embeddedInstructions), notDone: strings(produced.report?.notDone) };
      const review = async (step, exclude, avoid = [specifier]) => {
        const route = routeFor({ step, level: risk.level }, exclude, avoid);
        assertIndependentReview([...authors], route.family);
        reviewerFamilies.add(route.family);
        const input = step === 'test_guard_review' ? { ticket, weakening } : { ticket, authorReport };
        const result = mustSucceed(step, await agentStep(step, route, { patches, input }));
        const parsed = parseFindings(result.report);
        if (parsed.errors.length > 0) throw new Halt(`The ${step} report is malformed: ${parsed.errors[0]}`);
        raised.push(...parsed.findings);
        if (step === 'review') closure(ticket, result.report.criteria ?? {}).unmet.forEach((criterion) => unmet.add(criterion));
        return route.family;
      };
      let firstReviewer = null;
      for (const step of reviewSteps) {
        const family = await review(step, [...authors]);
        if (step === 'review') firstReviewer = family;
      }
      // The second review comes from a family that did not give the first one, when such a family exists.
      if (gates.includes('second_independent_review')) await review('review', [...authors], [firstReviewer, specifier]);

      const again = async (loop) => {
        const handled = await onLoop(loop);
        if (!handled) feedback = [];
        return handled;
      };
      const judged = await judge(raised, risk.level, patches);
      if (judged.loop) {
        const handled = await again(judged.loop);
        if (handled) return handled;
        continue;
      }
      if (judged.blocking.length > 0 || unmet.size > 0) {
        standing.set(change.patch, [...judged.blocking.map(describe), ...[...unmet].map((criterion) => `Acceptance criterion not evidenced: ${criterion}`)]);
        feedback = await sendBack(standing.get(change.patch));
        continue;
      }

      // The external tool has a small budget: it is spent on a commit the model reviews let through.
      const missed = [];
      if (gates.includes('external_tool_pass')) {
        if (run.counters.externalToolPasses >= budget.externalToolPasses) {
          missed.push('external_tool_pass');
        } else {
          run.counters.externalToolPasses += 1;
          await unlessHalted();
          const answer = await ports.externalReview({ sha, patch: change.patch });
          await unlessHalted();
          const external = parseFindings(answer);
          if (external.errors.length > 0) throw new Halt(`The external review report is malformed: ${external.errors[0]}`);
          const verdict = await judge(external.findings, risk.level, patches);
          if (verdict.loop) {
            const handled = await again(verdict.loop);
            if (handled) return handled;
            continue;
          }
          if (verdict.blocking.length > 0) {
            standing.set(change.patch, verdict.blocking.map(describe));
            feedback = await sendBack(standing.get(change.patch));
            continue;
          }
        }
      }

      // Every gate passed. Autonomy decides who presses the button.
      const passed = gates.filter((gate) => !missed.includes(gate));
      const scenariosReviewedByAnotherFamily = !reviewerFamilies.has(specifier);
      await log('gates_passed', { level: risk.level, gates: passed, missed, sha, authors: [...authors], specifier, reviewers: [...reviewerFamilies], scenariosReviewedByAnotherFamily });
      const done = { level: risk.level, sha, gatesPassed: true };
      if (missed.length > 0) return await stop('needs_owner', 'Every other gate passed, but the external review budget was spent on an earlier commit: this commit was not examined by the external tool.', done);
      const overrun = detectLoop(run, budget, config.limits);
      if (overrun) return await stop('needs_owner', `All gates passed but the budget was exceeded (${overrun.detail}).`, done);
      if (requestFile) return await stop('needs_owner', 'All gates passed and the dependency request was approved; installing it is a step for the owner until the queue does it.', done);
      if (mayMergeAlone(config.autonomy.tier, risk.level)) return await stop('queued', 'All gates passed.', done);
      return await stop('needs_owner', `All gates passed; tier ${config.autonomy.tier} does not merge ${risk.level} changes alone.`, done);
    }
  } catch (error) {
    if (error instanceof Interrupted) return await stop('halted', error.message);
    if (error instanceof RoutingError || error instanceof Halt) return await stop('needs_owner', error.message);
    throw error;
  }
}
