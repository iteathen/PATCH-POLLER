# Reconstructable environment lifecycle

Issue #170 establishes the source-of-truth contract used by the lifecycle program in #169.

## LEGO boundary

The lifecycle core owns only neutral local concepts:

- a stable logical environment identity;
- a versioned desired declaration;
- a bounded neutral observation of the current materialization;
- reconstructability classification;
- a restartable lifecycle journal.

It does **not** own virtualization implementation names, storage paths, command lines, network object names, guest filesystem paths, repository implementation objects, or transport/source mechanics. Those details terminate at their owning adapters. Composition temporarily wires lifecycle contracts to those adapters.

## Durable authority

A declaration binds the locally approved execution profile to:

- guest family and generation;
- immutable image identity and generation;
- resource requirements;
- a neutral boot requirement;
- a neutral network requirement;
- bootstrap/tooling generation and requirements;
- a neutral enrollment/trust requirement;
- neutral workspace identities plus opaque host-authority identities used for reseeding;
- protected state classes, if any.

Boot and enrollment are explicit declaration authority rather than provisioning defaults. Construction adapters may map those requirement identities onto their local mechanisms, but the declaration does not name provider firmware objects, credentials, key files, or guest paths.

The logical environment identity is derived from the approved profile and does not change when image, resources, guest materialization, or implementation generation changes. Declaration replacement is compare-and-swap revisioned so stale setup/recovery work cannot silently overwrite newer local authority.

The local image location is deliberately absent from the declaration. #178 owns availability of the exact semantic image identity when a local cache is missing or corrupt.

## Observed state

Observation is evidence, not authority. It separately reports:

- materialization never-created, present, missing, unavailable, or ambiguous;
- system storage unknown, absent, present, or invalid;
- attachment readiness;
- enrollment state;
- bootstrap/tooling state;
- guest health;
- incomplete or ambiguous transition state;
- the declaration revision used as the observation basis;
- the current implementation generation when one is actually observed.

The declaration revision makes stale observations explicit rather than allowing old evidence to authorize a new declaration. This allows later diagnosis to distinguish a missing implementation from missing system storage, invalid storage, stale enrollment, bootstrap degradation, provider unobservability, and interrupted lifecycle work without importing implementation-specific detail into the lifecycle core.

## Mutable-state taxonomy

Lifecycle planning uses five neutral classes:

1. `authority` — host-owned configuration needed for reconstruction;
2. `materialization` — replaceable current implementation state;
3. `reseedable` — source that can be restored from host authority;
4. `disposable` — rebuildable caches, dependencies, generated outputs, and scratch;
5. `protected` — explicitly registered state that another bounded owner must handle before destructive lifecycle work.

A guest system disk is never treated as the sole authority needed to reconstruct an environment.

## Journal

Every mutation advances contiguously through:

`intent -> pre-observation -> fenced-attempt -> post-observation -> verification -> cleanup-reconciliation -> terminal`

The journal records only neutral identities, bounded subject identities, neutral observations, implementation generations, fence identity, outcome, and time. It stores no raw command output, provider paths, credentials, or arbitrary diagnostic text.

An interrupted nonterminal record remains visible as active state. Later construction/recovery code must observe and reconcile that exact stage rather than blindly replaying an external effect.

## Reconstructability

The core exposes four explicit states:

- `fully-reconstructable`;
- `reconstructable-after-local-discovery`;
- `setup-reentry-required`;
- `ambiguous-or-unowned`.

The classifier never promotes unverified or ambiguous ownership into destructive authority. Legacy/incomplete state requiring additional decisions remains outside mutation until setup/re-entry supplies the missing local authority.

## Next slices

- #178 consumes the semantic image identity and makes the exact image available locally without turning a local cache path into authority.
- #171 consumes a complete declaration plus exact-image availability and implements the shared restartable construction pipeline and `create`.
- #172 classifies degradation into supported lifecycle actions.
- #173 reuses the same construction stages for missing/invalid system-storage `rebuild`.
