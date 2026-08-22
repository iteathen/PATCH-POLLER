# VM migration and legacy-sandbox removal inventory

Status: active migration map for DB-020 / issues #107 and #138.

This document records both major execution-boundary migrations:

1. host repository-code sandboxes -> persistent VM-only execution;
2. repository-owned persistent VMs -> shared execution-profile VMs with isolated repository workspaces.

Historical implementation evidence remains useful, but the active target is defined by DB-020 and `docs/execution-profile-environments.md`.

## Governing rule

Repository-controlled code executes only inside an admitted compatible VM execution profile. There is no direct/uncontained host fallback.

Persistent VM ownership is now:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

Required initial host providers remain:

- Windows -> Hyper-V;
- Linux -> KVM/QEMU managed through libvirt.

Provider-specific disk, machine, network, and bridge mechanics stay behind provider adapters. Repository identity must not leak into provider internals merely because a repository is currently routed to that profile.

## Migration 1 — remove host repository-code sandbox execution

The VM program deliberately removed active host-sandbox repository execution before production VM implementation. The temporary no-provider interval was intentional:

- repository-controlled execution was unavailable and fail-closed;
- no direct/uncontained host fallback was permitted;
- trusted static/control-plane work could continue only when independently classified as not executing repository-controlled code;
- VM execution was restored later through the same provider-neutral LEGO studs.

This remains an architectural falsification test: generic controller/Git/recovery/verification behavior must remain structurally coherent when no production execution provider is registered.

Historical Bubblewrap/AppContainer/ProcessContainer code, PR discussion, handoffs, and tests are evidence only. They do not regain authority as fallback mechanisms.

## Migration 2 — correct persistent VM ownership

The first VM lifecycle implementation used repository identity as the opaque persistent-environment subject. That proved provider-native lifecycle, image lineage, recovery, reset/reseed, and bridge mechanics, but the ownership topology does not scale operationally.

The trigger for issue #138 was concrete setup behavior: selecting all discovered repositories caused another Hyper-V guest to request a 4096 MB reservation and fail with `0x800705AA`. The failure was not primarily a Hyper-V defect or a missing RAM check. Repository selection had been coupled to VM allocation.

The corrected composition keeps the useful neutral lifecycle LEGO while changing its owner:

- persistent environment `subject` becomes a stable execution-profile subject;
- one compatible profile environment may serve multiple repositories;
- each repository/profile pair receives a deterministic workspace identity;
- repository routes resolve to synthetic workspace targets;
- the routing adapter maps those targets to the physical profile environment before provider operations;
- bridge locations are scoped beneath the active workspace identity;
- providers continue to see only profile-level physical environment identity.

## What remains reusable from the original Stage 3 implementation

Retain/refactor as generic LEGO structure:

- provider-neutral persistent environment lifecycle;
- immutable base-image identity and active-source protection;
- Hyper-V differencing disk lineage checks;
- libvirt/qcow2 backing-chain lineage checks;
- exact provider-owned VM/domain identity verification;
- durable lifecycle effects and observe/reconcile-before-repeat behavior;
- reset/reseed mechanics at the profile-environment level;
- file replacement/path ownership defenses;
- provider-neutral bridge and result contracts;
- authoritative host Git/publication ownership.

The original Stage 3 document is preserved as historical implementation evidence and explicitly marked superseded only with respect to repository-owned VM identity/topology.

## New state ownership model

### Execution-profile state

Owned by the profile VM:

- guest OS/profile identity;
- provider attachment and lifecycle;
- system/writable profile disk;
- profile-level bootstrap/tool/runtime state;
- intentionally shared SDK/compiler/driver state;
- safe shared download caches;
- profile-level memory/vCPU/storage/device policy.

### Repository-workspace state

Owned by one repository workspace inside a profile:

- source bytes supplied by the host;
- repository-local dependency environments;
- build trees/generated output;
- repository-local config/temp/cache state when sharing would create coupling;
- workspace cleanup/reset/reseed state when supported.

### Task state

Owned by one execution attempt:

- process/task identity;
- cancellation/timeout state;
- bounded input/output/evidence;
- temporary files and task environment overlay.

Task completion must not delete the profile environment or unrelated repository workspace state.

## Workspace boundary

The VM remains the host-security boundary. Workspace isolation is the normal DevBridge operation/correctness boundary inside a shared profile, not a claim that sibling workspaces survive a fully compromised/root guest.

Normal admitted operations must nevertheless prevent repository A from selecting repository B's workspace through DevBridge. Qualification covers:

- deterministic workspace identity;
- bridge input/work/output/scratch/cache prefixing;
- relative-path escape and link/reparse substitution;
- exact cleanup targeting;
- task/process ownership and cancellation;
- result/evidence separation;
- shared-cache ownership rules.

When separate hostile-guest trust domains are required, local policy uses separate profiles/VMs.

## Profile routing and compatibility

Repositories declare or derive neutral compatibility requirements rather than owning environments.

Examples:

- OS family;
- GPU/CUDA requirement;
- architecture;
- kernel/driver/toolchain constraints;
- explicit local profile preference.

Adding another repository to a compatible profile must not recreate the profile VM. A materially different requirement may select/provision another profile, for example `linux+cuda`, without changing internal logic of repositories already routed elsewhere.

If no compatible ready profile exists, execution fails/degrades or setup offers explicit profile provisioning. It never falls back to repository-specific VM creation as an implicit compatibility path.

## Resource migration

Repository count no longer determines VM resource allocation count.

Profile creation/start performs resource preflight once for the physical profile environment. The current implementation preflights requested guest memory plus a bounded host reserve and raises a typed `PROFILE_RESOURCES_UNAVAILABLE` failure before provider allocation.

