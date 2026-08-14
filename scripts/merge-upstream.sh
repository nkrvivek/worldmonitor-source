#!/usr/bin/env bash
#
# Merge koala73/worldmonitor into this fork.
#
# The point of this script is the report it prints BEFORE it touches anything.
# Our fork carries roughly 130 files upstream has never seen; those cannot
# conflict and are noise in a merge review. What matters is the small set both
# sides changed. The script computes that set from the merge base and shows it
# first, so you know the size of the job before you are standing in a conflict.
#
# It merges onto a dated branch, never onto main, so an abandoned merge leaves
# main untouched.
#
# See FORK.md for what we changed and why.

set -euo pipefail

UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"

cd "$(git rev-parse --show-toplevel)"

# Lock files and generated output are regenerated, not merged. Listing them
# separately keeps them out of the count you have to reason about.
REGENERATED='package-lock.json|.*/package-lock.json|docs/generated/.*'

die() { printf '%s\n' "$*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] \
  || die "Working tree is dirty. Commit or stash first."

git remote get-url upstream >/dev/null 2>&1 \
  || die "No 'upstream' remote. Add it: git remote add upstream https://github.com/koala73/worldmonitor.git"

echo "Fetching $UPSTREAM_REF ..."
git fetch upstream

BASE=$(git merge-base HEAD "$UPSTREAM_REF")
HERE=$(git rev-parse --abbrev-ref HEAD)

AHEAD=$(git rev-list --count "$BASE..$UPSTREAM_REF")
if [ "$AHEAD" -eq 0 ]; then
  echo "Already up to date with $UPSTREAM_REF."
  exit 0
fi

# Both sides' change sets, measured from the same base.
OURS=$(git diff --name-only "$BASE..HEAD" | sort)
THEIRS=$(git diff --name-only "$BASE..$UPSTREAM_REF" | sort)
OVERLAP=$(comm -12 <(printf '%s\n' "$OURS") <(printf '%s\n' "$THEIRS"))

REGEN=$(printf '%s\n' "$OVERLAP" | grep -E "^($REGENERATED)$" || true)
REAL=$(printf '%s\n' "$OVERLAP" | grep -Ev "^($REGENERATED)$" || true)

count() { printf '%s' "$1" | grep -c . || true; }

echo
echo "Merge base:  $BASE"
echo "Upstream:    $AHEAD commits, $(count "$THEIRS") files changed"
echo "Ours:        $(count "$OURS") files changed since the base"
echo
echo "Both sides changed $(count "$REAL") files that need a real merge:"
printf '%s\n' "$REAL" | sed 's/^/  /'
echo
if [ -n "$REGEN" ]; then
  echo "Plus $(count "$REGEN") regenerated files — take upstream's and rebuild:"
  printf '%s\n' "$REGEN" | sed 's/^/  /'
  echo
fi

echo "Upstream commits:"
git log --oneline --no-decorate "$BASE..$UPSTREAM_REF" | sed 's/^/  /'
echo

read -r -p "Merge onto a new branch off $HERE? [y/N] " reply
case "$reply" in
  y|Y) ;;
  *) echo "Nothing merged."; exit 0 ;;
esac

BRANCH="merge-upstream-$(date +%Y-%m-%d)"
git rev-parse --verify --quiet "$BRANCH" >/dev/null \
  && die "Branch $BRANCH already exists. Finish or delete it first."

git switch -c "$BRANCH"

if git merge --no-edit "$UPSTREAM_REF"; then
  echo
  echo "Merged cleanly onto $BRANCH."
else
  echo
  echo "Conflicts in:"
  git diff --name-only --diff-filter=U | sed 's/^/  /'
  echo
  echo "Resolve them, then: git add -A && git commit"
fi

cat <<'NEXT'

Before pushing:

  npm install                     # if any lock file moved
  npx tsc --noEmit
  npx tsx --test tests/convex-auth-handoff.test.mts tests/auth-token-expiry.test.mts
  npx tsx --test tests/deploy-config.test.mjs tests/ci-workflow-coverage.test.mts
  npx tsx --test tests/browser-bundle-secret-guard.test.mts

Those guard the fork deviations listed in FORK.md. Read it if any of them fail.
NEXT
