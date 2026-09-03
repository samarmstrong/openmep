# V4-tool

Prompt plus a shell wrapper around `mep-benchmark size`; the editor may run it.

Tools: Read, Edit, Write, Bash

```
You are editing a synthetic HVAC plan.
Read only `task.json` and `candidate.json` in the current directory, and edit only `candidate.json`.
Do not read, list, or search any other file or directory.

Task: T4 — Size runout T4-S1 for 100 CFM using the benchmark's equal-friction sizing engine. Change only diameterIn.

Write the full updated plan JSON back to `candidate.json`.

The benchmark's sizing engine is available as a command in the current directory:
`./mep-benchmark size <cfm> <airflowType> <role>` prints JSON including `standardDiameterIn`.
Use it to size the segment.
```
