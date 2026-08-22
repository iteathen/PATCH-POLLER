# DevBridge architecture

## Purpose

DevBridge is a trusted local control plane that turns remote development requests into bounded local work without giving remote content direct machine authority.

DB-020 defines the repository-execution security boundary. `docs/execution-profile-environments.md` defines the persistent VM ownership topology.

The active rule is:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

Persistent VM count therefore follows materially distinct execution platforms, not repository count.

## Required host providers

The initial provider set is first-class on both host families:

- Windows host -> Hyper-V;
- Linux host -> KVM/QEMU managed through libvirt.

Provider-specific commands, disk formats, VM/domain identities, networking, and bridge transports stay inside provider adapters. Generic control-plane modules operate on neutral profile/environment/workspace contracts.

## Authority hierarchy

DevBridge owns authoritative:

- task/feedback/decision provenance;
- local capability policy;
- stable repository identity and authorized baselines;
- repository-to-profile/workspace routing policy;
- execution-profile identity and provider/image lifecycle;
- host↔guest bridge admission;
- GitHub credentials and API mutation authority;
- coordination identity, leases, and fencing;
- authoritative Git/candidate/publication state;
- verification planning/evidence;
- checkpoints/hard-gate subjects;
- durable run/effect/recovery state;
- runtime release/activation/rollback state;
- daemon lifecycle/control state.

Remote controllers, coding models, repository content, dependencies, guest tools, tests, guest Git, and process output are inputs/proposals. They do not own control-plane truth.

## Trust domains

### Trusted host

The host contains:

- DevBridge controller and local policy;
- GitHub/Git transport credentials;
- coordination private keys;
- release/signing authority;
- authoritative Git administration/publication refs;
- daemon/control/recovery state;
- VM-provider management authority;
- immutable base-image registry;
- profile/workspace routing authority.

Host code may execute fixed/static control operations only when they cannot be redirected into repository-controlled code.

Provider/profile absence never broadens the set of host-safe operations.

### Untrusted execution-profile VM

A profile VM is persistent untrusted guest state for one materially distinct execution platform.

Assume guest administrator/root compromise. The guest may control every guest-local process/file/service, package/tool installation, build/test output, coding worker, guest Git repository, and guest-side bridge helper. It normally has network access.

The host therefore exposes no host secrets or authoritative writable control state to the VM.

Compromise of a profile VM may compromise guest/workspace data in that profile, but it must not grant host GitHub/publication/coordination/release/daemon/provider-management authority.

### Repository workspace

Each admitted repository/profile pair has a deterministic workspace identity inside the selected profile VM.

Normal DevBridge operations scope repository-controlled `input`, `work`, `output`, `scratch`, and `cache` paths beneath that workspace identity before reaching the physical VM.

Repository content cannot choose another workspace target through the normal routing contract.

This is a DevBridge operation/correctness boundary, not a second hypervisor boundary. A fully compromised/root shared guest may compromise sibling workspace state. Repositories requiring separate hostile-guest trust domains must use separate execution profiles/VMs.

### Task state

Each run owns bounded process-tree, temporary, input/output, cancellation, and evidence state within one workspace. Task completion/cancellation does not delete profile/workspace persistence.

## Provider model

Controller logic depends on provider-neutral image/lifecycle/environment/bridge contracts.

### Windows / Hyper-V

The Hyper-V adapter owns:

- observed Hyper-V capability/management readiness;
- profile VM identity/configuration;
- immutable VHD/VHDX base-image inventory;
- profile-owned differencing-disk lineage;
- provider networking;
- provider-specific lifecycle/recovery;
- selected Hyper-V bridge transport(s).

It does not need repository names.

### Linux / KVM-QEMU-libvirt

The libvirt/QEMU adapter owns:

- observed KVM acceleration/provider readiness;
- profile domain identity/configuration;
- immutable base-image inventory;
- profile-owned qcow2 backing/overlay lineage;
- libvirt/QEMU networking/storage ownership;
- provider-specific lifecycle/recovery;
- selected bridge transport(s).

It does not need repository names.

Presence of `/dev/kvm`, `virsh`, QEMU, Hyper-V, or a VM/domain name alone is not readiness evidence.

## Execution-profile routing

Repository identity terminates at the workspace-routing layer.

The current profile-routing composition uses:

