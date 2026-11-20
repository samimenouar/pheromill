# Factory image, shared by the three services (control, runner, egress).
# There is nothing to install: the factory has no runtime dependency.
#
# BASE_IMAGE has no default on purpose. It must be pinned by digest and provide
# Node.js 22 or newer and git 2.38 or newer. deploy/build.sh enforces the pin.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

WORKDIR /opt/pheromill
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY prompts ./prompts
COPY template ./template

USER 10001:10001
ENTRYPOINT ["node", "/opt/pheromill/bin/pheromill.js"]
