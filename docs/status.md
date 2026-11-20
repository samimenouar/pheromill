# Status: what is proven and what is not

Generated from `proofs/registry.json` by `pheromill proofs render`. Do not edit by hand.

**66 proven, 8 to prove, 22 planned.**

- **PROVEN**: an automated test demonstrates the claim on every change. Tests that need a container runtime run in the `sandbox` CI job; both CI jobs are required.
- **TO_PROVE**: the capability is built, but has not been demonstrated in a real environment.
- **PLANNED**: the capability is designed and not built, or only its computation exists.

A proven claim means the named tests pass. It does not mean the capability was exercised against a live forge or a real model provider: those are the TO_PROVE lines.

## Tickets and scheduling

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| A ticket is dispatched only with 1 to 5 points, acceptance criteria and likely files | PROVEN | `test/domain/flow.test.js`: ticket: a micro-fix, an oversized ticket or a ticket without criteria is not dispatchable<br>`holdout/pipeline.test.js`: pipeline: an invalid ticket is never dispatched |
| A ticket body that does not follow the form unambiguously is refused, not guessed | PROVEN | `test/domain/flow.test.js`: ticket: the form is read strictly; ambiguity is refused, not guessed<br>`holdout/pipeline.test.js`: pipeline: a ticket whose form is ambiguous is not dispatched |
| Only issues written by a person the repository already trusts, and labelled ready, become tickets | PROVEN | `test/adapters/github.test.js`: github: tickets are open issues with the label; pull requests are ignored |
| A change whose acceptance criteria are not all evidenced by the reviewer is sent back, not accepted | PROVEN | `test/domain/flow.test.js`: ticket: done means done<br>`holdout/pipeline.test.js`: pipeline: an acceptance criterion without evidence is not done |
| A frozen milestone defers every ticket that does not block one of its exit criteria | PROVEN | `test/domain/flow.test.js`: ticket: a frozen milestone only admits tickets that block an exit criterion<br>`test/application/dispatch.test.js`: dispatcher: a frozen milestone defers every ticket |
| Two tickets whose likely files may overlap never run at the same time, including while one waits in the queue | PROVEN | `test/domain/flow.test.js`: scheduler: tickets whose likely files may overlap never run together<br>`test/application/dispatch.test.js`: dispatcher: non-overlapping tickets run, overlapping ones wait |
| One debt ticket is scheduled for every four feature tickets | PROVEN | `test/domain/flow.test.js`: scheduler: capacity is bounded and one debt ticket is owed per four feature tickets |
| A ticket sent back twice, by the pipeline or by the queue, goes to the owner instead of looping | PROVEN | `test/application/dispatch.test.js`: dispatcher: a rerouted ticket keeps its number, gets its risk label, and is capped<br>`test/application/queue.test.js`: queue tick: a failing change is isolated and sent back to rework |
| An oversized change is split into valid smaller tickets, which wait for a person before they are worked | PROVEN | `holdout/pipeline.test.js`: pipeline: a change that outgrows its ticket is split<br>`test/application/dispatch.test.js`: dispatcher: a split closes the original |
| A ticket never stays in progress with nobody working on it, after an error or a restart | PROVEN | `test/application/dispatch.test.js`: dispatcher: after a restart, a ticket left in progress<br>`test/application/dispatch.test.js`: dispatcher: a failure while recording an outcome never leaves a ticket in progress<br>`test/application/dispatch.test.js`: dispatcher: an unexpected pipeline error stops that ticket only |
| The owner is alerted when a milestone closes no more tickets than it creates in a week | PLANNED | The computation exists and is tested; schedule the weekly job and the notification. |

