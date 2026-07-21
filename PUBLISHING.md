# Publishing

Everything below is wired and verified except the final push to a registry,
which needs credentials this repo deliberately does not contain.

## npm — `@susa/signals-core`, `@susa/signals`

Both are scoped and marked `"access": "restricted"`, so a publish cannot
accidentally go public.

```bash
npm run build                        # emits dist/ for both packages
npm pack --workspace @susa/signals-core --dry-run   # inspect contents first
npm publish --workspace @susa/signals-core
npm publish --workspace @susa/signals
```

`prepublishOnly` rebuilds, so a stale `dist/` cannot ship.

**Before the first publish:** bump both from `0.0.0`, and decide whether
`@susa/signals` ships the code-split chunks or a single file. It is
currently built by consumers' bundlers from `dist/`, so the splitting is theirs
to do — the chunking in `examples/demo` is a demonstration, not the shipped
artefact.

## Android — `com.susatest:feedback`

Verified end to end against `mavenLocal`: AAR, sources jar, POM and Gradle
module metadata all produced.

```bash
cd platforms/android
MAVEN_URL=https://your-registry/... \
MAVEN_USER=... MAVEN_PASSWORD=... \
  ./gradlew :feedback:publishReleasePublicationToInternalRepository
```

Credentials are read from the environment. Never commit them — a token in the
repo is a token in every clone and every CI log that prints the workspace.

## iOS — Swift Package Manager

SPM has no registry step: consumers resolve straight from git, so publishing is
tagging.

```bash
git tag ios-0.1.0
git push origin ios-0.1.0
```

Consumers then depend on it:

```swift
.package(url: "https://github.com/monk0062006/susa-signals.git", from: "0.1.0")
```

**Caveat:** `Package.swift` sits in `platforms/ios/`, not the repo root. SPM
requires it at the root of whatever it resolves, so before real distribution
this needs either a dedicated repo or a `Package.swift` at the top level.

## Version alignment

The three platforms currently version independently. They share one wire format,
so a schema change ships in all three at once — worth agreeing a single version
line before the first release rather than after.
