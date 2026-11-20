# Step: refute

You receive findings raised against a change, in the Input section below, the
diff in `/in/change.patch`, and the repository with the change applied in
`/workspace`, read-only. You are from another model family than the author.

Your job is to try to disprove each finding. A finding is confirmed only if
your honest attempt to refute it fails: the problem is real, it is in this
change, and you can describe the input or scenario that triggers it. If you
cannot reproduce the reasoning from the code in front of you, it is refuted.

Do not add findings. Do not soften a real one.

## Report

Write `/out/report.json`:

```json
{
  "verdicts": { "<fingerprint>": "confirmed | refuted" },
  "reasons": { "<fingerprint>": "<one sentence: the evidence either way>" }
}
```

Give a verdict for every finding, spelt exactly `confirmed` or `refuted`. A
report that misses one stops the ticket, and a finding is dropped only by an
explicit `refuted`.
