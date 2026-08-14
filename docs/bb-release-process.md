# Releasing bb-app

This fork does not use GitHub Actions. Releases are manual and require explicit
approval before any package, desktop artifact, or external release is
published.

## Release policy

- Publish only from `main`.
- Keep `packages/bb-app/package.json` and `apps/desktop/package.json` versions
  locked together.
- Do not publish or change npm dist-tags without explicit approval.
- Record the exact commit, versions, validation, and registry or release result.

## Prepare and validate

1. Inspect the current registry state if a release is approved:

   ```bash
   npm view bb-app version dist-tags versions --json
   ```

2. Bump both lockstep versions:

   ```bash
   node scripts/bump-version.mjs --patch
   ```

3. Run local validation:

   ```bash
   node -e 'const a=require("./packages/bb-app/package.json").version; const b=require("./apps/desktop/package.json").version; if (a !== b) throw new Error(`${a} != ${b}`); console.log(a)'
   pnpm exec turbo run typecheck test --filter=@bb/config --filter=@bb/server --filter=bb-app
   pnpm exec turbo run smoke:tarball --filter=bb-app --force
   git diff --check
   ```

4. Update the changelog and release metadata when required.

5. Commit the release and ensure it is on `main` before publishing.

## Publish bb-app

Only run this after explicit approval:

```bash
npm publish --tag latest
```

Use a prerelease tag such as `alpha`, `beta`, or `nightly` only when the
approved release plan names that tag. Verify the result:

```bash
npm view bb-app version dist-tags versions --json
npx --yes bb-app@latest --help
```

## Publish the desktop app

Build and package the desktop app locally using the platform's documented
signing and notarization credentials. Do not publish unsigned artifacts as a
stable release. Publish the signed artifacts and `desktop-version.json` only
after approval. Verify the release feed and assets from the configured release
system after publication.

## Failure handling

- If validation fails, stop and fix the defect before publishing.
- If the version already exists on npm, stop and choose a new approved version.
- If signing or notarization is incomplete, stop. Do not substitute unsigned
  artifacts.
- Preserve command output and the commit SHA in the release record.
