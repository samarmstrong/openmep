export type PascalAdapterErrorCode = "invalid-json" | "invalid-scene" | "invalid-node" | "invalid-argument" | "mcp-unavailable" | "mcp-tool-error";

export class PascalAdapterError extends Error {
  readonly code: PascalAdapterErrorCode;
  readonly nodeId: string | null;
  constructor(code: PascalAdapterErrorCode, nodeId: string | null, message: string) {
    super(message);
    this.name = "PascalAdapterError";
    this.code = code;
    this.nodeId = nodeId;
  }
}
