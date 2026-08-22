# DB-020 — Persistent VM Execution Boundary

Status: active architecture contract. The execution-profile ownership correction from issue #138 is normative and supersedes the original repository-owned VM topology. Historical Stage 3 evidence is retained in `docs/vm-stage3-persistent-environments.md`.

Implementation status: the VM migration stack has removed active Bubblewrap/AppContainer/ProcessContainer-style host repository execution and restored repository-controlled execution only through admitted persistent VM routes. The current topology is defined by `docs/execution-profile-environments.md`: persistent VMs are owned by execution profiles; repositories receive isolated workspaces inside compatible profiles.

## Goal

Make a persistent virtual machine the sole required host-security boundary for repository-controlled execution while keeping DevBridge's authoritative control plane, secrets, Git/publication authority, and recovery state on the trusted host.

The initial provider families are:

- **Windows host:** Hyper-V.
- **Linux host:** KVM/QEMU managed through libvirt.

Both are first-class providers. Common control-plane logic must not assume Hyper-V, PowerShell, VHDX, libvirt, qcow2, or a particular bridge transport.

## Governing topology

**Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

A repository is not itself a VM lifecycle owner. Discovering, approving, adding, removing, or selecting another repository must not implicitly create another VM.

An execution profile represents a materially distinct execution platform, for example:

- `windows`;
- `linux`;
- `windows+cuda`;
- `linux+cuda`;
- another profile justified by actual OS, kernel, driver, hardware, licensing, or toolchain requirements.

Profiles are demand-driven. If multiple repositories can use the same profile, they share that profile VM while retaining distinct workspace identities and bounded writable project state.

A repository may be compatible with more than one profile. Local routing policy selects a ready compatible profile from neutral requirements. If no compatible profile exists, execution fails/degrades or setup offers explicit profile provisioning; DevBridge must not silently synthesize a repository-specific VM.

## Core security rule

**Repository-controlled code executes in an untrusted VM. If no qualified/admitted compatible VM execution profile is available, repository-controlled execution does not occur. It never falls back to direct or uncontained host execution.**

A guest administrator/root compromise must not grant access to:

- GitHub credentials or credential brokers;
- coordination private keys or lease-signing authority;
- release/signing keys, manifests, or activation authority;
- authoritative Git administration, task-branch publication, or default-branch promotion authority;
- DevBridge daemon locks, durable run/control state, checkpoints, decisions, or recovery journals;
- host operator credentials, SSH agents, token-bearing environment variables, or user-home secrets;
- hypervisor/VM-management authority;
- arbitrary host paths or writable host mounts.

Repository content, dependencies, package scripts, build systems, tests, coding-worker subprocesses, browser tooling, generated tools, and guest-local Git are inside the untrusted guest trust domain unless a later specification deliberately establishes another independently enforced boundary.

No required Bubblewrap, AppContainer, ProcessContainer, or equivalent second sandbox exists inside the guest. Defense-in-depth guest hardening is allowed, but it is not the basis for the host-security claim.

## Security boundary versus workspace boundary

The VM is the host-security boundary. Repository workspace isolation inside a shared profile is a bounded DevBridge execution/correctness boundary, not a claim that sibling workspaces remain secure from a fully compromised guest administrator/root.

Normal DevBridge execution must nevertheless prevent one repository from selecting, mutating, deleting, or silently adopting another repository's workspace through admitted operations. At minimum:

- each admitted repository/profile pair has a deterministic workspace identity;
- bridge input/work/output/scratch/cache locations are scoped beneath that workspace identity before reaching the physical VM;
- repository-controlled input cannot select another workspace identity;
- relative path escape, symlink/junction/reparse substitution, and cleanup-target confusion fail closed at DevBridge-managed boundaries;
- task/run process ownership, cancellation, temporary state, and results remain bound to the active workspace/task;
- workspace cleanup/reset/reseed, where exposed, targets exact owned workspace state and does not destroy unrelated workspaces.

If local policy requires separate hostile-guest trust domains between two repositories, they must be routed to separate execution profiles/VMs rather than treating path scoping as a hypervisor boundary.

## Terminology

