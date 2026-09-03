import { ModelWorkspace } from "@/components/model-workspace";

export default async function ModelPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ModelWorkspace modelId={id} />;
}
