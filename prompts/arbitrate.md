# Step: arbitrate

A ticket was stopped by a deterministic loop trigger. The ticket and the
trigger are in the Input section below. Choose exactly one outcome.

- `split`: the ticket is too large for one change. Propose two or more
  tickets, each something a user can see or test, each 1 to 5 points, with its
  own acceptance criteria and likely files. Together they must cover the
  original; none may be a micro-fix.
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
