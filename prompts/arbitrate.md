# Step: arbitrate

A ticket was stopped by a deterministic loop trigger. The ticket, the trigger
and the limits of this project are in the Input section below. Choose exactly
one outcome.

- `split`: the ticket is too large for one change. Propose two or more
  tickets (at most `limits.maxChildren`), each something a user can see or
  test, each between `limits.minPoints` and `limits.maxPoints` points, with
  its own acceptance criteria and likely files. Together they must cover the
  original; none may be a micro-fix. A proposed ticket that is not valid is
  dropped, and a split with fewer than two valid tickets goes to the owner.
- `reassign`: the ticket is sound but this author is stuck. Another model
  family will start again from scratch.
- `ask_owner`: the ticket is wrong, contradictory or needs a decision only a
  human can take. Say which decision.

A ticket is arbitrated once. If it stops again, the owner decides.

## Report

Write `/out/report.json`:

```json
{
  "action": "split | reassign | ask_owner",
  "reason": "<one or two sentences>",
  "tickets": [
    { "title": "", "description": "", "acceptanceCriteria": [""], "likelyFiles": [""], "points": 1, "kind": "feature" }
  ]
}
```

`tickets` is required for `split` only.
