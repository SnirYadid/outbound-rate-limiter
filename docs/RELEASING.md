# Releasing

Maintainer runbook. Not shipped in the npm tarball.

Two things make releases unusually unforgiving, and everything here follows
from them: **npm versions are immutable** (a wrong `repository` URL or a
mistyped dist-tag cannot be edited, only superseded), and **a new trusted
publisher configuration expires if its first publish does not succeed within
2 days**. So the order of operations matters more than the individual steps.

---

## 1. GitHub repository preparation

Nothing in this list is automated, because all of it happens outside the repo.

- [x] Create the repository. **Public** — npm provenance attestations require a
      public repository and a public package.
      → `github.com/SnirYadid/quota-pilot`
- [x] Owner and name decided. The repository name matches the package name, so
      the npm page, the badge URLs and the provenance link all agree.
- [x] `git remote add origin https://github.com/SnirYadid/quota-pilot.git`
- [x] Placeholder replaced in `package.json` (`repository`, `homepage`,
      `bugs`). `npm run preflight` fails while any placeholder remains, and the
      release workflow runs it.
- [ ] Push `main`. Confirm the CI workflow runs green on Node 22, 24 and 26.
- [ ] Repository description and topics: `rate-limiting`, `token-bucket`,
      `retry`, `backoff`, `concurrency`, `typescript`, `nodejs`.
- [ ] Settings → Actions → General → Workflow permissions: **read repository
      contents**. Both workflows declare their own permissions, so the default
      only needs to be no wider than that.
- [ ] Settings → Environments → create **`release`**. Add yourself as a
      required reviewer. This is the human gate: a dispatched release waits
      here before any publish step runs.
- [ ] Settings → Branches → protect `main`: require the CI check, disallow
      force pushes.
- [ ] Verify every README link resolves on GitHub (relative links to `docs/`
      and `examples/` only resolve once the repository is public).

## 2. npm account preparation

- [ ] 2FA enabled on the npm account. Staged publishing requires it, and
      approving a staged version prompts for it.
- [ ] Local npm is **11.15.0 or later** on Node **22.14.0 or later**. The npm
      bundled with Node is usually older — check with `npm --version` and
      upgrade with `npm install -g npm@latest` if needed.
- [ ] Confirm the name is still free: `npm view quota-pilot` should 404.

## 3. First publication (bootstrap)

**A trusted publisher cannot be configured for a package that does not exist.**
The configuration lives in that package's settings page on npmjs.com, so the
very first publication cannot use OIDC. There is no way around this; the only
choice is what the first artifact is.

Two orders, with a real trade-off.

### Option A — publish the real alpha manually, then wire OIDC

```bash
npm run verify          # lint, typecheck, tests, build, consumer smoke
npm run preflight       # add --registry to also check the registry
npm publish             # publishConfig pins --tag alpha and public access
```

- Simplest, and nothing junk ends up on the registry.
- **The first tarball carries no provenance attestation**, because provenance
  requires OIDC.
- Watch the expiry trap: after configuring the trusted publisher, the config
  needs a successful publish within 2 days. With this option the real alpha is
  already out, so there may be nothing to publish inside that window and the
  config silently expires. Either configure it immediately before the next
  real release, or accept reconfiguring it later.

### Option B — bootstrap with a throwaway version, then release over OIDC

```bash
npm version 0.0.1-bootstrap --no-git-tag-version
npm publish --tag bootstrap     # creates the package so settings exist
git checkout package.json       # discard the version bump
```

Then configure the trusted publisher (step 4) and release `0.1.0-alpha.5`
through the workflow within 2 days.

- The real alpha gets a provenance attestation, and that first OIDC release is
  what validates the configuration — the expiry window is used rather than
  raced.
- Costs a permanent junk version on the registry. It can be deprecated
  (`npm deprecate quota-pilot@0.0.1-bootstrap "bootstrap placeholder"`) but not
  removed.

**Recommendation: Option B.** The whole argument for this library is that its
claims are checkable, and provenance on the first real artifact is exactly
that. One deprecated placeholder version is a cheap price.

> `npm stage publish` also works for an unpublished package, but it creates a
> publicly visible `0.0.0-stage` placeholder version, so it is not a way to
> avoid Option B's cost. Whether that placeholder is enough to unlock the
> settings page has not been verified — do not plan around it.

## 4. Configure the npm trusted publisher

On npmjs.com → the `quota-pilot` package → **Settings** → **Trusted Publisher**:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | the repository owner |
| Repository | `quota-pilot` |
| Workflow filename | `release.yml` |
| Environment | `release` |

Two settings deserve attention:

- **Environment must match the workflow.** `release.yml` declares
  `environment: release`; if the npm configuration names a different one (or
  none while the workflow declares one), the publish is rejected.
- **Allowed actions.** Configurations created after 3 September 2026 default to
  permitting `npm stage publish` only. Direct `npm publish` is an opt-in. The
  workflow's `mode: publish` path needs that opt-in — and the first OIDC
  release should use it, because a direct publish is what validates the new
  configuration.

npm does not validate the configuration when you save it. Mistakes surface as
a failed publish, which is another reason the first release should be a
deliberate dispatch rather than part of a larger change.

## 5. Running a release

1. `main` is green and `npm run preflight` passes locally.
2. Actions → **Release** → Run workflow:
   - `version`: exactly the `package.json` version, e.g. `0.1.0-alpha.5`
   - `dry_run`: **true** for the first run. It performs every check, packs the
     tarball and uploads it as an artifact, and publishes nothing.
3. Download the artifact and look inside it.
4. Re-dispatch with `dry_run: false` and the appropriate `mode`.
5. Approve the `release` environment when GitHub asks.
6. For `mode: stage`, finish locally:

```bash
npm stage list
npm stage view <stage-id>
npm stage download <stage-id>     # inspect the real tarball
npm stage approve <stage-id>      # 2FA
```

7. Verify: `npm view quota-pilot@alpha version`, then install it into an empty
   directory and import it.
8. Tag the commit: `git tag v0.1.0-alpha.5 && git push origin v0.1.0-alpha.5`,
   and write the GitHub release notes from the changelog entry.

## 6. What the workflow refuses to do

- Run from any branch but `main`.
- Run on a schedule, a push or a tag. Dispatch only.
- Publish when the `version` input disagrees with `package.json`.
- Publish while `package.json` holds a placeholder URL, the `VERSION` constant
  disagrees with the manifest, `dist/` was built from another version, the
  changelog has no entry for the version, a prerelease would take the `latest`
  dist-tag, a runtime dependency has appeared, `engines.node` names a floor the
  CI matrix does not test, or the version is already on the registry.
- Hold an npm token. There is no `NODE_AUTH_TOKEN` and no `NPM_TOKEN` in the
  workflow or in repository secrets; the credential is a short-lived one
  exchanged for the run's OIDC token.
- Write to the repository. `contents: read` and `id-token: write`, nothing else.

## 7. Version policy

`0.1.0-alpha.5` is the first published version; alpha.0 through alpha.4 exist
only in git history. While the line stays alpha:

- Breaking changes are allowed between alpha versions and must be in the
  changelog under **Changed**, naming what breaks.
- Every alpha goes out under the `alpha` dist-tag. `publishConfig.tag` makes
  that the default so it cannot be forgotten, and the preflight fails if a
  prerelease version is paired with any other tag.
- The `latest` tag stays unclaimed until 0.1.0. Until then
  `npm install quota-pilot` deliberately resolves nothing — asking for
  `@alpha` is the opt-in.
