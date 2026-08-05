import Receiver from "@/components/Receiver";

export default async function ReceiveSession({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Receiver sessionId={id} />;
}
