# Side-by-side permanent-entry qualification

Status: development/qualification procedure for #159. This does **not** cut over the installed DevBridge entrypoint and does not implement stable release/LKG authority.

## Purpose

The experimental exact-checkout path needs a physical-host entry seam before #157 can use its retained temporary control-plane commit. During this qualification interval, the existing installed `devbridge.mjs` must remain authoritative and unchanged.

`scripts/stage-entry-candidate.mjs` creates a disposable candidate directory beside the installation rather than replacing it. The candidate contains:

- byte-for-byte copied current installed stable `devbridge.mjs` for the no-selector/default route;
- the candidate `devbridge-entry.mjs` router;
- only the experimental permanent-entry dependency closure needed for explicit `--ref` / `--branch` selection;
- a bounded digest manifest for staging evidence.

The staging operation has no network behavior, accepts only explicit absolute local paths, refuses an existing output directory, and never writes the source stable launcher. It does not create stable accepted state, experimental accepted state, LKG state, release authority, or a production cutover.

## Stage a disposable candidate

Create an empty parent directory first. The exact output directory must not already exist.

Linux example:

```sh
mkdir -p "$HOME/.devbridge/qualification"
node scripts/stage-entry-candidate.mjs \
  --stable-launcher "$HOME/.devbridge/bin/devbridge.mjs" \
  --output "$HOME/.devbridge/qualification/entry-candidate"
```

Windows PowerShell example:

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\qualification" | Out-Null
node scripts/stage-entry-candidate.mjs `
  --stable-launcher "$HOME\.devbridge\bin\devbridge.mjs" `
  --output "$HOME\.devbridge\qualification\entry-candidate"
```

For reproducible qualification, run the staging script from the exact #163 commit being qualified and record that commit together with `entry-candidate-manifest.json`.

## Prove the unchanged default route

Invoke the candidate router without an experimental selector and use non-mutating bootstrap options appropriate for the installation, for example:

```text
node <candidate>/devbridge-entry.mjs doctor --home <installation-home> --no-update
```

The router then loads the byte-for-byte copied installed `devbridge.mjs`. The persistent installed launcher is not replaced.

## Prove exact experimental selection

Invoke the same candidate router with an exact 40-hex commit:

```text
node <candidate>/devbridge-entry.mjs --ref <exact-commit> <normal-devbridge-argv>
```

The explicit route never loads the copied Stage-0 launcher. It enters the frozen experimental-entry bundle, resolves/verifies the exact experimental subject, materializes a clean exact DevBridge checkout, re-verifies it, and launches that selected tree's normal `src/cli.js`.

For #157 acceptance, prefer the exact retained temporary commit over the moving branch name. The qualification record should therefore contain the exact #163 entry-bundle commit, the candidate manifest digests, the exact #157 selected commit, platform, installation identity, and the bounded canary result.

## Cleanup

The candidate directory is disposable qualification state. Removing it does not modify the installed stable launcher or stable accepted runtime state. Do not promote this side-by-side staging procedure into production stable authority; #159's signed stable subject, accepted/LKG state, bounded status, and installer cutover/rollback remain separate production work.
