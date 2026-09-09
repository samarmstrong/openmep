import { getPlanStorey } from "@openmep/model-core/server";
import { notFound } from "next/navigation";
import { AirflowWorkbench } from "@/components/airflow-workbench";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ModelDesignPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ storeyId?: string }>;
}) {
  const { id } = await params;
  const { storeyId } = await searchParams;
  const storey = await getPlanStorey(id, storeyId);
  if (!storey) notFound();
  return <AirflowWorkbench key={`${id}:${storey.globalId}`} initialStorey={storey} />;
}
