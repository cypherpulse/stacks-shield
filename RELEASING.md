# Releasing

Stacks Shield is released via **git tags**. Pushing a `v*` tag triggers the
[release workflow](.github/workflows/release.yml), which creates a matching
**GitHub Release** with auto-generated notes.

Versioning follows [SemVer](https://semver.org). A tag carrying a pre-release
identifier (e.g. `v1.0.0-beta.1`, `v1.1.0-rc.1`) is published as a GitHub
**pre-release** automatically.

## Cutting a release

1. **Update the changelog.** Move the relevant items from `## [Unreleased]` into a
   new `## [X.Y.Z] - YYYY-MM-DD` section in [`CHANGELOG.md`](CHANGELOG.md), and add
   the compare/tag links at the bottom.

2. **Bump versions** to `X.Y.Z` where relevant:
   - root `package.json`
   - `sdk/package.json` (the published `@stacks-shield/sdk` — also update
     `sdk/CHANGELOG.md`)
   - `frontend/package.json` and `services/*/package.json` as needed

3. **Commit** the changelog + version bumps:
   ```bash
   git add -A
   git commit -m "chore(release): vX.Y.Z"
   git push origin main
   ```

4. **Tag and push** (annotated tag — this fires the release workflow):
   ```bash
   git tag -a vX.Y.Z -m "Stacks Shield vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. **Publish the SDK to npm** (optional). For any pre-release / unaudited version,
   publish under a pre-release dist-tag so it is **not** `latest` — consumers must
   opt in explicitly (`@beta`), and the API can still change before a stable
   `1.0.0`:
   ```bash
   cd sdk
   npm publish --tag beta --access public   # requires a prerelease version, e.g. 1.0.0-beta.1
   ```
   For a stable release, publish without `--tag beta` so it becomes `latest`.

## Conventions

- Tags are always prefixed with `v` (the workflow triggers on `v*`).
- Use pre-release tags (e.g. `-beta.N`, `-rc.N`) for any build that is not
  audited and production-stable, so GitHub marks it a pre-release and the npm
  package stays off the `latest` tag.
- Keep a `## [Unreleased]` section at the top of the changelog for ongoing work.
- The SDK package ships only `dist/` + README/CHANGELOG/LICENSE; `prepublishOnly`
  builds it automatically.
