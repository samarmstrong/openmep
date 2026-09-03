import { DuctSizingError, sizeDuctForAirflow } from "@mep/hvac-domain";
import { BenchmarkInputError } from "./schema.js";

/** The benchmark's sizing oracle, exposed so agents can call the same engine the grader uses. */
export function sizeSegment({ cfm, airflowType, role }) {
  if (!Number.isFinite(cfm) || cfm <= 0) throw new BenchmarkInputError(`cfm must be a positive finite number, got ${cfm}`);
  try {
    return sizeDuctForAirflow({ cfm, airflowType, role });
  } catch (error) {
    if (error instanceof DuctSizingError) throw new BenchmarkInputError(`${error.code}: ${error.message}`);
    throw error;
  }
}
