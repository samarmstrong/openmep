import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Public, redistributable IFC fixtures (CC BY 4.0 buildingSMART sample files)
 * used by the IFC-reading tests and the dev seed scripts. They are downloaded
 * on demand by `fixtures/fetch-public-ifc.sh` and are gitignored, so a
 * missing file is a setup error the developer must fix — never a reason to skip.
 *
 * See `fixtures/README.md` for what each project contains.
 */
export type PublicFixtureProject = "duplex" | "wbdg_office";
export type PublicFixtureFile = "arc.ifc" | "mep.ifc";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const fetchScript = "fixtures/fetch-public-ifc.sh";

/** Directory holding `<project>/<file>`; overridable with `IFC_FIXTURE_DIR`. */
export function publicFixtureDir(): string {
  const override = process.env.IFC_FIXTURE_DIR;
  return override ? path.resolve(override) : path.join(repoRoot, "fixtures/public");
}

/**
 * Absolute path to a public fixture file. Throws when the file is absent so a
 * test or script fails loudly with the exact command that provisions it.
 */
export function publicFixturePath(project: PublicFixtureProject, file: PublicFixtureFile): string {
  const filePath = path.join(publicFixtureDir(), project, file);
  if (!existsSync(filePath)) {
    throw new Error(
      `Missing public IFC fixture ${project}/${file} (looked in ${filePath}). ` +
        `Run \`${fetchScript} ${project}\` from the repo root` +
        (process.env.IFC_FIXTURE_DIR ? ` (IFC_FIXTURE_DIR=${process.env.IFC_FIXTURE_DIR})` : "") +
        " to download and checksum-verify it."
    );
  }
  return filePath;
}