## Risk and gates

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| The risk level is computed from the paths a change touches, without any model | PROVEN | `test/domain/risk-and-tests.test.js`: risk: an ordinary change is LOW<br>`test/domain/risk-and-tests.test.js`: risk: a core module, an existing test or a dependency request is HIGH<br>`test/domain/risk-and-tests.test.js`: risk: a reserved path is CRITICAL |
| A change that cannot be parsed with certainty is treated as CRITICAL and refused by the patch gate | PROVEN | `test/domain/risk-and-tests.test.js`: risk: fails closed on a path it cannot parse<br>`test/domain/diff-and-policy.test.js`: diff: anything git would read differently from this parser is refused |
| The gates judge what git reports the patch does, not what the patch text claims | PROVEN | `test/adapters/git.test.js`: git: the gates see what git applies, whatever the patch text claims<br>`test/adapters/git.test.js`: git: a symbolic link already on the trunk cannot be retargeted<br>`test/domain/diff-and-policy.test.js`: diff: reconciling with what git reports fails closed on any disagreement<br>`holdout/pipeline.test.js`: pipeline: a patch that does not apply, or that says one thing and does another, is refused |
| File content that imitates a diff header cannot hide or forge a changed file | PROVEN | `test/domain/diff-and-policy.test.js`: diff: file content that imitates a diff header cannot forge a file entry |
| Symlinks, submodules, binaries, mode changes, path escapes and changes over 500 lines are refused | PROVEN | `test/domain/diff-and-policy.test.js`: patch policy: rejects structural tricks<br>`test/domain/diff-and-policy.test.js`: patch policy: a change above 500 lines or an empty patch is rejected<br>`test/adapters/git.test.js`: git: symlinks and nested repositories planted by a step are caught by the patch gate |
| Agents cannot edit lock files and other queue-owned files | PROVEN | `holdout/pipeline.test.js`: pipeline: a patch touching a queue-owned file is refused before anything is published |
| The merge queue regenerates queue-owned files in each candidate | PLANNED | Add a regenerate command to the candidate build and prove it on a lock file. |
| Review gates grow with the risk level, and a change riskier than its ticket was routed for is sent back | PROVEN | `test/domain/risk-and-tests.test.js`: autonomy: gates grow with the risk level<br>`holdout/pipeline.test.js`: pipeline: an injected instruction that reaches a reserved path makes the change CRITICAL |
| Each autonomy tier lets exactly one more risk level merge without a human | PROVEN | `test/domain/risk-and-tests.test.js`: autonomy: each tier unlocks exactly one more risk level<br>`holdout/pipeline.test.js`: pipeline: at tier 0 every gate still runs but the owner presses the button |
| Below the required tier, a change that passed every gate enters the queue when a person approves it, pinned to the reviewed commit | PROVEN | `test/application/dispatch.test.js`: dispatcher: at tier 0 a change that passed every gate enters the queue when a person approves it |
| Tier promotion is decided automatically from measured values | PLANNED | The comparison with thresholds exists and is tested; define the thresholds, collect four weeks of measurements, and wire the check. |

