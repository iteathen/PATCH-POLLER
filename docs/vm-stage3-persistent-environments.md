# VM Stage 3 — persistent environment lifecycle

Status: historical Stage 3 implementation contract; repository-owned VM identity is superseded by the execution-profile correction in `docs/execution-profile-environments.md` and issue #138.

Stage 3 remains implementation evidence for provider-native persistent lifecycle, lineage, reset/reseed, and recovery mechanics. Its original use of repository identity as the persistent VM owner is no longer the target architecture. Future work must preserve the neutral provider/lifecycle mechanics where useful while moving VM ownership to execution profiles and repository persistence to isolated workspaces inside compatible profile VMs.

This stage adds persistent, resettable guest-machine state on top of the Stage 2 provider/image foundation while repository-controlled task execution remains intentionally unavailable until Stage 6.

## Boundary

Stage 3 is split into replaceable LEGO modules:

- `src/runtime/persistent-environments.js` owns provider-neutral identity, lineage, lifecycle state, effect recovery, and reset/reseed semantics.
- `src/runtime/providers/hyperv-persistent-environment.js` owns only the Windows host attachment and its writable-disk/machine mechanics.
- `src/runtime/providers/libvirt-persistent-environment.js` owns only the Linux host attachment and its writable-disk/domain mechanics.
- `src/app/environment-foundation.js` is the composition root. It is the only Stage 3 code that selects a concrete attachment and bridges verified base-image location data into that attachment.
- `src/runtime/environment-foundation.js` exposes the neutral lifecycle operations and protects active backing identities from image collection.

The generic lifecycle module does not import or name a concrete attachment, repository execution, worker transport, or legacy host sandbox. Provider adapters do not import the lifecycle registry or one another.

## Neutral lifecycle stud

Creation accepts only local contract data:

- `subject` — opaque immutable owner identity supplied by a future caller;
- `profile` — guest profile identity;
- `sourceIdentity` — exact immutable backing identity;
- `settings` — bounded local machine settings (`memoryBytes`, `processorCount`, `firmware`).

Display names, repository slugs, upstream controller names, and downstream provider identities are not accepted. The current topology can therefore be replaced without changing lifecycle logic.

The provider-facing source stud is narrower still. It receives only exact source identity/revision/digest plus an opaque handle whose concrete interpretation belongs to the selected adapter. Guest-profile identity is not leaked into provider logic.

## Identity and lineage

A stable slot is derived from:

1. the selected attachment's opaque binding identity;
2. the immutable `subject`;
3. the guest `profile`.

The exact environment identity additionally binds the environment generation and exact source identity. Display-name changes therefore do not change identity, while provider/profile/source-generation changes cannot be silently adopted.

The registry persists:

- current exact environment identity and generation;
- source identity/profile/revision/digest;
- local machine settings;
- attachment binding identity;
- superseded generation history;
- durable lifecycle effect records.

Each provider keeps its own private ownership/lineage record containing only provider-local details needed to prove its machine and writable layer.

## Writable state

### Hyper-V attachment

The Windows adapter creates one derived writable VHD/VHDX with `New-VHD -ParentPath ... -Differencing` and verifies the exact parent through `Test-VHD`/`Get-VHD`.

It creates one owned VM whose name, ownership marker, configuration location, disk location, and recorded Hyper-V VM identity are derived or captured locally. Automatic checkpoints are disabled so hidden AVHDX/checkpoint chains cannot silently change the one-parent lineage. VM start/stop/remove operations re-check provider identity and ownership before mutation.

A crash after `New-VM` but before ownership metadata is written is recoverable only when the partial VM has no foreign marker and is already attached to the exact pre-recorded writable disk. A differently owned object is never adopted.

### libvirt attachment

The Linux adapter creates one qcow2 overlay with an explicit backing format and backing file:

`qemu-img create -f qcow2 -F qcow2 -b <source> <writable>`

Observation uses `qemu-img info --backing-chain` and requires exactly one qcow2 parent with the canonical expected backing identity. No rebase/commit path is exposed.

