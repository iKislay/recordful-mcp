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
  // Recordings once they exist: uploads, cloud videos, transcripts (see video.ts).
  AccountGet: "account.get",
  TakesList: "takes.list",
  VideoUpload: "video.upload",
  VideoGet: "video.get",
  VideoList: "video.list",
  VideoTranscript: "video.transcript",
  // Managing videos, folders and comments (Recordful Pro).
  VideoUpdate: "video.update",
  VideoDelete: "video.delete",
  VideoEngagement: "video.engagement",
  VideoComment: "video.comment",
  VideoLike: "video.like",
  VideoMove: "video.move",
  FolderList: "folder.list",
  FolderCreate: "folder.create",
  StorageGet: "storage.get",
} as const;
export type Method = (typeof Method)[keyof typeof Method];

export const METHODS: readonly Method[] = Object.values(Method);

export const isMethod = (value: string): value is Method =>
  (METHODS as readonly string[]).includes(value);