Future resource governance may add storage growth, vCPU policy, active-profile limits, idle shutdown/suspend, GPU/device exclusivity, and task-level quotas, but those remain profile/task concerns rather than multiplying a fixed VM reservation by repository count.

## Existing repository-owned environments

Existing repository-owned VMs are migration candidates, not automatically trusted profile environments.

The migration must be recoverable:

1. inventory exact old environment identity, repository identity, provider/profile, image lineage, tool state, and readiness;
2. create/select the compatible profile environment;
3. create the deterministic repository workspace;
4. migrate only safe/useful repository-owned state;
5. rebuild profile-level system/tool state when safer than copying opaque machine state;
6. verify workspace/tool/build readiness;
7. retain old environment until replacement is proven or explicitly discarded;
8. retire only exact DevBridge-owned obsolete artifacts.

Do not merge several old writable VM disks into one shared profile disk.

The current setup path deliberately recognizes old repository-owned environments as migration candidates and does not silently count them as ready profile environments.

## Provider-specific primitives retained

### Hyper-V

Relevant primitives remain:

- immutable VHD/VHDX base images;
- differencing VHD/VHDX writable profile disks;
- Hyper-V VM lifecycle/networking APIs;
- provider-specific integration/bridge transports;
- exact VM identity/ownership checks.

### KVM/QEMU/libvirt

Relevant primitives remain:

- KVM acceleration;
- libvirt system-provider management;
- immutable base images plus qcow2 overlays/backing chains;
- libvirt domain/storage/network lifecycle;
- virtio/QGA/vsock-capable bridge transports as selected by provider adapters.

Guest agents are untrusted under DB-020; they are transports, not authority sources.

## Host-owned authority retained throughout both migrations

The following remains host/control-plane authority and must not migrate into guests/workspaces:

- GitHub credentials;
- authoritative repository identity/baseline resolution;
- authoritative Git worktrees/refs;
- candidate import/sealing/publication;
- coordination keys/leases/fencing;
- release/signing/update authority;
- human decision authority;
- durable recovery/effect journals;
- profile VM management authority;
- verification/evidence authority.

Guest/local Git may exist for tooling, but it is untrusted and not publication authority.

## Setup migration

The old prompt model exposed repositories as VM selections. That vocabulary encouraged `all` to mean "create/start all repository VMs."

The corrected setup model separates:

1. execution-profile discovery/provisioning;
2. repository discovery/approval;
3. repository-to-profile workspace routing;
4. execution enablement.

`all` in repository selection means all eligible repository workspaces. The compatibility CLI flags `--environment`, `--all-environments`, and `--no-environments` may remain temporarily, but their semantics are workspace selection, not repository-owned VM lifecycle.

Setup reports profile count/resources separately from repository/workspace count.

## Uninstall and cleanup migration

Physical profile environments are manifest-owned once per profile VM. Adding repositories must not add duplicate environment-manifest entries.

Workspace cleanup/removal must not remove unrelated workspaces or the whole profile unless an explicit profile-level destructive action is authorized.

Uninstall preserves operator-owned virtualization infrastructure and removes only exact DevBridge-owned/reverified objects.

Legacy repository-owned VM retirement is explicit migration cleanup, not an automatic side effect of discovering the new topology.

## Sandbox-era configuration

Host-sandbox-era keys such as `workspace.externalReadRoots`, `execution.allowUncontainedTools`, and sandbox-specific profile fields must never regain repository-code host execution authority.

They may remain temporarily recognized only for migration/deprecation/error reporting. Final cleanup belongs to the VM-program cleanup stage after the active VM/profile topology is qualified.

## CI and qualification migration

Cheap architectural evidence includes:

1. no-provider/direct-host fallback denial;
2. fake-provider attachment;
3. profile identity independent of repository identity;
4. two repository workspace routes mapping to one physical profile environment;
5. workspace path scoping and route-selection denial;
6. typed profile resource preflight;
7. setup `all` not multiplying environment records.

Real-provider qualification additionally covers:

- Hyper-V and KVM/libvirt lifecycle/image/bridge evidence;
- profile restart persistence;
- multi-repository workspace operation in one profile;
- adversarial workspace escape/path substitution/cleanup targeting;
- process/task isolation and shared-cache boundaries;
- reset/reseed recovery;
- credential/host-path absence;
- provider/resource failure remaining fail-closed.

Hosted CI may not expose nested virtualization; real boundary evidence may require dedicated provider-capable runners.

## Documentation precedence

Active target documents are:

- `specs/DB-020-vm-execution-boundary.md`;
- `docs/execution-profile-environments.md`;
- `docs/architecture.md` and `docs/roadmap.md` where consistent with DB-020;
- current setup/qualification issues including #103, #107, #115, #116, and #138.

Historical Stage 3/sandbox handoffs, tests, PRs, and Git history are retained as engineering evidence but are non-normative where they conflict with the execution-profile ownership correction.

## Current migration sanity check

The corrected topology remains consistent with project principles:

- **LEGO/SOLID:** the persistent lifecycle's opaque `subject` contract survives; composition changes without provider rewrites;
- **security:** the VM remains the host boundary and no host fallback is introduced;
- **KISS:** VM count follows materially distinct execution platforms rather than repository count;
- **correctness:** workspace identity and bridge paths are explicit and repository-local;
- **recoverability:** old repository-owned VMs remain migration candidates until replacement is proven;
- **resource governance:** RAM/storage/device decisions belong to profile environments;
- **provider parity:** Hyper-V and KVM/libvirt continue to attach behind the same neutral lifecycle/execution studs;
- **setup UX:** repository selection cannot silently become fleet-scale VM allocation.
