# Operations

How to put the factory on a repository and run it. Everything here is
configuration; none of it requires changing Pheromill's code.

Running the services against a live forge and real providers is built and not
yet proven end to end (see [status.md](status.md)). Start at autonomy tier 0,
where a person approves every change before it enters the merge queue.

In this page `pheromill` stands for `node <path to this repository>/bin/pheromill.js`.

## Requirements

- Node.js 22.8 or newer and git 2.38 or newer.
- For the services: a Linux host with Docker, reachable over a private network
  only. One host is enough to evaluate; see [security.md](security.md) for why
  production needs two.
- At least two harnesses from two different model families. With one family,
  independent review is impossible and nothing can be approved.

## 1. Prepare the repository

```sh
pheromill init <directory> --name <name> --repository <owner/name>
```

This adds, without overwriting anything:

| File | Role |
| --- | --- |
| `pheromill.config.json` | The factory's rules for this repository |
| `AGENTS.md` | The rules every agent follows |
| `.github/ISSUE_TEMPLATE/ticket.yml` | The ticket form the dispatcher parses |
| `.github/workflows/verify.yml` | A workflow that calls the verify command |
| `scripts/verify.sh` | The verify command. It fails until you define it. |
| `holdout/`, `docs/decisions/` | Hidden scenarios; decision records |

Then define `scripts/verify.sh`: the one command that proves a change
(install, lint, tests including `holdout/`, build, product gates). Calling
`pheromill check --production` from it adds the repository hygiene checks.

## 2. Configure

`pheromill.config.json` is merged over the defaults. An excerpt of the parts
to fill in (one harness and one route shown; a working setup needs two
families and a route for every step):

```json
{
  "paths": { "core": ["src/billing/**"] },
  "providers": {
    "anthropic": { "baseUrl": "https://api.anthropic.com", "authHeader": "x-api-key", "keyEnv": "ANTHROPIC_API_KEY", "paths": ["/v1/messages"] }
  },
  "harnesses": {
    "claude-code": {
      "family": "anthropic",
      "provider": "anthropic",
      "image": "sha256:<identifier of the image you built>",
      "command": ["sh", "-c", "claude -p --model \"$PHEROMILL_MODEL\" --output-format json --dangerously-skip-permissions < /in/prompt.md > /out/harness.json"],
      "env": { "ANTHROPIC_BASE_URL": "{{gateway}}", "ANTHROPIC_API_KEY": "{{token}}" },
      "tokens": { "file": "harness.json", "fields": ["usage.input_tokens", "usage.output_tokens"] }
    }
  },
  "routing": [
    { "step": "implement", "levels": ["LOW"], "harness": "claude-code", "model": "<a fast model>", "grade": "C" }
  ],
  "egress": { "author": ["registry.npmjs.org"] }
}
```

- **Providers** name the environment variable that holds the key, and the
  exact API paths the gateway may forward. The key itself is never in this file.
- **Harnesses** are any command-line agent: an image pinned by identifier, the
  command to run, and the environment variables it reads. `{{gateway}}` and
  `{{token}}` are filled in per step. The prompt is in `/in/prompt.md`; the
  step writes `/out/report.json`. The Claude Code entry above is an example
  that has not been proven in a live run; check the flags against the
  vendor's documentation for the version you pin.
- **Routing** is one line per step and level; changing a model is a one-line
  change. The steps to route are `specify`, `implement`, `review`, `refute`,
  `security_review`, `test_guard_review` and `arbitrate`. Use the cheapest
  model that does the step well.
- **Grades**: a new route starts at grade C and cannot work real tickets. The
  command that replays the reference set to earn a grade is not built yet, so
  for now the owner sets `"grade": "B"` (LOW changes) or `"A"` (every level)
  by hand.
- **Egress** lists exact host names per role. A role that is not listed can
  only reach its model through the gateway.
