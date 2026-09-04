# Public artifact release

The repository is open source under the MIT license (root `LICENSE`). Two
workspaces are additionally packaged for npm as independent ESM packages,
`@openmep/hvac-domain` and `@openmep/agent-benchmark`; each carries its own copy of the
MIT license so the published archives are self-contained.

## License boundary

MIT covers the code in this repository. It does not cover the IFC fixtures the
tests download: those stay under their upstream licenses (see
`fixtures/README.md` — buildingSMART sample files, CC BY 4.0, mirrored by the
ifc-bench dataset) and are never committed to this repository.

Before a release, inspect both package archives and confirm that each contains
its own MIT license and no fixture data:

```sh
npm pack --dry-run --workspace @openmep/hvac-domain
npm pack --dry-run --workspace @openmep/agent-benchmark
```

## Data and provenance boundary

This repository contains no IFC models. Real-model tests and evals run on the
public fixtures fetched by `fixtures/fetch-public-ifc.sh` (sha256-pinned,
attributed in `fixtures/README.md`). Commercial-project IFC files, and any JSON,
screenshots, geometry, element identifiers, room or equipment names, loads, or
other data derived from them, must never be committed or published here.
Transformation does not establish redistribution rights.

A releasable benchmark fixture must instead be synthetic or come from a source
whose license explicitly permits redistribution and derivative works. Record,
alongside every fixture:

- the fixture author or upstream source and immutable version;
- the source license and a copy of its required notices;
- whether the data is synthetic, original, or transformed;
- the transformation script and enough information to reproduce it; and
- a review confirming that no client, project, person, address, stable model ID,
  proprietary family name, or commercial-project geometry remains.

Do not publish a benchmark result unless its inputs, task prompt, expected
output, grader version, runtime version, and agent/model configuration are
recorded. The packaged synthetic v0.1.0 result is **4/5** across one fresh
attempt per task; it is not evidence of general agent reliability. The separate
historical 5/5 result used non-public project-derived inputs and must not be
presented as the packaged benchmark result.

## Engineering references and limits

The implementation is informed by the *ASHRAE Handbook—Fundamentals*, “Duct
Design” chapter (ASHRAE, 2025), including the round-duct friction-chart relation
for galvanized steel at standard-air conditions. The release notes and API
documentation must cite the exact handbook edition, chapter, figure/table, and
page actually checked by the releaser. Also cite the applicable ASHRAE source
for the assumed standard-air density and disclose every coefficient, unit, and
roughness assumption; do not present an uncited code comment as a normative
reference.

These packages provide preliminary deterministic sizing calculations, not a
sealed mechanical design. They do not establish code compliance or account for
all fitting losses, fan selection, pressure balance, acoustics, leakage,
insulation, altitude, temperature-dependent density, fabrication constraints,
fire/smoke requirements, commissioning, or project-specific engineering
judgment. Velocity values are recommendations, not universal limits. A licensed
professional must select the governing codes, standards, inputs, and final
design. ASHRAE names and publications are references only; this project is not
endorsed by ASHRAE.

## Candidate verification

Use Node.js 24 LTS and npm. The committed npm lockfile is authoritative.

```sh
npm ci
npm run build --workspace @openmep/hvac-domain
npm run test --workspace @openmep/hvac-domain
npm run build --workspace @openmep/agent-benchmark
npm run test --workspace @openmep/agent-benchmark
npm run build
npm test
npm run benchmark:verify
npm pack --dry-run --workspace @openmep/hvac-domain
npm pack --dry-run --workspace @openmep/agent-benchmark
```

Review the dry-run file lists for unexpected application code, credentials,
fixtures, generated reports, source maps, or project data. CI runs the same
checks on pull requests and pushes to `main`.

## Create archives without publishing

From a clean, reviewed commit, create local npm-compatible archives:

```sh
npm pack --workspace @openmep/hvac-domain
npm pack --workspace @openmep/agent-benchmark
shasum -a 256 mep-hvac-domain-*.tgz mep-agent-benchmark-*.tgz > SHA256SUMS
```

Inspect each archive before release:

```sh
tar -tzf mep-hvac-domain-*.tgz
tar -tzf mep-agent-benchmark-*.tgz
```

After the version and changelog are reviewed, a maintainer may attach the two
archives and checksum file to a draft GitHub release:

```sh
gh release create public-artifact-v0.1.0 \
  mep-hvac-domain-*.tgz mep-agent-benchmark-*.tgz SHA256SUMS \
  --draft --generate-notes --title "Public artifact v0.1.0"
```

Keep the release draft until the provenance and citation review is complete.
This process deliberately does not run `npm publish` or publish the GitHub
release; either action requires separate approval. Registry publication also
requires an explicit package-name, ownership, access, provenance-attestation,
and versioning decision.
