import { DuctSizingError } from "./round-duct.js";

function assertPositiveDimension(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DuctSizingError("invalid-diameter", value, `${label} must be a positive finite number, got ${value}.`);
  }
}

/**
 * ASHRAE circular equivalent of a rectangular duct for equal friction and
 * airflow: De = 1.30 (a b)^0.625 / (a + b)^0.25 (Fundamentals, Duct Design).
 * Dimensions in inches; result in inches.
 */
export function rectangularEquivalentDiameterIn(widthIn: number, heightIn: number): number {
  assertPositiveDimension(widthIn, "widthIn");
  assertPositiveDimension(heightIn, "heightIn");
  return (1.3 * Math.pow(widthIn * heightIn, 0.625)) / Math.pow(widthIn + heightIn, 0.25);
}

/**
 * ASHRAE circular equivalent of a flat-oval duct for equal friction and
 * airflow: De = 1.55 A^0.625 / P^0.25 with A = π b²/4 + b (a − b) and
 * P = π b + 2 (a − b), where a is the major and b the minor axis.
 * Dimensions in inches; result in inches. Axis order does not matter.
 */
export function flatOvalEquivalentDiameterIn(majorIn: number, minorIn: number): number {
  assertPositiveDimension(majorIn, "majorIn");
  assertPositiveDimension(minorIn, "minorIn");
  const a = Math.max(majorIn, minorIn);
  const b = Math.min(majorIn, minorIn);
  const area = (Math.PI * b * b) / 4 + b * (a - b);
  const perimeter = Math.PI * b + 2 * (a - b);
  return (1.55 * Math.pow(area, 0.625)) / Math.pow(perimeter, 0.25);
}
