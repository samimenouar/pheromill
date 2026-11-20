/**
 * The ticket pipeline: a fixed sequence of deterministic gates around agent
 * steps. Agents write and review; they never decide whether their own work
 * passes. Every decision is appended to the ledger.
 *
 *   specify -> implement -> patch gate -> publish -> checks -> review(s)
 *           -> refutation -> correction round (bounded) -> risk gates -> queue
 */
import { mayMergeAlone, requiredGates } from '../domain/autonomy.js';
import { arbitrate, budgetFor, detectLoop } from '../domain/budget.js';
import { evaluateDependency, parseDependencyRequest } from '../domain/dependency-gate.js';
import { diffStats, parseUnifiedDiff, reconcile } from '../domain/diff.js';
import { parseFindings, parseVerdicts, triage } from '../domain/findings.js';
import { matchesAny, mayFallUnder } from '../domain/glob.js';
import { checkPatch } from '../domain/patch-policy.js';
import { classifyRisk, LEVELS, maxLevel } from '../domain/risk.js';
import { assertIndependentReview, families, RoutingError, selectRoute } from '../domain/routing.js';
import { detectWeakening, touchesExistingTests } from '../domain/test-guard.js';
import { closure, validateTicket } from '../domain/ticket.js';

const MAX_CHILDREN = 5;

