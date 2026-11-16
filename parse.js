// parse.js — a fast CommonMark 0.31.2 + GFM renderer whose output matches
// marked 18.1.3 (default options: gfm on, breaks off) byte for byte.
// Written from the CommonMark spec and the observed behaviour of marked on
// the practice set; no code is taken from marked or any other renderer.

// ---------- emphasis masking ----------
// marked hides code spans, links and HTML tags from its emphasis scan by
// first rewriting the paragraph text: backticks inside a code span become
// '+', then each such span is replaced by a same-length '[aaa...]' placeholder.
// A code span can therefore "form" in the masked copy even when this
// parser did not tokenise it as one (an unbalanced run in a link label
// pairs with a later run of the same length), and any * _ ~ run inside
// that masked span is invisible to emphasis. We replicate just that
// rewrite here to find the spans, so delimiter runs inside them can be
// hidden. The two patterns below are the standard CommonMark code-span
// shapes (an opening run, non-backtick content, the same closing run,
// not followed by another backtick); the surrounding logic is our own.
const MASK_OT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_CODE_RE = /(?<!`)(`+)[^`]+\1(?!`)/g;
// Ranges [start, end) of the paragraph text that the masking hides.
// Only code spans are needed here: links and HTML tags are already
// atomic nodes in this parser, so no paragraph-level delimiter run can
// sit inside one; a phantom code span is the one case that can.
function maskedCodeRanges(text) {
  const t1 = text.replace(MASK_OT_RE, (m, open, esc) => {
    if (esc !== undefined) return '+'.repeat(m.length);
    if (open === undefined) return m;
    // A code span: keep its delimiter runs, neutralise inner backticks.
    return open + m.slice(open.length, m.length - open.length).replace(/`/g, '+') + open;
  });
  const ranges = [];
  MASK_CODE_RE.lastIndex = 0;
  let m;
  while ((m = MASK_CODE_RE.exec(t1)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
function inRanges(ranges, pos) {
  for (let k = 0; k < ranges.length; k++) {
    if (pos >= ranges[k][0] && pos < ranges[k][1]) return true;
  }
  return false;
}

// ---------- escaping ----------
// Sticky email matcher (anchored at lastIndex, so no slice is needed).
const EMAIL_RE = /[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/y;
// Expand leading tabs in a code-block content line to spaces. A tab at
// column col expands to the next tab stop (4 - col%4 spaces). Only
// applies when col > 0 (a tab at column 0 is literal content in marked).
function expandLeadTabs(s, col) {
  let i = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 9) {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
      i++;
    } else if (c === 32) {
      out += ' ';
      col++;
      i++;
    } else break;
  }
  return i === 0 ? s : out + s.slice(i);
}
// Text escaping (marked's no-encode form): escape & < > " ', except that an
// & starting something that looks like a character reference (&name;,
// &#123;, &#x1F;) is left alone. Named references are NOT decoded by
// marked, so they survive here verbatim.
const RE_AMP_OK = /&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
function escText(s) {
  // Fast path: no special chars at all.
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      // lookahead: is this the start of a reference-looking sequence?
      let j = i + 1;
      if (j < s.length && s.charCodeAt(j) === 35) { // #
        j++;
        if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x/X
          j++;
          let n = 0;
          while (j < s.length && n < 6) {
            const h = s.charCodeAt(j);
            if (!((h >= 48 && h <= 57) || (h >= 65 && h <= 70) || (h >= 97 && h <= 102))) break;
            j++; n++;
          }
          if (n > 0 && j < s.length && s.charCodeAt(j) === 59) continue; // valid-looking: leave
        } else {
          let n = 0;
          while (j < s.length && n < 7) {
            const h = s.charCodeAt(j);
            if (h < 48 || h > 57) break;
            j++; n++;
          }
          if (n > 0 && j < s.length && s.charCodeAt(j) === 59) continue;
        }
      } else {
        let n = 0;
        while (j < s.length) {
          const h = s.charCodeAt(j);
          if (!((h >= 48 && h <= 57) || (h >= 65 && h <= 90) || (h >= 97 && h <= 122) || h === 95)) break;
          j++; n++;
        }
        if (n > 0 && j < s.length && s.charCodeAt(j) === 59) continue;
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Backslash escapes: \ + ASCII punctuation yields the punctuation char.
const ASCII_PUNCT_SET = new Set([...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~']);
function unescapeBackslash(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && ASCII_PUNCT_SET.has(s[i + 1])) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Code escaping: every & < > " ' is escaped (no reference lookahead).
function escCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// URL cleaning (marked's cleanUrl without sanitizing): encodeURI, then
// restore literal % signs. Returns null when encodeURI throws (lone
// surrogates), in which case the link renders as plain text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

function escHref(href) {
  const cleaned = cleanUrl(href);
  if (cleaned === null) return null;
  return escText(cleaned);
}

// ---------- numeric character references ----------
// marked decodes only numeric references: &#123; (1-7 decimal digits) and
// &#x1F600; / &#X41; (1-6 hex digits). 0, surrogates and > 0x10FFFF become
// U+FFFD. Anything else is left as text (and escaped by escText later).
// Returns the decoded character, or null when this is not a valid ref.
function decodeNumericRef(s, i) {
  // s[i] === '&', s[i+1] === '#'
  let j = i + 2;
  let hex = false;
  if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const start = j;
  let val = 0;
  let n = 0;
  const max = hex ? 6 : 7;
  while (j < s.length && n < max) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    if (d < 0) break;
    val = hex ? val * 16 + d : val * 10 + d;
    j++; n++;
  }
  if (n === 0 || j >= s.length || s.charCodeAt(j) !== 59) return null;
  if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) return { ch: '\uFFFD', end: j + 1 };
  return { ch: String.fromCodePoint(val), end: j + 1 };
}

// ---------- small helpers ----------
const SPACE_TAB = 32, TAB = 9, NL = 10;
function isSpace(c) { return c === 32 || c === 9; }
function isBlankLine(s) { return /^[ \t]*$/.test(s); }
// Count leading spaces of a line, with tabs expanding to 4-column stops.
// Returns {spaces, pos} where pos is the index just past the whitespace
// consumed for `spaces` columns (a partially consumed tab leaves the rest
// of the tab as virtual spaces, tracked by `pend`).
function indentOf(s, maxCol) {
  let col = 0, pos = 0, pend = 0;
  while (pos < s.length && col < maxCol) {
    const c = s.charCodeAt(pos);
    if (c === 32) { col++; pos++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > maxCol) { pend = col + w - maxCol; col = maxCol; }
      else { col += w; pos++; }
    } else break;
  }
  return { col, pos, pend };
}

// ---------- block parsing ----------
// Each source line is prepared once: `exp` is the line with every tab
// expanded to spaces (column == index), `orig` maps an expanded column to
// the original index where content starting there begins, and `lead` gives
// how many literal spaces to prepend when content starts inside a tab
// (a partially consumed tab becomes spaces, per CommonMark).
function prepLine(s) {
  if (s.indexOf('\t') === -1) return { s, exp: s, orig: null, lead: null };
  let exp = '';
  const orig = [];
  const lead = [];
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) {
      const w = 4 - (col % 4);
      for (let j = 0; j < w; j++) { exp += ' '; orig.push(i + 1); lead.push(w - j); }
      col += w;
    } else {
      exp += s[i]; orig.push(i); lead.push(0); col++;
    }
  }
  return { s, exp, orig, lead };
}
// Is expanded column k the first expanded column of a tab in the
// original line? A tab's expansion looks like spaces in the expanded
// line, but it is content (to be expanded at its column), not
// indentation to strip.
function isTabStart(L, k) {
  if (L.orig === null || k < 0 || k >= L.exp.length) return false;
  const oi = L.orig[k];
  return oi > 0 && L.s.charCodeAt(oi - 1) === 9 && (k === 0 || L.orig[k - 1] !== oi);
}
// Content of a prepared line from expanded column k (tabs preserved except
// a partially consumed one, which becomes spaces).
function lineContent(L, k) {
  if (k >= L.exp.length) return '';
  if (L.orig === null) return L.s.slice(k);
  const oi = L.orig[k];
  // If k is the first expanded column of a tab, keep the original tab.
  if (oi > 0 && L.s.charCodeAt(oi - 1) === 9 && (k === 0 || L.orig[k - 1] !== oi)) {
    return L.s.slice(oi - 1);
  }
  const lead = L.lead[k];
  return (lead ? ' '.repeat(lead) : '') + L.s.slice(oi);
}
// Is the prepared line blank from expanded column k?
function lineBlankFrom(L, k) {
  const e = L.exp;
  for (let i = k; i < e.length; i++) if (e.charCodeAt(i) !== 32) return false;
  return true;
}

// Link reference definition parsing (spec appendix). Tries to parse one
// definition starting at lines[li], column `col` (already past container
// prefixes and up to 3 spaces of indent). Returns {def, nextLine, nextCol}
// or null. `def` = {label, dest, title}. The label is raw (unnormalized);
// normalization happens at lookup time.
function parseRefDef(lines, li, col) {
  let line = li;
  let e = lines[line].exp;
  let i = col;
  // up to 3 spaces of indent already consumed by caller; label must start '['
  if (i >= e.length || e.charCodeAt(i) !== 91) return null; // [
  i++;
  let label = '';
  let closed = false;
  while (!closed) {
    while (i < e.length) {
      const c = e.charCodeAt(i);
      if (c === 92 && i + 1 < e.length && ASCII_PUNCT.has(e[i + 1])) { // backslash escape: keep raw
        label += e[i] + e[i + 1]; i += 2; continue;
      }
      if (c === 91) return null; // unescaped [ inside label
      if (c === 93) { closed = true; i++; break; } // ]
      label += e[i]; i++;
    }
    if (closed) break;
    // End of line without ]: the label may continue on the next line
    // (but not across a blank line).
    line++;
    if (line >= lines.length) return null;
    if (lineBlankFrom(lines[line], 0)) return null;
    label += '\n';
    e = lines[line].exp;
    i = 0;
  }
  if (label.length === 0 || label.length > 999) return null;
  // A label that is only whitespace normalizes to empty: not a definition.
  if (normalizeLabel(label).length === 0) return null;
  // optional whitespace, then ':' (on the label's closing line)
  while (i < e.length && e.charCodeAt(i) === 32) i++;
  if (i >= e.length || e.charCodeAt(i) !== 58) return null; // :
  i++;
  // skip whitespace incl. newlines (up to one line's worth is handled by
  // moving to following lines when the rest is blank)
  let pos = i;
  for (;;) {
    const LL = lines[line];
    const ee = LL.exp;
    while (pos < ee.length && (ee.charCodeAt(pos) === 32)) pos++;
    if (pos < ee.length) break;
    line++;
    if (line >= lines.length) return null;
    pos = 0;
  }
  // destination: <...> or bare
  let dest = '';
  const LL = lines[line];
  const ee = LL.exp;
  if (pos < ee.length && ee.charCodeAt(pos) === 60) { // <
    pos++;
    const start = pos;
    let ok = false;
    while (pos < ee.length) {
      const c = ee.charCodeAt(pos);
      if (c === 10 || c === 60) return null;
      if (c === 62) { ok = true; break; } // >
      if (c === 92 && pos + 1 < ee.length && ASCII_PUNCT.has(ee[pos + 1])) { dest += ee[pos + 1]; pos += 2; continue; }
      dest += ee[pos]; pos++;
    }
    if (!ok) return null;
    pos++; // past >
  } else {
    // bare destination: no spaces/control, parens balanced (or escaped)
    let depth = 0;
    const start = pos;
    while (pos < ee.length) {
      const c = ee.charCodeAt(pos);
      if (c === 32 || c < 32) break;
      if (c === 92 && pos + 1 < ee.length && ASCII_PUNCT.has(ee[pos + 1])) { dest += ee[pos + 1]; pos += 2; continue; }
      if (c === 40) depth++; // (
      else if (c === 41) { // )
        if (depth === 0) break;
        depth--;
      }
      dest += ee[pos]; pos++;
    }
    if (pos === start || depth !== 0) return null;
  }
  // optional whitespace, then optional title on this line or the next
  let tline = line, tpos = pos, skippedWs = false;
  for (;;) {
    const TL = lines[tline];
    const te = TL.exp;
    while (tpos < te.length && te.charCodeAt(tpos) === 32) { tpos++; skippedWs = true; }
    if (tpos < te.length) break;
    tline++;
    if (tline >= lines.length) {
      // definition ends here (no title)
      return { def: { label, dest, title: null }, nextLine: tline, nextCol: 0 };
    }
    tpos = 0;
    skippedWs = true;
  }
  let title = null;
  {
    const TL = lines[tline];
    const te = TL.exp;
    const c = te.charCodeAt(tpos);
    // A title must be separated from the destination by whitespace.
    if ((c === 34 || c === 39 || c === 40) && !skippedWs) return null;
    // If the title search moved to a later line and that line does not
    // start a title, the definition ends at the end of the destination's
    // line (the next line is separate content, e.g. another definition).
    if (tline > line && c !== 34 && c !== 39 && c !== 40) {
      return { def: { label, dest, title: null }, nextLine: line, nextCol: pos };
    }
    if (c === 34 || c === 39 || c === 40) { // " ' (
      const open = c, close = c === 40 ? 41 : c;
      const titleOnLaterLine = tline > line;
      // A title attempt that starts on a following line must never
      // invalidate the definition: if it fails, the def stands without
      // a title and the following line is left unconsumed.
      const noTitle = () => ({ def: { label, dest, title: null }, nextLine: line, nextCol: pos });
      let tl = tline, tp = tpos + 1;
      let t = '';
      let done = false;
      while (tl < lines.length) {
        const XL = lines[tl];
        const xe = XL.exp;
        while (tp < xe.length) {
          const ch = xe.charCodeAt(tp);
          if (ch === 92 && tp + 1 < xe.length && ASCII_PUNCT.has(xe[tp + 1])) {
            t += xe[tp + 1]; tp += 2; continue;
          }
          if (ch === close) { done = true; break; }
          if (ch === 10) break;
          t += xe[tp]; tp++;
        }
        if (done) {
          title = t;
          // after the title only whitespace may follow on the line
          let q = tp + 1;
          while (q < xe.length && xe.charCodeAt(q) === 32) q++;
          if (q < xe.length) return titleOnLaterLine ? noTitle() : null;
          return { def: { label, dest, title }, nextLine: tl, nextCol: q };
        }
        tl++; tp = 0;
        // title may not span a blank line
        if (tl < lines.length && lineBlankFrom(lines[tl], 0)) return titleOnLaterLine ? noTitle() : null;
        if (tl < lines.length) t += '\n';
      }
      return titleOnLaterLine ? noTitle() : null; // unterminated title
    }
  }
  // no title: rest of the line must be blank
  {
    const TL = lines[tline];
    if (!lineBlankFrom(TL, tpos)) return null;
  }
  return { def: { label, dest, title }, nextLine: tline, nextCol: tpos };
}

// Normalize a link label for lookup: collapse whitespace runs to one
// space, trim, and Unicode case-fold (marked's whole-string chain:
// toLowerCase -> toUpperCase -> toLowerCase, which folds ß/ẞ to ss and
// ﬀ to ff).
function normalizeLabel(label) {
  let out = '';
  let ws = true; // leading whitespace skipped
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) {
      if (!ws) { out += ' '; ws = true; }
    } else {
      out += label[i];
      ws = false;
    }
  }
  if (ws && out.length > 0) out = out.slice(0, -1);
  return out.toLowerCase().toUpperCase().toLowerCase();
}

// ---------- block parser main loop ----------
// Node kinds: doc, quote, list, item, para, h, code, html, hr, table.
// A list item tracks `contentCol` (absolute column where its content
// starts) and `markerCol`; a list tracks tight/loose at close time.
function parseBlocks(src) {
  const norm = src.replace(/\r\n?/g, '\n');
  const srcEndsNL = norm.endsWith('\n');
  const rawLines = norm.split('\n');
  // A trailing newline does not make an extra empty line.
  if (srcEndsNL) rawLines.pop();
  const lines = rawLines.map(prepLine);
  const n = lines.length;
  // Was line li terminated by a newline in the source?
  const terminated = (li) => li < n - 1 || srcEndsNL;
  const refs = new Map(); // normalized label -> {dest, title}
  const doc = { t: 'doc', children: [] };
  const stack = [doc]; // open containers, doc at bottom; leaf kept separate
  let leaf = null; // current open leaf block (para/code/html) or null

  function addChild(node) {
    stack[stack.length - 1].children.push(node);
  }
  function closeLeaf() {
    if (!leaf) return;
    if (leaf.t === 'para') {
      finalizePara(leaf);
      if (leaf.dead) {
        // The paragraph was only link reference definitions: remove it.
        const parent = stack[stack.length - 1];
        if (parent.children[parent.children.length - 1] === leaf) parent.children.pop();
      }
    } else if (leaf.t === 'code') {
      // Trailing blank lines: indented code drops all of them; fenced
      // code drops exactly one (the line before the closing fence).
      // Content always ends with one newline when non-empty.
      const ls = leaf.lines;
      if (leaf.fenced) {
        if (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      } else {
        while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      }
      leaf.text = ls.length === 0 ? '' : ls.join('\n') + '\n';
    } else if (leaf.t === 'html') {
      // Provisional text without a trailing newline; the post-pass
      // fixHtmlTrailingNewlines() at the end of parseBlocks sets the
      // correct trailing newline (it needs the finished tree to know
      // whether the block sits in the last item of a list).
      leaf.text = leaf.lines.join('\n');
    }
    leaf = null;
  }
  // Does source line j match every container in chain (outermost first,
  // doc excluded), the Phase-1 container matching, read-only? Returns
  // {ok, content} where content is the line's content in the container's
  // sub-input (after container prefixes); null when it does not match.
  // For a blank line inside an item, marked strips the item indent from
  // it too, so the indent is advanced here to compute the content.
  function matchChain(j, chain) {
    const L = lines[j];
    const e = L.exp;
    let pos = 0;
    for (const node of chain) {
      if (node.t === 'quote') {
        let p = pos, sp = 0;
        while (p < e.length && e.charCodeAt(p) === 32 && sp < 3) { sp++; p++; }
        if (p < e.length && e.charCodeAt(p) === 62) {
          p++;
          if (p < e.length && (e.charCodeAt(p) === 32 || e.charCodeAt(p) === 9)) p++;
          pos = p;
        } else return { ok: false, content: null };
      } else if (node.t === 'item') {
        if (lineBlankFrom(L, pos)) {
          let p = pos, avail = 0;
          while (p < e.length && e.charCodeAt(p) === 32 && avail < node.contentIndent) { avail++; p++; }
          pos = p;
        } else {
          const need = node.contentIndent;
          let p = pos, avail = 0;
          while (p < e.length && e.charCodeAt(p) === 32 && avail < need) { avail++; p++; }
          if (avail >= need) pos = p;
          else return { ok: false, content: null };
        }
      }
      // 'list' matches always, no prefix.
    }
    return { ok: true, content: e.slice(pos) };
  }
  // Does marked's last-item trimEnd() strip this html block's trailing
  // newline? Only when the block sits directly in an item (a quote's '>'
  // markers shield the newline), that item is the last item of its list,
  // and the block is the item's last child.
  function htmlAtEndOfLastItem(node, chain) {
    const parent = chain[chain.length - 1];
    if (!parent || parent.t !== 'item') return false;
    const list = chain[chain.length - 2];
    if (!list || list.t !== 'list') return false;
    if (list.children[list.children.length - 1] !== parent) return false;
    return parent.children[parent.children.length - 1] === node;
  }
  // Fix up every html block's trailing newline. Marked's html token keeps
  // one trailing newline iff the container's sub-input has exactly one
  // newline after the block's last line: a following non-empty line
  // (even a whitespace-only line, which stops the regex's \n+), a single
  // trailing blank line at the end of the container (unless the last
  // item's text is trimEnd()ed), or a terminated top-level end of input.
  // An empty line followed by more content, two or more trailing blank
  // lines, or a container that ends right after the block all drop it.
  // EXCEPTION: types 6 and 7 (block-level tags and other tags) end with
  // (?:(?:\n[ \t]*)+\n|$) in marked's regex, which consumes a following
  // whitespace-only line as a blank line, so for them a whitespace-only
  // line drops the newline; types 1-5 (pre/script/comment/pi/decl/cdata)
  // keep it, their regexes ending in (\n+) or [^\n]*\n*.
  function fixHtmlTrailingNewlines(node, chain) {
    if (node.t === 'html') {
      let keepNL = false;
      const blankEnds = node.htmlType === 6 || node.htmlType === 7;
      const isBlank = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return false; } return true; };
      if (terminated(node.lastLi) && node.lines.length > 0) {
        const parent = chain[chain.length - 1];
        if (!parent || parent.t === 'doc') {
          // Top level: the sub-input is the raw source. Keep iff the
          // next raw line is non-empty (whitespace counts, except for
          // types 6/7 where it is a blank line) or absent.
          keepNL = node.lastLi + 1 >= n || (blankEnds ? !isBlank(lines[node.lastLi + 1].exp) : lines[node.lastLi + 1].exp.length > 0);
        } else {
          // Inside containers: scan the lines after lastLi that belong
          // to this container chain, counting leading empty lines.
          let emptyCount = 0;
          let decided = false;
          for (let j = node.lastLi + 1; j < n; j++) {
            const m = matchChain(j, chain);
            if (!m.ok) break; // container ended
            if (blankEnds ? !isBlank(m.content) : m.content.length > 0) { keepNL = emptyCount === 0; decided = true; break; }
            emptyCount++;
          }
          if (!decided) {
            // Container ended (or EOF): keep only for exactly one
            // trailing empty line, and not when the last item is trimmed.
            keepNL = emptyCount === 1 && !htmlAtEndOfLastItem(node, chain);
          }
        }
      }
      node.text = node.lines.join('\n') + (keepNL ? '\n' : '');
    }
    if (node.children) {
      const childChain = (node.t === 'quote' || node.t === 'item' || node.t === 'list')
        ? chain.concat(node) : chain;
      for (const ch of node.children) fixHtmlTrailingNewlines(ch, childChain);
    }
  }
  // Strip leading link reference definitions from a paragraph's lines,
  // registering them in refs. Returns the remaining lines.
  function stripLeadingRefDefs(plines) {
    let linesLeft = plines;
    let li = 0;
    while (li < linesLeft.length) {
      const first = linesLeft[li];
      const r = tryRefDefAt(lines, first, li, linesLeft);
      if (!r) break;
      const norm = normalizeLabel(r.def.label);
      if (!refs.has(norm)) refs.set(norm, { dest: r.def.dest, title: r.def.title });
      linesLeft = r.rest;
      li = 0;
    }
    return linesLeft;
  }
  // Finalize a paragraph: strip leading link reference definitions; if
  // anything remains, check for a table, else keep as paragraph.
  function finalizePara(p) {
    let linesLeft = stripLeadingRefDefs(p.lines);
    if (linesLeft.length === 0) { p.dead = true; return; }
    p.lines = linesLeft;
    // Table check: at least 2 lines, second line a delimiter row.
    if (linesLeft.length >= 2) {
      const tbl = tryTable(linesLeft);
      if (tbl) { p.t = 'table'; p.aligns = tbl.aligns; p.header = tbl.header; p.rows = tbl.rows; p.lines = null; }
    }
  }
  // Try to parse a ref def starting at paragraph-lines index `idx`
  // (linesLeft[idx] = {L, col}); a def may span following paragraph lines.
  // Returns {def, rest} where rest is the remaining paragraph lines, or null.
  function tryRefDefAt(allLines, first, idx, linesLeft) {
    // Build a virtual view: the def starts at (first.L, first.col) and may
    // continue onto the following paragraph lines, each from column 0.
    const seq = [];
    seq.push({ L: first.L, col: first.col, paraIdx: idx });
    for (let k = idx + 1; k < linesLeft.length; k++) seq.push({ L: linesLeft[k].L, col: 0, paraIdx: k });
    // parseRefDef works on an array of prepared lines; adapt: temporarily
    // build a small array of {exp,...} wrappers. Our parseRefDef expects
    // lines[] with .exp and lineBlankFrom; a paragraph line contributes
    // its content from its start column. To keep it simple, synthesize
    // prepared-line objects for the sequence.
    const synth = seq.map(s => {
      const content = lineContent(s.L, s.col);
      return prepLine(content);
    });
    // The label may be indented up to 3 spaces (paragraph lines keep
    // their leading spaces now); skip them before the label.
    let col0 = 0;
    const e0 = synth[0].exp;
    while (col0 < e0.length && e0.charCodeAt(col0) === 32 && col0 < 3) col0++;
    const r = parseRefDef(synth, 0, col0);
    if (!r) return null;
    if (r.nextLine >= seq.length) return { def: r.def, rest: [] };
    // The def consumed synth lines 0..r.nextLine (partially, at r.nextCol).
    // Map back to paragraph lines: if it ends mid-line (nextCol > 0 or the
    // def's last line is a paragraph line with content after it), the rest
    // of that paragraph line becomes the start of the remaining paragraph.
    const endParaIdx = seq[r.nextLine].paraIdx;
    const rest = [];
    if (r.nextLine < synth.length) {
      // content remaining on the def's last line, from r.nextCol
      const rem = lineContent(synth[r.nextLine], r.nextCol);
      if (rem !== '' && !lineBlankFrom(synth[r.nextLine], r.nextCol)) {
        rest.push({ L: prepLine(rem), col: 0 });
      }
    }
    for (let k = endParaIdx + 1; k < linesLeft.length; k++) rest.push(linesLeft[k]);
    return { def: r.def, rest };
  }
  // Table recognition on paragraph lines (after ref-def stripping).
  // Returns {aligns, header, rows} or null. Each cell is raw inline text.
  function tryTable(plines) {
    const headText = plines.map(p => lineContent(p.L, p.col)).join('\n');
    const headLines = headText.split('\n');
    // header = first line; delimiter = second line
    const headerLine = headLines[0];
    const delimLine = headLines[1];
    if (headerLine === undefined || delimLine === undefined) return null;
    if (headerLine.indexOf('|') === -1 && delimLine.indexOf('|') === -1) return null;
    const aligns = parseDelimRow(delimLine);
    if (!aligns) return null;
    const header = splitRow(headerLine);
    if (header.length !== aligns.length) return null;
    const ncol = aligns.length;
    // Header must have at least one cell; adjust to ncol.
    const rows = [];
    for (let i = 2; i < headLines.length; i++) {
      const hl = headLines[i];
      // A tab-only line is an empty row: marked's table regex excludes
      // only spaces-only lines ((?! *\n)), so a tab line passes and
      // becomes a row. A spaces-only line is skipped (it cannot be in
      // a paragraph except the EOF trailing-spaces case, not a row).
      if (hl.trim() === '' && hl.indexOf('\t') === -1) continue;
      rows.push(splitRow(hl));
    }
    // A table's rows are only the paragraph's lines; blank line ends it.
    // (headLines came from a single paragraph, so no blank lines inside.)
    return { aligns, header, rows, ncol };
  }
  function parseDelimRow(line) {
    const cells = splitRow(line, true);
    if (cells.length === 0) return null;
    const aligns = [];
    for (const cell of cells) {
      const c = cell.trim();
      if (!/^:?-+:?$/.test(c)) return null;
      if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
      else if (c.endsWith(':')) aligns.push('right');
      else if (c.startsWith(':')) aligns.push('left');
      else aligns.push(null);
    }
    return aligns;
  }
  // Split a table row on unescaped pipes not inside code spans.
  // If `delim` is set, leading/trailing pipes are ignored and empty edge
  // cells dropped (delimiter-row semantics).
  // Split a table row on unescaped `|`. Marked's splitter (de) has NO
  // code-span tracking: a `|` inside backticks still splits (only `\|`
  // is safe), so a `` ``add` `` cell followed by `| `a \| b` `` splits
  // at that `|` even though an inline code span would span it.
  function splitRow(line, delim) {
    const cells = [];
    let cur = '';
    let i = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 92 && i + 1 < line.length) {
        // \| is an escaped pipe: it becomes a literal | in the cell.
        // Other escapes are kept for the inline parser.
        if (line.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
        cur += line[i] + line[i + 1]; i += 2; continue;
      }
      if (c === 124) { // |
        cells.push(cur); cur = ''; i++; continue;
      }
      cur += line[i]; i++;
    }
    cells.push(cur);
    // Drop empty edge cells when the row starts/ends with a pipe.
    if (line.trimStart().startsWith('|')) cells.shift();
    if (line.trimEnd().endsWith('|')) cells.pop();
    return cells;
  }

  function closeContainers(toDepth) {
    // Close everything above stack[toDepth] (containers) plus the leaf.
    closeLeaf();
    while (stack.length > toDepth + 1) {
      const node = stack.pop();
      if (node.t === 'list') finalizeList(node);
    }
  }
  // A leaf block can never be a direct child of a list: pop any list left
  // open at the top of the stack (its item did not match this line).
  function closeOpenLists() {
    while (stack.length > 1 && stack[stack.length - 1].t === 'list') {
      finalizeList(stack.pop());
    }
  }
  function finalizeList(list) {
    // Loose if any item is separated by a blank line, or any item has a
    // blank line between its block children.
    let loose = false;
    const items = list.children;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.blankBetween) { loose = true; break; }
      if (it.endsBlank && i < items.length - 1) { loose = true; break; }
    }
    list.tight = !loose;
  }

  // --- leaf starters (return a new leaf node, or null) ---
  // `pos` is an expanded column in L.exp (after container prefixes and
  // up to 3 spaces of indent already consumed by the caller where noted).
  function tryATX(L, pos) {
    const e = L.exp;
    let i = pos;
    let level = 0;
    while (i < e.length && e.charCodeAt(i) === 35 && level < 7) { level++; i++; }
    if (level === 0 || level > 6) return null;
    if (i < e.length && e.charCodeAt(i) !== 32 && e.charCodeAt(i) !== 9) return null;
    // skip spaces/tabs after the hashes
    while (i < e.length && (e.charCodeAt(i) === 32 || e.charCodeAt(i) === 9)) i++;
    let text = lineContent(L, i).replace(/[ \t]+$/, '');
    // strip closing sequence: spaces + #'s at end, or the whole content
    // when it is only #'s (the space after the opening hashes precedes it)
    if (/^#+$/.test(text)) text = '';
    else text = text.replace(/[ \t]+#+$/, '');
    return { t: 'h', level, text };
  }
  function tryFence(L, pos) {
    const e = L.exp;
    let i = pos;
    const ch = e.charCodeAt(i);
    if (ch !== 96 && ch !== 126) return null; // ` or ~
    let len = 0;
    while (i < e.length && e.charCodeAt(i) === ch) { len++; i++; }
    if (len < 3) return null;
    let info = lineContent(L, i).trim();
    if (ch === 96 && info.indexOf('`') !== -1) return null;
    return { t: 'code', fenced: true, fenceCh: ch, fenceLen: len, info, lines: [], indent: pos };
  }
  function tryHr(L, pos) {
    const e = L.exp;
    let i = pos;
    const c = e.charCodeAt(i);
    if (c !== 45 && c !== 95 && c !== 42) return null; // - _ *
    let n = 0;
    while (i < e.length) {
      const ch = e.charCodeAt(i);
      if (ch === c) { n++; i++; }
      else if (ch === 32 || ch === 9) { i++; }
      else return null;
    }
    return n >= 3 ? { t: 'hr' } : null;
  }
  // HTML block start conditions (7 types). Returns the type (1-7) or 0.
  const HTML_TAG_OPEN = /^(?:script|pre|style|textarea)(?:[\s>]|$)/i;
  const HTML_COMMENT = /^!--/;
  const HTML_PI = /^\?/;
  const HTML_DECL = /^![A-Za-z]/;
  const HTML_CDATA = /^!\[CDATA\[/;
  const HTML_BLOCK_TAGS = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$)/i;
  function htmlBlockType(L, pos) {
    const text = lineContent(L, pos);
    if (text.charCodeAt(0) !== 60) return 0; // <
    const rest = text.slice(1);
    if (rest.startsWith('/')) {
      const after = rest.slice(1);
      if (HTML_BLOCK_TAGS.test(after)) return 6;
      // A closing tag of any other name can still be type 7 (below).
    } else {
      if (HTML_BLOCK_TAGS.test(rest)) return 6;
      if (HTML_COMMENT.test(rest)) return 2;
      if (HTML_PI.test(rest)) return 3;
      if (HTML_DECL.test(rest)) return 4;
      if (HTML_CDATA.test(rest)) return 5;
      if (HTML_TAG_OPEN.test(rest)) return 1;
    }
    // Type 7: a complete open/closing tag (any name) alone on the line.
    const tagEnd = matchRawHtml(text, 0);
    if (tagEnd !== -1 && text.slice(tagEnd).trim() === '') return 7;
    return 0;
  }
  // Does a line start a list item? Returns {bullet, ordered, start, delim,
  // contentCol, markerLen} or null. `pos` is the column after container
  // prefixes (indent up to 3 spaces is allowed before the marker).
  function tryListItem(L, pos) {
    const e = L.exp;
    let i = pos;
    // up to 3 spaces of indent
    let sp = 0;
    while (i < e.length && e.charCodeAt(i) === 32 && sp < 3) { sp++; i++; }
    if (i >= e.length) return null;
    const markerCol = i;
    const c = e.charCodeAt(i);
    let bullet = false, ordered = false, start = 1, delim = '.', bulletChar = null;
    let markerEnd = i;
    if (c === 45 || c === 43 || c === 42) { // - + *
      bullet = true; bulletChar = e[i]; markerEnd = i + 1;
    } else if (c >= 48 && c <= 57) {
      let j = i, num = 0, digits = 0;
      while (j < e.length && e.charCodeAt(j) >= 48 && e.charCodeAt(j) <= 57 && digits < 9) { num = num * 10 + (e.charCodeAt(j) - 48); j++; digits++; }
      if (digits === 0 || digits > 9) return null;
      if (j >= e.length || (e.charCodeAt(j) !== 46 && e.charCodeAt(j) !== 41)) return null;
      delim = e.charCodeAt(j) === 46 ? '.' : ')';
      start = num;
      ordered = true;
      markerEnd = j + 1;
    } else return null;
    // marker must be followed by space/tab/EOL
    if (markerEnd < e.length) {
      const nc = e.charCodeAt(markerEnd);
      if (nc !== 32 && nc !== 9) return null;
    }
    // content indent: marker width + following spaces (up to 4 spaces, or
    // 1 tab), per spec; if 5+ spaces follow, content indent is marker+1.
    let j = markerEnd;
    let spaces = 0;
    while (j < e.length && e.charCodeAt(j) === 32 && spaces < 5) { spaces++; j++; }
    if (j < e.length && e.charCodeAt(j) === 9) {
      // a tab after the marker: counts as (4 - col%4) spaces
      const colAfter = markerEnd - pos + spaces; // columns from pos
      const w = 4 - ((pos + (markerEnd - pos) + spaces) % 4);
      spaces += w;
      j++;
    }
    let contentCol;
    const blankAfter = markerEnd >= e.length || lineBlankFrom(L, markerEnd);
    if (blankAfter) {
      // The line is blank after the marker: the item is empty on this
      // line and the content indent is marker width + 1, whatever the
      // number of spaces after the marker.
      contentCol = markerEnd + 1;
    } else if (spaces === 0) {
      contentCol = markerEnd + 1;
    } else if (spaces >= 5) {
      contentCol = markerEnd + 1;
    } else {
      contentCol = markerEnd + spaces;
    }
    // contentCol is absolute (expanded column). The item's content starts
    // there; but if the line after the marker is blank, contentCol is
    // markerEnd+1 and the item is empty.
    return { bullet, ordered, start, delim, bulletChar, contentCol, markerEnd, markerCol, blank: markerEnd >= e.length || lineBlankFrom(L, markerEnd) };
  }

  // --- main loop ---
  for (let li = 0; li < n; li++) {
    const L = lines[li];
    const e = L.exp;
    // Phase 1: match open containers outermost-first. `pos` is the expanded
    // column after the matched container prefixes; `depth` is how many
    // containers (excluding doc) matched.
    let pos = 0;
    let depth = 0;
    let allMatched = true;
    let preQuotePos = 0;
    for (let s = 1; s < stack.length; s++) {
      const node = stack[s];
      if (node.t === 'quote') {
        let p = pos, sp = 0;
        while (p < e.length && e.charCodeAt(p) === 32 && sp < 3) { sp++; p++; }
        if (p < e.length && e.charCodeAt(p) === 62) { // >
          p++;
          if (p < e.length && (e.charCodeAt(p) === 32 || e.charCodeAt(p) === 9)) p++;
          preQuotePos = pos; pos = p; depth = s;
        } else { allMatched = false; break; }
      } else if (node.t === 'item') {
        // An empty item followed by a blank line does not match
        // following content: the content falls outside the list.
        if (node.children.length === 0 && node.pendingBlank) { allMatched = false; break; }
        if (lineBlankFrom(L, pos)) { depth = s; continue; }
        const need = node.contentIndent;
        let p = pos, avail = 0;
        while (p < e.length && e.charCodeAt(p) === 32 && avail < need) { avail++; p++; }
        if (avail >= need) { pos = p; depth = s; }
        else { allMatched = false; break; }
      } else if (node.t === 'list') {
        depth = s;
      }
    }
    const blank = lineBlankFrom(L, pos);

    // Multi-line leaves consume their lines before anything else.
    if (leaf && leaf.t === 'code' && leaf.fenced) {
      if (!allMatched) {
        // RC-J1: if the mismatch is list-item containers only (no
        // blockquote) and the fence already has content, the line is
        // fence content, not the end of the fence. A non-matching first
        // content line, or a line that looks like a closing fence, still
        // ends the fence (close + retry).
        let listOnly = true;
        for (let s = depth + 1; s < stack.length; s++) {
          if (stack[s].t === 'quote') { listOnly = false; break; }
        }
        let isClose = false;
        if (listOnly) {
          let p = pos, sp = 0;
          while (p < e.length && e.charCodeAt(p) === 32 && sp < 3) { sp++; p++; }
          if (p < e.length && e.charCodeAt(p) === leaf.fenceCh) {
            let len = 0, q = p;
            while (q < e.length && e.charCodeAt(q) === leaf.fenceCh) { len++; q++; }
            if (len >= leaf.fenceLen && lineBlankFrom(L, q)) isClose = true;
          }
        }
        if (!listOnly || isClose || leaf.lines.length === 0) {
          closeLeaf(); closeContainers(depth); closeOpenLists();
          li--; continue;
        }
        // Fence content: strip the innermost item's content indent, but
        // only when the line has at least that many leading spaces;
        // otherwise keep the line whole.
        let need = 0;
        for (let s = stack.length - 1; s >= 1; s--) {
          if (stack[s].t === 'item') { need = stack[s].contentIndent; break; }
        }
        let sp = 0;
        while (pos + sp < e.length && e.charCodeAt(pos + sp) === 32) sp++;
        let q = sp >= need ? pos + need : pos;
        let content = lineContent(L, q);
        if (q > 0 && content.charCodeAt(0) === 9) content = expandLeadTabs(content, q);
        leaf.lines.push(content);
        leaf.lastLi = li;
        continue;
      }
      let p = pos, sp = 0;
      while (p < e.length && e.charCodeAt(p) === 32 && sp < 3) { sp++; p++; }
      let ok = false;
      if (p < e.length && e.charCodeAt(p) === leaf.fenceCh) {
        let len = 0, q = p;
        while (q < e.length && e.charCodeAt(q) === leaf.fenceCh) { len++; q++; }
        if (len >= leaf.fenceLen && lineBlankFrom(L, q)) ok = true;
      }
      if (ok) { closeLeaf(); continue; }
      // Content from expanded column pos. If pos sits inside a tab
      // that starts after the quote marker (preQuotePos), lineContent
      // would hand back the tab's remaining spaces expanded at the
      // absolute column; the re-expansion below must instead see the
      // raw tab so it can expand it at its column in the quote's text
      // (pos - preQuotePos). A tab starting before the quote marker
      // (e.g. in a list indent) keeps lineContent's spaces: there the
      // absolute expansion is the right one.
      let content = lineContent(L, pos);
      if (L.orig !== null && pos < L.exp.length && pos > 0 && L.orig[pos] > 0 && L.s.charCodeAt(L.orig[pos] - 1) === 9) {
        // First expanded column of this tab: scan back while orig matches.
        let a = pos;
        while (a > 0 && L.orig[a - 1] === L.orig[pos]) a--;
        if (a > preQuotePos) content = '\t' + L.s.slice(L.orig[pos]);
      }
      if (stack.length > 1) {
        // Inside a container: marked outdents container prefixes in
        // columns, so expand the leading whitespace run to spaces,
        // then strip the fence indent (in columns). A tab after a `>`
        // marker expands at its column in the quote's text
        // (pos - preQuotePos), not its absolute column.
        let _d = depth; while (_d >= 1 && stack[_d].t === 'list') _d--;
        let col = (stack[_d].t === 'quote') ? pos - preQuotePos : pos, k = 0, out = '';
        while (k < content.length) {
          const cc = content.charCodeAt(k);
          if (cc === 32) { out += ' '; col++; k++; }
          else if (cc === 9) { const w = 4 - (col % 4); out += '    '.slice(0, w); col += w; k++; }
          else break;
        }
        content = out + content.slice(k);
        // Dt is a no-op for ~~~ fences (indentCodeCompensation only
        // matches ```), so a tilde fence keeps its full indent.
        let cut = 0;
        while (leaf.fenceCh !== 126 && cut < leaf.fenceIndent && cut < content.length && content.charCodeAt(cut) === 32) cut++;
        content = content.slice(cut);
      } else {
        // Top level: marked's Dt strips up to fenceIndent leading
        // whitespace characters (a tab counts as one and survives
        // when beyond the strip); no strip at all for ~~~ fences.
        let cut = 0;
        while (leaf.fenceCh !== 126 && cut < leaf.fenceIndent && cut < content.length && (content.charCodeAt(cut) === 32 || content.charCodeAt(cut) === 9)) cut++;
        content = content.slice(cut);
      }
      leaf.lines.push(content);
      leaf.lastLi = li;
      continue;
    }
    if (leaf && leaf.t === 'html') {
      if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); li--; continue; }
      if (blank) {
        if (leaf.htmlType === 6 || leaf.htmlType === 7) { closeLeaf(); }
        else { leaf.lines.push(''); leaf.lastLi = li; continue; }
      } else {
        const text = lineContent(L, pos);
        leaf.lines.push(text);
        leaf.lastLi = li;
        if (htmlBlockEnds(leaf, text)) { closeLeaf(); }
        continue;
      }
    }
    if (leaf && leaf.t === 'code' && !leaf.fenced) {
      if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); li--; continue; }
      let p = pos, sp = 0;
      while (p < e.length && e.charCodeAt(p) === 32 && sp < 4) { sp++; p++; }
      if (sp >= 4) { leaf.lines.push(lineContent(L, p)); leaf.lastLi = li; continue; }
      if (blank) { leaf.lines.push(''); leaf.lastLi = li; continue; }
      closeLeaf();
    }

    if (blank) {
      // A trailing spaces-only line at end of input is part of the open
      // paragraph (its spaces are the paragraph's last line), not a
      // separator.
      if (li === n - 1 && leaf && leaf.t === 'para' && pos < e.length) {
        leaf.lines.push({ L, col: pos });
        continue;
      }
      // Tab-only blank line inside a paragraph that already forms a
      // valid table: marked keeps it as an empty row, so keep it in
      // the paragraph instead of closing it. (A tab line before the
      // delimiter still breaks the table: tryTable fails there, so
      // the line closes the paragraph as usual. Tab lines between
      // plain paragraphs do not diverge -- marked's paragraph regex
      // excludes [ \t]+\n lines -- so this is table-scoped.)
      if (leaf && leaf.t === 'para' && allMatched && lineContent(L, pos).indexOf('\t') !== -1 && tryTable(leaf.lines)) {
        leaf.lines.push({ L, col: pos });
        continue;
      }
      // Blank line: closes the open leaf, and any container the blank
      // line does not match (a blockquote without its marker). A list
      // item is matched by a blank line, so lists stay open.
      if (!allMatched) closeContainers(depth);
      else closeLeaf();
      // A blank line marks every open item; when new content starts,
      // only the item directly containing it turns the mark into a
      // blank-between (the others' marks are cleared, so a blank line
      // deep inside a nested item does not loosen the outer lists).
      // directBlank is set only when the blank line is directly in the
      // item (not nested in a blockquote inside it): it drives endsBlank.
      // A blank line inside a blockquote does not mark any item at all:
      // it is contained within the quote.
      const inQuote = depth < stack.length && stack[depth].t === 'quote';
      if (!inQuote) {
        for (let s = 1; s < stack.length; s++) {
          const node = stack[s];
          if (node.t === 'item') node.pendingBlank = true;
        }
        if (depth < stack.length && stack[depth].t === 'item') stack[depth].directBlank = true;
      }
      continue;
    }

    // Setext heading: only when every container matched and a paragraph
    // is open. Reference definitions at the start of the paragraph are
    // stripped first; if nothing remains, this is not a heading.
    if (leaf && leaf.t === 'para' && allMatched) {
      let p = pos, sp = 0;
      while (p < e.length && e.charCodeAt(p) === 32 && sp < 3) { sp++; p++; }
      if (p < e.length && (e.charCodeAt(p) === 61 || e.charCodeAt(p) === 45)) {
        const ch = e.charCodeAt(p);
        let q = p;
        while (q < e.length && e.charCodeAt(q) === ch) q++;
        if (lineBlankFrom(L, q)) {
          leaf.lines = stripLeadingRefDefs(leaf.lines);
          // A paragraph that already forms a table is not a setext
          // heading: the =/- line is a table row, not an underline.
          if (leaf.lines.length > 0 && !tryTable(leaf.lines)) {
            const h = { t: 'h', level: ch === 61 ? 1 : 2, text: paraText(leaf).trim() };
            const parent = stack[stack.length - 1];
            parent.children[parent.children.length - 1] = h;
            leaf = null;
            continue;
          }
          // Nothing left, or a table: fall through so the underline
          // line joins the paragraph as content.
        }
      }
    }

    // Start new blocks. This loop handles nested container starts
    // (blockquote, list items) followed by a leaf.
    let cur = pos;
    let started = false;
    // True when this line started a sibling item in an already-open
    // list: the item is not a new block inside the parent item, so a
    // blank line before it must not make the parent item blankBetween.
    let siblingItem = false;
    for (let guard = 0; guard < 12 && !started; guard++) {
      // (a) blockquote container start
      {
        let p = cur, sp = 0;
        while (p < e.length && e.charCodeAt(p) === 32 && sp < 3) { sp++; p++; }
        if (p < e.length && e.charCodeAt(p) === 62) {
          if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); }
          else if (leaf && leaf.t === 'para') { closeLeaf(); }
          p++;
          if (p < e.length && (e.charCodeAt(p) === 32 || e.charCodeAt(p) === 9)) p++;
          preQuotePos = cur;
          const q = { t: 'quote', children: [] };
          addChild(q);
          stack.push(q);
          depth = stack.length - 1;
          allMatched = true;
          cur = p;
          continue;
        }
      }
      let lead = cur, sp = 0;
      while (lead < e.length && e.charCodeAt(lead) === 32 && sp < 3) { sp++; lead++; }
      const paraOpen = leaf && leaf.t === 'para';
      // (b) ATX heading
      const atx = tryATX(L, lead);
      if (atx) {
        if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); }
        else if (leaf) closeLeaf();
        addChild(atx);
        started = true; break;
      }
      // (c) fenced code
      const fence = tryFence(L, lead);
      if (fence) {
        if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); }
        else if (leaf) closeLeaf();
        fence.fenceIndent = lead - cur;
        addChild(fence);
        leaf = fence;
        started = true; break;
      }
      // (d) HTML block
      const htype = htmlBlockType(L, lead);
      if (htype !== 0 && (!paraOpen || htype !== 7)) {
        if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); }
        else if (leaf) closeLeaf();
        const hb = { t: 'html', htmlType: htype, lines: [lineContent(L, cur)], lastLi: li };
        addChild(hb);
        leaf = hb;
        if (htype !== 6 && htype !== 7 && htmlBlockEnds(hb, hb.lines[0])) { closeLeaf(); }
        started = true; break;
      }
      // (e) thematic break
      if (tryHr(L, lead)) {
        if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); }
        else if (leaf) closeLeaf();
        addChild({ t: 'hr' });
        started = true; break;
      }
      // (f) list item
      const item = tryListItem(L, cur);
      if (item) {
        // An empty item cannot interrupt a paragraph (unless a container
        // already failed to match, i.e. we are continuing a list).
        // A nested list inside a list item can interrupt the item's
        // paragraph regardless of start number.
        const inItem = stack.length > 1 && stack[stack.length - 1].t === 'item';
        const canInterrupt = !paraOpen || !allMatched || inItem || (!item.blank && (item.bullet || item.start === 1));
        if (canInterrupt) {
          if (!allMatched) { closeLeaf(); closeContainers(depth); }
          else if (leaf) closeLeaf();
          let parent = stack[stack.length - 1];
          // A list item of a different type than the open list closes
          // that list; the new list is a sibling, not a child. The type
          // is the bullet character (for bullets) or the delimiter.
          const sameListType = (a, b) => a.bullet === b.bullet && (a.bullet ? a.bulletChar === b.bulletChar : a.delim === b.delim);
          if (parent.t === 'list' && !sameListType(parent, item)) {
            const popped = stack.pop();
            if (popped.t === 'list') finalizeList(popped);
            parent = stack[stack.length - 1];
          }
          let list = null;
          let listOnStack = false;
          if (parent.t === 'list' && sameListType(parent, item)) { list = parent; listOnStack = true; }
          else {
            const last = parent.children[parent.children.length - 1];
            if (last && last.t === 'list' && sameListType(last, item)) list = last;
          }
          // A sibling item in the open list is not a new block inside
          // the parent item: a blank line before it separated list
          // items, so it must not make any ancestor item blankBetween.
          if (listOnStack) siblingItem = true;
          if (!list) {
            list = { t: 'list', bullet: item.bullet, bulletChar: item.bulletChar, delim: item.delim, start: item.start, children: [] };
            parent.children.push(list);
          }
          const it = { t: 'item', children: [], contentIndent: item.contentCol - cur, baseCol: cur, pendingBlank: false, blankBetween: false, endsBlank: false };
          list.children.push(it);
          if (!listOnStack) stack.push(list);
          stack.push(it);
          depth = stack.length - 1;
          allMatched = true;
          cur = item.contentCol;
          // Task list item: [ ] / [x] / [X] followed by a space and
          // content on the same line. The checkbox is rendered before
          // the item's first block; the space after ] stays in the text.
          if (cur + 3 < e.length && e.charCodeAt(cur) === 91 && e.charCodeAt(cur + 2) === 93) {
            const m = e.charCodeAt(cur + 1);
            const nc = e.charCodeAt(cur + 3);
            if ((m === 32 || m === 120 || m === 88) && (nc === 32 || nc === 9) && !lineBlankFrom(L, cur + 4)) {
              it.task = (m === 32) ? 'unchecked' : 'checked';
              cur += 3;
            }
          }
          if (item.blank) { started = true; break; }
          continue;
        }
      }
      // (g) indented code (cannot interrupt a paragraph)
      if (!paraOpen) {
        let p = cur, spc = 0;
        while (p < e.length && e.charCodeAt(p) === 32 && spc < 4) { spc++; p++; }
        if (spc >= 4) {
          if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); }
          const cb = { t: 'code', fenced: false, lines: [lineContent(L, p)], lastLi: li };
          addChild(cb);
          leaf = cb;
          started = true; break;
        }
      }
      // (h) paragraph: start new, or continue the open one. The content
      // starts at cur (after container prefixes); leading spaces are
      // part of the paragraph's text, not stripped. A line that is blank
      // after the prefixes starts no paragraph, but an open paragraph
      // still takes it as a continuation (its spaces are content).
      if (lineBlankFrom(L, cur) && !(leaf && leaf.t === 'para')) {
        if (leaf) closeLeaf();
        started = true; break;
      }
      // Deepest container the paragraph line sits in (for the quote
      // J-expansion of a leading tab): walk past trailing lists.
      let _pd = stack.length - 1; while (_pd >= 1 && stack[_pd].t === 'list') _pd--;
      const paraInQuote = stack[_pd].t === 'quote';
      if (leaf && leaf.t === 'para') {
        let col = cur;
        let pad = 0;
        let pushed = false;
        if (!allMatched) {
          // A lazy setext underline (`=` run) is not a heading; it joins
          // the paragraph as text, padded out to exactly 4 leading
          // spaces (fewer than 4 are topped up, 4+ are kept as-is).
          let sp = 0, p = cur;
          while (p < e.length && e.charCodeAt(p) === 32 && sp < 3) { sp++; p++; }
          let isSetextEq = false;
          if (p < e.length && e.charCodeAt(p) === 61) {
            let q = p;
            while (q < e.length && e.charCodeAt(q) === 61) q++;
            if (lineBlankFrom(L, q)) isSetextEq = true;
          }
          if (isSetextEq) {
            let I = 0;
            while (cur + I < e.length && e.charCodeAt(cur + I) === 32) I++;
            if (I < 4) { col = cur + I; pad = 4 - I; }
            leaf.lines.push({ L, col, pad });
            pushed = true;
          } else {
            // Lazy continuation inside a list item: the line did not match
            // the item's content indent, but it is still paragraph content.
            // Strip leading spaces by the continuation rule, measured from
            // cur (after the containers that did match): strip min(I, C)
            // if the indent I >= the item's content indent C or I >= 4;
            // otherwise keep the spaces (col stays cur). With no list item
            // in the stack (e.g. inside a blockquote), strip exactly 4
            // spaces when I >= 4, else keep them.
            let foundItem = false;
            for (let s = stack.length - 1; s >= 1; s--) {
              if (stack[s].t === 'item') {
                foundItem = true;
                const it = stack[s];
                const C = it.contentIndent;
                let I = 0;
                while (cur + I < e.length && e.charCodeAt(cur + I) === 32 && !isTabStart(L, cur + I)) I++;
                if (I >= C || I >= 4) col = cur + Math.min(I, C);
                break;
              }
              if (stack[s].t === 'list') break;
            }
            if (!foundItem) {
              let I = 0;
              while (cur + I < e.length && e.charCodeAt(cur + I) === 32 && !isTabStart(L, cur + I)) I++;
              if (I >= 4) col = cur + 4;
            }
          }
        }
        if (!pushed) {
          let ln = { L, col };
          // A leading tab in a lazy continuation line expands at its
          // column too (marked does this even when the line did not
          // match every container); the column is relative to the
          // outermost quote marker that did match.
          if (paraInQuote) { const s0 = lineContent(L, col); const s1 = expandLeadTabs(s0, col - preQuotePos); if (s1 !== s0) ln.txt = s1; }
          leaf.lines.push(ln);
        }
      } else {
        if (!allMatched) { closeLeaf(); closeContainers(depth); closeOpenLists(); }
        let _ln = { L, col: cur };
        if (paraInQuote) { const s0 = lineContent(L, cur); const s1 = expandLeadTabs(s0, cur - preQuotePos); if (s1 !== s0) _ln.txt = s1; }
        const p = { t: 'para', lines: [_ln] };
        addChild(p);
        leaf = p;
      }
      started = true; break;
    }
    // New content in an item: only the deepest item containing the new
    // content turns a pending blank into a blank-between; the outer
    // items' marks are cleared (a blank line deep inside a nested item
    // does not loosen the outer lists). The deepest item also loses its
    // directBlank (it did not end with a blank line). A sibling item in
    // an open list is not new content inside the parent item, so it
    // only clears the marks and never sets blankBetween.
    {
      let deepest = -1;
      for (let s = 1; s < stack.length; s++) {
        if (stack[s].t === 'item' && stack[s].pendingBlank) deepest = s;
      }
      if (deepest !== -1 && !siblingItem) { stack[deepest].blankBetween = true; stack[deepest].directBlank = false; }
      for (let s = 1; s < stack.length; s++) {
        if (stack[s].t === 'item') stack[s].pendingBlank = false;
      }
    }
  }
  // End of input: close everything.
  closeLeaf();
  while (stack.length > 1) {
    const node = stack.pop();
    if (node.t === 'list') finalizeList(node);
  }
  markEndsBlank(doc);
  fixHtmlTrailingNewlines(doc, []);
  markTrimEnd(doc);
  return { doc, refs };

  function paraText(p) {
    return p.lines.map(x => x.txt !== undefined ? x.txt : (x.pad ? '    '.slice(0, x.pad) : '') + lineContent(x.L, x.col)).join('\n');
  }
  // marked trimEnd()s every list's last item text: a paragraph that
  // ends the last item (directly, or through trailing blockquotes)
  // loses its trailing spaces/tabs. A nested list's own rule covers
  // text ending inside it, so descent stops at a list.
  function markTrimEnd(node) {
    if (!node.children) return;
    for (const ch of node.children) {
      if (ch.t === 'list' && ch.children.length > 0) {
        let n = ch.children[ch.children.length - 1];
        while (n && n.children && n.children.length > 0) {
          const last = n.children[n.children.length - 1];
          if (last.t === 'quote') { n = last; continue; }
          if (last.t === 'para') last.trimEnd = true;
          break;
        }
      }
      markTrimEnd(ch);
    }
  }
  function markEndsBlank(node) {
    if (!node.children) return;
    for (const ch of node.children) {
      if (ch.t === 'list') {
        const items = ch.children;
        for (let i = 0; i < items.length; i++) {
          if (items[i].pendingBlank && i < items.length - 1) items[i].endsBlank = true;
        }
        let loose = false;
        for (let i = 0; i < items.length; i++) {
          if (items[i].blankBetween || items[i].endsBlank) { loose = true; break; }
        }
        ch.tight = !loose;
      }
      markEndsBlank(ch);
    }
  }
  function htmlBlockEnds(hb, text) {
    switch (hb.htmlType) {
      case 1: return /<\/(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(text);
      case 2: return text.indexOf('-->') !== -1;
      case 3: return text.indexOf('?>') !== -1;
      case 4: return text.indexOf('>') !== -1;
      case 5: return text.indexOf(']]>') !== -1;
      default: return false;
    }
  }
}

