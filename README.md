# marked-fast

A dependency-free Markdown renderer written from scratch in plain
JavaScript. It takes a Markdown string and returns exactly the HTML
that marked 18.1.3 produces with its default options (CommonMark
0.31.2 plus GitHub-flavoured extensions: tables, strikethrough, task
lists and bare autolinks, with hard breaks off).

The whole parser lives in `parse.js` and exports a single pure
function, `parse(markdown)`, which reads no files, no clock and no
environment, and keeps nothing between calls. `main.ts` is a thin
driver: it reads the cases the make.fun kit hands over, renders each
one with `parse()`, and writes the HTML strings back out in the same
order.

![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/drop9490-ship-it/marked-fast/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/drop9490-ship-it/marked-fast/reward.svg)

## Usage

```js
import { parse } from "./parse.js";

parse("# Hello\n\nSome *emphasised* text.");
// "<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n"
```

The driver is run by the kit with `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` set; it reads `cases.json` from the input
directory and writes `html.json` to the output directory.