## Independence and anti-cheating

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Nobody approves their own work: reviewers and the refuter always come from another model family than the author | PROVEN | `test/domain/security.test.js`: routing: nobody approves their own work<br>`holdout/pipeline.test.js`: pipeline: with a single model family nothing can be approved<br>`holdout/pipeline.test.js`: pipeline: a confirmed blocking finding costs one fix round<br>`holdout/pipeline.test.js`: pipeline: the same failure three times stops the author and hands the ticket to another family |
| The implementing agent never sees the hidden scenarios; reviewers receive them with the change | PROVEN | `holdout/pipeline.test.js`: pipeline: the implementer never sees the holdout scenarios, reviewers do<br>`test/adapters/git.test.js`: git: a step workspace has no repository metadata and no hidden path<br>`test/domain/diff-and-policy.test.js`: patch policy: holdout scenarios are writable by the specify step only |
| The specify step can only add scenarios; without it nothing is implemented | PROVEN | `holdout/pipeline.test.js`: pipeline: the specify step may only add scenarios<br>`holdout/pipeline.test.js`: pipeline: without a route for hidden scenarios nothing is implemented |
| Editing or removing an existing test raises the change to HIGH and triggers a dedicated review, with or without a detector signal | PROVEN | `test/domain/risk-and-tests.test.js`: test guard: detects a deleted test, removed assertions and skipped tests<br>`test/domain/risk-and-tests.test.js`: test guard: detects a relaxed threshold, a replaced snapshot and a coverage drop<br>`holdout/pipeline.test.js`: pipeline: an author who edits an existing test is caught and rerouted as HIGH<br>`holdout/pipeline.test.js`: pipeline: swapping a real assertion for an empty one |
| A finding is dropped only by an explicit refutation from another family; minor findings are recorded as debt and never become tickets | PROVEN | `holdout/pipeline.test.js`: pipeline: a confirmed blocking finding costs one fix round<br>`holdout/pipeline.test.js`: pipeline: a refutation that is missing, late, partial or misspelt stops the ticket<br>`test/domain/measure.test.js`: findings: a refutation report needs one exact verdict per finding |
| A step that crashed, timed out or returned a malformed report never counts as approval | PROVEN | `holdout/pipeline.test.js`: pipeline: a step that crashed or timed out proves nothing<br>`holdout/pipeline.test.js`: pipeline: a malformed review report stops the ticket<br>`test/adapters/sandbox-runner.test.js`: runner: timeouts, crashes and malformed reports are reported, never trusted |
| An author that reports a conflict between the ticket and the rules stops the ticket | PROVEN | `holdout/pipeline.test.js`: pipeline: an author who reports a conflict |
| A reviewing step cannot modify the change it reviews | PROVEN | `test/adapters/sandbox-runner.test.js`: runner: a reviewing step reads the change, cannot write it, and has no proxy<br>`integration/docker.test.js`: docker: a read-only workspace cannot be modified by a reviewing step |
| A correction round starts from the previous attempt, and its patch stays relative to the trunk | PROVEN | `test/adapters/sandbox-runner.test.js`: runner: a correction round starts from the previous attempt<br>`holdout/pipeline.test.js`: pipeline: a confirmed blocking finding costs one fix round |
| A route with grade C only runs on the reference set, never on real tickets | PROVEN | `test/domain/security.test.js`: routing: a grade C route only runs on the reference set |
| Routes earn their grade by replaying known tickets and four trap cases | PLANNED | The scoring exists and is tested; build the four trap fixtures and the replay command. |
| Mutation tests run on changed core files in the merge queue | PLANNED | Add a mutation command to the configuration and run it on candidates that touch core modules. |
| Weekly and monthly audits of merged code run on a schedule within a written token ceiling | PLANNED | The audit prompt exists; add the schedule and route its findings through refutation. |
| A finding class seen three times is turned into a rule or a lint | PLANNED | The detection exists and is tested; add the step that opens the rule ticket. |
| An external review tool can be configured for HIGH and CRITICAL changes | PLANNED | The pipeline accepts one and budgets a single pass (tested); add the configuration key and a first adapter. |
| Untrusted external content is read by a separate step with no repository access | PLANNED | The role, its network policy and its prompt exist; add the read step to the pipeline and give it an empty workspace. |

## Loops and budget

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Five deterministic triggers stop a ticket that is going in circles | PROVEN | `test/domain/flow.test.js`: loop detection: each of the five deterministic triggers fires |
| A ticket is escalated once; the second time the owner decides | PROVEN | `test/domain/flow.test.js`: arbiter: three outcomes, one escalation per ticket<br>`holdout/pipeline.test.js`: pipeline: a ticket is escalated once; the second time the owner decides |
| Each ticket has a budget derived from its points, and uncalibrated ceilings stay UNKNOWN | PROVEN | `test/domain/flow.test.js`: budget: ceilings scale with points and uncalibrated ones stay UNKNOWN |
| A cost no harness reported is recorded as UNKNOWN, never estimated | PROVEN | `test/domain/measure.test.js`: cost: a cost no harness reported stays UNKNOWN<br>`holdout/pipeline.test.js`: pipeline: token cost is summed when reported and UNKNOWN as soon as one step hides it |
| An external review, when one is wired in, runs at most once and only on HIGH or CRITICAL changes | PROVEN | `holdout/pipeline.test.js`: pipeline: an external review tool, when configured, runs once on HIGH changes only |
| Daily and weekly budget reports compare cost per point over time and flag changes near their ceiling | PLANNED | The computations exist and are tested; schedule the reports, add the daily ceiling, calibrate after four weeks. |

