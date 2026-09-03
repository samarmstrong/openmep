import type { PlanPolygon, Point2D } from "../../types";

/** Even-odd ray cast: is a point inside a single ring? */
export function pointInRing(point: Point2D, ring: ReadonlyArray<Point2D>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] <
        ((xj - xi) * (point[1] - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Point inside a polygon (inside the outer ring and outside every hole). */
export function pointInPolygon(point: Point2D, polygon: PlanPolygon): boolean {
  if (!pointInRing(point, polygon.outer)) return false;
  return polygon.holes.every((hole) => !pointInRing(point, hole));
}

/** Shoelace area of a polygon's outer ring (absolute value). */
export function polygonOuterArea(polygon: PlanPolygon): number {
  const ring = polygon.outer;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(sum) / 2;
}