// ---------- inline parsing ----------
// Node kinds: 0 text, 1 code, 2 hard break, 3 raw html, 4 em/strong/del,
// 5 link, 6 image.
const ASCII_PUNCT = new Set([...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~']);
const RE_WS = /^\s$/u;
const RE_PUNCT = /^[\p{P}\p{S}]$/u;
function isWsCh(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f' || RE_WS.test(ch); }
function isPunctCh(ch) { return ASCII_PUNCT.has(ch) || RE_PUNCT.test(ch); }

// Match a raw HTML tag/comment/PI/declaration/CDATA at position i.
// Returns the end index (exclusive) or -1.
function matchRawHtml(s, i) {
  const n = s.length;
  if (s.charCodeAt(i) !== 60) return -1; // <
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (abruptly closed) comments.
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const e = s.indexOf('-->', i + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (s.startsWith('<!', i)) {
    if (i + 2 < n) {
      const c = s.charCodeAt(i + 2);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        const e = s.indexOf('>', i + 2);
        return e === -1 ? -1 : e + 1;
      }
      if (s.startsWith('<![CDATA[', i)) {
        const e = s.indexOf(']]>', i + 9);
        return e === -1 ? -1 : e + 3;
      }
    }
    return -1;
  }
  let j = i + 1;
  let closing = false;
  if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; } // /
  if (j >= n) return -1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    return j < n && s.charCodeAt(j) === 62 ? j + 1 : -1;
  }
  // open tag: attributes then optional / then >. An attribute must be
  // preceded by whitespace (also directly after the tag name).
  let needWs = true;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) return j + 1; // >
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2; // />
    if (c === 32 || c === 9 || c === 10) { j++; needWs = false; continue; }
    if (needWs) return -1;
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || (c >= 48 && c <= 57))) return -1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 45 || d === 46) j++;
      else break;
    }
    needWs = true; // after the name, whitespace is required before the next thing
    let skippedWs = false;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) { j++; skippedWs = true; }
    if (skippedWs) needWs = false;
    if (j < n && s.charCodeAt(j) === 61) { // =
      j++;
      while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        let m = 0;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 32 || d === 9 || d === 10 || d === 62 || d === 61 || d === 60 || d === 96 || d === 34 || d === 39) break;
          j++; m++;
        }
        if (m === 0) return -1;
      }
      needWs = true; // after the value, whitespace is required before the next attribute
    }
  }
  return -1;
}