- stable execution-profile subject derived from profile identity;
- deterministic workspace identity derived from stable repository subject + profile;
- deterministic synthetic workspace target used by repository execution;
- mapping from workspace target -> one physical profile environment;
- shared profile access configuration validated for consistency;
- workspace-scoped bridge paths before the physical channel is invoked.

The existing persistent-environment lifecycle remains reusable because its `subject` contract was opaque. Composition changed the meaning of that subject from repository ownership to execution-profile ownership without teaching Hyper-V/libvirt about repositories.

## Control-plane flow

The primary path is conceptually:

`TaskSource -> ProvenanceGate -> RunCoordinator -> LeaseGate -> Host Repository/Baseline -> Profile Router -> Repository Workspace -> VM Bridge -> Verification/Import -> DecisionGate -> Host Seal/Publish -> Reconciler`

Detailed flow:

1. DevBridge obtains a typed task from a configured queue/source.
2. Provenance is verified against exact trusted actor/revision identity.
3. Local policy resolves repository, semantic baseline, requested capabilities, and compatible execution profile.
4. A deterministic repository workspace identity is resolved inside that profile.
5. Coordination lease/fence state is acquired/revalidated when enabled.
6. Host prepares authoritative source/baseline state.
7. DevBridge verifies provider/base-image/profile-environment/bridge/workspace-route readiness.
8. Source/context/files cross the bridge through workspace-scoped logical locations.
9. Repository-controlled operations or optional coding workers execute inside the guest workspace.
10. Results/candidate files return as untrusted data through workspace-scoped bridge paths.
11. Host validates run/repository/baseline/source/candidate identities and imports only permitted bytes into authoritative Git state.
12. Verification policy selects/reuses required evidence; human gates apply only where required.
13. Host seals the exact candidate.
14. Before publication, lease/gate/verification/baseline/remote predecessor state is rechecked.
15. Host Git/GitHub adapters perform authorized effects with explicit expected state.
16. Ambiguous external effects are observed/reconciled before retry.

No stage of this flow redirects repository-controlled work to direct host execution when a profile is unavailable.

## Persistent storage model

Base OS/tooling images are immutable/versioned. Profile writable state is provider-native copy-on-write where supported.

Conceptually:

```text
base-images/
  <provider>/<profile>/<image-generation>/<immutable-base>

profile-environments/
  <profile-id>/<provider>/<environment-generation>/
    <provider-native-writable-layer>
    lifecycle-state
    bridge-state

repository-workspaces/  # logical guest topology
  <profile-id>/<repository-stable-id>/
    source/
    dependencies/
    build/
    temp/
```

Exact host/guest paths are implementation details and must not become externally selectable authority.

Hyper-V uses differencing VHD/VHDX semantics. KVM/QEMU uses qcow2 backing/overlay semantics. Parent/backing identity is revalidated rather than inferred from filenames.

Stopping a profile VM does not delete its disk or workspace state. Adding/removing a repository does not recreate the profile VM.

Profile reset/reseed is an explicit destructive operation affecting the whole profile environment. Workspace reset/reseed, when supported, is a narrower operation and must not destroy sibling workspaces.

## Shared versus workspace-local tooling

Share only intentionally profile-level state:

- compatible OS runtimes/SDKs;
- compilers;
- GPU drivers/runtime;
- safe immutable/read-mostly tooling;
- content-addressed download caches with safe ownership semantics.

Keep project semantics workspace-local:

- `node_modules` and package hooks;
- Python virtual environments;
- build trees;
- generated source/output;
- repository-specific configuration;
- mutable project caches when sharing would couple correctness/trust.

A global install performed for one repository must not silently become every repository's dependency or mutation surface.

## Narrow host↔guest bridge

The bridge is the only normal command/file crossing between host control plane and profile guest.

It supports bounded:

- command/operation invocation;
- structured context/input;
- source/file transfer into one workspace;
- result/evidence/candidate retrieval from that workspace;
- timeout/cancellation/liveness observation;
- exact profile/workspace/run/operation identity.

Guest-controlled messages cannot name arbitrary host paths, host executables, Git refs, credentials, provider-management targets, profile identities, workspace identities, or control-state objects.

Guest agents are untrusted. Host validation determines truth.

## Git and source/candidate model

Authoritative Git remains host-owned.

Guest Git is ordinary untrusted development state. The profile VM receives no publication credential and no writable authoritative host `.git` mount.

