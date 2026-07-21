# Publishing

All three channels are live. Releases are driven by a git tag; nothing is
published by hand.

```bash
git tag -a v0.2.0 -m "Susa Signals 0.2.0"
git push origin v0.2.0
```

That runs `.github/workflows/release.yml`, which publishes npm and Maven
Central. Swift Package Manager needs no job at all — SPM has no registry, so
the tag *is* the Swift release.

## Current state

| Channel | Coordinates | Status |
| --- | --- | --- |
| npm | `@susatest/signals`, `@susatest/signals-core` | published, `0.1.0` |
| Maven Central | `com.susatest:signals` | published, `0.1.0` |
| SPM | `github.com/monk0062006/susa-signals` @ `v0.1.0` | published |

Consumers:

```bash
npm install @susatest/signals
```

```kotlin
implementation("com.susatest:signals:0.1.0")
```

```swift
.package(url: "https://github.com/monk0062006/susa-signals", from: "0.1.0")
```

## Testing a channel without burning a version

Tags are permanent and npm versions cannot be reused, so "tag it and see" is an
expensive way to discover a credential is wrong. Use the manual trigger:

```bash
# validate only - builds, signs, and checks, but uploads nothing
gh workflow run release.yml -f version=0.2.0 -f channel=maven -f dry_run=true

# real publish of one channel
gh workflow run release.yml -f version=0.2.0 -f channel=npm -f dry_run=false
```

## Required secrets

Set in **Settings → Secrets and variables → Actions**. None of these belong in
the repo, in a shell command, or in a chat window.

| Secret | Source |
| --- | --- |
| `NPM_TOKEN` | npmjs.com → Granular Access Token, read+write on `@susatest/*` |
| `MAVEN_USERNAME` | central.sonatype.com → View Account → Generate User Token |
| `MAVEN_PASSWORD` | second half of that token |
| `SIGNING_KEY` | armored GPG private key (`scripts/setup-signing-key.ps1`) |
| `SIGNING_PASSWORD` | that key's passphrase |

The npm token must be **granular**, not classic: an account with 2FA on writes
rejects a classic token from CI with a 403 that says nothing about the cause.

If `MAVEN_USERNAME` or `SIGNING_KEY` is absent the Maven job reports *skipped*
rather than failed. A red X on a channel that simply is not provisioned trains
people to ignore red X's.

## What the workflow guards against

Each of these is a failure that reported success at some point during
development:

- **Non-semver tag** — rejected before anything is built. A malformed version
  cannot be unpublished from npm after 72 hours.
- **Empty tarball** — `files: ["dist"]` ships an empty package if the build did
  not run. Publishing nothing is worse than failing.
- **Unpinned workspace dependency** — npm publishes `"*"` literally rather than
  rewriting it the way pnpm rewrites `workspace:*`. The workflow pins
  `@susatest/signals-core` to the exact released version, or every install
  would resolve to whatever core is newest, including a future breaking major.
- **Unsigned artifacts** — asserted before upload. Central rejects an unsigned
  bundle during validation, long after the job would otherwise have gone green.
- **Upload accepted ≠ published** — Central returns `201` for "bundle received",
  then validates asynchronously and can reject. The workflow polls for the real
  verdict: `PUBLISHED`, `VALIDATED` (sound, awaiting a manual release click), or
  `FAILED`.

## Signing key

`scripts/setup-signing-key.ps1` generates it, publishes the public half to
`keyserver.ubuntu.com`, and puts the private half on the clipboard. It never
writes the key or passphrase to disk.

Central verifies signatures against a public keyserver — skip that step and
every upload fails validation with an error that does not mention the cause.

Back the key up offline. Losing it means future releases cannot be signed under
the same identity.

> On Windows, GnuPG 2.4 ships with `use-keyboxd` enabled and that daemon never
> returns — every `gpg` call hangs, under bash as well as PowerShell. The script
> disables it.

## Maven Central: manual release step

The portal currently has automatic publishing **off**, so a validated
deployment waits for a human at
<https://central.sonatype.com/publishing/deployments>.

The workflow treats `VALIDATED` as success and says so. Turn on automatic
publishing in the portal if you would rather a tag go all the way out.

## Versioning

All three platforms share one version line, set by the tag. They share a wire
format, so a schema change must ship everywhere at once — independent versions
would let a web client and an Android client disagree about the payload.

Pre-1.0 while the API settles: breaking changes are allowed in minor versions.