- **trusted host** — the machine/OS context in which the DevBridge controller and VM-provider adapter hold local authority.
- **VM provider** — the host-specific virtualization backend: initially Hyper-V or KVM/QEMU+libvirt.
- **execution profile** — a stable provider-neutral description/identity for a materially distinct guest execution platform and its profile-level lifecycle/resource state.
- **profile environment** — the persistent VM owned by one execution profile on the selected provider.
- **repository workspace** — the isolated writable project state for one authoritative repository identity inside a compatible profile environment.
- **task state** — disposable process/temp/result/evidence state for one bounded execution attempt inside one workspace.
- **guest** — the VM OS and all software/state inside the profile environment; it is untrusted.
- **base image** — immutable/versioned OS+bootstrap/tooling disk identity from which profile environments are derived.
- **child/overlay disk** — the persistent profile-level writable system disk based on an immutable image.
- **bridge** — the narrow host-controlled command/file exchange used to operate a guest without exposing arbitrary host filesystem authority.
- **authoritative Git** — host-owned repository/worktree/ref state used for provenance, candidate sealing, reconciliation, and publication.
- **guest Git** — ordinary development Git state inside the guest; disposable/untrusted and never publication authority.

## Authority partition

### Host-owned authority

The trusted host owns:

- task/feedback/decision provenance and local authorization;
- stable repository identity and repository-to-profile/workspace routing policy;
- execution-profile identity and compatibility requirements;
- immutable base-image registry and compatibility policy;
- profile VM create/start/stop/reset/reseed/delete authority;
- workspace identity/admission and bridge destination derivation;
- GitHub API and Git transport credentials;
- coordination identity/private keys and lease/fence evaluation;
- authoritative repository clone/worktree/ref state;
- candidate import, validation identity, sealing, commit creation, push/publication, merge/release authority;
- human-decision authority and exact approval subjects;
- durable effect/recovery state;
- verification policy/evidence authority;
- runtime update/release/signing authority;
- daemon lifecycle/control state.

The guest may observe bounded non-secret inputs derived from these authorities, but it never owns or widens them.

### Profile-owned persistent but untrusted state

A profile environment may persist intentionally profile-level state such as:

- guest OS and bootstrap state;
- compatible SDKs, compilers, runtimes, drivers, and GPU runtime;
- safe shared content-addressed download caches;
- provider-neutral guest helpers that contain no host secret.

A global mutable install performed for one repository must not silently become an authority or correctness dependency for every repository. Shared state needs explicit profile-level ownership.

### Repository-workspace state

A repository workspace may persist:

- source working bytes supplied by the host;
- repository-local dependency state such as `node_modules`, Python virtual environments, build trees, generated output, and local configuration;
- repository-local caches when sharing would create correctness/trust coupling;
- test/browser artifacts;
- guest-local Git metadata and local branches/remotes that are not publication authority.

Persistence does not convert guest/workspace state into authority.

### Task state

A task owns bounded process-tree, temporary, input/output, cancellation, and evidence state. Task completion or cancellation must not delete the profile VM or unrelated workspace state.

## Threat model

The architecture must remain correct for the host-security claim if repository-controlled execution obtains administrator/root in the guest, replaces guest tools, tampers with guest Git, modifies guest startup/services, persists across reboots, controls every guest-local file, forges guest protocol responses, and uses normal network access.

Therefore confidentiality is achieved primarily by **not placing host secrets in the guest**, not by assuming guest egress filtering will contain a compromised process.

Hypervisor escape, host-kernel compromise, firmware compromise, or a defect in the selected hypervisor security boundary is outside DevBridge's software-only containment claim. Provider qualification must still use supported configurations and treat unsafe/unknown capability state as unavailable.

## Identity and persistence

Persistent VM identity is derived from stable execution-profile identity plus provider/image/environment generation, not repository identity or display name.

Repository workspace identity is derived from authoritative stable repository identity plus execution-profile identity through a provider-neutral contract. Repository display rename/transfer metadata may change without silently changing the underlying stable repository subject.

The durable profile environment identity binds at least:

- host provider attachment identity;
- execution-profile identity;
- base-image identity/version/generation;
- environment generation;
- child/overlay disk identity;
- lifecycle/recovery state;
- bridge generation/version where relevant.

A provider/image/profile compatibility change cannot silently reuse incompatible state.

Adding/removing a repository must not recreate a compatible profile VM. Stopping/restarting the profile VM preserves its persistent disk and intended repository workspace state. Reset/reseed of the entire profile is an explicit profile-level action; repository-workspace reset is a separate narrower operation when supported.

DB-009 observe/reconcile-before-repeat semantics apply to ambiguous VM lifecycle and bridge effects.

## Base images and writable layers

Base OS/tooling images are immutable and versioned. A profile environment must not mutate its parent/base image in place.

