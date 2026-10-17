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
  // Page tools: act on the tab the user handed to Recordful (see page.ts).
  PageNavigate: "page.navigate",
  PageSnapshot: "page.snapshot",
  PageClick: "page.click",
  PageType: "page.type",
  PagePress: "page.press",
  PageScroll: "page.scroll",
  PageWaitFor: "page.waitFor",
  PageScreenshot: "page.screenshot",
} as const;
export type Method = (typeof Method)[keyof typeof Method];

export const METHODS: readonly Method[] = Object.values(Method);

export const isMethod = (value: string): value is Method =>
  (METHODS as readonly string[]).includes(value);
