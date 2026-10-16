// Stable error codes. Agents and humans both see these, so they are part of
// the public contract: add new ones freely, never repurpose an existing one.
export const ErrorCode = {
  // bridge-side
  NotConnected: "NOT_CONNECTED",
  Disconnected: "DISCONNECTED",
  Timeout: "TIMEOUT",
  BridgeUnavailable: "BRIDGE_UNAVAILABLE",
  InvalidParams: "INVALID_PARAMS",
  // extension-side (mirrored in the extension adapter)
  UnknownMethod: "UNKNOWN_METHOD",
  AlreadyRecording: "ALREADY_RECORDING",
  NotRecording: "NOT_RECORDING",
  NoTargetTab: "NO_TARGET_TAB",
  TabNotRecordable: "TAB_NOT_RECORDABLE",
  StartFailed: "START_FAILED",
  StopFailed: "STOP_FAILED",
  Internal: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class BridgeError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.data = data;
  }
}
