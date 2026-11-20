# Metrics, budgets and autonomy

DORA measures what the factory delivers. The budget bounds what it spends to
get there. Both are computed by scripts without a model, from records agents
cannot write.

## The five DORA metrics

Definitions follow [dora.dev](https://dora.dev/guides/dora-metrics-four-keys/).
The first three measure throughput, the last two instability.

| Metric | DORA definition | Computed here as |
| --- | --- | --- |
| Change lead time | Time from commit to deployment in production | First commit of the change to the successful deployment that contains it (median) |
| Deployment frequency | How often changes are deployed | Successful deployments per week |
| Failed deployment recovery time | Time to recover from a failed deployment | From the faulty deployment to the next successful rollback or fix (median) |
| Change fail rate | Share of deployments that need immediate intervention | Deployments that failed, were rolled back, or caused an incident, over the total |
| Deployment rework rate | Share of deployments that are unplanned fixes | Deployments whose change is labelled as a fix, over the total |

- Two records make them computable: the delivery log, one line per deployment
  with environment, time, result and the changes it contains, and the list of
  changes with their first commit, level, agent and whether they are fixes.
- Each metric is also sliced by agent and by risk level.
- Without a production environment, they are measured on staging, and the
  report says so.
- Without data, the value is empty. Nothing is extrapolated.

`pheromill metrics dora` computes them today from a delivery log. Writing that
log from the factory's own deployment step is planned.

Factory-specific indicators complete them: checks green on the first try,
correction rounds, findings after merge, refuted findings, change size, check
runs per change, cost per point, and net progress per milestone.

## Budget

A budget per ticket, derived from its points, bounds each piece of work. A
daily ceiling per subscription, to bound overall spending, is planned.

| Counter | Starting ceiling |
| --- | --- |
| Commits on the branch | 15 |
| Review and discussion comments | 25 |
| Correction rounds | 2, then the arbiter |
| Passes of an external tool | 1, on HIGH and CRITICAL changes only |
| Check runs | 4 |
| Sandbox time | 30 minutes per point for the whole ticket, and 30 minutes for any single step; to recalibrate after four weeks of measurements |
| Tokens | Not set until four weeks of measurements exist |

With two correction rounds per attempt, the ceilings on commits, comments and
check runs are rarely the first to be reached; they are a second line.

Every step is recorded in the ledger with its ticket, agent, model, duration,
and tokens when the harness reports them. **A cost that was not reported is
recorded as UNKNOWN. It is never estimated.** The daily report (planned) flags
any change above 80 % of its budget.

## Loop detection

The dispatcher stops a ticket and calls the arbiter in five cases, all
deterministic:

1. The same error three times in a row.
2. A counter of the budget above its ceiling.
3. Two steps in a row that change no file.
4. A change above 400 lines, or a ticket above 5 points, along the way.
5. A finding that was already refuted comes back.

The arbiter has three outcomes: split the ticket, hand it to an agent of
another family, or ask the owner. A model may propose the outcome, but only
among those three. **One escalation per ticket**; after that, the owner decides.

## Autonomy tiers

The pipeline is the same from the first day; what changes is who presses the
button. The factory earns the right to merge alone one risk level at a time.

| Tier | Merges without a human |
| --- | --- |
| 0 | Nothing. Every gate runs; the owner presses the button. |
| 1 | LOW |
| 2 | LOW and HIGH |
| 3 | Every level |

Below the required tier, a change that passed every gate waits for a person
to add the label `factory:approved`.

Promotion is meant to be a comparison between measured values and thresholds
written before the measurements started. The thresholds and the tier live in
the configuration file, a reserved path, so changing either is a CRITICAL
change. The comparison is built and tested; nothing calls it automatically
yet, so today the owner changes the tier. A tier with no thresholds was not
earned, and `pheromill doctor` says so.

This repository runs at tier 0.
