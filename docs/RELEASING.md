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
- [x] Push `main`. Confirm the CI workflow runs green on Node 22, 24 and 26.
      → run 43821400614, all three matrix jobs green at `3b8beae`.
- [x] Repository description and topics set.
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
      approving a staged version prompts for it. **Unverified** — checking it
      needs an authenticated session (`npm profile get`).
- [x] Local npm is **11.15.0 or later** on Node **22.14.0 or later**.
      → npm 12.2.2 on Node 22.22.3.
- [x] Confirm the name is still free: `npm view quota-pilot` 404s.
- [ ] `npm login`. Interactive (browser + 2FA), so it cannot be scripted. Until
      this is done, `npm whoami` reports ENEEDAUTH and nothing can be staged.

## 3. First publication (bootstrap)

**A trusted publisher cannot be configured for a package that does not exist.**
The configuration lives in that package's settings page on npmjs.com, so the
very first submission cannot use OIDC and must carry an ordinary credential.
That part is unavoidable. What *is* avoidable is publishing something junk to
get there.

**Prerequisite:** local npm **11.15.0 or later** on Node **22.14.0 or later**.
The npm bundled with Node is older than that, so `npm install -g npm@latest`
first and confirm with `npm --version`.

### Step 3.1 — stage the real version, do not approve it

```bash
npm run verify            # lint, typecheck, tests, build, consumer smoke
node scripts/preflight.mjs --registry
npm stage publish --tag alpha --dry-run   # read the summary line first
npm stage publish --tag alpha
```

**Pass `--tag alpha` explicitly. Do not rely on `publishConfig.tag`.** On npm
12.2.2, `npm config list` reports `tag = "alpha"` from `publishConfig` while
`npm config get tag` reports `latest`, and both `npm publish --dry-run` and
`npm stage publish --dry-run` announce *"with tag latest"*. Whether that is a
display bug or the real behaviour cannot be settled without doing a publish,
and a dist-tag cannot be unassigned — only moved, after `npm install
quota-pilot` has already started resolving to an alpha. The dry run above
prints the tag it would use; check that line says `alpha` before running the
real command.

Staging a package that has never been published creates the package on the
registry with a placeholder version `0.0.0-stage`. The placeholder is publicly
visible; **the staged contents are not installable until approved.** So after
this step the package exists — which is the precondition the trusted publisher
needs — without anything installable having been released.

### Step 3.2 — check whether the settings page is now available

Open npmjs.com → `quota-pilot` → **Settings**. Either the Trusted Publisher
section is there or it is not.

npm's documentation states that staging creates the package, but does **not**
say whether a staged-only package exposes its settings page. That is the one
unknown in this sequence. Checking costs nothing and changes nothing, which is
why the sequence is ordered to find out before anything is irreversible.

**If Trusted Publisher is available** — configure it (step 4), then:

```bash
npm stage list
npm stage reject <stage-id>    # discard the locally built artifact
```

and dispatch the Release workflow with `mode: publish`. The real
`0.1.0-alpha.5` is then published from CI, carrying a provenance attestation,
and that publish is what validates the new configuration inside its 2-day
window. Cost: one public `0.0.0-stage` placeholder, nothing installable that
should not be.

**If Trusted Publisher is not available** — approve what you staged:

```bash
npm stage download <stage-id>  # inspect the exact tarball first
npm stage approve <stage-id>   # 2FA
```

`0.1.0-alpha.5` goes live without a provenance attestation. Configure the
trusted publisher afterwards and use OIDC from `0.1.0-alpha.6` onward, timing
the configuration so a real release falls inside the 2-day window.

### Why not a throwaway bootstrap version

An earlier draft of this runbook recommended publishing `0.0.1-bootstrap` to
create the package, then releasing the real alpha over OIDC. Staging is
strictly better: it creates the same package entry without putting an
installable version on the registry that has to be deprecated and then lives
there forever. The `0.0.0-stage` placeholder is a marker, not a release — no
one can install it.

### Why the first OIDC release uses `mode: publish`, not `mode: stage`

Configurations created after 3 September 2026 permit `npm stage publish` by
default, with direct `npm publish` as an opt-in. A direct publish is
unambiguously "a successful publish" for the purpose of validating a new
configuration; whether a *staged* submission also counts is not documented.
Enable the direct-publish option, use it once to validate, and switch to
`mode: stage` for every release after that.

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
- Every alpha goes out under the `alpha` dist-tag, passed **explicitly** as
  `--tag alpha` at every call site. `publishConfig.tag` is set as well and the
  preflight checks it, but it is not sufficient on its own — see step 3.1.
- The `latest` tag stays unclaimed until 0.1.0. Until then
  `npm install quota-pilot` deliberately resolves nothing — asking for
  `@alpha` is the opt-in.
