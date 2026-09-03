import { type AirflowType, type DuctRole, type RoundDuctSize } from "./round-duct.js";
export type { AirflowType } from "./round-duct.js";
export type NetworkNode = {
    id: string;
    elementRef: string;
    kind: "equipment" | "fitting" | "terminal";
    airflowType: AirflowType;
    connectedItemRefs: readonly string[];
    requiredCfm?: number | null;
};
export type NetworkSegment = {
    id: string;
    elementRef: string;
    kind: "segment";
    airflowType: AirflowType;
    connectedItemRefs: readonly string[];
};
export type NetworkItem = NetworkNode | NetworkSegment;
export type DuctNetworkErrorCode = "duplicate-element-ref" | "duct-sizing-failed" | "invalid-terminal-airflow";
export declare class DuctNetworkError extends Error {
    readonly code: DuctNetworkErrorCode;
    readonly elementRef: string;
    constructor(code: DuctNetworkErrorCode, elementRef: string, message: string);
}
export type DuctNetworkFinding = {
    code: "dangling-reference" | "no-equipment-path";
    message: string;
    itemId: string;
    elementRef: string;
};
export type SupplyDuctSegmentRecommendation = {
    itemId: string;
    elementRef: string;
    cfm: number;
    terminalItemIds: readonly string[];
    role: DuctRole;
    size: RoundDuctSize;
};
export type SupplyDuctNetworkResult = {
    segments: readonly SupplyDuctSegmentRecommendation[];
    findings: readonly DuctNetworkFinding[];
};
/**
 * Propagate each positive-CFM supply terminal over one deterministic shortest
 * compatible path to equipment and recommend every traversed round segment.
 */
export declare function recommendSupplyDuctSegments(items: readonly NetworkItem[]): SupplyDuctNetworkResult;
