/** Default low-velocity commercial friction rate, in. w.g. per 100 ft. */
export declare const DEFAULT_FRICTION_RATE_PER_100FT = 0.08;
/** Standard spiral/round galvanized duct diameters (inches). */
export declare const STANDARD_ROUND_DIAMETERS_IN: readonly [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60];
export type DuctRole = "main" | "branch" | "runout";
export type AirflowType = "supply" | "return" | "exhaust" | "outside-air" | "unknown";
export type SupplyAirflowType = "supply";
export type DuctSizingErrorCode = "invalid-airflow" | "invalid-diameter" | "invalid-friction-rate" | "invalid-velocity" | "unsupported-airflow-type" | "diameter-exceeds-standard-range";
export declare class DuctSizingError extends Error {
    readonly code: DuctSizingErrorCode;
    readonly value: number | string;
    constructor(code: DuctSizingErrorCode, value: number | string, message: string);
}
export type RoundDuctSize = {
    cfm: number;
    exactDiameterIn: number;
    standardDiameterIn: number;
    velocityFpm: number;
    frictionRatePer100ft: number;
    targetFrictionRatePer100ft: number;
    governingConstraint: "friction" | "velocity";
};
export type RoundDuctSizingInput = {
    cfm: number;
    frictionRatePer100ft?: number;
    maxVelocityFpm?: number | null;
};
export type SupplyRoundDuctSizingInput = {
    cfm: number;
    role: DuctRole;
    frictionRatePer100ft?: number;
};
export type DuctForAirflowSizingInput = SupplyRoundDuctSizingInput & {
    airflowType: AirflowType;
};
/** Friction rate (in. w.g. per 100 ft) for airflow through a round duct. */
export declare function roundDuctFrictionRate(cfm: number, diameterIn: number): number;
/** Air velocity (fpm) for airflow through a round duct. */
export declare function roundDuctVelocityFpm(cfm: number, diameterIn: number): number;
/** Recommended maximum velocity (fpm) by classified airflow and role. */
export declare function recommendedMaxVelocityFpm(airflowType: AirflowType, role: DuctRole): number;
/** Size a round duct by equal friction, optionally enforcing a velocity cap. */
export declare function sizeRoundDuct(input: RoundDuctSizingInput): RoundDuctSize;
/** Size a supply round duct using the published role-based velocity cap. */
export declare function sizeSupplyRoundDuct(input: SupplyRoundDuctSizingInput): RoundDuctSize;
/** Size a round duct using the role-based velocity cap for classified airflow. */
export declare function sizeDuctForAirflow(input: DuctForAirflowSizingInput): RoundDuctSize;