- **forge.queueActor** is the identity allowed to fast-forward the trunk under
  the ruleset, for example `{ "id": <app id>, "type": "Integration" }`.

Run `pheromill doctor`. It refuses an invalid configuration with every reason,
a misspelt setting included, and lists what still prevents autonomous work.

Then commit and push these files to the trunk. The services read the
configuration, the prompts' rules and the ticket form from the trunk, never
from your working copy: nothing you configured exists for them until it is
merged.

## 3. Apply the repository settings

With `PHEROMILL_FORGE_TOKEN` set in the environment to a token that has
administration rights on the repository:

```sh
pheromill settings plan
pheromill settings apply
```

Labels, repository options and the trunk ruleset (changes through pull
requests only, the required checks, no force push, no deletion) are created
from code. `pheromill settings plan --offline` prints the desired state
without calling the forge.

## 4. Run the services

Create a GitHub App for the control zone with these repository permissions:
Contents, Pull requests and Issues (read and write), and Checks (read).
Install it on the repository and note the App id and the installation id.
Without the Workflows permission, a change that edits a file under
`.github/workflows/` cannot be published and stops at the owner; to let the
factory publish such changes (they are CRITICAL), grant Workflows (write) to
the App and set `PHEROMILL_GITHUB_WORKFLOWS=write` in `deploy/control.env`.

```sh
sudo sh deploy/setup.sh                                  # state directories and the sandbox network
BASE_IMAGE=node@sha256:<digest> sh deploy/build.sh       # prints PHEROMILL_IMAGE=sha256:...
cp deploy/.env.example deploy/.env                       # image, repository, docker group id
cp deploy/control.env.example deploy/control.env         # forge credential (control zone only)
cp deploy/egress.env.example deploy/egress.env           # model keys (egress zone only)
chmod 600 deploy/.env deploy/control.env deploy/egress.env
# fill in the three files: each line is explained in its example
# put the App private key in <PHEROMILL_HOME>/control/app-private-key.pem, mode 600, owner 10001
docker compose -f deploy/compose.yaml up -d
```

| Service | Holds | Notes |
| --- | --- | --- |
| `control` | Forge credential | A GitHub App gives one-hour tokens limited to the repository |
| `runner` | Container daemon access | Runs as the sandbox user; for production, on its own machine |
| `egress` | Model provider keys | The only way out of the sandbox network |

For a private repository, set `PHEROMILL_READ_TOKEN` in `deploy/.env` to a
token that can only read the repository: the runner and egress use it to fetch
the trunk. Images are never pulled at run time and never referenced by tag:
the base image is given by digest, and built images by identifier.

`deploy/setup.sh` refuses a sandbox network that exists and is not internal.
When it starts, the runner removes the sandboxes a previous run left behind.

## Day to day

| Task | How |
| --- | --- |
| Give work to the factory | Open a ticket with the form, then add the label `factory:ready` |
| Approve a change that passed every gate | Add the label `factory:approved` to its pull request. It approves the commit the gates passed, once; a later commit needs a new approval |
| Reject a change that waits for approval | Relabel its ticket `factory:ready` to have it worked again, or close the ticket |
| See why a ticket stopped | Read the comment on the ticket; it is labelled `factory:needs-owner` |
| Restart a ticket that was sent back too often | Fix what the comment says, then label it `factory:ready` again: it gets a fresh allowance of reworks |
| Stop everything now | Create the file `HALT` in the control state directory (see [security.md](security.md)) |
| Check the record | `pheromill ledger verify <state>/ledger.jsonl` |
| Check a patch by hand | `git diff --no-renames main... \| pheromill risk - --gate`. Advisory: the pipeline judges what git applies, this command reads the text you give it |
| Compute delivery metrics | `pheromill metrics dora --deliveries F --changes F --from D --to D` |
| See what is provisional | `pheromill check` lists every provisional item |
| Raise the autonomy tier | Change `autonomy.tier` in the configuration, once the thresholds are met |