## Merge queue

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Every change is tested on the future state of the trunk, and the trunk only fast-forwards to a commit whose checks passed | PROVEN | `test/domain/flow.test.js`: merge queue: later batches are tested on the future trunk<br>`test/application/queue.test.js`: queue tick: the trunk only fast-forwards to candidates whose checks passed<br>`test/adapters/git.test.js`: git: publish, build a candidate on the future trunk, and fast-forward to it |
| The queue merges the commit that passed the gates, not whatever its branch points to later | PROVEN | `test/adapters/git.test.js`: git: a candidate is built from the reviewed commit<br>`test/application/dispatch.test.js`: dispatcher: non-overlapping tickets run, overlapping ones wait, approved changes enter the queue |
| Changes are tested in batches; a failed batch is bisected and only the culprit is evicted | PROVEN | `test/domain/flow.test.js`: merge queue: a failed batch is bisected<br>`test/domain/flow.test.js`: merge queue: the last change of a failed batch is evicted without a wasted run<br>`test/application/queue.test.js`: queue tick: a failing change is isolated and sent back to rework |
| A flaky failure is retried, recorded, and does not evict a change | PROVEN | `test/domain/flow.test.js`: merge queue: a flaky failure is retried, reported, and does not evict<br>`test/application/queue.test.js`: queue tick: a flaky candidate is rebuilt, retested and recorded |
| Whatever the order of admissions and results, the queue lands every good change and evicts every bad one | PROVEN | `test/application/queue.test.js`: queue tick: random admissions, failures and timings always converge on the right trunk<br>`test/application/queue.test.js`: queue tick: changes admitted while candidates are under test never wedge the queue<br>`test/application/queue.test.js`: queue tick: a head that fails while its speculative child passes |
| When the trunk moves outside the queue, or a tick is interrupted, the queue recovers without a wrong or double landing | PROVEN | `test/application/queue.test.js`: queue tick: when the trunk moves outside the queue, candidates are rebuilt on the new head<br>`test/application/queue.test.js`: queue tick: a tick interrupted after the fast-forward is replayed without a second landing |
| A change that conflicts with the future trunk is evicted before any check runs | PROVEN | `test/application/queue.test.js`: queue tick: a change that conflicts with the future trunk is evicted<br>`test/adapters/git.test.js`: git: a conflicting branch is reported instead of producing a candidate |
| The merge queue lands changes on a real forge | TO_PROVE | Set forge.queueActor, apply the ruleset, and run the control service against a sandbox repository. |
| Changes in independent scopes are tested in parallel lanes | PLANNED | Declare scopes in the configuration and partition the queue by scope; one serial lane is always correct meanwhile. |

## Sandbox

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Every step is launched as a fresh container: pinned image, non-root, read-only, no capability, bounded, no daemon socket | PROVEN | `test/domain/security.test.js`: sandbox: every container is disposable, unprivileged, read-only and bounded<br>`test/domain/security.test.js`: sandbox: refuses unpinned images, root, open environments, daemon sockets and host networks |
| The hardening holds on a real container runtime (checked in the CI sandbox job) | PROVEN | `integration/docker.test.js`: docker: the step runs as an unprivileged user with no capability<br>`integration/docker.test.js`: docker: the root filesystem is mounted read-only<br>`integration/docker.test.js`: docker: without a network the step only has a loopback interface<br>`integration/docker.test.js`: docker: the environment is the closed list and nothing from the host<br>`integration/docker.test.js`: docker: a step that exceeds its time limit is killed |
| Secret values never appear on a command line | PROVEN | `test/domain/security.test.js`: sandbox: secret values never appear on the command line<br>`test/adapters/sandbox-runner.test.js`: runner: the sandbox only receives a step token |
| A step gets a fresh workspace without repository metadata, and the workspace is destroyed afterwards | PROVEN | `test/adapters/sandbox-runner.test.js`: runner: an author step gets a hidden-free workspace<br>`test/adapters/git.test.js`: git: attributes in the tree cannot hide files from a workspace |
| What a step leaves behind is read without following links, within a size limit | PROVEN | `test/adapters/sandbox-runner.test.js`: runner: a report that is a link to a host file<br>`test/adapters/files-and-registry.test.js`: files: a file from a less trusted party is read without following links |
| Concurrent sandboxes cannot reach each other, and each has a disk quota | PLANNED | Give each run its own internal network and a size-limited filesystem. |
| Steps run under a rootless daemon or in a micro-VM | PLANNED | Add a launcher behind the same interface; the factory only depends on the launch contract. |

