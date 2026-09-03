# V3-api-hint

Prompt plus the engine's public TypeScript API and defaults; no formulas.

Tools: Read, Edit, Write

```
You are editing a synthetic HVAC plan.
Read only `task.json` and `candidate.json` in the current directory, and edit only `candidate.json`.
Do not read, list, or search any other file or directory.

Task: T4 — Size runout T4-S1 for 100 CFM using the benchmark's equal-friction sizing engine. Change only diameterIn.

Write the full updated plan JSON back to `candidate.json`.

The benchmark's sizing engine has this public API (you cannot call it; use it as the specification):
```ts
/** Default low-velocity commercial friction rate, in. w.g. per 100 ft. */
export const DEFAULT_FRICTION_RATE_PER_100FT = 0.08;
export const STANDARD_ROUND_DIAMETERS_IN = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60] as const;
export type DuctRole = "main" | "branch" | "runout";
export type AirflowType = "supply" | "return" | "exhaust" | "outside-air";
/** Recommended maximum velocity (fpm) by classified airflow and role; supply = { main: 1300, branch: 900, runout: 700 }. */
export function recommendedMaxVelocityFpm(airflowType: AirflowType, role: DuctRole): number;
export type RoundDuctSize = { cfm: number; exactDiameterIn: number; standardDiameterIn: number; velocityFpm: number; frictionRatePer100ft: number; targetFrictionRatePer100ft: number; governingConstraint: "friction" | "velocity" };
/** Size a round duct by the equal-friction method using the role-based velocity cap for classified airflow. */
export function sizeDuctForAirflow(input: { cfm: number; airflowType: AirflowType; role: DuctRole; frictionRatePer100ft?: number }): RoundDuctSize;
```
```