### Hyper-V

The storage model uses immutable base VHD/VHDX images and a profile-owned differencing disk where the required semantics are supported.

### KVM/QEMU/libvirt

The storage model uses immutable base images and a profile-owned qcow2 overlay/backing chain.

### Common rules

The controller validates the exact parent/backing relationship and fails closed on unexplained/incompatible lineage. Base-image updates create a new image identity; they do not silently rewrite the parent/backing image beneath persistent profile state.

Provider adapters manage provider-native disk/machine details without repository names or repository-specific branching.

## Guest networking

Repository guests normally have network connectivity. Development environments need package registries, SDK installers, documentation, source fetches, test endpoints, browser access, and coding-service traffic.

Because guest egress is normally available:

- any secret placed in the guest must be assumed exfiltratable;
- host GitHub, coordination, release/signing, daemon, and VM-management secrets must never be injected for convenience;
- network availability is not evidence of host authority;
- disabling guest networking may exist as an optional workload/policy mode but is not the normal security basis.

Private-source/authenticated-service workflows require explicit scoped mechanisms that preserve host-only authority. Copying a broad host credential into a persistent profile VM is not authorized by this specification.

## Narrow host↔guest bridge

DevBridge operates profile VMs through a narrow host-controlled bridge rather than arbitrary shared host directories.

The bridge supports bounded classes of exchange:

- start a locally admitted guest command/operation;
- pass bounded structured input/context;
- transfer bounded files/source snapshots into an admitted repository workspace;
- retrieve bounded result/evidence/candidate files from that workspace;
- observe exit, timeout/cancellation, and bounded output/liveness;
- identify the exact profile environment, workspace, operation, and run subject.

The bridge must not allow guest-controlled input to name arbitrary host paths, host executables, Git refs, credential locations, VM-management targets, profile identities, workspace identities, or control-state objects.

Provider transports are adapter details. Guest agents are untrusted under the threat model; host-side validation remains authoritative.

## Source, candidate, and Git model

Authoritative Git remains host-owned.

A normal workflow is:

1. host resolves trusted task/repository/baseline identity;
2. local policy resolves a compatible execution profile and deterministic workspace identity;
3. host prepares authoritative source state without giving the guest GitHub credentials;
4. source/input is synchronized into that repository workspace through the bridge;
5. repository-controlled commands/workers operate inside the workspace;
6. guest returns candidate bytes/results/evidence through bounded workspace-scoped bridge paths;
7. host validates the returned subject against expected source/baseline/run identity;
8. host imports accepted candidate bytes into authoritative Git state;
9. host performs required verification/evidence reconciliation, sealing, commit creation, and publication.

Guest Git may be useful for development tooling, but guest refs/remotes/index/config/hooks are untrusted data. A guest `git commit` or `git push` cannot satisfy DevBridge publication requirements.

## Execution routing

Repository-controlled execution classes use the VM boundary. This includes, as applicable:

- deterministic build/test/tool operations that execute repository-controlled code/config/plugins;
- proposal/coding-worker command execution;
- package-manager/dependency lifecycle execution;
- browser/integration tooling driven by repository content;
- generated/local-manifest tool wrappers whose execution class is repository-controlled;
- repository-specific compiler/build/test invocations;
- candidate-controlled validation where the candidate is untrusted executable code.

Pure control-plane parsing, cryptographic verification, GitHub API operations, authoritative Git operations, VM management, deterministic transformations proven not to execute repository-controlled code, and other trusted static adapters may remain on the host.

The classification/routing decision remains DevBridge-owned. Repository content cannot label itself `safe host`, choose arbitrary profile/workspace/provider identities, or turn provider absence into a direct-host fallback.

## Tooling and development environment behavior

Repository tools are installed/discovered inside compatible profile environments. Profile-level tools may be shared only when their ownership/compatibility is intentionally profile-wide. Repository-local dependency/build state remains workspace-local.

Host-side inventory remains useful for control-plane/provider/bootstrap prerequisites. Guest tool inventory is untrusted observation used for planning/verification, not authority to execute arbitrary host commands.

Core interfaces use neutral profile/workspace/tool concepts. Provider-specific identities stay inside provider adapters. Repository modules do not name concrete providers or neighboring module identities.

## Resource governance

VM resource policy belongs primarily to execution profiles.

Before provisioning/starting a profile VM, DevBridge must perform bounded host resource preflight appropriate to the provider. Memory shortage is a typed profile resource failure rather than a repository failure. Repository count must not be multiplied into VM RAM reservations.

