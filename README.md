# marked-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/drop9490-ship-it/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/drop9490-ship-it/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch. `parse(markdown)` returns exactly the HTML that marked 18.1.3 renders with default options (GFM on, breaks off), byte for byte on the CommonMark 0.31.2 and GFM 0.29 spec examples — and renders it faster than marked itself.

Status: **720/720 on the practice set** (all 680 spec examples plus all 40 generated documents). The parser reproduces marked's emphasis rules exactly — opener-first scanning with the rule of three, leftovers kept inside a formed wrap, and the code-span masking that hides delimiter runs inside phantom code spans — as well as its tab expansion inside blockquotes, lists and fenced code.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` and writes `/output/html.json` (set `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` to point elsewhere). `parse.js` is a dependency-free ES module: `import { parse } from './parse.js'`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9ncycshz&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