One libvirt domain is defined with a deterministic UUID, local ownership metadata, the exact overlay, and an explicit backing-store declaration. Start/stop/remove operations verify UUID, marker, disk attachment, and overlay lineage before mutation.

Stage 3 does not attach guest networking or arbitrary host shares. Those are separate later-stage concerns.

## File replacement defenses

Provider-local state records filesystem identity for both immutable backing media and writable media. Writable identity uses device, file identifier/inode, and creation/birth identity so normal guest writes do not invalidate the child while delete-and-replace substitution does.

Cleanup is fail-closed:

- paths are derived under provider-owned object roots;
- source paths must resolve beneath the admitted image root;
- symlink/file-shape changes are rejected;
- a substituted or reparented writable layer is not deleted;
- a foreign machine/domain is not removed merely because its display name collides.

The backing image library remains authoritative for immutable-byte digest verification. Stage 3 adds active-source protection to image collection without changing Stage 2 retirement semantics.

## Reset and reseed

`reset` creates a fresh environment generation from the same exact source.

`reseed` creates a fresh generation from a caller-selected exact source identity.

Both follow the same order:

1. durably plan the rotation;
2. prove and stop the current owned generation (bounded graceful stop with forced termination allowed for explicit discard);
3. create/observe the replacement generation without modifying the old backing relationship;
4. durably switch the current generation only after the replacement is owned and compatible;
5. remove only the exact superseded owned generation;
6. reconcile the operation.

The old generation is never deleted first. Source drift during ordinary `ensure` is rejected with an explicit-reseed requirement; dirty writable state is never silently reparented to a newer base image.

## Recovery and concurrency

Lifecycle effects are persisted before provider mutation and reconciled by observation:

- `planned` records intent;
- already-complete exact effects are accepted after observation rather than repeated;
- incomplete provider-local effects are resumed idempotently by the owning adapter;
- rotations persist an intermediate `switched` state so a crash after authority moves to the replacement only needs old-generation cleanup;
- deletion treats already-absent exact owned state as reconciled;
- attachment-binding drift fences pending replay.

Mutations are serialized inside the lifecycle LEGO. Production cross-process ownership remains governed by the existing DevBridge daemon/singleton state-root authority; Stage 3 does not create a second competing lock protocol.

## Stage boundaries preserved

Stage 3 does **not**:

- restore repository-controlled execution;
- import or revive Bubblewrap/AppContainer/host-sandbox execution;
- add host↔guest command transport (Stage 4);
- add normal guest networking/bootstrap/tooling (Stage 5);
- move Git, publication, credentials, or repository authority into the guest;
- introduce a generic provider abstraction that exposes provider-specific raw fields.

`src/runtime/repository-execution.js` remains unchanged and fail-closed for normal repository task execution.

## Verification

Focused tests cover:

- opaque stable identity and rejection of display/topology-shaped request fields;
- explicit source-drift rejection, reset, reseed, stale-generation fencing, and concurrent mutation serialization;
- daemon-style restart reconciliation after ambiguous provisioning and interrupted reseed;
- exact source preservation across lifecycle transitions;
- attachment-binding drift rejection;
- Hyper-V differencing-disk command shape, checkpoint suppression, partial-creation recovery, provider identity, immutable backing preservation, path admission, independent stud validation, and writable substitution refusal;
- libvirt explicit `-F qcow2 -b` creation, two-level backing-chain verification, owned UUID/metadata/domain XML, immutable backing preservation, path admission, independent stud validation, and writable substitution refusal;
- Stage 2 foundation status/retirement behavior remaining additive;
- active backing identities being protected from collection;
- static LEGO-boundary checks proving generic Stage 3 code does not name concrete attachments, neighboring execution modules, or legacy host sandboxes.

Real Hyper-V and KVM/libvirt qualification remains Stage 7 as defined by DB-020; Stage 3 tests exercise the lifecycle contracts and provider command construction without claiming nested-virtualization qualification in generic CI.