## Network and secrets

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Through the proxy, a step reaches only the exact hosts listed for its role, on port 443, and every refusal is recorded | PROVEN | `test/domain/security.test.js`: egress: only exact listed hosts on port 443, per role<br>`test/adapters/egress.test.js`: egress: unlisted hosts, other ports, missing, expired or revoked grants are refused and reported |
| A listed host that resolves to a private or metadata address is refused | PROVEN | `test/adapters/egress.test.js`: egress: a listed host that resolves to a private address is refused<br>`test/domain/security.test.js`: egress: private, loopback, link-local and metadata addresses are recognised |
| Model provider keys never enter a sandbox: the gateway adds them, for exact listed API paths only | PROVEN | `test/adapters/egress.test.js`: gateway: the provider key is added outside the sandbox<br>`test/adapters/egress.test.js`: gateway: a grant works for its own provider only |
| Each step gets its own short-lived token, stored hashed and revoked when the step ends | PROVEN | `test/adapters/egress.test.js`: egress: a grant stores only a hash of the step token<br>`test/adapters/sandbox-runner.test.js`: runner: the sandbox only receives a step token, valid for the step and revoked after it |
| A dependency request is checked against the registry: young, unlicensed or scripted packages are refused, and a manifest edited directly is HIGH | PROVEN | `test/domain/security.test.js`: dependency gate: refuses unknown, too young, unlicensed, deprecated or scripted packages<br>`holdout/pipeline.test.js`: pipeline: a dependency is requested, never installed<br>`test/adapters/files-and-registry.test.js`: npm registry: metadata for the dependency gate comes from the package document |
| An approved dependency is installed by the merge queue | PLANNED | Until then an approved request stops with the owner; add the regeneration of manifests and lock files to the candidate build. |
| Results crossing from the execution zone are sanitised, and an answer to an earlier job is never taken for a new one | PROVEN | `test/application/dispatch.test.js`: spool: a job crosses the zone boundary as a file and its answer is sanitised<br>`test/application/dispatch.test.js`: spool: an answer to an earlier job with the same identifier |
| A committed secret fails the verify command | PROVEN | `test/domain/security.test.js`: hygiene: committed secrets are reported without echoing them<br>`test/cli.test.js`: cli: check reports non-English text, secrets, outward imports and shipped provisional data |
| The model gateway works with real providers and harnesses | TO_PROVE | Run one step per configured harness through the gateway and confirm the provider accepts the forwarded call. |
| The three services run from deploy/compose.yaml | TO_PROVE | Follow docs/operations.md on a host and run a ticket end to end. On one host the separation is between processes only. |
| The control zone and the execution zone run on two machines | PLANNED | Carry the job spool over a private network, with one directory per direction; the file protocol is already the only link for work. |
| Model keys and forge credentials can be revoked and rotated within minutes | TO_PROVE | Run the drill in docs/security.md with a stopwatch, each quarter, and record the time. |

## Traceability and measurement

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Every decision is appended to a hash-chained ledger: an edited, removed or reordered entry is detected, and the head can be anchored elsewhere | PROVEN | `test/domain/security.test.js`: ledger: entries are chained and any edit, removal or reordering is detected<br>`test/domain/security.test.js`: ledger: what is hashed is what is read back<br>`test/adapters/files-and-registry.test.js`: files: the ledger survives restarts and concurrent appends as one valid chain<br>`test/cli.test.js`: cli: ledger verify detects tampering |
| The head of the ledger is copied outside the control zone, so that a cut or rebuilt file is detected | PLANNED | Write the head hash into each merge commit or to an external store. |
| Within a service, concurrent updates of the queue state never lose a write | PROVEN | `test/adapters/files-and-registry.test.js`: files: the store returns its fallback until something is written<br>`test/application/dispatch.test.js`: dispatcher: non-overlapping tickets run, overlapping ones wait, approved changes enter the queue |
| The five DORA metrics are computed without a model from a delivery log, sliced by agent and risk level | PROVEN | `test/domain/measure.test.js`: DORA: the five metrics are computed from the delivery log<br>`test/domain/measure.test.js`: DORA: recovery is measured to the rollback of that deployment<br>`test/domain/measure.test.js`: DORA: metrics are sliced by agent and by risk level without cross-attribution<br>`test/domain/measure.test.js`: DORA: without deployments nothing is invented |
| A delivery step writes one line per deployment and promotes by image digest | PLANNED | Define the deliver port, its log line and a first adapter; until then the delivery log comes from the deployment system. |
| A debt register keeps each measure with its trend and proposes at most three tickets | PROVEN | `test/domain/measure.test.js`: debt: the register keeps measure and trend, and proposes at most three tickets |
| A weekly model-free job measures debt, fills the register, and opens the proposed tickets | PLANNED | Add configurable probe commands and the weekly schedule; layer violations and provisional items are already measured. |
| Every claim on this page is checked: a PROVEN claim names a test that exists | PROVEN | `test/domain/measure.test.js`: proofs: PROVEN needs evidence that exists<br>`test/cli.test.js`: this repository: its own configuration is valid, honest about readiness, and matches the template |

