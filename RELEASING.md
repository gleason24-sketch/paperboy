# Releasing

Paperboy ships on a weekly cadence. A release is small and named, so each one gives people a reason to look again, for example "v0.2.0: Search Console loop".

## Cadence

- Tag a release every Tuesday: `v0.x.y`. Skip a week rather than ship an empty one.
- Package small features into one named release. The name is the headline of the post.
- Before 1.0, bump the minor version for a new feature and the patch version for fixes only.

## Steps

1. **Bump versions.** Set `version` in the root `package.json` and in `packages/engine`, `packages/cli` and `packages/db` to the new number.
2. **Update `CHANGELOG.md`.** Add a dated section at the top, newest first:

   ```md
   ## 0.2.0 (2026-11-10)

   Name: Search Console loop
   Headline: Rank loop

   - Rank loop: what it does, in one plain sentence.
   - Another change.
   ```

   `Name:` and `Headline:` are optional. `Name` becomes the release title. `Headline` picks the bullet the dev.to and Hackernoon drafts are built around; without it the script picks a bullet by keyword (fact check first), then the first bullet. Write each bullet so it is true and checkable: no invented numbers, no dashes.
3. **Check the tree.** `npm run typecheck && npm test && npm run scrub`.
4. **Generate the drafts.** `node scripts/release-post.mjs --out <dir>` (optionally `--version 0.2.0` and `--since <tag|sha>`). The default output directory is `release-posts/`, which is git-ignored. The script reads the changelog section and the commits since the last tag (the whole history if there is no tag yet) and writes `<dir>/v<version>.md` with six drafts. It writes a file only; nothing is posted.
5. **Read every draft.** Fix anything that is wrong or reads like a template. Update `CLI_ON_NPM` in the script once the CLI is published.
6. **Tag and release.** `git tag v0.2.0 && git push origin v0.2.0`, then create the GitHub Release from the "GitHub Release notes" section of the drafts file.
7. **Post by hand, one community per day.** Order: r/selfhosted, then the Lemmy selfhosted community, dev.to, Indie Hackers, Hackernoon. Read each community's self-promotion rules first, use the right flair, and always say you are the maker (the drafts carry a disclosure line; keep it). Reply to comments yourself. Do not cross-post the same text on the same day.

## The repository URL

The script has one default repository URL at the top (`REPO_URL`) unless the environment variable `PAPERBOY_REPO_URL` is set. When the repository moves to an organisation, change that one default in `scripts/release-post.mjs`.

## Rules for the drafts

- No invented numbers: no stars, users, downloads or traffic. Only what the changelog, the docs or the code can show.
- No dashes in prose (house style, see [CONTRIBUTING.md](CONTRIBUTING.md)). The script replaces any it finds.
- Say what is not done. The CLI is not on npm until it is, and the posts say "run from source".
