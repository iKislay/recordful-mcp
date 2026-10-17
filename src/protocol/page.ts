// Params for the page.* methods: actions Recordful performs in the tab the
// user handed to it (clicked its icon on), so agents with no browser tool of
// their own can still walk through a feature. The MCP tools and the `call`
// CLI both validate with these before anything goes on the wire; the
// extension validates again, since it can't trust its peer either.
import { z } from "zod";
import { BridgeError, ErrorCode } from "./errors.js";
import { Method } from "./methods.js";

// Refs come from page.snapshot and stay stable for an element while it is on
// the page; a navigation starts a new set.
export const ElementRef = z
  .string()
  .regex(/^e[1-9]\d{0,6}$/, 'ref must look like "e12", taken from the latest snapshot')
  .describe('Element ref from the latest snapshot, e.g. "e12".');

const httpUrl = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL")
  .describe("Absolute http(s) URL to open in the recorded tab.");

const NAMED_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];
const MODIFIERS = ["Control", "Shift", "Alt", "Meta"];
// "Enter", "a", "Shift+Tab", "Control+a", "Meta+Enter".
const KEY_COMBO = new RegExp(`^(?:(?:${MODIFIERS.join("|")})\\+)*(?:${NAMED_KEYS.join("|")}|[^\\s+]|\\+)$`, "u");

export const pageParams = {
  [Method.PageNavigate]: {
    url: httpUrl,
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .optional()
      .describe("How long to wait for the page to finish loading, in milliseconds (default 20000)."),
  },
  [Method.PageSnapshot]: {
    scope: z
      .enum(["page", "viewport"])
      .optional()
      .describe('"page" (default) lists elements on the whole page; "viewport" only those currently visible.'),
  },
  [Method.PageClick]: {
    ref: ElementRef,
  },
  [Method.PageType]: {
    ref: ElementRef,
    text: z.string().max(2_000).describe("Text to type into the field, as a person would."),
    clear: z
      .boolean()
      .optional()
      .describe("Select and replace what the field already holds (default false: type after it)."),
    delayMs: z
      .number()
      .int()
      .min(0)
      .max(300)
      .optional()
      .describe("Average delay between keystrokes in milliseconds (default about 70; 0 fills the field at once)."),
  },
  [Method.PagePress]: {
    key: z
      .string()
      .max(40)
      .regex(KEY_COMBO, 'key must be a key name such as "Enter", "Tab", "Escape", "ArrowDown", "a" or "Shift+Tab"')
      .describe(
        `Key to press in the focused element, optionally with modifiers: ${NAMED_KEYS.slice(0, 14).join(", ")}, F1–F12, or a single character, e.g. "Enter", "Shift+Tab", "Control+a".`,
      ),
  },
  [Method.PageScroll]: {
    ref: ElementRef.optional().describe("Scroll this element into view. Give either ref or direction."),
    direction: z
      .enum(["up", "down", "left", "right"])
      .optional()
      .describe("Scroll the page this way. Give either ref or direction."),
    amount: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .optional()
      .describe("Pixels to scroll with direction (default: most of a screen)."),
  },
  [Method.PageWaitFor]: {
    text: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Wait until this text is on the page (case-insensitive). Give either text or ref."),
    ref: ElementRef.optional().describe("Wait until this element is visible (or gone). Give either text or ref."),
    state: z
      .enum(["visible", "hidden"])
      .optional()
      .describe('"visible" (default) waits for it to appear; "hidden" waits for it to go away.'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(60_000)
      .optional()
      .describe("How long to wait, in milliseconds (default 10000)."),
  },
  [Method.PageScreenshot]: {},
} satisfies Record<string, z.ZodRawShape>;

export type PageMethod = keyof typeof pageParams;
export type PageParams<M extends PageMethod> = z.infer<z.ZodObject<(typeof pageParams)[M]>>;

export const isPageMethod = (method: string): method is PageMethod =>
  Object.prototype.hasOwnProperty.call(pageParams, method);

const exactlyOne = (params: Record<string, unknown>, a: string, b: string) => {
  const count = [a, b].filter((key) => params[key] !== undefined).length;
  if (count !== 1) {
    throw new BridgeError(ErrorCode.InvalidParams, `Give exactly one of ${a} or ${b}.`);
  }
};

// Validates params for a page method, rejecting unknown keys, and returns them
// with undefined fields dropped so the wire stays tidy.
export const parsePageParams = <M extends PageMethod>(method: M, params: unknown): PageParams<M> => {
  const result = z.object(pageParams[method]).strict().safeParse(params ?? {});
  if (!result.success) {
    throw new BridgeError(
      ErrorCode.InvalidParams,
      result.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "),
    );
  }
  const parsed = result.data as Record<string, unknown>;
  if (method === Method.PageScroll) exactlyOne(parsed, "ref", "direction");
  if (method === Method.PageWaitFor) exactlyOne(parsed, "text", "ref");
  if (method === Method.PageScroll && parsed.amount !== undefined && parsed.direction === undefined) {
    throw new BridgeError(ErrorCode.InvalidParams, "amount only applies with direction.");
  }
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as PageParams<M>;
};

// How long the extension may legitimately spend on a page method, beyond the
// bridge's base request budget: cursor motion, human-paced typing, loads.
export const pageExtraWaitMs = (method: PageMethod, params: Record<string, unknown>): number => {
  switch (method) {
    case Method.PageNavigate:
      return typeof params.timeoutMs === "number" ? params.timeoutMs : 20_000;
    case Method.PageClick:
      // Motion, then up to 10s for a navigation the click started.
      return 12_000;
    case Method.PageType: {
      const text = typeof params.text === "string" ? params.text : "";
      const delay = typeof params.delayMs === "number" ? params.delayMs : 70;
      // Keystrokes jitter up to about twice the average, plus pauses at spaces.
      return 5_000 + text.length * (delay * 2 + 40);
    }
    case Method.PageWaitFor:
      return typeof params.timeoutMs === "number" ? params.timeoutMs : 10_000;
    case Method.PageScroll:
      return 5_000;
    default:
      return 0;
  }
};
