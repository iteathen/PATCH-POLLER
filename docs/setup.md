# DevBridge setup

DevBridge is installed from one standalone stage-0 launcher and keeps its managed runtime current through the secure supervisor.

## Current execution architecture

DB-020 and `docs/execution-profile-environments.md` define the active repository-execution topology:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

Repository selection and VM provisioning are therefore separate concerns. Discovering or selecting ten repositories does not imply ten VMs. If those repositories all use the same compatible profile, setup provisions or reuses one profile VM and registers ten workspace routes inside it.

The required initial host providers remain:

- **Windows:** Hyper-V;
- **Linux:** KVM/QEMU managed through libvirt.

Provider/image readiness is distinct from profile-environment readiness, and profile readiness is distinct from repository-workspace routing readiness. DevBridge never infers repository execution readiness merely because Hyper-V, `/dev/kvm`, `virsh`, a VM/domain name, or a repository route exists.

Repository-controlled and candidate-controlled execution remains fail-closed when a compatible profile environment is unavailable. There is no direct/uncontained host fallback.

## Fast-track integration branch

The `codex/temp-fast-functional` integration line originally created one persistent Ubuntu Hyper-V VM per admitted repository. Issue #138 corrects that topology.

On the corrected branch:

- the `linux-development` execution profile owns one persistent VM;
- each admitted repository receives a deterministic workspace identity inside that VM;
- normal bridge `input`, `work`, `output`, `scratch`, and `cache` locations are scoped beneath that workspace identity;
- selecting `all` repositories adds workspace routes but does not fan out VM creation/start;
- legacy repository-owned VMs remain migration candidates and are not silently adopted as the shared profile VM;
- provider allocation performs profile-level resource preflight before VM provisioning.

The fast branch still contains temporary integration shortcuts such as Hyper-V `Default Switch` use and probe-oriented guest enrollment. Those are not the production Stage-8 contract. The temporary direct-host implementation remains disabled and must not become a fallback.

## Current requirements

The managed runtime requires:

- Node.js 22.16.0 or newer;
- Git;
- a GitHub account with access to configured task queues and target repositories.

When VM execution is expected:

- Windows requires usable Hyper-V plus DevBridge management authority;
- Linux requires usable KVM acceleration plus QEMU/libvirt access, normally through a locally authorized `qemu:///system` provider.

## Fresh install

### Linux

```sh
mkdir -p "$HOME/.devbridge/bin" && curl -fsSL https://raw.githubusercontent.com/iteathen/DevBridge/codex/temp-fast-functional/devbridge.mjs -o "$HOME/.devbridge/bin/devbridge.mjs" && node "$HOME/.devbridge/bin/devbridge.mjs"
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\bin" | Out-Null; Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/codex/temp-fast-functional/devbridge.mjs" -OutFile "$HOME\.devbridge\bin\devbridge.mjs"; node "$HOME\.devbridge\bin\devbridge.mjs"
```

The launcher uses Node.js built-ins and local Git to establish/verify the managed runtime. Fresh setup discovers authenticated repositories before asking the operator to type identities that are already knowable.

Useful commands include:

```text
node ~/.devbridge/bin/devbridge.mjs setup
node ~/.devbridge/bin/devbridge.mjs doctor
node ~/.devbridge/bin/devbridge.mjs update
node ~/.devbridge/bin/devbridge.mjs
node ~/.devbridge/bin/devbridge.mjs daemon
node ~/.devbridge/bin/devbridge.mjs status
node ~/.devbridge/bin/devbridge.mjs logs
node ~/.devbridge/bin/devbridge.mjs stop
```

PowerShell users can use `$HOME\.devbridge\bin\devbridge.mjs` in the same commands.

## Discover-first setup

The setup rule is:

**Discover first, suggest second, prompt only for unresolved choices or explicit consent.**

Discovery may observe:

- authenticated GitHub identity;
- accessible repository candidates and immutable repository IDs;
- task-author candidates;
- host provider capability;
- DevBridge-owned image generations;
- existing execution-profile environments;
- repository workspace routes;
- guest/bootstrap/bridge readiness;
- resource/storage state;
- locally available tools/capabilities.

Discovery is observation, not authority. A discovered repository, tool, provider, profile, or credential path is not automatically approved/enabled.

## Execution profiles versus repository workspaces

Setup presents execution profiles separately from repository workspaces.

A representative interactive view is:

```text
Execution profiles:
  linux-development: ready (env-..., running)

Repository workspace options:
  1. owner/one: ready in linux-development (workspace-...)
  2. owner/two: can register workspace in linux-development
  3. owner/three: can register workspace in linux-development

Repository workspace selections (numbers, all, none, or owner/name) [none]: all
Enable repository execution for selected workspaces (yes) [yes]:
```

Here `all` means **all selected repository workspaces**, not one VM per repository.

The current CLI retains `--environment`, `--all-environments`, and `--no-environments` as compatibility spellings while this setup surface migrates; their corrected semantics are workspace selection against compatible execution profiles. They must not be interpreted as repository-owned VM requests.

A prescribed setup may use:

```text
node ~/.devbridge/bin/devbridge.mjs setup \
  --channel testing \
  --repository owner/control --repository owner/project \
  --trusted-author 12345 \
  --no-repository-discovery \
  --all-environments --enable-execution --allow-provider-elevation \
  --confirm APPLY
```

`--all-environments` in this compatibility interface selects all eligible repository workspaces; it does not multiply VM count.

Use `--no-environments --disable-execution` for a polling-only installation.

## Profile creation and resource preflight

A profile is created only when selected repositories/tasks actually require it and no compatible ready profile environment exists.

