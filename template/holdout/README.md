# Holdout scenarios

Acceptance scenarios for each ticket live here. They are written by the
specify step from the ticket alone, before any implementation exists.

The agent that implements a ticket never sees this directory: its workspace is
built without it, and its patch is refused if it touches it. The verify
command runs these scenarios on every change, so an implementation cannot be
tuned to pass tests it has read.

Humans may add or edit scenarios. Any change to an existing scenario is
treated as HIGH risk and gets a dedicated review.
