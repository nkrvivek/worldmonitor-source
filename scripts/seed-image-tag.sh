#!/usr/bin/env bash
# =============================================================================
# Prints the image tag for Dockerfile.seeds, derived from the build context.
# =============================================================================
# The tag must change whenever the image content changes, and must never be
# reused for different content. Wrangler sends a registry image to Cloudflare as
# the tag string -- only the local-Docker path substitutes a digest -- so a
# rolling tag looks unchanged to the API and can leave a stale image running.
# Wrangler rejects the tag "latest" outright for the same reason.
#
# `git ls-files -s` prints each file's mode and blob hash, so the hash below
# covers content, not timestamps, and is identical on any machine at the same
# commit. It reads the index, so unstaged edits are invisible here -- which is
# what we want: CI builds a commit, and at a commit the index matches HEAD.
#
# STAGE FIRST, THEN RUN THIS. Run against unstaged edits it prints the tag for
# the PREVIOUS content, which looks exactly like "nothing in the image changed"
# and lands a push whose pin CI then rejects. That happened on 3d8e3a0f2: the
# script was run before `git add`, printed the old tag, the pin was left alone,
# and "Build seed container image" failed on `Check wrangler.jsonc points at
# this tag` with the two hashes side by side.
#
# The path list mirrors what Dockerfile.seeds COPYs, plus the Dockerfile and
# .dockerignore themselves. Adding a COPY line there means adding it here.
# This script lives under scripts/ and so is itself copied into the image;
# editing it genuinely changes the image, and the tag moves. That is correct.
set -euo pipefail

cd "$(dirname "$0")/.."

hash=$(git ls-files -s -- \
  Dockerfile.seeds \
  .dockerignore \
  scripts \
  server \
  shared \
  data \
  worker/counters \
  tsconfig.json \
  tsconfig.api.json \
  | shasum -a 256 | cut -c1-12)

printf 'seeds-%s\n' "$hash"