// Try an autolink <scheme:...> or <email> at position i (s[i] === '<').
// Returns {end, href, text} or null.
const RE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;
const RE_EMAIL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
function matchAutolink(s, i) {
  const gt = s.indexOf('>', i + 1);
  if (gt === -1) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0 || /[\s<>]/.test(inner)) return null;
  if (RE_SCHEME.test(inner)) return { end: gt + 1, href: inner, text: inner };
  if (RE_EMAIL.test(inner)) return { end: gt + 1, href: 'mailto:' + inner, text: inner };
  return null;
}

// ---------- inline scanner ----------
function parseInline(text, refs, st) {
  const nodes = [];
  const delims = [];
  const n = text.length;
  let i = 0;
  // Spans the emphasis masking hides (phantom code spans). Only
  // computed when the text has a backtick at all.
  const maskRanges = text.indexOf('`') !== -1 ? maskedCodeRanges(text) : null;

  function pushText(s) {
    if (s === '') return;
    const last = nodes[nodes.length - 1];
    if (last && last.k === 0 && !last.d) last.s += s;
    else nodes.push({ k: 0, s });
  }
  // A delimiter run / '[' / '!': its own text node, never merged.
  function pushDelimNode(s, rec) {
    const node = { k: 0, s, d: rec };
    nodes.push(node);
    rec.node = node;
    rec.arr = nodes;
    delims.push(rec);
    return node;
  }
  function flanking(i0, i1) {
    // delimiter run text[i0..i1); returns {canOpen, canClose} for * and _
    const before = i0 > 0 ? text[i0 - 1] : '';
    const after = i1 < n ? text[i1] : '';
    // Start/end of string counts as whitespace: a leading delimiter
    // cannot close and a trailing delimiter cannot open.
    const beforeWs = before === '' || isWsCh(before);
    const afterWs = after === '' || isWsCh(after);
    const beforePunct = before !== '' && isPunctCh(before);
    const afterPunct = after !== '' && isPunctCh(after);
    const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
    return { leftFlanking, rightFlanking };
  }

  while (i < n) {
    const c = text.charCodeAt(i);
    // Backslash escapes and hard breaks
    if (c === 92) { // \
      const d = i + 1 < n ? text.charCodeAt(i + 1) : -1;
      if (d === 10) { // \<newline> = hard break
        nodes.push({ k: 2 });
        i += 2;
        // A hard break eats the next line's leading spaces.
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (d !== -1 && ASCII_PUNCT.has(text[i + 1])) { nodes.push({ k: 7, s: text[i + 1] }); i += 2; continue; }
      pushText('\\');
      i++;
      continue;
    }
    // Code spans
    if (c === 96) { // `
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const run = j - i;
      // find a matching run of the same length -- but never swallow a
      // `]` that closes a link which would form (marked matches the
      // LINK rule first and tokenises the label in isolation, where no
      // such closer exists). A rejected span leaves its backticks
      // literal and the `]` for tryLink.
      let k = j;
      let found = -1;
      while (k < n) {
        if (text.charCodeAt(k) === 93 && linkWouldFormAt(k)) { found = -2; break; }
        if (text.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && text.charCodeAt(m) === 96) m++;
          if (m - k === run) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found === -2) {
        pushText(text.slice(i, j));
        i = j;
        continue;
      }
      if (found !== -1) {
        let content = text.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        nodes.push({ k: 1, s: content });
        i = found + run;
        continue;
      }
      pushText(text.slice(i, j));
      i = j;
      continue;
    }
    // Images and links
    if (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) { // ![
      const bang = { k: 0, s: '!', bang: true };
      nodes.push(bang);
      pushDelimNode('[', { ch: '[', len: 1, canOpen: true, canClose: false, active: true, image: true, bangNode: bang, pos: i + 1 });
      i += 2;
      continue;
    }
    if (c === 91) { // [
      pushDelimNode('[', { ch: '[', len: 1, canOpen: true, canClose: false, active: true, image: false, pos: i });
      i++;
      continue;
    }
    if (c === 93) { // ]
      const ni = tryLink(i);
      if (ni !== -1) { i = ni; continue; }
      pushText(']');
      i++;
      continue;
    }
    // Autolinks and raw HTML
    if (c === 60) { // <
      const al = matchAutolink(text, i);
      if (al) {
        nodes.push({ k: 5, href: al.href, title: null, auto: true, children: [{ k: 0, s: al.text }] });
        i = al.end;
        continue;
      }
      const he = matchRawHtml(text, i);
      if (he !== -1) {
        const tagText = text.slice(i, he);
        // marked's inline tag() sets state.inLink on `<a ...` and clears
        // it on `</a>`; the flag persists across blocks for the whole
        // parse and gates GFM autolinks (never reset between blocks).
        if (/^<a /i.test(tagText)) st.inLink = true;
        else if (/^<\/a>/i.test(tagText)) st.inLink = false;
        nodes.push({ k: 3, s: tagText });
        i = he;
        continue;
      }
      pushText('<');
      i++;
      continue;
    }
    // Numeric character references (named ones pass through literally)
    if (c === 38 && i + 1 < n && text.charCodeAt(i + 1) === 35) { // &#
      const r = decodeNumericRef(text, i);
      if (r) { pushText(r.ch); i = r.end; continue; }
      pushText('&');
      i++;
      continue;
    }
    // Emphasis / strikethrough delimiter runs
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      const ch = text[i];
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const len = j - i;
      const { leftFlanking, rightFlanking } = flanking(i, j);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlanking && (!rightFlanking || isPunctCh(i > 0 ? text[i - 1] : ''));
        canClose = rightFlanking && (!leftFlanking || isPunctCh(j < n ? text[j] : ''));
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      if (ch === '~') { canOpen = canOpen && len <= 2; canClose = canClose && len <= 2; }
      pushDelimNode(text.slice(i, j), { ch, len, canOpen, canClose, active: true, image: false, pos: i, masked: maskRanges !== null && inRanges(maskRanges, i) });
      i = j;
      continue;
    }
    // GFM extended autolinks: www. / http(s):// / ftp:// / mailto: / xmpp: / emails in text
    // (schemes are case-insensitive; www. is lowercase-only)
    // These fire even inside a link label: marked only suppresses them
    // while tokenising a link that *forms* (state.inLink), so a label
    // whose link fails keeps its autolinks (doc-39). A formed link
    // unwraps them back to text in tryLink (gfm flag).
    if (!st.inLink && (c === 119 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 77 || c === 120 || c === 88)) { // w h H f F m M x X
      const m = matchGfmUrl(i);
      if (m) {
        nodes.push({ k: 5, href: m.href, title: null, auto: true, gfm: true, children: [{ k: 0, s: m.text }] });
        i = m.end;
        continue;
      }
    }
    if (c === 64) { // @ : possible GFM email autolink
      const ni = st.inLink ? null : matchGfmEmail(i);
      if (ni !== null) { i = ni; continue; }
      pushText('@');
      i++;
      continue;
    }
    // Newlines: hard break (2+ trailing spaces) or soft break
    if (c === 10) {
      const last = nodes[nodes.length - 1];
      if (last && last.k === 0 && !last.d) {
        let sp = 0;
        let t = last.s.length;
        while (t > 0 && last.s.charCodeAt(t - 1) === 32) { sp++; t--; }
        if (sp >= 2) {
          last.s = last.s.slice(0, t);
          nodes.push({ k: 2 });
          i++;
          // A hard break eats the next line's leading spaces.
          while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
          continue;
        }
      }
      pushText('\n');
      i++;
      continue;
    }
    // Plain text run (up to the next special character)
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 92 || d === 96 || d === 91 || d === 93 || d === 60 || d === 38 || d === 42 || d === 95 || d === 126 || d === 10 || d === 33 || d === 64) break;
      if (d === 119 && text.startsWith('www.', j)) break;
      if ((d === 104 || d === 72) && text.slice(j, j + 8).toLowerCase().startsWith('http')) {
        const l = text.slice(j, j + 8).toLowerCase();
        if (l.startsWith('http://') || l.startsWith('https://')) break;
      }
      if ((d === 102 || d === 70) && text.slice(j, j + 6).toLowerCase() === 'ftp://') break;
      if (d === 109 && text.startsWith('mailto:', j)) break;
      if (d === 120 && text.startsWith('xmpp:', j)) break;
      j++;
    }
    pushText(text.slice(i, j));
    i = j;
  }

  // ---------- link parsing helpers (inside parseInline scope) ----------
  function skipLinkWs(j) {
    let seenNL = false;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9) { j++; continue; }
      if (c === 10) {
        if (seenNL) return -1;
        seenNL = true; j++; continue;
      }
      break;
    }
    return j;
  }
  function parseLinkTitle(j) {
    const open = text.charCodeAt(j);
    const close = open === 40 ? 41 : open;
    let k = j + 1;
    let t = '';
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c === 92 && k + 1 < n && ASCII_PUNCT.has(text[k + 1])) { t += text[k + 1]; k += 2; continue; }
      if (c === close) return { title: t, end: k + 1 };
      if (c === 10) {
        // may span lines, but not a blank line
        let m = k + 1;
        while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
        if (m >= n || text.charCodeAt(m) === 10) return null;
        t += '\n'; k++; continue;
      }
      t += text[k]; k++;
    }
    return null;
  }
  function parseLinkLabel(j) {
    // text[j] === '['
    let k = j + 1;
    let label = '';
    let seenNL = false;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c === 10) {
        if (seenNL) return null;
        seenNL = true;
        label += '\n'; k++; continue;
      }
      if (c !== 32 && c !== 9) seenNL = false;
      if (c === 92 && k + 1 < n && ASCII_PUNCT.has(text[k + 1])) { label += text[k] + text[k + 1]; k += 2; continue; }
      if (c === 91) return null;
      if (c === 93) return { label, end: k + 1 };
      label += text[k]; k++;
      if (label.length > 999) return null;
    }
    return null;
  }
  function parseInlineLink(j) {
    // text[j] === '('
    let k = skipLinkWs(j + 1);
    if (k === -1) return null;
    let dest = null;
    if (text.charCodeAt(k) === 60) { // <...>
      let m = k + 1;
      let d = '';
      let ok = false;
      while (m < n) {
        const c = text.charCodeAt(m);
        if (c === 10 || c === 60) return null;
        if (c === 62) { ok = true; break; }
        if (c === 92 && m + 1 < n && ASCII_PUNCT.has(text[m + 1])) { d += text[m + 1]; m += 2; continue; }
        d += text[m]; m++;
      }
      if (!ok) return null;
      dest = d;
      k = m + 1;
    } else {
      let m = k, d = '', depth = 0;
      while (m < n) {
        const c = text.charCodeAt(m);
        if (c === 32 || c === 9 || c === 10 || c < 32) break;
        if (c === 92 && m + 1 < n && ASCII_PUNCT.has(text[m + 1])) { d += text[m + 1]; m += 2; continue; }
        if (c === 40) depth++;
        else if (c === 41) { if (depth === 0) break; depth--; }
        d += text[m]; m++;
      }
      if (depth !== 0) return null;
      dest = d;
      k = m;
    }
    let m = skipLinkWs(k);
    if (m === -1) return null;
    let title = null;
    const tc = text.charCodeAt(m);
    if (tc === 34 || tc === 39 || tc === 40) {
      const t = parseLinkTitle(m);
      if (!t) return null;
      title = t.title;
      m = skipLinkWs(t.end);
      if (m === -1) return null;
    }
    if (text.charCodeAt(m) !== 41) return null;
    return { dest, title, end: m + 1 };
  }
  function plainText(ns) {
    let out = '';
    for (const node of ns) {
      if (node.k === 0 || node.k === 1 || node.k === 3) out += node.s;
      else if (node.k === 4 || node.k === 5) out += plainText(node.children);
      else if (node.k === 6) out += node.alt;
    }
    return out;
  }
  // Does this node list contain a (non-autolink) link, looking through
  // emphasis/del wrappers? A link cannot contain another link, but an
  // autolink inside a link's text is allowed (marked renders it).
  function containsLink(ns) {
    for (const node of ns) {
      if (node.k === 5 && !node.auto) return true;
      if (node.k === 4 && containsLink(node.children)) return true;
    }
    return false;
  }
  // Validate a raw link label against the label grammar's backtick
  // rules: every backtick run must open a code span whose content holds
  // no backtick (closed by the next backtick run), or be a run of 2+
  // backticks immediately before the label's closing `]`. A run that
  // cannot be consumed this way (e.g. `` `` a ` b `` `` followed by
  // more text) makes the whole label unmatchable, so the link never
  // forms and the brackets stay literal.
  function labelBackticksOk(raw) {
    let i = 0;
    const n = raw.length;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (c === 92) { i += 2; continue; } // backslash escape
      if (c === 91) { // nested [...] group: skip it balanced
        let depth = 1, j = i + 1;
        while (j < n && depth > 0) {
          if (raw.charCodeAt(j) === 92) { j += 2; continue; }
          if (raw.charCodeAt(j) === 91) depth++;
          else if (raw.charCodeAt(j) === 93) depth--;
          j++;
        }
        if (depth !== 0) return false;
        i = j;
        continue;
      }
      if (c === 96) { // backtick run
        let j = i;
        while (j < n && raw.charCodeAt(j) === 96) j++;
        if (j - i >= 2 && j >= n) { i = j; continue; } // trailing run before ]
        // code span: content up to the next backtick run (no backtick
        // allowed inside), then that run closes it
        let k = j;
        while (k < n && raw.charCodeAt(k) !== 96) k++;
        if (k >= n) return false;
        while (k < n && raw.charCodeAt(k) === 96) k++;
        i = k;
        continue;
      }
      i++;
    }
    return true;
  }
  // When a link fails but the `]` is followed by a complete `(...)`
  // group, the span is an attempted inline link: marked's emphasis
  // masking erases its delimiters from the closer index, so a `*`/`_`
  // run inside the label cannot serve as a closer (it may still open
  // onto a closer outside the span). Clear canClose on those runs.
  function maskFailedInlineLink(opener, closeIdx) {
    if (text.charCodeAt(closeIdx + 1) !== 40) return; // not '('
    // The masking pattern's label cannot contain a `[` (it has no
    // nested-bracket alternative), so a label holding an inner link is
    // never masked and its emphasis still forms.
    if (text.slice(opener.pos + 1, closeIdx).indexOf('[') !== -1) return;
    let depth = 0, end = -1;
    for (let i = closeIdx + 1; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 92) { i++; continue; } // escape
      if (c === 40) { depth++; if (depth > 2) return; }
      else if (c === 41) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return; // no complete group: no masking
    // The label's nodes are everything after the opener's node (the
    // scanner is at `]`, so nothing past the label is in `nodes` yet).
    // A `*`/`_` run whose node is one of them loses canClose.
    const opIdx = nodes.indexOf(opener.node);
    if (opIdx === -1) return;
    const labelNodes = nodes.slice(opIdx + 1);
    for (const d of delims) {
      if ((d.ch === '*' || d.ch === '_') && labelNodes.indexOf(d.node) !== -1) { d.canClose = false; d.noClose = true; }
    }
  }
  // Unwrap GFM autolinks (k:5, gfm) in a forming link's children back
  // to plain text: marked suppresses the url rule while tokenising a
  // link that forms, so a URL/email inside its label stays literal.
  // Explicit <...> autolinks (no gfm flag) are NOT unwrapped.
  function unwrapGfmAutolinks(arr) {
    for (let i = 0; i < arr.length; i++) {
      const nd = arr[i];
      if (nd.k === 5 && nd.gfm) {
        arr[i] = { k: 0, s: nd.children && nd.children[0] ? nd.children[0].s : '' };
      } else if (nd.children) {
        unwrapGfmAutolinks(nd.children);
      }
    }
  }
  function tryLink(closeIdx) {
    let opener = null;
    for (let k = delims.length - 1; k >= 0; k--) {
      const d = delims[k];
      if (d.ch === '[' && d.active) { opener = d; break; }
    }
    if (!opener) return -1;
    // The label must match the label grammar; a code span in it whose
    // content holds a backtick dooms the link (the brackets stay
    // literal and later `]`/shortcuts are still tried).
    if (!labelBackticksOk(text.slice(opener.pos + 1, closeIdx))) {
      opener.active = false;
      maskFailedInlineLink(opener, closeIdx);
      return -1;
    }
    const opIdx = nodes.indexOf(opener.node);
    if (opIdx === -1) { opener.active = false; maskFailedInlineLink(opener, closeIdx); return -1; }
    const children = nodes.slice(opIdx + 1);
    let after = closeIdx + 1;
    let dest = null, title = null, end = -1;
    if (text.charCodeAt(after) === 40) {
      const r = parseInlineLink(after);
      if (r) { dest = r.dest; title = r.title; end = r.end; }
    }
    if (end === -1 && text.charCodeAt(after) === 91) {
      const lab = parseLinkLabel(after);
      if (lab) {
        // A collapsed ref (empty label) takes its key from the link text's
        // raw source, not from the parsed children (escapes/code kept).
        const rawKey = lab.label === '' ? text.slice(opener.pos + 1, closeIdx) : lab.label;
        const key = normalizeLabel(rawKey);
        const ref = refs.get(key);
        if (ref) { dest = ref.dest; title = ref.title; end = lab.end; }
        // A [label] was present but matched no definition: this was a
        // full-reference attempt, so there is no shortcut fallback.
        if (end === -1) { opener.active = false; maskFailedInlineLink(opener, closeIdx); return -1; }
      }
    }
    if (end === -1) {
      // Shortcut ref: the key is the link text's raw source (escapes and
      // code spans kept), not the parsed children.
      const key = normalizeLabel(text.slice(opener.pos + 1, closeIdx));
      const ref = refs.get(key);
      if (ref) { dest = ref.dest; title = ref.title; end = closeIdx + 1; }
    }
    if (end === -1) {
      opener.active = false;
      maskFailedInlineLink(opener, closeIdx);
      return -1;
    }
    // A link cannot contain another link (images are exempt: a link may
    // contain an image, and an image's alt may contain a link).
    if (!opener.image && containsLink(children)) {
      opener.active = false;
      maskFailedInlineLink(opener, closeIdx);
      return -1;
    }
    // GFM autolinks inside a forming link stay literal.
    unwrapGfmAutolinks(children);
    // Deactivate [ delimiters inside the link text; re-tag emphasis
    // delimiters there to the link's children array. Recompute their
    // masking for the label's own context: marked re-tokenises the
    // label, so a phantom span in the paragraph does not hide runs
    // inside the label (and a phantom span inside the label does).
    const labelText = text.slice(opener.pos + 1, closeIdx);
    const labelMask = labelText.indexOf('`') !== -1 ? maskedCodeRanges(labelText) : null;
    for (const d of delims) {
      if (children.indexOf(d.node) !== -1) {
        if (d.ch === '[') d.active = false;
        else {
          d.arr = children;
          if ((d.ch === '*' || d.ch === '_' || d.ch === '~') && d.pos !== undefined) {
            const lp = d.pos - (opener.pos + 1);
            d.masked = labelMask !== null && inRanges(labelMask, lp);
          }
        }
      }
    }
    opener.active = false;
    let node;
    if (opener.image) {
      // Alt text is resolved after emphasis processing (see below).
      node = { k: 6, src: dest, title, alt: '', children };
      const bangIdx = opIdx - 1;
      const removeFrom = (bangIdx >= 0 && nodes[bangIdx] && nodes[bangIdx].bang) ? bangIdx : opIdx;
      nodes.splice(removeFrom, nodes.length - removeFrom, node);
    } else {
      node = { k: 5, href: dest, title, children };
      nodes.splice(opIdx, nodes.length - opIdx, node);
    }
    return end;
  }
  // GFM extended autolinks in text. marked's url rule, in order:
  // mailto:/xmpp: + email, protocol:// or www. + host + tail (backpedalled),
  // bare email. The text run stops before these starts (see the scanner).
  // The backpedal: the longest prefix of s that marked's _backpedal regex
  // matches, i.e. trailing punctuation / unbalanced ')' / trailing &entity;
  // is cut, while balanced (...) groups survive.
  function isGfmPunct(c) {
    return c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === ';' || c === '*' || c === '_' || c === '\'' || c === '"' || c === '~' || c === ')';
  }
  function backpedal(s) {
    let i = 0;
    const m = s.length;
    while (i < m) {
      const c = s[i];
      if (c === '(') {
        const close = s.indexOf(')', i + 1);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
      if (c === '&') {
        if (/^[a-zA-Z0-9]+;$/.test(s.slice(i + 1))) break;
        i++;
        continue;
      }
      if (isGfmPunct(c)) {
        let j = i;
        while (j < m && isGfmPunct(s[j])) j++;
        if (j >= m) break;
        i = j;
        continue;
      }
      let j = i;
      while (j < m && !isGfmPunct(s[j]) && s[j] !== '(' && s[j] !== '&') j++;
      i = j;
    }
    return s.slice(0, i);
  }
  // Match an email whose local part starts at i. Returns {end, email} or
  // null. Domain: label (. label)+, labels of [A-Za-z0-9-_] (first) and
  // [A-Za-z0-9-_]*[A-Za-z0-9] (later); the char after the domain must not
  // be a word char or '-'.
  function matchEmailAt(i) {
    EMAIL_RE.lastIndex = i;
    const m = EMAIL_RE.exec(text);
    if (!m) return null;
    const end = i + m[0].length;
    if (end < n) {
      const c = text.charCodeAt(end);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) return null;
      if (c === 95) {
        // A trailing `_` run blocks the email unless it is an emphasis
        // closer: the whole run must be followed by whitespace / end /
        // punctuation, and an active `_` opener must exist for it to
        // close (e.g. `__…table@x.com__ `). Without an opener
        // (`foo@bar.com_ baz`, `foo@bar.com__ end`) it blocks.
        let k = end;
        while (k < n && text.charCodeAt(k) === 95) k++;
        const after = k >= n ? '' : text[k];
        const afterOk = after === '' || isWsCh(after) || isPunctCh(after);
        let hasOpener = false;
        for (const d of delims) {
          if (d.ch === '_' && d.active && d.canOpen) { hasOpener = true; break; }
        }
        if (!afterOk || !hasOpener) return null;
      }
    }
    return { end, email: m[0] };
  }
  // Would the `]` at closeIdx close a link that forms? Replicates
  // tryLink's resolution without side effects: nearest active `[`
  // opener, valid label grammar, then inline dest / full ref /
  // shortcut ref. A GFM autolink tail stops before such a `]` so the
  // link can form; otherwise the tail consumes it (failed link).
  function linkWouldFormAt(closeIdx) {
    let opener = null;
    for (let d = delims.length - 1; d >= 0; d--) {
      if (delims[d].ch === '[' && delims[d].active) { opener = delims[d]; break; }
    }
    if (!opener) return false;
    if (!labelBackticksOk(text.slice(opener.pos + 1, closeIdx))) return false;
    const opIdx = nodes.indexOf(opener.node);
    if (opIdx === -1) return false;
    // A link cannot contain another link (images exempt): tryLink
    // enforces this, so a label that already holds a formed link never
    // forms -- the `]` then belongs to the autolink tail, not the link.
    if (!opener.image && containsLink(nodes.slice(opIdx + 1))) return false;
    const after = closeIdx + 1;
    if (text.charCodeAt(after) === 40) {
      if (parseInlineLink(after)) return true;
    }
    if (text.charCodeAt(after) === 91) {
      const lab = parseLinkLabel(after);
      if (lab) {
        const rawKey = lab.label === '' ? text.slice(opener.pos + 1, closeIdx) : lab.label;
        if (refs.get(normalizeLabel(rawKey))) return true;
        return false; // full-ref attempt, no definition: no shortcut
      }
    }
    return !!refs.get(normalizeLabel(text.slice(opener.pos + 1, closeIdx)));
  }
  // Try a GFM autolink at position i. Returns {href, text, end} or null.
  function matchGfmUrl(i) {
    // mailto: / xmpp: (must not be preceded by an alphanumeric; scheme
    // is case-insensitive, the href keeps the original case)
    const low7 = text.slice(i, i + 7).toLowerCase();
    if (low7 === 'mailto:' || text.slice(i, i + 5).toLowerCase() === 'xmpp:') {
      if (i > 0) {
        const pc = text.charCodeAt(i - 1);
        if ((pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122)) return null;
      }
      const scheme = low7 === 'mailto:' ? 'mailto:' : 'xmpp:';
      const em = matchEmailAt(i + scheme.length);
      if (!em) return null;
      let end = em.end;
      if (scheme === 'xmpp:' && end < n && text.charCodeAt(end) === 47) {
        let k = end + 1;
        while (k < n) {
          const c = text.charCodeAt(k);
          if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64 || c === 46) k++;
          else break;
        }
        if (k > end + 1) end = k;
      }
      return { href: text.slice(i, end), text: text.slice(i, end), end };
    }
    // www. (preceded by start / whitespace / * _ ~ ()
    if (text.startsWith('www.', i)) {
      if (i > 0) {
        const p = text[i - 1];
        if (!(isWsCh(p) || p === '*' || p === '_' || p === '~' || p === '(')) return null;
      }
      return matchHostUrl(i, 4, 'http://');
    }
    // http:// https:// ftp:// (no preceding restriction; scheme is
    // case-insensitive, the href keeps the original case)
    let protoLen = 0;
    const low = text.slice(i, i + 8).toLowerCase();
    if (low.startsWith('https://')) protoLen = 8;
    else if (low.startsWith('http://')) protoLen = 7;
    else if (low.startsWith('ftp://')) protoLen = 6;
    if (protoLen > 0) return matchHostUrl(i, protoLen, '');
    return null;
  }
  function matchHostUrl(i, schemeLen, prefix) {
    const j = i + schemeLen;
    // domain part: (?:[A-Za-z0-9-]+\.?)+  (at least one label)
    let k = j, ok = false;
    while (k < n) {
      let l = k;
      while (l < n) {
        const c = text.charCodeAt(l);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) l++;
        else break;
      }
      if (l === k) break;
      ok = true;
      k = l;
      if (k < n && text.charCodeAt(k) === 46) { k++; continue; }
      break;
    }
    if (!ok) return null;
    // tail: [^\s<]* -- but stop before a `]` that closes a link
    // which would form, so the link's `]` survives (a failed link's
    // tail keeps consuming it, as marked does).
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 60) break;
      if (c === 93 && linkWouldFormAt(k)) break;
      k++;
    }
    const cand = backpedal(text.slice(i, k));
    if (cand.length <= schemeLen) return null;
    return { href: prefix + cand, text: cand, end: i + cand.length };
  }
  // GFM email autolink: the @ is at position i; look back for the local
  // part (already emitted as text) and match the full address.
  function matchGfmEmail(i) {
    let ls = i - 1;
    let stoppedAtLive = false;
    while (ls >= 0) {
      const c = text.charCodeAt(ls);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45) {
        if (c === 95) {
          // A `_` that is part of a live `_` delimiter run is an
          // emphasis delimiter, not email text: the local part starts
          // after that run. Inert `_` (intra-word, can neither open nor
          // close) stays part of the local part (`foo_bar@x.com`).
          let rs = ls;
          while (rs > 0 && text.charCodeAt(rs - 1) === 95) rs--;
          let re = ls + 1;
          while (re < n && text.charCodeAt(re) === 95) re++;
          const { leftFlanking, rightFlanking } = flanking(rs, re);
          const before = rs > 0 ? text[rs - 1] : '';
          const after = re < n ? text[re] : '';
          const canOpen = leftFlanking && (!rightFlanking || isPunctCh(before));
          const canClose = rightFlanking && (!leftFlanking || isPunctCh(after));
          if (canOpen || canClose) { ls = re; stoppedAtLive = true; break; }
        }
        ls--;
      } else break;
    }
    if (!stoppedAtLive) ls++;
    if (ls >= i) return null;
    const em = matchEmailAt(ls);
    if (!em) return null;
    const email = em.email;
    // The local part [ls, i) was already emitted as text/delimiter nodes
    // (a `_` in it is an emphasis delimiter, so it may span nodes).
    // Walk back over text nodes to find where the local part starts.
    let endPos = i;
    let firstIdx = -1, firstOff = 0;
    for (let j = nodes.length - 1; j >= 0; j--) {
      const nd = nodes[j];
      if (nd.k !== 0) return null; // a non-text node inside the local part
      const startPos = endPos - nd.s.length;
      if (startPos <= ls) { firstIdx = j; firstOff = ls - startPos; break; }
      endPos = startPos;
    }
    if (firstIdx === -1) return null;
    const first = nodes[firstIdx];
    first.s = first.s.slice(0, firstOff);
    // Drop the nodes after it, deactivating any delimiter records they held.
    const removed = nodes.splice(firstIdx + 1, nodes.length - firstIdx - 1);
    for (const nd of removed) if (nd.d) nd.d.active = false;
    if (first.s === '') {
      if (first.d) first.d.active = false;
      nodes.splice(firstIdx, 1);
    }
    nodes.push({ k: 5, href: 'mailto:' + email, title: null, auto: true, gfm: true, children: [{ k: 0, s: email }] });
    return em.end;
  }

  // ---------- emphasis processing ----------
  // A delimiter run's neighbours in its array, as raw characters.
  // Non-text nodes contribute a representative character: a code span,
  // tag, wrap, link or image starts/ends with punctuation, a hard
  // break is whitespace. An empty node is transparent (null).
  function nodeFirstChar(nd) {
    switch (nd.k) {
      case 0: return nd.s.length ? nd.s[0] : null;
      case 1: return '`';
      case 2: return '\n';
      case 3: return '<';
      case 4: return '*';
      case 5: {
        // A bare-URL/email GFM autolink's raw text IS the URL (no
        // brackets); a markdown link starts with '['.
        if (nd.gfm && nd.children && nd.children[0] && nd.children[0].s) return nd.children[0].s[0];
        return '[';
      }
      case 6: return '!';
      case 7: return nd.s;
      default: return null;
    }
  }
  function nodeLastChar(nd) {
    switch (nd.k) {
      case 0: return nd.s.length ? nd.s[nd.s.length - 1] : null;
      case 1: return '`';
      case 2: return '\n';
      case 3: return '>';
      case 4: return '*';
      case 5: {
        if (nd.gfm && nd.children && nd.children[0] && nd.children[0].s) {
          const s = nd.children[0].s;
          return s[s.length - 1];
        }
        return ']';
      }
      case 6: return ']';
      case 7: return nd.s;
      default: return null;
    }
  }
  function neighborChars(arr, idx) {
    let before = '', after = '';
    for (let j = idx - 1; j >= 0; j--) { const c = nodeLastChar(arr[j]); if (c !== null) { before = c; break; } }
    for (let j = idx + 1; j < arr.length; j++) { const c = nodeFirstChar(arr[j]); if (c !== null) { after = c; break; } }
    return { before, after };
  }
  function isAlnumCh(c) { return c !== '' && /[\p{L}\p{N}]/u.test(c); }
  function gfmPunctCh(c) { return c !== '~' && isPunctCh(c); }
  // Classify a * / _ run the way marked's emStrong delimiter regexes
  // do (groups 1-6). Punctuation is GFM (excludes '~') for '*', and
  // plain (includes '~') for '_'. kind is opener / closer / both /
  // neither; canOpen also applies the '_' intra-word guard.
  function delimKind(ch, beforeCh, afterCh) {
    const beforeWs = beforeCh === '' || isWsCh(beforeCh);
    const afterWs = afterCh === '' || isWsCh(afterCh);
    const beforePunct = ch === '*' ? gfmPunctCh(beforeCh) : isPunctCh(beforeCh);
    const afterPunct = ch === '*' ? gfmPunctCh(afterCh) : isPunctCh(afterCh);
    const bc = beforeWs ? 'ws' : beforePunct ? 'punct' : 'other';
    const ac = afterWs ? 'ws' : afterPunct ? 'punct' : 'other';
    let kind;
    if (bc === 'ws' && ac === 'ws') kind = 'neither';
    else if (bc === 'ws') kind = 'opener';
    else if (bc === 'punct' && ac === 'ws') kind = 'closer';
    else if (bc === 'punct' && ac === 'punct') kind = 'both';
    else if (bc === 'punct') kind = 'opener';
    else if (ac === 'other') kind = ch === '*' ? 'both' : 'neither';
    else kind = 'closer';
    let canOpen = kind === 'opener' || kind === 'both';
    const canClose = kind === 'closer' || kind === 'both';
    if (ch === '_' && canOpen) {
      const afterNonPunct = afterCh !== '' && !isWsCh(afterCh) && !gfmPunctCh(afterCh);
      if (afterNonPunct && isAlnumCh(beforeCh)) canOpen = false;
    }
    return { kind, canOpen, canClose };
  }
  function recomputeKind(rec, arr, idx) {
    // A run hidden by the emphasis masking can neither open nor close.
    if (rec.masked) {
      rec.kind = 'neither';
      rec.canOpen = false;
      rec.canClose = false;
      return;
    }
    const nc = neighborChars(arr, idx);
    const r = delimKind(rec.ch, nc.before, nc.after);
    rec.kind = r.kind;
    rec.canOpen = r.canOpen;
    rec.canClose = r.canClose;
    if (rec.noClose) {
      rec.canClose = false;
      if (rec.kind === 'both') rec.kind = 'opener';
      else if (rec.kind === 'closer') rec.kind = 'neither';
    }
  }
  function processEmphasis() {
    const byArr = new Map();
    for (const d of delims) {
      if (!d.active || d.ch === '[') continue;
      let list = byArr.get(d.arr);
      if (!list) { list = []; byArr.set(d.arr, list); }
      list.push(d);
    }
    for (const [arr] of byArr) processEmphasisIn(arr);
  }
  function processEmphasisIn(arr) {
    scanStar(arr);
    scanTilde(arr);
  }
  function starRecords(arr) {
    const ds = [];
    for (const nd of arr) {
      if (nd.d && (nd.d.ch === '*' || nd.d.ch === '_') && nd.d.active && !nd.d.absorbed) ds.push(nd.d);
    }
    return ds;
  }
  // Opener-first emphasis scan (marked's emStrong) for * and _.
  function scanStar(arr) {
    for (let idx = 0; idx < arr.length; idx++) {
      const nd = arr[idx];
      if (nd.d && (nd.d.ch === '*' || nd.d.ch === '_') && nd.d.active && !nd.d.absorbed) {
        recomputeKind(nd.d, arr, idx);
      }
    }
    let ds = starRecords(arr);
    let oi = 0;
    while (oi < ds.length) {
      const opener = ds[oi];
      if (!opener.active || opener.absorbed || !opener.canOpen || opener.len <= 0) { oi++; continue; }
      if (tryOpener(arr, opener)) { ds = starRecords(arr); continue; }
      oi++;
    }
  }
  // The RDelim skip: a * inside a __...__ span (or a _ inside a
  // **...** span) is hidden from the closer scan. The span must start
  // at the first delimiter after the opener, hold exactly one run of
  // the scanned char of length 1, and close with a run of length >= 2.
  function skipHidden(arr, oi2, ch) {
    const other = ch === '*' ? '_' : '*';
    let j = oi2 + 1, first = null, firstIdx = -1;
    for (; j < arr.length; j++) {
      const nd = arr[j];
      if (nd.d && nd.d.active && !nd.d.absorbed && (nd.d.ch === '*' || nd.d.ch === '_')) { first = nd.d; firstIdx = j; break; }
    }
    if (!first || first.ch !== other || first.len !== 2) return null;
    let k = firstIdx + 1, mid = null, midIdx = -1;
    for (; k < arr.length; k++) {
      const nd = arr[k];
      if (nd.d && nd.d.active && !nd.d.absorbed && (nd.d.ch === '*' || nd.d.ch === '_')) { mid = nd.d; midIdx = k; break; }
    }
    if (!mid || mid.ch !== ch || mid.len !== 1) return null;
    let m = midIdx + 1, last = null;
    for (; m < arr.length; m++) {
      const nd = arr[m];
      if (nd.d && nd.d.active && !nd.d.absorbed && (nd.d.ch === '*' || nd.d.ch === '_')) { last = nd.d; break; }
    }
    if (!last || last.ch !== other || last.len < 2) return null;
    return mid;
  }
  function tryOpener(arr, opener) {
    const L = opener.len;
    const R = opener.kind === 'both';
    const oi2 = arr.indexOf(opener.node);
    if (oi2 === -1) return false;
    const hidden = skipHidden(arr, oi2, opener.ch);
    for (let k = L; k >= 1; k--) {
      const o = k < L;
      let m = k, f = 0;
      let closer = null, bUsed = 0;
      for (let j = oi2 + 1; j < arr.length; j++) {
        const nd = arr[j];
        if (!nd.d || nd.d.ch !== opener.ch || !nd.d.active || nd.d.absorbed) continue;
        if (nd.d === hidden) continue;
        const cand = nd.d;
        if (cand.kind === 'neither') continue;
        const B = cand.len;
        if (cand.kind === 'opener') { m += B; continue; }
        if (cand.kind === 'both' || R) {
          if (o && cand.kind === 'both') break;
          if (L % 3 !== 0 && (L + B) % 3 === 0) { f += B; continue; }
        }
        m -= B;
        if (m > 0) continue;
        bUsed = Math.min(B, B + m + f);
        closer = cand;
        break;
      }
      if (!closer) continue;
      formStarWrap(arr, opener, closer, k, bUsed);
      return true;
    }
    return false;
  }
  function formStarWrap(arr, opener, closer, k, bUsed) {
    const use = (Math.min(k, bUsed) % 2 === 1) ? 1 : 2;
    const tag = use === 2 ? 'strong' : 'em';
    const oi2 = arr.indexOf(opener.node);
    const ci2 = arr.indexOf(closer.node);
    const L = opener.len, B = closer.len;
    const children = [];
    let openLeft = null, closeLeft = null;
    if (k - use > 0) {
      const node = { k: 0, s: opener.ch.repeat(k - use), d: null };
      openLeft = { ch: opener.ch, len: k - use, canOpen: false, canClose: false, active: true, image: false, node, arr: children };
      node.d = openLeft;
      children.push(node);
      delims.push(openLeft);
    }
    const middle = arr.slice(oi2 + 1, ci2);
    for (const nd of middle) children.push(nd);
    if (bUsed - use > 0) {
      const node = { k: 0, s: closer.ch.repeat(bUsed - use), d: null };
      closeLeft = { ch: closer.ch, len: bUsed - use, canOpen: false, canClose: false, active: true, image: false, node, arr: children };
      node.d = closeLeft;
      children.push(node);
      delims.push(closeLeft);
    }
    for (const nd of middle) if (nd.d) nd.d.arr = children;
    const wrap = { k: 4, tag, children };
    const replacement = [];
    if (L - k > 0) {
      opener.node.s = opener.ch.repeat(L - k);
      opener.node.d = null;
      opener.active = false;
      replacement.push(opener.node);
    } else {
      opener.active = false;
    }
    replacement.push(wrap);
    let closerRemIdx = -1;
    if (B - bUsed > 0) {
      closer.node.s = closer.ch.repeat(B - bUsed);
      closer.len = B - bUsed;
      closer.node.d = closer;
      replacement.push(closer.node);
      closerRemIdx = oi2 + replacement.length - 1;
    } else {
      closer.active = false;
    }
    arr.splice(oi2, ci2 - oi2 + 1, ...replacement);
    if (openLeft) recomputeKind(openLeft, children, 0);
    if (closeLeft) recomputeKind(closeLeft, children, children.length - 1);
    if (closerRemIdx !== -1) recomputeKind(closer, arr, closerRemIdx);
    processEmphasisIn(children);
  }
  // Closer-first scan for ~ (unchanged from the old shared loop).
  function scanTilde(arr) {
    const list = [];
    for (const nd of arr) {
      if (nd.d && nd.d.ch === '~' && nd.d.active && !nd.d.absorbed) list.push(nd.d);
    }
    for (let ci = 0; ci < list.length; ci++) {
      const closer = list[ci];
      if (!closer.active || !closer.canClose || closer.absorbed || closer.masked) continue;
      const ci2 = arr.indexOf(closer.node);
      if (ci2 === -1) continue;
      let opener = null;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const cand = list[oi];
        if (cand.ch !== closer.ch || !cand.active || !cand.canOpen || cand.absorbed || cand.masked) continue;
        opener = cand;
        break;
      }
      if (!opener) continue;
      const use = Math.min(opener.len, closer.len);
      const oi2 = arr.indexOf(opener.node);
      const children = arr.slice(oi2 + 1, ci2);
      const wrap = { k: 4, tag: 'del', children };
      opener.len -= use;
      closer.len -= use;
      if (opener.len === 0) { opener.node.s = ''; opener.active = false; }
      else opener.node.s = opener.node.s.slice(0, opener.node.s.length - use);
      if (closer.len === 0) { closer.node.s = ''; closer.active = false; }
      else closer.node.s = closer.node.s.slice(use);
      // Re-tag the swallowed records to the children array and recurse
      // (marked re-tokenises the del's inner text, so inner emphasis
      // sees the del boundary as end-of-string).
      for (const nd of children) if (nd.d) nd.d.arr = children;
      arr.splice(oi2 + 1, ci2 - oi2 - 1, wrap);
      processEmphasisIn(children);
      if (closer.active && closer.canClose && closer.len > 0) ci--;
    }
  }
  // ---------- inline rendering ----------
  function renderInlineNodes(ns) {
    let out = '';
    for (const node of ns) {
      switch (node.k) {
        case 0: out += escText(node.s); break;
        case 1: out += '<code>' + escCode(node.s) + '</code>'; break;
        case 2: out += '<br>'; break;
        case 3: out += node.s; break;
        case 4: out += '<' + node.tag + '>' + renderInlineNodes(node.children) + '</' + node.tag + '>'; break;
        case 5: {
          const href = escHref(node.href);
          if (href === null) { out += renderInlineNodes(node.children); break; }
          out += '<a href="' + href + '"';
          if (node.title != null) out += ' title="' + escText(node.title) + '"';
          out += '>' + renderInlineNodes(node.children) + '</a>';
          break;
        }
        case 6: {
          const src = escHref(node.src);
          if (src === null) { out += escText(node.alt); break; }
          out += '<img src="' + src + '" alt="' + escText(node.alt) + '"';
          if (node.title != null) out += ' title="' + escText(node.title) + '"';
          out += '>';
          break;
        }
        case 7: out += escCode(node.s); break; // backslash-escaped char: always fully escaped
      }
    }
    return out;
  }
  // Resolve image alt text after emphasis processing, post-order so
  // nested images resolve first. plainText then sees the emphasis
  // structure (e.g. `*bar*` contributes `bar`, unmatched `*` stays).
  function resolveImageAlts(ns) {
    for (const node of ns) {
      if (node.k === 4 || node.k === 5) resolveImageAlts(node.children);
      if (node.k === 6) {
        if (node.children) resolveImageAlts(node.children);
        node.alt = plainText(node.children || []);
        delete node.children;
      }
    }
  }
  processEmphasis();
  resolveImageAlts(nodes);
  return renderInlineNodes(nodes);
}

