import { redirect } from "next/navigation";

export default async function PlanPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/models/${id}?mode=plan`);
}
