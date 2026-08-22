# Recoverable immutable image artifacts

Issue #178 makes the local immutable image library a verified cache rather than the sole copy of reconstruction authority.

## LEGO boundary

The generic artifact lifecycle knows only:

`semantic image subject -> complete encoded object -> ordered transport objects -> verified canonical image`

It does not know which external service carries those transport objects, which provider will later consume the canonical image, or where a future environment will materialize. External-service mechanics terminate in source adapters. Provider-native media validation remains owned by the existing image-library publication boundary.

## Artifact order

Publication is deliberately one-way:

`canonical image -> encode the complete image -> measure the complete encoded object -> chunk only for transport`

The bundle builder never encodes chunks independently. Its default transport chunk bound is 1 GiB; callers may use a smaller fixed bound for testing or another transport while preserving the same semantic image identity.

## Three integrity levels

The versioned manifest binds:

1. **Canonical image** — profile, generation, semantic image identity, media format, virtual size, exact byte size, whole SHA-256, and bootstrap/tooling compatibility identity.
2. **Encoded object** — encoding algorithm and deterministic publication parameters, exact byte size, and whole SHA-256.
3. **Transport objects** — contiguous ordinal order, safe immutable leaf name, exact offset, exact size, and per-object SHA-256.

Manifest validation rejects duplicate names, reordered ordinals, gaps, overlaps, truncated coverage, invalid digests, and a semantic image identity that does not match profile/generation/canonical digest.

## Recovery

The source-neutral acquisition component verifies the exact local immutable image first, resolves and verifies one exact manifest when recovery is needed, reuses only chunks already verified for the exact encoded-object digest, fetches missing/corrupt chunks with exact byte bounds, verifies each chunk and the complete encoded stream, decodes to one owned temporary canonical image, verifies the complete canonical size/SHA-256, then publishes through the existing local image-library contract with provider-native validation. Only after exact replacement bytes are verified can an invalid prior cache subject be quarantined.

Interrupted fetches leave verified transport objects reusable for that exact encoded-object identity. Temporary concatenation/decode files are not admitted and are removed on completion/failure.

## Local cache quarantine

The cache adapter does not manipulate image-library catalog internals. It uses only public observe/list/retire/collect/publication studs. If corrupt bytes still exist as a real regular file, they are copied to a bounded quarantine artifact plus an integrity record before retirement. Every other image identity is explicitly protected during collection.

## Initial adapters

The initial codec adapter is zstd with one-thread deterministic publication parameters recorded in the manifest; generic image identity does not depend on zstd. The initial remote source adapter uses an exact GitHub Release numeric subject plus a locally pinned canonical manifest SHA-256. Release/tag names and branch refs are not image authority. Exact release-asset API identities and streaming byte bounds are enforced in that adapter.

Future mirrors, offline bundles, or other artifact services can implement the same source port without changing image identity, acquisition, cache, or environment-construction contracts.

## Construction integration

#171 consumes only the semantic image identity/generation already present in the #170 declaration and calls `ensure exact image available` before allocating provider storage. It does not select external image repositories, URLs, tags, or transport object names.