/** Raised to stop the pipeline and hand the ticket to the owner. */
class Halt extends Error {}

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
 *   externalReview?: (input: {sha: string, patch: string}) => Promise<{findings: object[]}>}} ports
 * @returns {Promise<{outcome: 'queued'|'needs_owner'|'rework'|'split'|'invalid', reason: string, level?: string,
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
  let changeId = null;
  let stepCount = 0;
  const base = await vcs.head(config.project.trunk);
  const branch = `factory/t${ticket.id}`;
  const runId = `t${ticket.id}`.toLowerCase();

  const agentStep = async (step, route, job) => {
    stepCount += 1;
    const result = await runner.run({ runId: `${runId}-${stepCount}`, step, route, base, patches: [], hidePaths: [], readOnly: true, ...job });
    run.counters.sandboxSeconds += result.seconds;
    if (typeof result.tokens === 'number' && run.counters.tokens !== null) run.counters.tokens += result.tokens;
    else run.counters.tokens = null; // unknown stays unknown
    await log('step', { step, harness: route.harness, model: route.model, family: route.family, seconds: result.seconds, tokens: result.tokens, error: result.report?.error ?? null });
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
      proposal = (await agentStep('arbitrate', route, { input: { ticket, loop } })).report;
    }
    const decision = arbitrate({ trigger: loop.trigger, escalations, otherFamilyAvailable, proposal: proposal?.action });
    escalations += 1;
    await log('arbitration', { trigger: loop.trigger, detail: loop.detail, action: decision.action });
    return { decision, proposal };
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

    let feedback = [];
    let previous = null; // the last patch of this author that applied, carried into a correction round

    // A loop trigger stops the author. Returns the final outcome, or null to start over with another family.
    const onLoop = async (loop) => {
      const { decision, proposal } = await escalate(loop);
      if (decision.action === 'reassign') {
        excludedAuthors = [...excludedAuthors, ...authors];
        authors = new Set();
        previous = null;
        run.steps = [];
        run.changedLines = 0;
        run.raisedFingerprints = [];
        run.counters = { ...run.counters, fixRounds: 0, ciRuns: 0, commits: 0 };
        return null;
      }
      if (decision.action === 'split') {
        const proposed = Array.isArray(proposal?.tickets) ? proposal.tickets.slice(0, MAX_CHILDREN) : [];
        const children = proposed.filter((child) => validateTicket(child, config).length === 0);
        if (children.length < 2) return stop('needs_owner', 'A split was decided but no valid set of smaller tickets was proposed.');
        return stop('split', decision.reason, { children });
      }
      return stop('needs_owner', `${decision.reason} ${loop.detail}`);
    };

    for (;;) {
      const loop = detectLoop(run, budget, config.limits);
      if (loop) {
        const handled = await onLoop(loop);
        if (handled) return handled;
        feedback = [];
        continue;
      }

      // Implement, or correct on top of the previous attempt, without ever seeing the hidden scenarios.
      const authorRoute = selectRoute(config, { step: 'implement', level: routeLevel, excludeFamilies: excludedAuthors });
      authors.add(authorRoute.family);
      const produced = await agentStep('implement', authorRoute, {
        readOnly: false,
        hidePaths: config.paths.holdout,
        patches: previous ? [previous] : [],
        input: { ticket, feedback },
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
      previous = change.patch === '' ? previous : change.patch;
      record.changedFiles = files.length;
      run.changedLines = diffStats(files).changedLines;
      const outgrown = detectLoop(run, budget, config.limits);
      if (outgrown) {
        const handled = await onLoop(outgrown);
        if (handled) return handled;
        feedback = [];
        continue;
      }

      // Deterministic patch gate.
      const gate = checkPatch(files, config);
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

      // Independent reviews: never a family that wrote the change.
      const gates = requiredGates(risk.level, { weakeningSignals: weakening.length, testsTouched, externalTool: Boolean(ports.externalReview) });
      const reviewSteps = ['review'];
      if (gates.includes('security_review')) reviewSteps.push('security_review');
      if (gates.includes('test_guard_review')) reviewSteps.push('test_guard_review');
      const raised = [];
      const unmet = new Set();
      const reviewerFamilies = new Set();
      const authorReport = { summary: produced.report?.summary ?? null, embeddedInstructions: strings(produced.report?.embeddedInstructions), notDone: strings(produced.report?.notDone) };
      const review = async (step, exclude) => {
        const route = selectRoute(config, { step, level: risk.level, excludeFamilies: exclude });
        assertIndependentReview([...authors], route.family);
        reviewerFamilies.add(route.family);
        const input = step === 'test_guard_review' ? { ticket, weakening } : { ticket, authorReport };
        const result = mustSucceed(step, await agentStep(step, route, { patches, input }));
        const parsed = parseFindings(result.report);
        if (parsed.errors.length > 0) throw new Halt(`The ${step} report is malformed: ${parsed.errors[0]}`);
        raised.push(...parsed.findings);
        if (step === 'review') closure(ticket, result.report.criteria ?? {}).unmet.forEach((criterion) => unmet.add(criterion));
      };
      for (const step of reviewSteps) await review(step, [...authors]);
      if (gates.includes('second_independent_review')) {
        const third = families(config).some((family) => !authors.has(family) && !reviewerFamilies.has(family));
        await review('review', third ? [...authors, ...reviewerFamilies] : [...authors]);
      }
      if (gates.includes('external_tool_pass') && run.counters.externalToolPasses < budget.externalToolPasses) {
        run.counters.externalToolPasses += 1;
        const external = parseFindings(await ports.externalReview({ sha, patch: change.patch }));
        if (external.errors.length > 0) throw new Halt(`The external review report is malformed: ${external.errors[0]}`);
        raised.push(...external.findings);
      }

      // Refutation: by a family that did not write the change, with an explicit
      // verdict for every finding. A finding already refuted is not argued again;
      // its return is a loop signal.
      const fresh = raised.filter((finding) => !run.refutedFingerprints.includes(finding.fingerprint));
      run.raisedFingerprints = raised.filter((finding) => !fresh.includes(finding)).map((finding) => finding.fingerprint);
      let verdicts = {};
      if (fresh.length > 0) {
        const route = selectRoute(config, { step: 'refute', level: risk.level, excludeFamilies: [...authors] });
        const refuted = mustSucceed('refute', await agentStep('refute', route, { patches, input: { findings: fresh } }));
        const parsed = parseVerdicts(refuted.report, fresh);
        if (parsed.errors.length > 0) throw new Halt(`The refute report is incomplete: ${parsed.errors[0]}`);
        verdicts = parsed.verdicts;
      }
      const sorted = triage(fresh, verdicts);
      run.refutedFingerprints = [...new Set([...run.refutedFingerprints, ...sorted.refuted.map((finding) => finding.fingerprint)])];
      for (const finding of sorted.debt) await log('debt_finding', { category: finding.category, path: finding.path, message: finding.message });

      if (sorted.blocking.length > 0 || unmet.size > 0) {
        feedback = await sendBack([
          ...sorted.blocking.map((finding) => `${finding.category} in ${finding.path}: ${finding.message}`),
          ...[...unmet].map((criterion) => `Acceptance criterion not evidenced: ${criterion}`),
        ]);
        continue;
      }

      // Every gate passed. Autonomy decides who presses the button.
      await log('gates_passed', { level: risk.level, gates, sha, authors: [...authors], reviewers: [...reviewerFamilies] });
      const done = { level: risk.level, sha, gatesPassed: true };
      const overrun = detectLoop({ ...run, raisedFingerprints: [] }, budget, config.limits);
      if (overrun) return await stop('needs_owner', `All gates passed but the budget was exceeded (${overrun.detail}).`, done);
      if (requestFile) return await stop('needs_owner', 'All gates passed and the dependency request was approved; installing it is a step for the owner until the queue does it.', done);
      if (mayMergeAlone(config.autonomy.tier, risk.level)) return await stop('queued', 'All gates passed.', done);
      return await stop('needs_owner', `All gates passed; tier ${config.autonomy.tier} does not merge ${risk.level} changes alone.`, done);
    }
  } catch (error) {
    if (error instanceof RoutingError || error instanceof Halt) return await stop('needs_owner', error.message);
    throw error;
  }
}