Resource governance includes, where supported:

- profile memory/vCPU policy;
- host available memory/storage reserve;
- active profile/warm-pool limits;
- idle shutdown/suspend without losing persistent profile/workspace state;
- disk growth/retention;
- operation timeout/cancel;
- GPU/device exclusivity;
- task/process limits inside a profile.

## Setup/reconfiguration semantics

Setup follows discover-first/suggest-second/prompt-only-when-needed.

Repository selection and VM provisioning are separate decisions:

- `all` for repository selection means register/enable all selected repository workspaces;
- it does not mean create/start one VM per repository;
- setup reports repository/workspace count separately from execution-profile count;
- profiles are provisioned only when needed by selected repositories/tasks;
- resource implications belong to the profile provisioning decision;
- legacy repository-owned VMs are migration candidates, not automatically adopted as profile environments.

`doctor` remains diagnostic/read-only with respect to authority. It reports provider, image, profile-environment, workspace-route, bridge/tool, and resource readiness separately.

## Migration from repository-owned VM topology

The original Stage 3 implementation derived persistent VM ownership from an opaque `subject` supplied as repository identity. That implementation is historical evidence, not the target topology.

The neutral lifecycle LEGO remains reusable because `subject` was intentionally opaque. Current composition supplies a stable execution-profile subject instead. Repository identity terminates at a separate workspace-routing layer.

Existing repository-owned VM state is handled conservatively:

1. inventory exact old environment/repository/profile/tool/workspace state;
2. create/select a compatible profile environment;
3. create the repository's isolated workspace;
4. migrate only safe/useful repository-owned state;
5. rebuild profile-level system/tool state where safer than merging opaque VM disks;
6. verify workspace/tool/build readiness;
7. retain the old environment until replacement is proven or explicitly discarded;
8. retire only exact DevBridge-owned obsolete artifacts.

Multiple old writable VM disks must never be blindly merged into one shared profile disk.

## Verification and qualification

Configuration declarations do not prove isolation/readiness.

Qualification must include:

- fake-provider attachment through the same neutral studs;
- real Hyper-V and KVM/libvirt provider/image/lifecycle evidence on capable hardware;
- one compatible profile VM serving multiple distinct repository workspace routes;
- repository selection `all` not fanning out VM provisioning/start;
- stable profile identity independent of repository identity;
- stable workspace identity bound to repository+profile without provider leakage;
- workspace bridge-path escape/substitution/cleanup-target tests;
- process/task cancellation and result isolation across workspace routes;
- shared-cache ownership/boundary tests;
- profile restart preserving intended workspace state;
- adding/removing repositories without profile VM recreation;
- typed host resource preflight failures;
- reset/reseed recovery from contaminated profile state;
- absence of host credentials/arbitrary host mounts;
- forged/malformed guest-agent responses failing closed;
- no direct-host repository execution fallback;
- authoritative Git/publication remaining host-owned.

`doctor` reports repository execution ready only after provider + image + compatible profile environment + bridge/bootstrap/tool/workspace route requirements are observed ready.

## Non-goals

- No required AppContainer/Bubblewrap layer inside guests.
- No claim that sibling workspaces resist a fully compromised/root shared guest; separate profiles are required for separate hostile-guest trust domains.
- No default-deny guest networking requirement.
- No host publication/control credentials copied into guests.
- No arbitrary writable host directory shares.
- No parallel long-lived sandbox+VM repository-execution architecture.
- No direct-host repository execution fallback.
- No hypervisors beyond Hyper-V and KVM/QEMU/libvirt merely for abstraction symmetry.

## Acceptance

- [ ] Repository-controlled code executes only through admitted compatible profile VMs.
- [ ] Persistent VM identity is profile-owned and repository-independent.
- [ ] Multiple repositories can use one profile VM through distinct workspace identities.
- [ ] Repository count does not determine VM count or RAM reservation count.
- [ ] Workspace-scoped normal operations cannot select another repository's workspace through DevBridge.
- [ ] Provider adapters remain repository-agnostic.
- [ ] Host Git/credentials/publication/control authority remains outside guests.
- [ ] Provider/profile/resource unavailability fails closed with typed status and no host fallback.
- [ ] Legacy repository-owned environments have recoverable migration/retirement semantics.
- [ ] Real-provider qualification validates the claimed boundaries on Windows/Hyper-V and Linux/KVM/libvirt.
