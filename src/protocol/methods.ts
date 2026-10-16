// Methods the bridge may call on the extension. Params are validated here
// before they go on the wire; results are passed through to the agent as-is
// (the extension is the source of truth for their shape, see docs/protocol.md).

export const Method = {
  StatusGet: "status.get",
  RecordingStart: "recording.start",
  RecordingStop: "recording.stop",
  RecordingPause: "recording.pause",
  RecordingResume: "recording.resume",
  CaptureProbe: "capture.probe",
} as const;
export type Method = (typeof Method)[keyof typeof Method];

export const METHODS: readonly Method[] = Object.values(Method);

export const isMethod = (value: string): value is Method =>
  (METHODS as readonly string[]).includes(value);
