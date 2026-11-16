// Driver for the markdown-render-speed-02 entry.
// The harness runs `node /bot/main.ts`. It reads every case from
// /input/cases.json, renders each one alone with parse() from parse.js,
// and writes the HTML strings, in order, to /output/html.json.
// Outside a container the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// environment variables stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as { id: string; markdown: string }[];

const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
