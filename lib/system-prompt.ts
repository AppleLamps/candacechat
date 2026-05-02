import { readFileSync } from "fs";
import { join } from "path";

export const DEFAULT_SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), "systemprompt.md"),
  "utf8"
);
