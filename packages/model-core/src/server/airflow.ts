import type { AirflowType, ElementSummary, SystemAssignment } from "../types";

function normalizeText(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

export function classifyAirflowType(input: {
  description?: string | null;
  name?: string | null;
}): AirflowType {
  const description = normalizeText(input.description);
  const name = normalizeText(input.name);

  if (description.includes("outside air")) {
    return "outside-air";
  }
  if (description.includes("supply")) {
    return "supply";
  }
  if (description.includes("return")) {
    return "return";
  }
  if (description.includes("exhaust")) {
    return "exhaust";
  }

  if (/^osa\b/.test(name) || /\boutside air\b/.test(name)) {
    return "outside-air";
  }
  if (/^sa\b/.test(name) || /\bsupply\b/.test(name)) {
    return "supply";
  }
  if (/^ra\b/.test(name) || /\breturn\b/.test(name)) {
    return "return";
  }
  if (/^ea\b/.test(name) || /\bexhaust\b/.test(name)) {
    return "exhaust";
  }

  return "unknown";
}

export function resolveAirflowType(
  assignments: SystemAssignment[]
): AirflowType {
  const classified = Array.from(
    new Set(
      assignments
        .map((assignment) => assignment.airflowType)
        .filter((airflowType) => airflowType !== "unknown")
    )
  );

  if (classified.length === 1) {
    return classified[0];
  }

  return "unknown";
}

const AIR_SYSTEM_PROPERTY_KEYS = new Set([
  "systemtype",
  "systemclassification",
  "systemname",
  "systemabbreviation"
]);

function airflowTypeFromAirSystemLabel(label: string): AirflowType {
  const text = normalizeText(label);
  if (/\b(outside|outdoor) air\b/.test(text)) {
    return "outside-air";
  }
  if (/\bsupply air\b/.test(text)) {
    return "supply";
  }
  if (/\breturn air\b/.test(text)) {
    return "return";
  }
  if (/\bexhaust air\b/.test(text)) {
    return "exhaust";
  }
  return "unknown";
}

/**
 * Exporters without IfcSystem groups (Revit MEP ≤ 2011) carry the system on the
 * element itself, e.g. `PSet_Revit_Mechanical.System Type = "Supply Air"`.
 * Multi-valued labels ("Hydronic Supply,Return Air") count only air systems and
 * must agree on exactly one type.
 */
export function classifyAirflowTypeFromProperties(
  properties: Record<string, unknown>
): AirflowType {
  const found = new Set<AirflowType>();
  for (const propertySet of Object.values(properties)) {
    if (typeof propertySet !== "object" || propertySet === null) {
      continue;
    }
    for (const [key, value] of Object.entries(propertySet as Record<string, unknown>)) {
      if (typeof value !== "string" || !AIR_SYSTEM_PROPERTY_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""))) {
        continue;
      }
      for (const label of value.split(",")) {
        const airflowType = airflowTypeFromAirSystemLabel(label);
        if (airflowType !== "unknown") {
          found.add(airflowType);
        }
      }
    }
  }
  return found.size === 1 ? [...found][0] : "unknown";
}

/** Precedence: IfcSystem group assignment → element system properties → element name. */
export function resolveElementAirflowType(
  element: Pick<ElementSummary, "systemAssignments" | "properties" | "name" | "objectType">
): AirflowType {
  const fromSystems = resolveAirflowType(element.systemAssignments);
  if (fromSystems !== "unknown") {
    return fromSystems;
  }
  const fromProperties = classifyAirflowTypeFromProperties(element.properties);
  if (fromProperties !== "unknown") {
    return fromProperties;
  }
  // Revit names glue tokens with "_" and ":" ("M_Supply Diffuser:600 x 600"),
  // which defeat word boundaries; split them first.
  const name = (element.name ?? element.objectType ?? "").replace(/[^a-z0-9]+/gi, " ");
  return classifyAirflowType({ name });
}

export type SystemDomain = "air" | "non-air" | "unknown";

const NON_AIR_PROPERTY_SET_PATTERN = /electrical|plumbing|piping|fire protection/i;
const UNSPECIFIED_SYSTEM_LABELS = new Set(["", "undefined", "other", "none"]);

/**
 * Whether an element belongs to an air system, a declared non-air system
 * (hydronic, plumbing, fire, electrical), or carries no system evidence.
 * Precedence: any air label wins (a rooftop fan also carries electrical
 * psets); then any other system label; then domain-specific property sets.
 */
export function classifySystemDomain(properties: Record<string, unknown>): SystemDomain {
  let sawSystemLabel = false;
  for (const propertySet of Object.values(properties)) {
    if (typeof propertySet !== "object" || propertySet === null) {
      continue;
    }
    for (const [key, value] of Object.entries(propertySet as Record<string, unknown>)) {
      if (typeof value !== "string" || !AIR_SYSTEM_PROPERTY_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""))) {
        continue;
      }
      for (const label of value.split(",")) {
        if (airflowTypeFromAirSystemLabel(label) !== "unknown") {
          return "air";
        }
        if (!UNSPECIFIED_SYSTEM_LABELS.has(normalizeText(label))) {
          sawSystemLabel = true;
        }
      }
    }
  }
  if (sawSystemLabel) {
    return "non-air";
  }
  return Object.keys(properties).some((setName) => NON_AIR_PROPERTY_SET_PATTERN.test(setName))
    ? "non-air"
    : "unknown";
}
