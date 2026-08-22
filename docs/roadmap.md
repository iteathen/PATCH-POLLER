# DevBridge roadmap

## Current checkpoint

DevBridge has a substantial trusted host control plane: exact GitHub provenance, authoritative Git/workspaces, durable runs/recovery, controller plans, tool inventory/onboarding, checkpoint-and-proceed decisions, coordination leases/fencing, baseline-drift reverification, supervised self-update, resource priority/pause, and cost-aware verification governance.

The VM program has also completed the major security pivot away from host repository-code sandboxes. Repository-controlled execution is VM-only and fails closed when the selected VM route is unavailable.

Issue #138 corrects the persistent VM ownership model that emerged during the first VM lifecycle implementation:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

This correction is now part of the active VM roadmap. Repository count must not determine VM count.

## Active provider targets

Required host providers remain:

- Windows / Hyper-V;
- Linux / KVM-QEMU-libvirt.

Both attach through provider-neutral lifecycle/image/bridge studs. Provider-specific disk/domain/network/transport details stay in adapters.

## VM program history and current direction

### Stage 0 — architecture/spec ratification — #108 — complete

Established DB-020, provider parity, VM-only host security boundary, immutable images, host-only authority/secrets, narrow bridge contracts, and migration inventory.

The original Stage-0/DB-020 topology assumed a repository-owned persistent environment. Issue #138 supersedes that ownership assumption while preserving the VM-only security boundary.

### Stage 1 — remove host sandbox execution — #109 — complete

Removed active Bubblewrap/AppContainer/ProcessContainer-style repository execution, proved fail-closed no-provider behavior, preserved neutral execution studs, and prevented direct/uncontained host fallback.

### Stage 2 — provider/image foundation — #110 — complete

Implemented provider-local Hyper-V and KVM/QEMU/libvirt management foundations, owned storage/networking lifecycle, and immutable/versioned base-image behavior behind neutral contracts.

### Stage 3 — persistent environment lifecycle — #111 — complete historical implementation

Proved provider-native persistent lifecycle, image lineage, reset/reseed, recovery, and exact VM/domain ownership mechanics.

The original Stage 3 composition used repository identity as the persistent environment owner. That topology is now historical. Its lifecycle mechanics remain reusable because the environment `subject` contract was opaque.

Current composition supplies an execution-profile subject instead.

### Stage 4 — narrow host↔guest bridge — #112 — complete

Provides bounded command/file exchange behind provider adapters without exposing arbitrary host paths, credentials, or provider-management authority.

### Stage 5 — guest bootstrap/tooling/network — #113 — complete on migration stack

Provides persistent guest preparation and development tool behavior needed by VM execution.

### Stage 6 — VM-only repository execution — #114 — complete on migration stack

Restores repository-controlled operations through persistent VM routes with host-owned source/candidate/Git authority and no direct-host fallback.

Issue #138 changes route topology so multiple repository workspaces may resolve to one physical compatible profile VM.

### Stage 7 — provider/security/recovery/resource qualification — #115 — active

Qualification now includes both original VM security claims and shared-profile workspace claims:

- real Hyper-V/KVM-libvirt provider evidence;
- no host credential/control leakage;
- provider/image/writable-layer lineage;
- restart/reset/reseed recovery;
- one profile VM serving multiple repository workspaces;
- workspace route/path/cleanup targeting;
- process/task/result isolation at the claimed boundary;
- shared-cache ownership rules;
- typed profile resource failures;
- no direct-host fallback.

Workspace scoping is not a claim that sibling workspaces survive a fully compromised/root shared guest. Separate hostile-guest trust domains require separate profiles/VMs.

### Stage 8 — setup/reconfiguration — #116 / #103 — active

Setup is discover-first and now separates:

1. host provider/image/profile readiness;
2. repository discovery/approval;
3. repository workspace routing;
4. execution enablement.

Repository `all` means all eligible workspaces, not one VM per repository. Profile provisioning is explicit/demand-driven and resource-preflighted.

