# Upstream sync

This fork ships two upstream codebases under one roof:

| Component             | Upstream                                                                       | Local path     |
| --------------------- | ------------------------------------------------------------------------------ | -------------- |
| serverless-dns proxy  | [`serverless-dns/serverless-dns`](https://github.com/serverless-dns/serverless-dns) | repo root      |
| Web-Check audit GUI   | [`Lissy93/web-check`](https://github.com/Lissy93/web-check)                    | `web-check/`   |

Both are tracked automatically. Neither sync workflow pushes to `main` — they
each open a pull request so a human can review the upstream diff against this
fork's local changes (notably `src/core/workers/json-api.js`, the
`deepmarket` `wrangler.toml` env, and the vendored Web-Check shape) before it
lands.

This repo can stay private the whole time: the workflows run *inside* the
private fork, fetch *from* public upstreams, and push back only to your own
remote. No fork code leaves the repo.

## The workflows

```
.github/workflows/
  build.yml           — runs `npm run build`, asserts dist/worker.js exists.
                        Triggers: PRs, push to main, push to upstream-sync/**.
  sync-upstream.yml   — weekly + on-demand sync of serverless-dns.
                        Opens / updates PR on  upstream-sync/serverless-dns.
  sync-webcheck.yml   — weekly + on-demand sync of web-check.
                        Opens / updates PR on  upstream-sync/web-check.
  pr.yml              — existing Google-style eslint + auto-fmt-commit
                        (runs on `pull_request_target`).
```

### `sync-upstream.yml` — serverless-dns

Schedule: Mondays 06:00 UTC. Manual: **Actions → sync-upstream → Run workflow**.

Per run:

1. Checkout `main` of this fork.
2. Fetch `upstream/main` from `serverless-dns/serverless-dns`.
3. If already up to date, exit quietly.
4. Branch `upstream-sync/serverless-dns` off `main` (force-reset on reruns).
5. Try `git merge --ff-only`, then a regular merge commit, otherwise abort
   with a loud error so the conflict gets fixed by hand.
6. **`npm install` + `npm run build`** — fails the job if the fork's changes
   no longer compile against new upstream.
7. `git push --force-with-lease` the sync branch.
8. `gh pr create` (or `gh pr edit` on reruns) → PR titled
   `sync: serverless-dns/serverless-dns@<sha>`.

### `sync-webcheck.yml` — Lissy93/web-check

Schedule: Tuesdays 06:00 UTC (offset so both PRs don't land the same morning).
Manual: **Actions → sync-webcheck → Run workflow** (with optional `ref`
override — defaults to `master`).

Per run:

1. Shallow-clone the upstream ref into a scratch dir.
2. Strip the upstream `.git` and `.github/screenshots/` (multi-MB images we
   don't want vendored) — same shape as the initial vendor commit.
3. `rsync -a --delete` the scratch dir into `web-check/`.
4. If nothing changed, exit.
5. Commit the refresh on branch `upstream-sync/web-check`.
6. `npm install` + `npm run build` on the Worker (sanity guard — Web-Check
   itself is a separate Node app and isn't built in CI).
7. Force-push the branch, open / update the PR.

We use rsync rather than `git submodule` or `git subtree` so `web-check/`
stays a plain vendored directory with no submodule state to break Docker
builds or `git clone` for downstream consumers.

## Reviewing a sync PR

The PR description records the upstream sha and merge mode. Things worth a
human eyeball before merging:

- **serverless-dns sync**: anything under `src/core/`, `src/server-*.js`,
  `wrangler.toml`, or the JSON DNS API wiring (`src/core/workers/json-api.js`).
  Upstream sometimes renames internal modules — that's exactly what the
  inline build check is there to catch.
- **web-check sync**: `web-check/api/` (the lambda implementations) and
  `web-check/server.js` (express entrypoint). Major upstream version bumps
  in `web-check/package.json` are worth noting in case you self-host with
  Docker — rebuild the image.

Reruns of either workflow `force-with-lease` the same sync branch, so if
you push fixups onto the PR and then a fresh sync arrives, the workflow will
warn (lease check) instead of clobbering your fixes. If that happens, merge
or rebase manually.

## Optional: `WORKFLOWS_PAT` so PRs trigger downstream CI

GitHub deliberately suppresses event-driven workflow runs for actions
performed by the default `GITHUB_TOKEN` — to prevent infinite loops. The
practical effect: when the sync workflows open their PR, **`build.yml` and
`pr.yml` will not auto-run on that PR**. The inline `npm run build` step
inside the sync workflow itself is what guards against a broken merge — but
the PR's own CI status will sit empty.

If you want the lint + build workflows to also run on sync PRs:

1. Generate a fine-grained personal access token scoped to this repo with
   `Contents: read & write` and `Pull requests: read & write`.
2. Save it as repo secret `WORKFLOWS_PAT`
   (**Settings → Secrets and variables → Actions → New repository secret**).
3. Both sync workflows already pick it up automatically:
   ```yaml
   token: ${{ secrets.WORKFLOWS_PAT || secrets.GITHUB_TOKEN }}
   ```
   No code change needed — they fall back to `GITHUB_TOKEN` when the secret
   is absent.

Without the PAT the system still works; the sync workflow's own build step
is the meaningful gate. Without the PAT you just lose the convenience of
"PR opens → CI lights up green" — to kick CI on a sync PR manually, push
any commit to its branch (e.g. close + reopen the PR, or
`git commit --allow-empty -m "trigger ci" && git push`).

## Failure runbook

| Symptom                                              | What to do                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Merge conflicts` step failed                        | Locally: `git fetch origin upstream-sync/serverless-dns && git checkout upstream-sync/serverless-dns`, resolve, push. The workflow's next rerun will detect the resolved tip and update the PR. |
| Inline `npm run build` failed after a clean merge    | An upstream change broke the fork's deepmarket code. Inspect the PR diff, patch on the same sync branch, push. The workflow will pass on rerun, or `build.yml` will pass once you trigger it.  |
| `sync-webcheck` opened a PR with screenshots back in | The strip step (`rm -rf .github/screenshots`) failed or upstream moved the assets. Update the rsync excludes / strip list, rerun.                                                              |
| Want to fast-track an out-of-cycle sync              | Actions → **sync-upstream** / **sync-webcheck** → Run workflow. Both accept `workflow_dispatch`.            |

## Privacy

- Both workflows clone from public upstreams over HTTPS and push only to
  this private repo's `origin`. No fork code ever leaves.
- No upstream remote is added in a way that would `git push upstream` —
  pushes target `origin` only.
- The optional `WORKFLOWS_PAT` is scoped to this repo, never to the
  upstream orgs.
