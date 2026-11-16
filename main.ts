// main.ts — driver for the marked-fast entry.
//
// Reads the cases the kit hands over, renders each one with the local
// parse() implementation, and writes the HTML strings back out in the
// same order. This is the only file in the repo that touches the
// filesystem; parse.js itself is a pure function of its input string.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8"));

// Render every case in order. The output is a plain JSON array of HTML
// strings, one per input case, in exactly the same order.
const html = cases.map((c: { id: string; markdown: string }) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));