Source synchronization is host -> workspace. Candidate synchronization is workspace -> host. Host publication uses exact candidate/baseline identity and expected remote predecessor state.

A guest commit SHA is never publication authority by itself.

## Networking and secrets

Guests normally have network access so package managers, SDK installers, docs/source fetches, browser tests, coding services, and development tools work naturally.

The confidentiality rule is therefore: **do not put host secrets in the guest**.

Host-only state includes:

- GitHub tokens/CLI credentials;
- host SSH agent/keys;
- coordination keys;
- release/signing authority;
- daemon-control state;
- authoritative Git/publication state;
- Hyper-V/libvirt management authority;
- operator-home secrets.

Private dependency/coding-service workflows require explicit scoped designs rather than copying broad credentials into persistent profile VMs.

## Deterministic operations and tools

Controller plans remain data, not command authority.

- static/control operations may run on host only when provably not repository-controlled;
- repository-controlled operations execute only inside the routed workspace/profile VM;
- unknown operations default to repository-controlled.

Controllers provide bounded schema parameters, not raw shell/host argv/paths/provider targets.

Host tool inventory covers control-plane/provider prerequisites. Repository-class tools are discovered/used inside profile guests and remain untrusted observations.

## Verification/evidence

Passing evidence binds relevant identities such as:

- exact candidate/baseline;
- test/policy;
- host provider;
- base image;
- execution profile/environment generation;
- repository workspace identity;
- writable-layer lineage;
- bridge version;
- guest toolchain/config.

Issue #138 adds qualification that specifically proves:

- two/more repositories can route to one physical profile VM;
- selecting `all` repositories does not fan out VM provisioning;
- profile identity is repository-independent;
- workspace IDs/paths remain distinct;
- workspace escape/substitution/cleanup targeting fails closed at the claimed boundary;
- profile resource shortage is typed/preflighted;
- old repository-owned VM state is not silently adopted as the new profile.

Real Hyper-V/libvirt boundary qualification remains required on capable hardware; hosted CI mocks/unit tests do not substitute for that evidence.

## Resource governance

Resource policy belongs primarily to profiles.

Before provisioning a profile VM, DevBridge preflights requested memory plus a bounded host reserve. Insufficient memory reports a typed `PROFILE_RESOURCES_UNAVAILABLE` failure before provider allocation.

Repository count does not multiply VM RAM reservations.

Future/qualified resource governance may include:

- memory/vCPU limits;
- storage growth/retention;
- active profile/warm-pool policy;
- idle shutdown/suspend;
- GPU/device exclusivity;
- task/process quotas.

## Setup/reconfiguration

Setup separates:

1. provider/image/profile discovery;
2. repository discovery/approval;
3. repository workspace routing;
4. execution enablement.

`all` means all eligible repository workspaces. It never means one VM per repository.

Legacy repository-owned VMs are migration candidates. They are not silently counted as profile environments.

See `docs/setup.md` for operator behavior.

## Recovery

The universal rule remains:

> Persist intent/evidence, observe exact current state, reconcile ambiguity, then repeat only what remains necessary.

Durable VM/profile/workspace objects include:

- base images;
- profile VHDX/qcow2 writable layers;
- profile environment records;
- workspace routes/identity;
- bridge operations/transfers;
- source/candidate import subjects.

A failed guest command is not permission to delete persistent profile/workspace state. Deletion/reset/reseed requires exact ownership proof.

## Migration history

The VM program first removed host sandboxes and restored VM-only execution. The original Stage 3 implementation then bound persistent VM identity to repository identity.

Issue #138 corrects only that ownership topology while preserving neutral lifecycle/provider/bridge/security mechanisms.

Historical Stage 3 documentation and old repository-owned VMs remain migration evidence. Active architecture is profile-owned.

See `docs/vm-migration.md` for the combined migration map.

## Documentation authority

The live target is defined by:

- `specs/DB-020-vm-execution-boundary.md`;
- `docs/execution-profile-environments.md`;
- this architecture document;
- `docs/setup.md`;
- `docs/vm-migration.md`;
- active VM/setup/qualification issues including #103, #107, #115, #116, and #138.

Historical handoffs, testing audits, superseded Stage 3 ownership language, and old sandbox PRs remain evidence but do not override newer active contracts.
