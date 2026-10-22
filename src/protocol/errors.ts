// Stable error codes. Agents and humans both see these, so they are part of
// the public contract: add new ones freely, never repurpose an existing one.
export const ErrorCode = {
  // bridge-side
  NotConnected: "NOT_CONNECTED",
  Disconnected: "DISCONNECTED",
  Timeout: "TIMEOUT",
  BridgeUnavailable: "BRIDGE_UNAVAILABLE",
  InvalidParams: "INVALID_PARAMS",
  PairingPending: "PAIRING_PENDING",
  PairingDenied: "PAIRING_DENIED",
  // extension-side (mirrored in the extension adapter)
  UnknownMethod: "UNKNOWN_METHOD",
  AlreadyRecording: "ALREADY_RECORDING",
  NotRecording: "NOT_RECORDING",
  NoTargetTab: "NO_TARGET_TAB",
  TabNotRecordable: "TAB_NOT_RECORDABLE",
  StartFailed: "START_FAILED",
  StopFailed: "STOP_FAILED",
  Internal: "INTERNAL",
  // page tools (extension-side)
  NotArmed: "NOT_ARMED",
  TabNotActive: "TAB_NOT_ACTIVE",
  PageNotScriptable: "PAGE_NOT_SCRIPTABLE",
  StaleRef: "STALE_REF",
  ElementNotInteractable: "ELEMENT_NOT_INTERACTABLE",
  ElementObscured: "ELEMENT_OBSCURED",
  NavigationFailed: "NAVIGATION_FAILED",
  WaitTimeout: "WAIT_TIMEOUT",
  // uploads, videos, transcripts (extension-side)
  NoRecording: "NO_RECORDING",
  CloudUnavailable: "CLOUD_UNAVAILABLE",
  CloudUnreachable: "CLOUD_UNREACHABLE",
  CloudError: "CLOUD_ERROR",
  NotSignedIn: "NOT_SIGNED_IN",
  ProRequired: "PRO_REQUIRED",
  VideoNotFound: "VIDEO_NOT_FOUND",
  StorageFull: "STORAGE_FULL",
  NotUploaded: "NOT_UPLOADED",
  RateLimited: "RATE_LIMITED",
  TranscriptionUnavailable: "TRANSCRIPTION_UNAVAILABLE",
  TranscriptionFailed: "TRANSCRIPTION_FAILED",
  UploadFailed: "UPLOAD_FAILED",
  UploadInterrupted: "UPLOAD_INTERRUPTED",
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
