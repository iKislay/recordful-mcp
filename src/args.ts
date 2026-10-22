// The CLI's argument parser: positional words and --flags, where some flags
// take a value (--title "Demo" or --title=Demo) and the rest are switches.
import { BridgeError, ErrorCode } from "./protocol/errors.js";

export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const FLAGS_WITH_VALUES = new Set(["tab", "title", "visibility", "limit", "query", "format", "timeout", "target", "component"]);

export const parseArgs = (argv: string[]): Parsed => {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (FLAGS_WITH_VALUES.has(name)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new BridgeError(ErrorCode.InvalidParams, `--${name} needs a value`);
      }
      if (inline === undefined) i += 1;
      flags[name] = value;
    } else {
      if (inline !== undefined) throw new BridgeError(ErrorCode.InvalidParams, `--${name} doesn't take a value`);
      flags[name] = true;
    }
  }
  return { positional, flags };
};

export const intFlag = (flags: Parsed["flags"], name: string): number | undefined => {
  const value = flags[name];
  if (value === undefined) return undefined;
  const n = Number(value);
  if (typeof value !== "string" || !Number.isInteger(n) || n <= 0) {
    throw new BridgeError(ErrorCode.InvalidParams, `--${name} must be a positive whole number`);
  }
  return n;
};
