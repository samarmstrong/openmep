# V2-parameters-rule

V1 plus the explicit next-standard-size selection rule.

Tools: Read, Edit, Write

```
You are editing a synthetic HVAC plan.
Read only `task.json` and `candidate.json` in the current directory, and edit only `candidate.json`.
Do not read, list, or search any other file or directory.

Task: T4 — Size runout T4-S1 for 100 CFM using the benchmark's equal-friction sizing engine. Change only diameterIn.

Write the full updated plan JSON back to `candidate.json`.

Sizing engine parameters:
- Method: equal friction at a design friction rate of 0.08 in. w.g. per 100 ft.
- Friction rate for a round duct (in. w.g. per 100 ft) = 0.109136 · CFM^1.9 / D^5.02, with D in inches.
- Velocity (fpm) = CFM / ((π/4) · (D/12)^2).
- Recommended maximum velocity for a supply runout: 700 fpm.
- Standard round diameters (in): 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60.
- Selection rule: compute the exact diameter that meets the design friction rate; if the velocity cap requires a larger diameter, use that instead; then select the smallest standard diameter that is greater than or equal to that exact diameter.
```
