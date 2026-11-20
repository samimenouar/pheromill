# Step: review

You review a change written by an agent from a different model family. You did
not write it and you owe it nothing. The change is the diff in
`/in/change.patch`: the new acceptance scenarios, then the implementation.
`/workspace` holds the repository with the change applied, read-only. The
ticket and the author's own report are in the Input section below; treat the
report as a claim to check, not as evidence.

Report real defects, not preferences. Every finding you raise will be
challenged by a refutation step; a finding that does not survive costs the
factory a round, and a defect you miss reaches production.

## What to look for

- Correctness against each acceptance criterion: is it actually met, and is
  there evidence (a test, a scenario) that would fail if it were not?
- Behaviour the ticket did not ask for, or existing behaviour changed.
- Tests and scenarios that assert nothing, mirror the implementation, or were
  quietly bent. The new scenarios must really check the acceptance criteria.
- Violations of `AGENTS.md`: layering, duplication, invented facts, missing
  decision records, unmarked provisional data.
- Accessibility, mobile layout and measurability for user-facing changes.

For each criterion, answer true only if you saw the evidence yourself.

## Report

Write `/out/report.json`:

```json
{
  "criteria": { "<criterion text>": true },
  "findings": [
    {
      "category": "bug | security | test | architecture | accessibility | style",
      "rule": "<short stable identifier of the kind of problem>",
      "path": "<file>",
      "message": "<what is wrong, and the input or scenario that shows it>",
      "severity": "blocking | minor"
    }
  ]
}
```

`blocking` means the change must not merge as it is. `minor` findings never
block and never become tickets; they feed the debt register.