Legacy repository-owned VMs are migration candidates, not silently adopted profile environments.

### Stage 9 — final cleanup — #117 — pending final qualification

Remove stale sandbox-era and repository-owned-topology compatibility/documentation after migration behavior and real provider qualification are complete.

## Issue #138 implementation slices

The execution-profile correction is considered complete only when all of the following hold:

1. stable profile identity is independent of repository identity;
2. stable workspace identity binds repository + profile without provider leakage;
3. many workspace routes can resolve to one physical profile environment;
4. bridge operations are workspace-scoped;
5. provider adapters remain repository-agnostic;
6. selecting all repositories cannot fan out VM creation/start;
7. profile memory/resource allocation is preflighted and typed;
8. legacy repository-owned environments have explicit migration/retirement semantics;
9. docs/specs no longer present one VM per repository as the active target;
10. CI and real-provider qualification cover the new claimed boundaries.

## Execution-profile evolution

Profiles represent materially distinct platforms, not organizational grouping.

Expected examples include:

- `windows`;
- `linux`;
- `windows+cuda`;
- `linux+cuda`.

A new profile is justified only by actual compatibility/isolation/resource requirements such as OS, kernel, driver, GPU/device, licensing, architecture, or toolchain constraints.

Do not create profiles merely because repositories differ.

## Workspace lifecycle follow-through

Near-term work after the basic routing correction should make workspace lifecycle first-class where needed:

- explicit workspace inventory/status;
- exact workspace reset/reseed/cleanup;
- repository-local HOME/TMP/config overlays where required;
- safe cache-sharing policy;
- migration tooling for useful old repository-owned state;
- operator-visible workspace/profile relationship in `doctor`/setup;
- task scheduling/resource accounting when multiple workspaces share one profile.

These operations must remain narrower than profile reset/delete and must not destroy sibling workspaces.

## Resource governance

Profile resource policy owns:

- memory/vCPU;
- host reserve/preflight;
- persistent disk growth/retention;
- active-profile/warm-pool policy;
- idle shutdown/suspend;
- GPU/device exclusivity;
- operation timeout/cancel.

Task/process limits inside a running profile may be separate. A raw repository count or `maxConcurrentTasks` value must not imply VM fleet size or a scheduler.

## Verification governance

Cost-aware verification remains control-plane authority.

Cheap checks should run before expensive provider qualification. Real VM/security claims require capable hardware; hosted CI unit/mocks are architecture evidence but do not substitute for real Hyper-V/KVM boundary qualification.

Evidence should bind relevant candidate, provider, image, profile environment, workspace, bridge, and toolchain identities so still-valid expensive evidence can be reused safely.

## Setup/operator experience target

The desired setup experience is a guided review of discovered state, not a questionnaire and not a hidden VM fleet provisioner.

A useful summary is:

```text
Repositories approved: 15
Repository workspaces enabled: 15
Ready execution profiles: 1
Additional profiles required now: 0
```

A resource-bearing change should be expressed in profile terms, for example:

```text
Create linux+cuda profile VM: 8 GiB RAM, 4 vCPU, GPU access
```

rather than as fifteen repository VM decisions.

## Deferred/future work

After issue #138 and Stage 7/8 qualification:

- richer profile compatibility/capability selection;
- GPU execution-profile support where hardware exists;
- workspace lifecycle/migration tooling;
- resource-aware scheduling across profiles;
- optional stronger per-workspace isolation mechanisms if a real threat model requires them;
- additional providers only when justified, not for abstraction symmetry.

## Documentation authority

Current active target documents are:

- `specs/DB-020-vm-execution-boundary.md`;
- `docs/execution-profile-environments.md`;
- `docs/architecture.md`;
- `docs/setup.md`;
- `docs/vm-migration.md`;
- this roadmap;
- active issues #103, #107, #115, #116, #117, and #138.

Historical Stage 3 ownership language, old sandbox work, handoffs, tests, and PRs remain evidence but are non-normative where they conflict with the execution-profile correction.
