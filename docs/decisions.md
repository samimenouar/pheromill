# Decisions

Each decision states what was chosen, why, what it brings, and what it costs.
Any of them can be reopened with a ticket. Items the owner has not confirmed
are marked provisional and listed by `pheromill check`.

## D-01 Deterministic gates around agent steps

- **Decision.** The pipeline is a fixed sequence in code. Agents fill the
  creative steps; code decides routing, risk, pass or fail, and when to stop.
- **Why.** A model asked whether its own work passes will often say yes.
  Stripe describes the same split for its Minions (deterministic nodes mixed
  with agent nodes, and a hard cap on CI rounds).
- **Benefit.** Behaviour is testable and cheap: no tokens are spent deciding
  things a rule can decide.
- **Risk.** A fixed sequence does not adapt to unusual work. Such tickets end
  with the owner, which is slower but safe.

## D-02 The reviewer comes from another model family

- **Decision.** Routing refuses a reviewer or a refuter of the same family as
  any author of the change.
- **Why.** "Nobody approves their own work" must hold structurally. Two runs of
  one model share blind spots.
- **Benefit.** Uncorrelated review; a single-vendor outage or regression does
  not silently lower the bar.
- **Risk.** At least two vendors are required, which costs more and doubles
  the integration work. With one family the factory still runs, at tier 0.

## D-03 Hidden acceptance scenarios

- **Decision.** A specify step writes scenarios from the ticket alone; the
  implementer's workspace is built without them and its patch cannot touch them.
- **Why.** An agent that can read the tests can satisfy the tests instead of
  the ticket.
- **Benefit.** Passing means the behaviour exists.
- **Risk.** Scenarios written without seeing the code may assume an interface
  the implementer does not choose; a mismatch costs a round. In a public
  repository, old scenarios are readable on the forge; the implementer's
  sandbox has no route to it.

## D-04 Risk is computed from paths

- **Decision.** LOW, HIGH or CRITICAL depends only on what a change touches.
- **Why.** The level must not be negotiable by the agent it constrains.
- **Benefit.** Predictable, explainable in one line, impossible to argue with.
- **Risk.** Paths are a proxy. A dangerous change in an ordinary file is LOW;
  a weekly review of merged code is planned for that case. The lists of core
  and reserved paths need upkeep.

## D-05 Autonomy is earned by tier

- **Decision.** Four tiers. Each lets one more risk level merge without a
  human, on thresholds written before measuring.
- **Why.** The goal is full autonomy from the start, HIGH and CRITICAL
  included, but only where the evidence supports it.
- **Benefit.** The same pipeline runs at every tier; raising autonomy is a
  one-line change to a reserved file. Below the required tier a person
  approves with a label, and the queue still does the landing.
- **Risk.** Thresholds chosen badly either block progress or grant trust too
  early. They are provisional until four weeks of measurements exist.

PROVISIONAL(promotion-thresholds): the thresholds for tiers 1 to 3 are not defined; the owner sets them before measurements start.

## D-06 A merge queue of our own, landing by fast-forward

- **Decision.** The queue builds candidate commits (merge commits on top of the
  trunk), tests them, and fast-forwards the trunk to a candidate that passed.
- **Why.** GitHub's native queue is limited to organization-owned
  repositories, and a forge feature would tie the factory to that forge.
  Batching, speculation and bisection follow the approach documented by Mergify.
- **Benefit.** What lands is the exact commit that was tested, built from the
  commits that were reviewed. One serial lane with speculative candidates is
  always correct.
- **Risk.** History contains merge commits rather than a linear list. Fully
  parallel lanes for independent scopes are not built; throughput is bounded
  by check duration until they are.

## D-07 Three zones; work crosses as files

- **Decision.** Control, runner and egress each hold one kind of secret. Jobs
  and results cross between control and runner as files only.
- **Why.** The lesson of build-system breaches is that one over-trusted
  credential turns a sandbox escape into a platform compromise.
- **Benefit.** A broken sandbox yields a patch that still faces every gate.
  The link is trivially auditable and works across machines.
- **Risk.** Polling files is slower than a message bus (about a second per
  step) and needs a shared directory. The runner's daemon access remains the
  most sensitive point of the design: on a single host it defeats the
  separation, so production needs a second machine, which is not built yet.

## D-08 Model keys stay behind a gateway

- **Decision.** A sandbox receives a step token; the gateway swaps it for the
  provider key on the way out, for exact listed API paths only.
- **Why.** AI provider keys are what attackers look for.
- **Benefit.** A leaked token is worth minutes of one step.
- **Risk.** Depends on each harness accepting a custom base URL; to prove per
  harness. The gateway is one more service to keep available.

## D-09 Agents return patches; the control zone publishes

- **Decision.** No agent ever holds a forge credential or runs git against the
  remote. The runner diffs the workspace; the control zone applies the patch.