// ---------- block rendering ----------
function renderBlocks(node, out, refs, st) {
  switch (node.t) {
    case 'doc':
      for (const ch of node.children) renderBlocks(ch, out, refs, st);
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const ch of node.children) renderBlocks(ch, out, refs, st);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = node.bullet ? 'ul' : 'ol';
      out.push(node.bullet ? '<ul>\n' : (node.start !== 1 ? '<ol start="' + node.start + '">\n' : '<ol>\n'));
      for (const ch of node.children) renderBlocks(ch, out, refs, st);
      out.push(node.bullet ? '</ul>\n' : '</ol>\n');
      break;
    }
    case 'item': {
      const list = node._list;
      const tight = list ? list.tight : true;
      const inputHtml = node.task === 'checked'
        ? '<input checked="" disabled="" type="checkbox">'
        : node.task === 'unchecked'
        ? '<input disabled="" type="checkbox">'
        : '';
      if (tight) {
        out.push('<li>');
        if (inputHtml) out.push(inputHtml);
        for (let i = 0; i < node.children.length; i++) {
          const ch = node.children[i];
          if (ch.t === 'para') {
            out.push(parseInline(paraTextOf(ch), refs, st));
          } else {
            renderBlocks(ch, out, refs, st);
          }
        }
        out.push('</li>\n');
      } else {
        out.push('<li>');
        let inputDone = false;
        for (let i = 0; i < node.children.length; i++) {
          const ch = node.children[i];
          if (!inputDone && inputHtml && ch.t === 'para') {
            out.push('<p>' + inputHtml + parseInline(paraTextOf(ch), refs, st) + '</p>\n');
            inputDone = true;
          } else {
            if (!inputDone && inputHtml && i === 0) { out.push(inputHtml); inputDone = true; }
            renderBlocks(ch, out, refs, st);
          }
        }
        out.push('</li>\n');
      }
      break;
    }
    case 'para':
      out.push('<p>' + parseInline(paraTextOf(node), refs, st) + '</p>\n');
      break;
    case 'h':
      out.push('<h' + node.level + '>' + parseInline(node.text, refs, st) + '</h' + node.level + '>\n');
      break;
    case 'code': {
      let lang = '';
      if (node.fenced && node.info) {
        const m = node.info.match(/^\S*/);
        if (m && m[0] !== '') lang = ' class="language-' + escText(unescapeBackslash(m[0])) + '"';
      }
      out.push('<pre><code' + lang + '>' + escCode(node.text) + '</code></pre>\n');
      break;
    }
    case 'html':
      out.push(node.text);
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'table': {
      const aligns = node.aligns;
      const ncol = aligns.length;
      const cell = (c, tag) => {
        const a = aligns[c.i];
        return '<' + tag + (a ? ' align="' + a + '"' : '') + '>' + parseInline(c.s.trim(), refs, st) + '</' + tag + '>\n';
      };
      out.push('<table>\n<thead>\n<tr>\n');
      for (let c = 0; c < ncol; c++) {
        const s = c < node.header.length ? node.header[c] : '';
        out.push(cell({ i: c, s }, 'th'));
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let c = 0; c < ncol; c++) {
            const s = c < row.length ? row[c] : '';
            out.push(cell({ i: c, s }, 'td'));
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
  }
}
function paraTextOf(p) {
  const t = p.lines.map(x => x.txt !== undefined ? x.txt : (x.pad ? '    '.slice(0, x.pad) : '') + lineContent(x.L, x.col)).join('\n');
  return p.trimEnd ? t.replace(/[ \t]+$/, '') : t;
}

// ---------- entry point ----------
export function parse(markdown) {
  const { doc, refs } = parseBlocks(markdown);
  // Link list items back to their list for tight/loose rendering.
  (function linkLists(n) {
    if (!n.children) return;
    for (const ch of n.children) {
      if (ch.t === 'list') for (const it of ch.children) it._list = ch;
      linkLists(ch);
    }
  })(doc);
  const out = [];
  // Per-parse inline state (fresh each parse() call): inLink is set by
  // an `<a ...>` raw-HTML tag and cleared only by `</a>`, persisting
  // across blocks; it gates GFM autolinks (marked's Lexer.state.inLink).
  const st = { inLink: false };
  renderBlocks(doc, out, refs, st);
  return out.join('');
}
