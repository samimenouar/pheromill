# Security

The factory runs code written by models, on inputs written by strangers, next
to credentials worth stealing. It is designed on three assumptions: the source
code is already known to the attacker, any single sandbox can be broken, and
an agent can be talked into anything by the text it reads.

What is proven, what is only built and what is planned is tracked claim by
claim in [status.md](status.md). This page describes the design and says where
it stops.

## Threats and controls

| Threat | Controls |
| --- | --- |
| An agent reads a secret that is not its business | One fresh container per step, pinned image, closed list of environment variables, no forge credential, non-root, read-only root filesystem, no capability, CPU, memory, process and time limits, no access to the container daemon. Model keys are not in the container at all. |
| An agent sends data out | A sandbox has no route to the outside. It joins an internal network whose only service is the egress proxy, which allows exact host names on port 443, one list per role, and records every refusal. A listed host that resolves to a private or metadata address is refused. |
| Injected text gives orders | Tickets are accepted only from authors the repository trusts and after a person labelled them. Agents are told to treat ticket text as data and to report embedded instructions. A separate reader role for external content, with no repository access, is designed and not yet in the pipeline. |
| A poisoned dependency enters the repository | Agents write a request instead of installing. A script checks that the package exists, its age, its history, its license; versions younger than seven days and install scripts that are not named are refused. A manifest edited directly makes the change HIGH. |
| A patch says one thing and does another | The control zone applies the patch in a private index and asks git which paths and modes change. The gates run on that answer, and any disagreement with the patch text fails closed. |
| A stolen credential is replayed | Each step gets its own token, stored hashed, valid for the step, revoked when it ends. With a GitHub App, the forge token lasts one hour and is limited to one repository. |
| The execution side is compromised | It holds no forge write credential. What it returns is a patch and a report, read defensively and run through every gate. The queue merges the commit that was reviewed, not what a branch points to later. |
| The control host is compromised | Reachable over a private network only (host setup), secrets handed to the service at start, the halt switch, and the runbooks below. |
| The record is rewritten | The ledger is hash-chained: an edited, removed or reordered entry is detected by `pheromill ledger verify`. A cut tail or a fully rebuilt file is not, until the head hash is anchored outside the host, which is planned. |
| A secret is committed | The verify command scans every tracked file and fails on a match. |

## The model gateway

Inside a sandbox, the harness is given a base URL that points to the gateway
and, as its "API key", the step token. The gateway checks the token, checks
that the path is exactly one of the listed API paths for that provider,
replaces the token with the real key, and forwards the call. A sandbox that is
fully compromised can spend model budget for the duration of one step; it
cannot take the key away.

Whether a given harness accepts a custom base URL depends on the harness.
This is to prove per harness.

## What a compromise takes with it

Three measures are meant to limit the blast radius.

1. **Separate zones.** Agent execution and model access on one side;
   publishing and merging, with the forge credential, on the other.
2. **Short-lived tokens**, issued per step.
3. **A revocation drill each quarter**: revoke the model keys and the forge
   credential, stopwatch in hand, and record the time.

The first one is only as strong as the deployment. With the shipped compose
file, all three services run on one host, and the runner can drive the
container daemon, which is equivalent to root on that host: a compromised
runner reaches the other services' secrets. Use one host to evaluate. For
production, put the runner and egress on a second machine; carrying the job
spool between two machines is planned.

## The risk that remains

Written as it is: a deceived agent can deliver, in a LOW change, code that
passes the checks and that the review does not block. Two things bound it
today: the change touches no reserved path, and it carries no production
secret. A weekly review of what merged is planned as the third.

Other limits worth stating:

- Long-lived secrets exist: the GitHub App private key in the control zone,
  the provider keys in the egress zone, and, for a private repository, a
  read-only token used by the runner and egress to fetch the trunk. A personal
  access token can replace the App for a trial; it is long-lived too.
- Sandboxes share one internal network and are not isolated from each other.
  They have no disk quota.
- Containers share the host kernel.
- Reviewers of another family reduce correlated mistakes; they do not remove
  them. With two families, hidden scenarios written by one family are reviewed
  by the other on the first attempt only.
- The test-weakening detector and the English-only check are heuristics.
- Hidden scenarios of past tickets are visible in a public repository. The
  implementer's workspace excludes them and it has no route to the forge, but
  a model provider's own server-side tools (web access) are outside the
  factory's control: disable them in the harness configuration.
- The halt switch is read between ticks; a ticket already running finishes
  its current step unless the sandboxes are killed.

## Lessons from build-system breaches

In October 2026 the Railway platform was breached through its build system
and, according to public reports of its post-mortem, the attacker went after
AI provider keys. The lessons this design draws from that kind of incident:

| Lesson | In Pheromill |
| --- | --- |
| Isolate every build | One disposable container per step, never a shared machine. |
| No long-lived secret in the pipeline | Step tokens only inside sandboxes; a step token cannot be exchanged for a lasting credential. |
| Assume the source code is known | Security never rests on secrecy; the repository is written as public. |
| Partition secrets | Each zone has its own; no service has broad access to a key store. |
| Secure by default | Deny-all egress, closed environment, blocking gates in the pipeline. |
| Detect and react in minutes | Every refusal is recorded; the halt switch stops dispatching and merging. Alerting on those records is not built. |
| Reduce the attack surface | No package dependency, three small services. |
| Prepare the crisis | The runbooks below are written before they are needed. |
| Attackers use AI, so must defenders | Automated gates on every change. A reference set with an injection trap and a planted defect is planned. |

## Runbooks

**Halt (red button).** Create the file `HALT` in the control state directory.
Nothing new is dispatched and nothing lands while it exists. To stop steps
that are already running, kill the sandboxes on the runner host:
`docker kill $(docker ps -q --filter label=pheromill.sandbox=true)`.

**Suspected compromise.**

1. Halt, kill the sandboxes, stop the runner and egress services.
2. Revoke the model provider keys at each provider, then the forge
   credentials. Decide in advance who is told first: the providers, so that
   they can block the keys, then the users of the products.
3. Run `pheromill ledger verify <state>/ledger.jsonl` and read the egress
   record for refusals and unusual volumes.
4. Rebuild the hosts from clean images rather than cleaning them.
5. Issue new credentials, restart, and watch closely: assume the attacker
   comes back the same evening.

**Revocation drill (quarterly).** Steps 2 and 5 on a calm day, timed. It has
not been run yet.

**Negotiated in advance.** A contact channel with each model provider and the
cloud host, and the written answers to the hard questions: who is told first,
whether builds are blocked, whether to migrate rather than fix.