- **Why.** Publishing is the privilege worth protecting.
- **Benefit.** The gates see every byte that enters the repository. They do
  not trust the patch text: the control zone applies it and takes git's own
  account of the paths and modes it changes, because a parser and `git apply`
  can read the same text differently.
- **Risk.** Agents cannot use forge features directly (comments, labels); the
  dispatcher does it for them. Each patch is applied twice, which costs a few
  hundred milliseconds.

## D-10 No dependency, plain JavaScript

- **Decision.** Node.js 22, ES modules, the built-in test runner, no package
  to install, JSON configuration.
- **Why.** A factory that guards supply chains should keep its own as short as
  possible. JSON needs no parser dependency.
- **Benefit.** Clone and run. What remains to trust is Node.js, git, the
  container runtime, the base image, and two pinned CI actions.
- **Risk.** No static type checking and no third-party linter; JSON has no
  comments. Coverage thresholds and the layer check compensate in part.

## D-11 A proof registry instead of promises

- **Decision.** Every capability is a claim with a status; a claim marked
  proven names a test, and the verify command checks that the test exists.
- **Why.** "Production-ready" is not a fact one can check; a list of proven
  and unproven claims is.
- **Benefit.** Readers can trust the documentation exactly as far as the
  status page goes.
- **Risk.** A test can exist and still prove little; the registry checks
  presence, reviewers check substance.

## D-12 A hash-chained ledger

- **Decision.** Decisions, steps, costs, merges and evictions are appended to
  a file where each entry commits to the previous one.
- **Why.** Every choice must leave a trace that agents cannot rewrite.
- **Benefit.** An edited, removed or reordered entry is detectable with one
  command; rework counts and escalations are read from it.
- **Risk.** Tamper-evident is not tamper-proof: someone with write access to
  the control host can cut the tail or rebuild the chain. Copying the head
  hash elsewhere closes that gap; the command prints it, and anchoring it
  automatically is planned.

## D-13 Docker as the first sandbox runtime

- **Decision.** Steps run as hardened Docker containers.
- **Why.** It is available everywhere and the hardening is expressible as
  arguments that can be tested.
- **Benefit.** The hardening is checked against a real runtime in CI.
- **Risk.** Containers share the host kernel. A micro-VM per step is stronger
  isolation and would be a new launcher behind the same interface.

## D-14 Tickets come from trusted authors and start with a label

- **Decision.** Only issues written by the owner, a member or a collaborator,
  and labelled `factory:ready` by a person, are dispatched. Tickets proposed
  by the factory itself (a split) wait for that label too.
- **Why.** In a public repository anyone can open an issue, and an author can
  edit the text after it was labelled. Issue text is input to agents.
- **Benefit.** Authorization uses the forge's own permissions.
- **Risk.** A person is in the loop at intake, and outside contributors need a
  maintainer to file their ticket. That is deliberate.

## D-15 Starting values

The ceilings and limits in the default configuration (500 lines, two
correction rounds, four check runs, batches of four, seven days for a
dependency version, and so on) are starting values to recalibrate on
measurements.

PROVISIONAL(calibration): time and token ceilings per point are to be set after four weeks of measurements.

## D-16 License

Apache License 2.0 was chosen for its explicit patent grant.

PROVISIONAL(license): the license was chosen by the author of the genesis import; the owner confirms or replaces it.

## D-17 The genesis exception

- **Decision.** The first import of this repository did not go through the
  factory: it was written in one session by one AI agent, in a single change
  far above 500 lines.
- **Why.** A factory cannot build itself before it exists.
- **Benefit.** Everything after it is subject to the rules.
- **Review.** Three independent agents reviewed the import before it was
  published: security, correctness, and documentation against code. They
  reported about ninety findings. Among those confirmed and fixed: a patch
  could name one file and change another; a failed refutation step cleared
  every finding; the refuter could belong to the author's family; a correction
  round lost the previous attempt; the queue could wedge when changes arrived
  while candidates were under test; and several statements in these documents
  described planned work in the present tense.
- **Risk.** Those reviewers were of the same model family as the author, not
  of another family. The owner's review of the genesis change is the missing
  independent look.

## Sources of inspiration

| Source | What was taken from it |
| --- | --- |
| Stripe, Minions ([part 1](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents), [part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2)) | Deterministic steps around agent steps; a hard cap on correction rounds |
| [OpenAI, Symphony specification](https://github.com/openai/symphony) | Tracker credentials never reach the agent's environment; one isolated workspace per run |
| [Dark factory experiment](https://github.com/coleam00/dark-factory-experiment) | Protected files, a 500-line cap, tests are never edited to pass |
| [Addy Osmani, factory](https://github.com/addyosmani/factory) | The writer never grades the work; autonomy tracks consequence |
| [Fabro](https://github.com/fabro-sh/fabro) | Model routing as a one-line change; cross-vendor critique |
| [Mergify documentation](https://docs.mergify.com/merge-queue/batches) | Batches, speculative checks, bisection on failure |
| [DORA](https://dora.dev/guides/dora-metrics-four-keys/) | The five delivery metrics |
