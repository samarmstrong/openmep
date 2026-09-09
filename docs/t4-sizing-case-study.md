# A duct-sizing agent chose 6 inches. The benchmark required 7.

OpenMEP represents HVAC plans as inspectable JSON and gives agents
deterministic tools and checks. This case study asks a narrow question:
what context helps an agent choose the sizing engine's expected standard
diameter? You can re-grade every preserved attempt locally without an API key.

## The task and two recorded edits

One synthetic room needs 100 CFM. Its supply runout, `T4-S1`, starts at
4 inches. The task permits changing only `segment.T4-S1.diameterIn`.
For the benchmark's defaults, the engine calculates a minimum diameter of
6.079113 inches and selects 7 inches from its standard-size list.

```text
                      Same synthetic starter
                  100 CFM / diameterIn: 4
                         /         \
            Formula parameters    Sizing tool available
             V1, attempt 1         V4, attempt 1
             diameterIn: 6         diameterIn: 7
                 FAIL                  PASS
          expected 7, actual 6    no remaining findings
```

These are **independent attempts**, not a failed attempt retried with a tool.
Both changed only the allowed diameter field. The actual stored edits are:

```diff
// V1-parameters-1.json: FAIL
- "diameterIn": 4
+ "diameterIn": 6

// V4-tool-1.json: PASS
- "diameterIn": 4
+ "diameterIn": 7
```

The engine uses an equal-friction target of 0.08 in. w.g. per 100 ft and a
700 fpm supply-runout velocity recommendation. Friction governs this case.
The selection rule chooses the smallest listed diameter at least as large
as the calculated requirement. These are this implementation's assumptions;
see the [domain package's basis and limits](../packages/hvac-domain/README.md).

## All fifteen attempts

The August 28, 2026 record has three attempts per condition on the same task.
The replay derives this table from the candidates and checks it against the
recorded summary.

| Context condition | Passes | Selected diameters, in | Mean recorded duration |
|---|---:|---|---:|
| V0: task prompt | 1/3 | 7, 6, 6 | 20.9 s |
| V1: formulas, parameters, standard sizes | 1/3 | 6, 7, 6 | 24.7 s |
| V2: V1 plus explicit selection rule | 3/3 | 7, 7, 7 | 27.2 s |
| V3: API specification, not callable | 3/3 | 7, 7, 7 | 57.2 s |
| V4: callable sizing tool available | 3/3 | 7, 7, 7 | 14.7 s |

In these recorded attempts, formula parameters alone did not consistently
produce the engine's expected standard size. The explicit-rule and
tool-available conditions each passed three out of three. This supports
making selection rules explicit in an agent interface. It does not establish
what each agent reasoned internally or a general reliability rate.

## Reproduce the checks

Use Node.js 24+ and npm in a fresh checkout:

```sh
git clone https://github.com/samarmstrong/openmep.git
cd openmep
npm ci
npm run build --workspace @openmep/hvac-domain --workspace @openmep/agent-benchmark
npm run benchmark:replay:t4
```

The replay verifies fixture/result checksums, re-grades stored outcomes,
checks per-condition summaries, and prints the two edits above. It exits
nonzero if evidence no longer matches. This includes the expected 6-inch
failure; successfully reproducing that failure is a successful replay.
No IFC download, database, model credentials, or new agent trial is needed.

For the underlying sizing output and individual grades, run from the same
repository root:

```sh
node packages/agent-benchmark/bin/mep-benchmark.js size 100 supply runout
node packages/agent-benchmark/bin/mep-benchmark.js grade packages/agent-benchmark/fixtures/single/T4 packages/agent-benchmark/results/t4-context/candidates/V1-parameters-1.json
# Expected exit 1: duct-sizing, expected 7, actual 6.
node packages/agent-benchmark/bin/mep-benchmark.js grade packages/agent-benchmark/fixtures/single/T4 packages/agent-benchmark/results/t4-context/candidates/V4-tool-1.json
# Expected exit 0: passed, mutation guard passed, no remaining findings.
```

These commands evaluate stored edits. The separate experiment runner launches
new paid CLI trials and overwrites records; it is not needed for this replay.

## Evidence and limits

- **Inputs:** [task](../packages/agent-benchmark/fixtures/single/T4/task.json), [starter](../packages/agent-benchmark/fixtures/single/T4/starter.json), [all prompts](../packages/agent-benchmark/results/t4-context/prompts), [all candidates](../packages/agent-benchmark/results/t4-context/candidates), and [recorded results](../packages/agent-benchmark/results/t4-context-v1.json). The fixture is authored synthetic data with no client-derived inputs.
- **Versions:** the record identifies benchmark 0.2.0, dated 2026-08-28. The replay uses the current checkout's grader (package 0.4.0 when this example was added). The preserved evidence was inspected at base commit `f90a80d06b66bc021c8fdb49cdced9eb6f13d844`; capture `git rev-parse HEAD` for the revision you replay. The replay prints its Node version and results-manifest fingerprint. The original trial runtime version is absent from the record.
- **Model attribution:** the runner requested `claude-sonnet-5`. Every trial's usage reports both that identifier and `claude-haiku-4-5-20251001`; this is not evidence attributable exclusively to one model.
- **Access and traces:** V0–V3 allowed Read/Edit/Write; V4 also allowed Bash. Context restrictions were instructions, not an enforced filesystem sandbox. Stored records do not include tool-call traces, so “tool available” does not prove which calls occurred.
- **Measurement:** timings come from the runner's reported duration, with separate wall times also recorded. Three trials per condition and concurrent, grouped execution make these descriptive observations, not a controlled speed comparison.
- **Checker scope:** T4 demands exactly the engine-selected 7-inch size; it also rejects 8 inches. This tests agreement with the engine and the edit boundary. Because the tool and grader share an engine, agreement is not independent engineering validation. Checksums verify stored-artifact integrity, not the original model execution's provenance. OpenMEP's broader load calculations remain unvalidated.

If you build BIM or engineering automation, **what is one HVAC checking or
repair task your tools handle badly?** A small shareable failing case, its
expected result, and the tool you need it to fit into would help select the
next useful experiment. You can [open an issue](https://github.com/samarmstrong/openmep/issues/new).
