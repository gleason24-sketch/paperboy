# GitHub Actions workflows (to be moved)

These belong in `.github/workflows/`. They are parked here because the token that created this repository could not push
workflow files (GitHub requires the `workflow` scope for that). To activate them:

```bash
git mv ci-workflows/ci.yml .github/workflows/ci.yml
git mv ci-workflows/release-cli.yml .github/workflows/release-cli.yml
git rm ci-workflows/README.md
```

`ci.yml` runs typecheck, tests, the build, the banned-string scrub, gitleaks and a Docker build on every push.
`release-cli.yml` publishes `@paperboyseo/cli` with provenance and only runs when you start it by hand.