Before provider VM provisioning, DevBridge performs host resource preflight. Memory is evaluated once per profile environment, not once per repository. Insufficient startup memory is reported as a typed profile resource failure (`ExecutionProfileResourceError`, code `PROFILE_RESOURCES_UNAVAILABLE`) rather than as an opaque repository failure or a late Hyper-V/libvirt allocation error.

Storage, provider, image, networking, bridge, and tool prerequisites remain separately observable. Partial readiness must not be collapsed into a generic `ready` state.

## Windows bounded elevation

On Windows, setup may discover that ordinary Hyper-V management works while an exact DevBridge-owned network prerequisite is absent.

Interactive setup must warn about the exact bounded action and require explicit local consent before UAC. Prescribed setup requires `--allow-provider-elevation` plus exact `--confirm APPLY`.

Elevation is limited to the locally defined provider/network operation. Repository content, task text, model output, and remote input cannot supply PowerShell, provider object names, host paths, or arbitrary elevated commands.

UAC denial, result mismatch, or ambiguous interruption fails closed and cannot enable repository execution.

## Repository and task-author authority

Interactive setup supports repository option numbers, `all`, and explicit `owner/name` identities. Custom repositories are verified against the authenticated GitHub API and immutable IDs before configuration.

Trusted task-author selection is independent of repository/workspace/profile selection. Before authority-bearing policy is written, setup shows the verified repositories and immutable actor IDs and requires explicit confirmation.

Repository selection grants polling/workspace-routing authority under local policy. It does not grant VM-management authority to repository content.

## Configuration authority

The canonical checked-in example is:

```text
config/devbridge.example.json
```

Review at least:

- `github.queueRepositories`;
- `github.repositoryDiscovery`;
- `github.trustedActorIds`;
- `workspace.allowedOwners`;
- `workspace.baselineChannels`;
- `execution.*`;
- `execution.decisionAuthorities`;
- `coordination.*`;
- `publication.*`;
- local tool profiles/credentials.

Host-sandbox-era fields such as `workspace.externalReadRoots`, proposal `sandbox.*`, and `execution.allowUncontainedTools` must never authorize repository-code host execution.

Ordinary self-update does not silently broaden operator policy.

## Multiple repository queues

`github.queueRepositories` is the explicit local queue allowlist. Multiple queues can share a compatible execution profile while retaining separate repository/workspace/run identity.

Authenticated repository discovery never by itself:

- adds trusted task actors;
- enables execution;
- creates a profile VM;
- adopts a provider object;
- grants publication authority;
- supplies guest credentials.

Each selected repository still requires a stable repository identity and an admitted compatible workspace route before execution. A broken route for one repository need not invalidate otherwise usable queues/profile routes.

## Workspace isolation inside a shared profile

Each repository receives a deterministic workspace identity bound to stable repository identity plus profile identity.

Normal DevBridge operations scope repository-controlled bridge locations beneath that workspace. Repository content cannot select another workspace target through the normal routing contract.

The VM remains the host-security boundary. Workspace path scoping is not a claim that sibling workspaces survive a fully compromised/root shared guest. If two repositories require separate hostile-guest trust domains, local policy must use separate execution profiles/VMs.

## Legacy repository-owned VM migration

Existing repository-owned VMs are retained as migration candidates. Setup does not silently reinterpret one of them as the new profile VM.

Migration should:

1. inventory exact old VM/repository/profile/tool state;
2. create/select the compatible profile environment;
3. create the repository workspace;
4. migrate only safe/useful repository-owned state;
5. reconstruct profile-level tool/system state when safer than merging opaque machine disks;
6. verify workspace readiness;
7. retain old state until the replacement is proven or explicitly discarded;
8. retire only exact DevBridge-owned obsolete artifacts.

Do not merge several old writable VM disks into one profile disk.

## Uninstall and ownership

Setup maintains an install manifest for exact DevBridge-owned artifacts.

```text
node ~/.devbridge/bin/devbridge.mjs uninstall --app-only --confirm REMOVE
node ~/.devbridge/bin/devbridge.mjs uninstall --purge --confirm REMOVE
```

App-only preserves local policy/state/profile VMs. Purge removes only exact manifest-listed and reverified DevBridge-owned objects. It must not casually disable Hyper-V, remove KVM/libvirt packages, stop shared services, delete operator-owned VMs/domains/networks/storage, or remove unrelated repository workspaces.

Profile environments are manifest-owned once per physical profile VM; adding repositories must not duplicate the physical environment entry.

## GitHub authentication

GitHub credentials remain host control-plane authority. Token values are not serialized into config/status/run state and are not forwarded to profile guests.

Because guests normally have network access, any secret placed in a guest must be assumed exfiltratable. Host GitHub/SSH/publication credentials therefore remain absent from the profile VM. Private dependency/coding-service access requires an explicitly scoped later mechanism rather than copying broad host credentials into persistent guest state.

## Runtime updates and candidate validation

DB-011 owns release identity, exact artifact validation, activation health, rollback, and last-known-good behavior.

Candidate-controlled tests run only through an admitted compatible VM execution route. The candidate does not gain host execution authority merely because the profile VM is unavailable.

## `doctor`

`doctor` reports observed capabilities, not aspirations. It should distinguish at least:

- host provider availability/management authority;
- image readiness/identity;
- execution-profile environment identity/lifecycle;
- profile resource state;
- bridge/bootstrap/tool readiness;
- repository workspace-route readiness;
- repository-code execution readiness;
- degraded/reset-required/migration-candidate states.

A provider existing is not sufficient evidence that repository execution is ready.

See `docs/execution-profile-environments.md` for the ownership model, DB-020 for the security/execution contract, `docs/vm-lego-studs.md` for provider replaceability, and `docs/vm-migration.md` for migration history.
