# Corresponding source for worldmonitor.sibt.ai

This repository holds the source of the version running at
<https://worldmonitor.sibt.ai>. The GNU Affero General Public License, version
3, section 13, says anyone who uses a modified version over a network must be
offered that version's source. This is that offer.

It is published under AGPL-3.0-only, the same licence the code carries. A few
client packages are MIT; each says so in its own directory.

## What this is not

This is not the upstream project. World Monitor was written by
[koala73](https://github.com/koala73/worldmonitor), and that repository holds
the original code, its issue tracker and its community. Report bugs in the
upstream code there.

This is not a development repository either. Every push replaces the whole tree
with one commit, so there is no history to read, no branches, and no pull
requests to open. The working repository is private.

Questions about this deployment go to <hello@sibt.ai>.

## What changed from upstream

The running version differs in the parts that carry it:

- Supabase handles sign-in, in place of Clerk
- Cloudflare Workers serve the site and run every scheduled job
- Convex holds the application data
- The data seeds, their freshness rails and the tests around them are ours

## Building it

`README.md` covers the build. The deployment also needs credentials that are
not here — API keys for the upstream data feeds, and the Cloudflare, Supabase
and Convex accounts it runs on. Nothing in the licence obliges us to hand over
our accounts, and nothing here will start without your own.
