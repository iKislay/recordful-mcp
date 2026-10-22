import { describe, expect, it } from "vitest";
import { intFlag, parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("splits words and switches", () => {
    expect(parseArgs(["upload", "recording-1.webm", "--force", "--json"])).toEqual({
      positional: ["upload", "recording-1.webm"],
      flags: { force: true, json: true },
    });
  });

  it("reads values as the next word or after =", () => {
    expect(parseArgs(["--title", "Sign-up demo", "--visibility=public"]).flags).toEqual({
      title: "Sign-up demo",
      visibility: "public",
    });
    // A value may contain "=".
    expect(parseArgs(["--query=a=b"]).flags.query).toBe("a=b");
  });

  it("refuses a value flag with no value, and a switch with one", () => {
    expect(() => parseArgs(["--title"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--title", "--json"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--force=yes"])).toThrow(/doesn't take a value/);
  });
});

describe("intFlag", () => {
  it("parses positive whole numbers only", () => {
    expect(intFlag({ limit: "5" }, "limit")).toBe(5);
    expect(intFlag({}, "limit")).toBeUndefined();
    expect(() => intFlag({ limit: "0" }, "limit")).toThrow();
    expect(() => intFlag({ limit: "2.5" }, "limit")).toThrow();
    expect(() => intFlag({ limit: true }, "limit")).toThrow();
  });
});
