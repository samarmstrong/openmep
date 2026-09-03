# Changelog

## 0.4.0 — 2026-09-01

- Added the compound task **T6** to both fixture sets: restore a room's supply
  by adding a terminal, adding a new runout segment (no stub exists), and
  sizing that runout with the engine — add + connect + size in one edit. The
  grader checks the room total, the added terminal's CFM, its duct path to the
  AHU, and the added segment's engine-exact diameter; the mutation guard
  approves exactly the two additions (plus the branch connection in
  `branching`). Both sets ship explicit and `finding` prompt forms.
- `verify`, the fixture manifests, and the matrix runner now cover T1–T6.
- A candidate that is not valid JSON or not a valid plan is now a graded
  failure: the matrix runner records the validator message as
  `invalidCandidate` on the trial and `verify` re-grades it as failed, instead
  of both crashing. (Observed in the wild: a T6 editor added a terminal with
  no `position` field.)
- Recorded `results/branching-t6-v1.json` (sonnet-5, 6/6),
  `results/single-t6-v1.json` (sonnet-5, 5/6 — the missing-`position`
  failure above), and `results/branching-haiku45-v1.json` (haiku-4.5 full
  T1–T6 matrix, 36/36, $2.70).

## 0.3.0 — 2026-08-28

- Fixtures are now grouped into sets under `fixtures/<set>/T1–T5`. The original
  tasks live in `single`; the new `branching` set puts each fault into one
  shared network (AHU → 13 in main → 9 in and 11 in branches → seven runouts
  across four rooms) so distractor rooms, stub runouts, and a neighboring room
  exist. It is authored deterministically by
  `scripts/author-branching-fixtures.mjs` and tested byte-for-byte.
- Tasks may carry `promptVariants`; `branching` ships a `finding` form that
  states only the validator finding and constraint, without item identifiers.
- Recorded runs name their `fixtureSet`; `verify` checks every set.
- Added the generalized matrix runner (`experiments/run-matrix.mjs`) and
  recorded `results/branching-v1.json`: 30 isolated `claude-sonnet-5` attempts
  (5 tasks × explicit/finding prompt forms × 3) with the `size` tool available
  scored 30/30. The finding form — which hides item identifiers, target, and
  mutation plan — passed 15/15 at a 1.8 s mean latency cost (16.2 s vs 14.4 s).

## 0.2.0 — 2026-08-28

- Added `mep-benchmark size <cfm> <airflowType> <role>` and the `sizeSegment`
  export so agents can be handed the grader's own sizing engine as a tool.
- Recorded the T4 sizing-context experiment (`results/t4-context-v1.json`):
  15 isolated `claude-sonnet-5` attempts across five context variants with a
  fixed 7-inch oracle. Prompt-only and parameters-only context passed 1/3 each
  (every miss rounded the exact 6.08 in down to 6); adding the explicit
  next-standard-size selection rule, the engine's TypeScript API, or the
  `size` tool each passed 3/3. The tool variant was fastest (14.7 s mean).
- `verify` now hashes every file under `results/` and re-grades every recorded
  run, not only `v1.json`.

## 0.1.0 — 2026-08-03

Initial public release: five synthetic HVAC plan-editing tasks, deterministic grading, mutation guards, and fixture integrity verification.

- Recorded one isolated attempt per task: 4/5 passed; T4 selected 6 inches
  instead of the required 7-inch standard diameter.
- Corrected T1's mutation allowlist to include the reciprocal segment connection
  required by its prompt; the recorded editor candidate was not retried.
