# @openmep/agent-benchmark

A small benchmark for agents that repair a synthetic HVAC plan, using the local `@openmep/hvac-domain` sizing package. It contains no IFC data and does not depend on private MEP schemas. Fixtures are deliberately simple structural JSON so an adapter can map any plan representation into this boundary.

## Quick start

```sh
git clone https://github.com/samarmstrong/openmep.git
cd openmep
npm ci
npm run build --workspace @openmep/hvac-domain --workspace @openmep/agent-benchmark
npm run benchmark:replay:t4
```

Run these commands with Node.js 24+ and npm. The replay verifies the manifests
and re-grades frozen candidates; it does not call an agent or require IFCs or
credentials. See the [case study](../../docs/t4-sizing-case-study.md) for the
evidence and limitations. From this package directory after building, the
same example is `node examples/t4-replay.mjs`.

To grade an edit of your own, from the repository root:

```sh
cp packages/agent-benchmark/fixtures/single/T2/starter.json /tmp/t2.json
# Edit /tmp/t2.json to resolve the task.
node packages/agent-benchmark/bin/mep-benchmark.js grade packages/agent-benchmark/fixtures/single/T2 /tmp/t2.json
```

`grade` prints deterministic JSON and exits `0` for a pass, `1` for a valid graded failure, or `2` for malformed input/configuration. `verify` validates every fixture, every recorded result, and their SHA-256 manifests; it exits `0` or `2`. `size <cfm> <airflowType> <role>` runs the same `@openmep/hvac-domain` sizing engine the grader uses for T4 (e.g. `mep-benchmark size 100 supply runout` → `standardDiameterIn: 7`), so an agent under test can be handed the oracle's engine as a tool rather than its answer.

Fixtures are grouped into sets under `fixtures/<set>/T1–T6`: `single` (one room, one runout per task) and `branching` (one AHU → main → two branches → seven runouts across four rooms, each task injecting one fault into the same base network; authored deterministically by `scripts/author-branching-fixtures.mjs`). Each task directory contains `task.json` (prompt, optional `promptVariants` such as `finding`, metadata, guard), `starter.json`, `oracle.json`, and `initial-report.json`. Every starter has exactly one intended target finding. The target must be resolved, no error may be newly introduced, and only the task's approved mutation plan may be changed. Warnings are reported but nonfatal.

## API

```js
import { grade, sizeSegment, verifyFixtures, validatePlan } from "@openmep/agent-benchmark";
const result = grade(task, starter, candidate);
const runout = sizeSegment({ cfm: 100, airflowType: "supply", role: "runout" }); // standardDiameterIn: 7
```

The plan shape is `version`, `spaces`, `equipment`, `terminals`, and `segments`. See `src/schema.js` for the formal validation contract. T1 adds a missing terminal, T2 moves a terminal into its declared room, T3 reconnects a terminal to supply equipment, T4 sizes a runout using `@openmep/hvac-domain`, T5 balances two terminal flows, and T6 is compound: add a terminal, add a new runout (no stub exists), and size it with the engine in one edit.

The fixture is entirely synthetic and authored for this benchmark. No IFC file,
client identifier, commercial-project geometry, or derived project data is
included. The tasks are intentionally small capability checks, not evidence of
general reliability or code-compliant mechanical design.

## Recorded v0.1.0 run

Five isolated fresh-agent attempts on the synthetic fixture produced 4/5
passes: T1, T2, T3, and T5 passed; T4 selected 6 inches instead of the required
7-inch standard diameter. `results/v1.json` records the environment,
limitations, exact candidate files, findings, and the T1 mutation-guard
instrumentation correction. This is one observation per task, not a statistical
reliability claim.

## Recorded T4 sizing-context experiment (0.2.0)

`results/t4-context-v1.json` holds 15 recorded attempts requesting `claude-sonnet-5` on T4
(fixed 7-inch oracle, three per context variant; prompts under
`results/t4-context/prompts/`, exact candidates under
`results/t4-context/candidates/`). Prompt-only and formula-parameters-only
context each passed 1/3 — every miss selected 6 in against the engine's 7-in target.
Stating the next-standard-size selection rule, exposing the engine's
TypeScript API, or exposing `mep-benchmark size` as a tool each passed 3/3;
the tool-available variant had the lowest mean recorded duration (14.7 s vs.
57.2 s for API-only). This supports making selection rules explicit in this
case; it does not establish the agents' internal reasoning. All trials report
usage for both `claude-sonnet-5` and `claude-haiku-4-5-20251001`; tool-call
traces and the original runtime version were not preserved in this record.
The API-only condition supplied a specification, not a callable API.
Replay the frozen evidence with `npm run replay:t4` from this package directory.
`experiment:t4-context` launches new paid CLI trials and overwrites recorded
results; it is not the replay command.

## Recorded branching matrix (0.3.0)

`results/branching-v1.json` holds 30 fresh `claude-sonnet-5` attempts on the
`branching` set: five tasks × two prompt forms × three attempts, each editor
given only `candidate.json`, a trial-local `task.json`, and the `mep-benchmark
size` tool. The **explicit** form (identifiers, target, and mutation plan
visible) passed 15/15 at 14.4 s mean; the **finding** form (only the validator
finding and its constraint — the editor must discover the affected items)
passed 15/15 at 16.2 s mean. Every discovery-form repair chose the intended
stub runout, and T4's finding form summed the 250 CFM downstream and sized the
branch to 9 in through the tool. Reproduce with `npm run experiment:matrix`.

## Recorded T6 compound runs and haiku-4.5 matrix (0.4.0)

`results/branching-t6-v1.json` holds 6 fresh `claude-sonnet-5` attempts on the
compound branching T6 (explicit and finding forms × 3, `size` tool available):
6/6 — every editor added D-4B and RO-4B, wired BR-2, and sized the 100 CFM
runout to 7 in through the tool. `results/single-t6-v1.json` holds the same
matrix on the single set: 5/6, the first recorded failure under the tool
condition — one explicit-form editor added terminal T6-D2 with no `position`
field, a schema-invalid candidate recorded with its validator message as
`invalidCandidate` (its added segment was connected and sized correctly).
`results/branching-haiku45-v1.json` holds the full T1–T6 × explicit/finding
× 3 matrix at `claude-haiku-4-5-20251001`: 36/36 at 25.7 s mean and $2.70
total — the tool condition holds one model tier down on this set.
