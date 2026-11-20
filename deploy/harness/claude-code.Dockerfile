# Example sandbox image for the Claude Code harness.
#
# Status: example, not yet proven in a live run (see docs/status.md). Check the
# vendor's installation notes for the version you pin before relying on it.
#
# Both arguments are required and have no default: the base is pinned by
# digest, the harness by exact version.
#   docker build -f deploy/harness/claude-code.Dockerfile \
#     --build-arg BASE_IMAGE=node@sha256:<digest> \
#     --build-arg CLAUDE_CODE_VERSION=<exact version, published at least 7 days ago> \
#     --iidfile claude-code.iid .
# Use the identifier written to claude-code.iid as "image" in pheromill.config.json.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG CLAUDE_CODE_VERSION
RUN test -n "${CLAUDE_CODE_VERSION}" && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
USER 10001:10001
WORKDIR /workspace
