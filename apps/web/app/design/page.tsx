import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { planStoreySchema } from "@openmep/model-core/types";
import { AirflowWorkbench } from "@/components/airflow-workbench";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DesignPage() {
  const file = path.resolve(process.cwd(), "../../eval-runs/wbdg_office/Level_1/planStorey.json");
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return <main className="shell"><h1>Airflow design</h1><p>The example building has not been prepared on this server.</p><Link href="/">Back to models</Link></main>;
  }
  const storey = planStoreySchema.parse(JSON.parse(contents));
  return <>
    <AirflowWorkbench initialStorey={storey} />
    <footer style={{ padding: "16px 32px", background: "#090f19", color: "#96a9bf", fontSize: 12 }}>
      Public Office example · <a href="https://github.com/buildingsmart-community/Community-Sample-Test-Files">buildingSMART / NIBS</a>,
      mirrored by <a href="https://huggingface.co/datasets/sylvainHellin/ifc-bench">ifc-bench</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
      {" "}Transformed into an editable plan by OpenMEP. Connections inferred from geometry; initial room demands use office assumptions.
    </footer>
  </>;
}
