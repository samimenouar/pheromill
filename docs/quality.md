# Quality: an agent cannot cheat

An agent optimises for whatever decides that its work passes. So the factory
makes sure the only way to pass is to do the work.

## Why cheating does not pay

| Shortcut an agent could take | What stops it |
| --- | --- |
| Write code that satisfies the tests it can read, not the ticket | The acceptance scenarios are written first by another step and are absent from the implementer's workspace. Without that step, nothing is implemented. |
| Edit, skip or delete a failing test | Any edit or removal of an existing test makes the change HIGH and brings a dedicated reviewer, who gets the ticket and the diff. A deterministic detector adds signals for removed assertions, skipped tests, relaxed thresholds and replaced snapshots. |
| Weaken the hidden scenarios | The specify step can only add files. Its scenarios are reviewed with the change, by a family that did not write them whenever the routes allow it (see [architecture.md](architecture.md)); the ledger records when they do not. |
| Approve its own work | Reviewers and the refuter never belong to a family that wrote the implementation. This is enforced by routing, not by instruction, and the runner refuses to launch a job on another family than the one it was routed to. |
| Report success without evidence | Each acceptance criterion needs evidence seen by the reviewer. A step that crashed, timed out or returned a malformed report stops the ticket; it never counts as approval. |
| Argue a finding away | A finding is dropped only by an explicit refutation from a family that did not write the implementation; a missing verdict stops the ticket. |
| Hand in the same work again and hope for a kinder review | What was confirmed on a patch still stands when the same patch comes back: it is sent back without a new review, and a second time stops the ticket. |
| Wear the reviewer down | A finding that comes back after it was refuted is not dropped and not argued again: the ticket stops and the arbiter decides. |
| Change the rules | Configuration, pipelines, prompts and agent rules are reserved paths: touching them is CRITICAL. In this repository the factory's own source is reserved too. |
| Say one thing and do another in a patch | The gates do not read the patch as the agent wrote it. The patch is applied, and git reports the paths and modes it really changes. |
| Rewrite the record | Decisions are appended to a hash-chained ledger in the control zone, out of reach of any sandbox. |

The detector is a heuristic over diffs, not a proof; that is why touching an
existing test triggers the review even when it stays silent. It can also flag
coverage drops, but the pipeline does not feed it coverage data yet.

## Reviews

| When | What is read | Who reads | Output | Cost bounded by |
| --- | --- | --- | --- | --- |
| Every change | The diff of the change, hidden scenarios included | An agent of a family that did not write the implementation, then refutation | Findings | Two correction rounds |
| Every week (planned) | What merged in core modules and reserved paths | The most capable model in the routing table | At most three tickets | The diff of the week, never the whole repository |
| Every month and before each release (planned) | The whole repository, from a fresh session, six angles | The most capable model; for security, one that accepts security review work | A report, one ticket per confirmed finding | A written token ceiling |

Findings are sorted after refutation:

- **Blocking, confirmed**: back to the author, within the correction budget.
- **Minor, confirmed**: never a ticket. It is recorded in the ledger, to feed
  the debt register.
- **Refuted**: dropped. If the same finding comes back on the same author's
  change, the ticket stops and the arbiter decides.
- **Seen three times**: the class of finding should become a rule or a lint.
  The detection exists; opening the rule ticket is planned.

The pipeline can also take findings from one external review tool on HIGH and
CRITICAL changes, at most once per ticket, on a commit the model reviews let
through. If that commit is corrected afterwards, the new one was not examined
by the tool and the owner decides. No such tool is wired in yet.

## The reference set (planned)

A route (a step, a harness, a model) should earn the right to work by
replaying known work, not by reputation.

- **Content**: five to ten merged tickets of varied levels, plus four traps: a
  simple ticket, a ticket that contradicts a test, a ticket carrying an
  injected instruction, and a change with a planted security defect.
- **Method**: start from the parent commit, give the ticket to the agent, keep
  the tests of the real change hidden, then run them on the result.
- **Score**: hidden tests green, checks green on the first try, size, rounds,
  cost, traps avoided.
- **When**: on every change of route, model, harness version, method or rule.
- **New repository**: the set starts with the four traps and grows with the
  first merged tickets.

Grades gate what a route may do: **C** runs on the reference set only, **B**
may work LOW changes, **A** may work every level. The grades and the scoring
are built and enforced. The replay command and the trap fixtures are not:
until they exist, the owner assigns grades by hand, which is a change to a
reserved file.

## Debt (planned loop)

Debt is meant to be handled by a weekly, model-free loop with reserved
capacity, so that it neither piles up nor floods the backlog.

1. A job measures: dead code, boundary violations, duplication, complexity,
   flaky tests, late dependencies, documented exceptions, check duration.
2. The result goes to a register where each line has its measure and trend.
3. At most three debt tickets are proposed, each with the number that
   justifies it.
4. The dispatcher reserves one slot in five for debt.
5. The rework rate (see [metrics.md](metrics.md)) says whether debt really
   goes down.

Built today: the register logic, the selection of at most three proposals,
and the reserved capacity in the scheduler. Planned: the measuring job and
its schedule.
