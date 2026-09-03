export function json<T>(payload: T, init?: ResponseInit) {
  return Response.json(payload, init);
}

export function errorResponse(status: number, message: string) {
  return json(
    {
      error: message
    },
    { status }
  );
}