## Repository hygiene

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Text with letters outside basic Latin fails the verify command (a heuristic for English-only content) | PROVEN | `test/domain/security.test.js`: hygiene: non-English prose is reported, symbols are not<br>`test/cli.test.js`: cli: check reports non-English text |
| Provisional information is listed for the owner and fails the check in production paths | PROVEN | `test/domain/security.test.js`: hygiene: provisional information is listed and blocks production paths only<br>`test/cli.test.js`: cli: check reports non-English text, secrets, outward imports and shipped provisional data |
| Inner architecture layers cannot import outer ones | PROVEN | `test/domain/security.test.js`: hygiene: inner layers must not import outer layers |

## Forge and configuration

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| Unsafe or inconsistent configuration is refused, and readiness gaps are stated plainly | PROVEN | `test/domain/measure.test.js`: config: unsafe or inconsistent values are refused<br>`test/domain/measure.test.js`: config: readiness says plainly what still blocks autonomous work<br>`test/cli.test.js`: cli: a template without project name is refused by doctor |
| A repository starts from the template with one command, without overwriting anything | PROVEN | `test/cli.test.js`: cli: init starts a repository from the template and never overwrites |
| Labels, repository options and the trunk ruleset are planned from code; a loosened ruleset is detected | PROVEN | `test/domain/measure.test.js`: settings: the plan lists only what differs from the desired state<br>`test/adapters/github.test.js`: github: settings are read, diffed and applied without manual steps<br>`test/cli.test.js`: cli: settings prints the desired state offline, plans and applies with a token |
| Settings as code are applied on a real repository by a credential with administration rights | TO_PROVE | Run pheromill settings apply with an administrator token and compare the result with the plan. |
| The GitHub adapter sends the expected requests for tickets, change requests, approvals and checks (against a double) | PROVEN | `test/adapters/github.test.js`: github: a change request targets the trunk, links its ticket and carries its risk label<br>`test/adapters/github.test.js`: github: checks pass only when every required check completed successfully<br>`test/adapters/github.test.js`: github: errors never contain the token |
| GitHub App tokens are requested signed, limited to one repository, and renewed before expiry | PROVEN | `test/adapters/github.test.js`: github app: tokens are signed requests, scoped to one repository, cached until near expiry |
| The GitHub adapter works against the live API | TO_PROVE | Run the control service against a sandbox repository; the request shapes are proven against a double only. |
| Another forge is supported | PLANNED | Write an adapter for the Forge and Checks ports and move the ruleset shape behind it; git operations are already forge-independent. |
| The Claude Code harness example runs a step end to end | TO_PROVE | Build the example image, configure the route, and run a ticket through it. |
| A second model family is configured, so that independent review is possible | TO_PROVE | Add a harness of another family; any command-line harness works through the same configuration. |

## Product creation

| Claim | Status | Evidence or next step |
| --- | --- | --- |
| From a short prompt and a few questions: audience, brand book, logo, design system, backlog, stack, monorepo | PLANNED | Define the inception workflow as steps with schemas and decision records, each reversible by a human. |
| Accessibility, SEO, mobile layout and performance budgets are enforced in each product's verify command | PLANNED | The rules are in the template AGENTS.md; add reference gate scripts to the template. |
| Customer journey, conversion, errors and availability are monitored for each product | PLANNED | Add the monitoring contract to the template and a check that every user-facing change is measurable. |
