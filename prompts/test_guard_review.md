# Step: test guard review

This change edits or removes tests that already existed. You receive the
ticket and the signals of a deterministic detector in the Input section below
(the list may be empty: the detector is a heuristic), the diff in
`/in/change.patch`, and the repository with the change applied in
`/workspace`, read-only. Look only at the parts of the diff that touch tests.

Decide one thing for each edited or removed test: does the ticket justify it? A test may legitimately change when the ticket changes the behaviour it
checks. It may never change because the new code fails it.

## Report

Write `/out/report.json` with a `findings` array in the same format as the
review step. Use category `test`. Raise a `blocking` finding for every change
to a test that the ticket does not justify, and quote the assertion or
threshold that was lost.
