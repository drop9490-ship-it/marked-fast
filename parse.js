// parse.js — a dependency-free CommonMark 0.31.2 + GFM parser.
// Returns, for every string, exactly the HTML that marked 18.1.3 produces
// with its default options (gfm on, breaks off, pedantic off, async off).
// The parser is a pure function of its one input string: it reads no file,
// no clock and no environment, and it keeps nothing between calls.

const REPLACEMENT = '�';

// A document-level switch for bare autolinks. marked disables the GFM
// bare-autolink rule for the rest of a document once it has seen an
// unclosed multi-line <a> tag (see the note at the raw-HTML site in
// scanInline). The switch starts off for every parse call, so the
// output still depends only on the input string.
let bareAutoOff = false;

function normalizeInput(input) {
  let s = String(input);
  s = s.replace(/\r\n?/g, '\n');
  if (s.indexOf('\0') !== -1) s = s.split('\0').join(REPLACEMENT);
  return s;
}

// ---------------------------------------------------------------------------
// Character helpers. Text is handled as Unicode code points wherever a
// character class is tested; astral characters are never split.
// ---------------------------------------------------------------------------

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNCT_RE = /^[\p{P}\p{S}]$/u;
const LETTER_RE = /^[\p{L}]$/u;
const LETTER_DIGIT_RE = /^[\p{L}\p{N}]$/u;

function charAt(s, i) {
  // The full code point starting at index i, as a one-character string.
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i];
}

function charLen(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return 2;
  }
  return 1;
}

function isSpaceCh(ch) {
  // Whitespace for flanking decisions; a non-breaking space counts.
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '\f' || ch === '\v' || ch === ' ';
}

function isWsCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '\f' || ch === '\v';
}

function isAsciiPunct(ch) {
  return ch.length === 1 && ASCII_PUNCT.indexOf(ch) !== -1;
}

function isPunctCh(ch) {
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return isAsciiPunct(ch);
  return PUNCT_RE.test(ch);
}

function isLetterCh(ch) {
  if (ch.length === 1) {
    const c = ch.charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
    if (c < 128) return false;
  }
  return LETTER_RE.test(ch);
}

function isDigitCh(ch) {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}

function isAlnumCh(ch) {
  if (ch.length === 1) {
    const c = ch.charCodeAt(0);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
    if (c < 128) return false;
  }
  return LETTER_DIGIT_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Escaping and URL handling.
// ---------------------------------------------------------------------------

const TEXT_ESC_RE = /[&<>"']/g;
function escapeText(s) {
  return s.replace(TEXT_ESC_RE, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

// Attribute escaping that leaves a well-formed entity reference alone, so
// that an &copy; or &#32; inside a link destination, title or alt text
// survives verbatim instead of being double-escaped.
const ATTR_ESC_RE = /&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]*;)|&|[<>"']/g;
function escapeAttr(s) {
  return s.replace(ATTR_ESC_RE, (m) => {
    if (m.length > 1 && m[0] === '&') return m;
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    if (m === '"') return '&quot;';
    return '&#39;';
  });
}

function isUrlOkCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      ch === '-' || ch === '.' || ch === '_' || ch === '~' || ch === ':' ||
      ch === '/' || ch === '?' || ch === '#' ||
      ch === '@' || ch === '!' || ch === '$' || ch === '&' || ch === "'" ||
      ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === ',' ||
      ch === ';' || ch === '=' || ch === '%';
  }
  return false;
}

function encodeUrl(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (isUrlOkCh(ch)) { out += ch; continue; }
    const cp = s.codePointAt(i);
    if (cp > 0xffff) i++;
    try {
      out += encodeURIComponent(String.fromCodePoint(cp));
    } catch (e) {
      out += '%EF%BF%BD';
    }
  }
  return out;
}

// A link destination, after escapes have been applied, is percent-encoded
// and then attribute-escaped; entity-shaped sequences inside it stay whole.
function cleanHref(dest) {
  return escapeAttr(encodeUrl(dest));
}

function cleanTitle(title) {
  return escapeAttr(title);
}

// ---------------------------------------------------------------------------
// Entities.
// ---------------------------------------------------------------------------

// Matches one entity or character reference at the start of s (which must
// begin with '&'), or returns null. The caller decides what to do with it:
// a named shape is emitted verbatim, a numeric one is decoded.
const ENTITY_RE = /^&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));/;
function matchEntity(s) {
  const m = ENTITY_RE.exec(s);
  if (!m) return null;
  if (m[3] !== undefined) return { kind: 'named', text: m[0], len: m[0].length };
  const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
  if (cp === 0 || cp > 0x10ffff) return { kind: 'char', text: REPLACEMENT, len: m[0].length };
  return { kind: 'char', text: String.fromCodePoint(cp), len: m[0].length };
}

// ---------------------------------------------------------------------------
// Reference labels.
// ---------------------------------------------------------------------------

const FOLD_EXTRA = { 'ß': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

function normalizeLabel(raw) {
  let s = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const k in FOLD_EXTRA) {
    if (s.indexOf(k) !== -1) s = s.split(k).join(FOLD_EXTRA[k]);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Indentation and tabs. Columns are always counted from the start of the
// original line, so a tab's width depends on its absolute column. Stripping
// columns that end inside a tab leaves spaces for the tab's remainder.
// ---------------------------------------------------------------------------

function indentOf(s, startCol) {
  let col = startCol;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col - startCol, idx: i };
}

function stripCols(s, startCol, n, keepTab) {
  // Remove up to n columns of leading whitespace; never runs past the
  // first non-whitespace character. A tab that ends exactly at the
  // strip boundary is expanded to spaces, because the columns it
  // covered are gone and it no longer lines up with a tab stop —
  // except for indented code blocks, whose tabs stay literal
  // (keepTab), matching marked.
  let col = startCol;
  let i = 0;
  const target = startCol + n;
  let prefix = '';
  let partial = false;
  while (i < s.length && col < target) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w > target) {
        prefix = ' '.repeat(col + w - target);
        col = target;
        i++;
        partial = true;
        break;
      }
      col += w;
      i++;
    } else break;
  }
  // If the strip ended exactly at a tab, the tab is expanded to spaces.
  if (!keepTab && !partial && i < s.length && s[i] === '\t' && col > startCol) {
    const w = 4 - (col % 4);
    prefix += ' '.repeat(w);
    i++;
    col += w;
  }
  return { s: prefix + s.slice(i), col };
}

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return false;
  }
  return true;
}

function trimRightSpaces(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return s.slice(0, i);
}

// ---------------------------------------------------------------------------
// Raw HTML tags.
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

function isTagNameStart(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

function isTagNameCh(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') || ch === '-');
}

function isAttrNameStart(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
    ch === '_' || ch === ':');
}

function isAttrNameCh(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') || ch === '_' || ch === '-' || ch === '.' || ch === ':');
}

function isUnquotedEnd(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '"' || ch === "'" || ch === '=' || ch === '<' || ch === '>' || ch === '`';
}

// Try to read one tag starting at s[i] (which must be '<'). Returns the
// index just past the closing '>', or -1 when no valid tag starts there.
// A closing tag may carry no attributes.
function parseTag(s, i) {
  if (s[i] !== '<') return -1;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (!isTagNameStart(s[j])) return -1;
  while (isTagNameCh(s[j])) j++;
  if (closing) {
    while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r') j++;
    if (s[j] !== '>') return -1;
    return j + 1;
  }
  for (;;) {
    let k = j;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r') k++;
    if (s[k] === '>') return k + 1;
    if (s[k] === '/') {
      if (s[k + 1] === '>') return k + 2;
      return -1;
    }
    if (k === j) return -1;
    j = k;
    if (!isAttrNameStart(s[j])) return -1;
    while (isAttrNameCh(s[j])) j++;
    let m = j;
    while (s[m] === ' ' || s[m] === '\t') m++;
    if (s[m] === '=') {
      m++;
      while (s[m] === ' ' || s[m] === '\t') m++;
      if (s[m] === '"' || s[m] === "'") {
        const q = s[m];
        m++;
        while (m < s.length && s[m] !== q) m++;
        if (m >= s.length) return -1;
        m++;
      } else {
        if (isUnquotedEnd(s[m])) return -1;
        while (!isUnquotedEnd(s[m])) m++;
      }
      j = m;
    } else {
      // No value: leave j just past the attribute name, so the next
      // loop pass can skip the spaces that separate it from the
      // following attribute.
    }
  }
}

function tagNameOf(s, i) {
  // The lower-cased tag name of the tag starting at s[i], or ''.
  let j = i + 1;
  if (s[j] === '/') j++;
  let name = '';
  while (isTagNameCh(s[j])) { name += s[j]; j++; }
  return name.toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline scanning. One left-to-right pass over a leaf block's text produces
// a flat list of nodes; emphasis is resolved afterwards by the delimiter
// stack. A construct that fails to parse leaves its first character as
// plain text and scanning continues after it.
// ---------------------------------------------------------------------------

// Node shapes:
//  {t:'text', s}  plain text (escaped at render time)
//  {t:'ent', s}   a named entity reference, emitted verbatim
//  {t:'code', s}  a code span's content (escaped at render time)
//  {t:'delim', ch, len, canOpen, canClose}
//  {t:'em'|'strong'|'del', children}
//  {t:'link', href, title, children, auto}
//  {t:'img', src, title, alt}
//  {t:'html', s}  a raw HTML fragment, emitted verbatim
//  {t:'br'}       a hard break, rendered as <br>
//  {t:'soft'}     a soft break, rendered as a line break

const LOCAL_PART_CHARS = "!#$%&'*+/=?^_`{|}~-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function isLocalPartCh(ch) {
  if (ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  return LOCAL_PART_CHARS.indexOf(ch) !== -1;
}

function isDomainLabelCh(ch) {
  if (ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || ch === '-' || ch === '_';
}

function charBefore(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const d = s.charCodeAt(i - 2);
    if (d >= 0xd800 && d <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

function scanInline(text, refs, inLink) {
  const nodes = [];
  const n = text.length;
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf !== '') { nodes.push({ t: 'text', s: buf }); buf = ''; }
  };

  while (i < n) {
    const ch = text[i];

    // Backslash escape, or a hard break before a line break.
    if (ch === '\\') {
      if (i + 1 < n) {
        const nx = text[i + 1];
        if (nx === '\n') {
          flush();
          nodes.push({ t: 'br' });
          i += 2;
          // A hard break strips the next line's leading spaces.
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
          continue;
        }
        if (isAsciiPunct(nx)) { buf += nx; i += 2; continue; }
      }
      buf += '\\';
      i++;
      continue;
    }

    // Code span.
    if (ch === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const len = j - i;
      const close = findCodeClose(text, j, len);
      if (close !== -1) {
        let content = text.slice(j, close).replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ') {
          let allSpaces = true;
          for (let p = 0; p < content.length; p++) {
            if (content[p] !== ' ') { allSpaces = false; break; }
          }
          if (!allSpaces) content = content.slice(1, -1);
        }
        flush();
        nodes.push({ t: 'code', s: content });
        i = close + len;
        continue;
      }
      buf += text.slice(i, j);
      i = j;
      continue;
    }

    // Bracketed autolink, or raw HTML.
    if (ch === '<') {
      const auto = tryBracketAutolink(text, i);
      if (auto) {
        flush();
        nodes.push(auto.node);
        i = auto.end;
        continue;
      }
      const tag = tryRawHtml(text, i);
      if (tag) {
        flush();
        nodes.push({ t: 'html', s: tag.text });
        // A </a> close tag parsed inline clears the bare-autolink
        // switch again (marked's "inside a link" state is global to
        // the document). A </a> in a code span never reaches here.
        if (tag.text.length > 2 && tag.text[1] === '/' &&
            (tag.text[2] === 'a' || tag.text[2] === 'A') &&
            !isTagNameCh(tag.text[3] || '')) {
          bareAutoOff = false;
        }
        // marked quirk: an <a> open tag that spans lines (a line break
        // past the tag name, inside its attributes) with no </a> later
        // in this same inline run leaves the parser "inside a link",
        // and bare autolinks (email, www, http/https/ftp) stop working
        // for the rest of the document. Explicit links, bracketed
        // autolinks, images and emphasis are unaffected, and a </a>
        // in this same run, or a single-line <a> tag, does not trip it.
        if (!bareAutoOff && tag.text.length > 2 && tag.text[1] !== '/' &&
            (tag.text[1] === 'a' || tag.text[1] === 'A') &&
            !isTagNameCh(tag.text[2] || '')) {
          const nl = tag.text.indexOf('\n');
          if (nl > 2 && !/<\/a(?=[\s>])/i.test(text.slice(tag.end))) {
            bareAutoOff = true;
          }
        }
        i = tag.end;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }

    // Image or link.
    if (ch === '!' && text[i + 1] === '[') {
      const link = tryLink(text, i + 1, true, refs);
      if (link) {
        flush();
        nodes.push(link.node);
        i = link.end;
        continue;
      }
      buf += '!';
      i++;
      continue;
    }
    if (ch === '[') {
      const link = tryLink(text, i, false, refs);
      if (link) {
        flush();
        nodes.push(link.node);
        i = link.end;
        continue;
      }
      buf += '[';
      i++;
      continue;
    }

    // Emphasis, strong and strikethrough delimiter runs.
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i;
      while (j < n && text[j] === ch) j++;
      const len = j - i;
      const before = i > 0 ? charBefore(text, i) : '';
      const after = j < n ? charAt(text, j) : '';
      const beforeWs = before === '' || isSpaceCh(before);
      const afterWs = after === '' || isSpaceCh(after);
      const beforePunct = before !== '' && isPunctCh(before);
      const afterPunct = after !== '' && isPunctCh(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flush();
      nodes.push({ t: 'delim', ch, len, canOpen, canClose });
      i = j;
      continue;
    }

    // Entity or character reference.
    if (ch === '&') {
      const ent = matchEntity(text.slice(i));
      if (ent) {
        flush();
        if (ent.kind === 'named') nodes.push({ t: 'ent', s: ent.text });
        else nodes.push({ t: 'text', s: ent.text });
        i += ent.len;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }

    // Line break: a hard break after two or more trailing spaces, else
    // a soft break. Trailing spaces are stripped for a hard break only.
    if (ch === '\n') {
      let spaces = 0;
      let k = buf.length;
      while (k > 0 && buf[k - 1] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        buf = buf.slice(0, k);
        flush();
        nodes.push({ t: 'br' });
        i++;
        // A hard break strips the next line's leading spaces.
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      } else {
        flush();
        nodes.push({ t: 'soft' });
        i++;
      }
      continue;
    }

    // Bare autolink (GFM extension). Disabled for the rest of the
    // document once an unclosed multi-line <a> tag has been seen.
    // Uppercase H and F start a case-insensitive scheme (Http, Ftp).
    if (!bareAutoOff && !inLink && (ch === 'w' || ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'm' || isLocalPartCh(ch))) {
      const bare = tryBareAutolink(text, i);
      if (bare) {
        flush();
        nodes.push(bare.node);
        i = bare.end;
        continue;
      }
    }

    buf += charAt(text, i);
    i += charLen(text, i);
  }
  flush();
  resolveEmphasis(nodes);
  return nodes;
}

function findCodeClose(text, from, len) {
  const n = text.length;
  let i = from;
  while (i < n) {
    if (text[i] === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      if (j - i === len) return i;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Bracketed autolinks and raw HTML.
// ---------------------------------------------------------------------------

function unescapeInline(s) {
  // A backslash before an ASCII punctuation character yields that
  // character; any other backslash stays literal.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function tryBracketAutolink(text, i) {
  // text[i] === '<'. The contents may hold no space and no line break.
  let k = i + 1;
  const n = text.length;
  while (k < n) {
    const c = text[k];
    if (c === '>') break;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') return null;
    k++;
  }
  if (k >= n) return null;
  // The contents are used raw: backslash escapes are not processed inside
  // an autolink, and the href percent-encodes the raw characters.
  const clean = text.slice(i + 1, k);
  if (clean.length === 0) return null;
  // URI scheme form: 2-32 characters, starting with a letter.
  const sm = /^([A-Za-z][A-Za-z0-9+.\-]{1,31}):(.+)$/.exec(clean);
  if (sm) {
    const node = {
      t: 'link',
      href: cleanHref(clean),
      title: null,
      children: [{ t: 'text', s: clean }],
      auto: true,
    };
    return { node, end: k + 1 };
  }
  // Email form: local part, @, dotted domain ending in a letter.
  if (matchBracketEmail(clean)) {
    const node = {
      t: 'link',
      href: cleanHref('mailto:' + clean),
      title: null,
      children: [{ t: 'text', s: clean }],
      auto: true,
    };
    return { node, end: k + 1 };
  }
  return null;
}

function matchBracketEmail(clean) {
  const at = clean.indexOf('@');
  if (at <= 0) return false;
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  for (let i = 0; i < local.length; i++) {
    if (!isLocalPartCh(local[i])) return false;
  }
  if (domain.indexOf('.') === -1) return false;
  const parts = domain.split('.');
  for (const p of parts) {
    if (p.length === 0) return false;
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '-')) return false;
    }
  }
  const last = domain[domain.length - 1];
  return (last >= 'a' && last <= 'z') || (last >= 'A' && last <= 'Z');
}

function tryRawHtml(text, i) {
  // text[i] === '<'.
  if (text.startsWith('<!--', i)) {
    // An abrupt closing: <!--> and <!---> are complete comments on
    // their own. Otherwise the comment runs to the first -->, and its
    // content may hold hyphens freely.
    if (text.startsWith('<!-->', i)) return { text: '<!-->', end: i + 5 };
    if (text.startsWith('<!--->', i)) return { text: '<!--->', end: i + 6 };
    const close = text.indexOf('-->', i + 4);
    if (close === -1) return null;
    return { text: text.slice(i, close + 3), end: close + 3 };
  }
  if (text.startsWith('<?', i)) {
    const close = text.indexOf('?>', i + 2);
    if (close === -1) return null;
    return { text: text.slice(i, close + 2), end: close + 2 };
  }
  if (text.startsWith('<![CDATA[', i)) {
    const close = text.indexOf(']]>', i + 9);
    if (close === -1) return null;
    return { text: text.slice(i, close + 3), end: close + 3 };
  }
  if (text.startsWith('<!', i) && isLetterCh(text[i + 2] || '')) {
    const close = text.indexOf('>', i + 2);
    if (close === -1) return null;
    return { text: text.slice(i, close + 1), end: close + 1 };
  }
  const end = parseTag(text, i);
  if (end !== -1) return { text: text.slice(i, end), end };
  return null;
}

// ---------------------------------------------------------------------------
// Bare autolinks (GFM extension).
// ---------------------------------------------------------------------------

// The address runs until whitespace or '<'. An opening parenthesis starts
// a group that runs to the next closing parenthesis; an unmatched opening
// parenthesis ends the address there.
function scanBareAddress(text, i) {
  const n = text.length;
  let j = i;
  while (j < n) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<') break;
    if (c === '(') {
      const close = text.indexOf(')', j + 1);
      if (close === -1) break;
      let bad = false;
      for (let k = j + 1; k < close; k++) {
        const d = text[k];
        if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === '<') { bad = true; break; }
      }
      if (bad) break;
      j = close + 1;
      continue;
    }
    j++;
  }
  return j;
}

const BARE_TRIM = ".,;:!?*_~'\"";

function trimBareAddress(addr) {
  // Trim trailing punctuation, trailing entity-like sequences, and trailing
  // closing parentheses that are not part of a parenthesised group.
  for (;;) {
    if (addr.length === 0) return addr;
    const em = /&[A-Za-z][A-Za-z0-9]*;$/.exec(addr);
    if (em) { addr = addr.slice(0, addr.length - em[0].length); continue; }
    const last = addr[addr.length - 1];
    if (BARE_TRIM.indexOf(last) !== -1) { addr = addr.slice(0, -1); continue; }
    if (last === ')') {
      // A closing parenthesis belongs to a group only when it is the
      // closing parenthesis of a group that opened earlier in the
      // address; a trailing one that is not grouped is trimmed.
      let p = 0;
      let grouped = false;
      while (p < addr.length) {
        if (addr[p] === '(') {
          const close = addr.indexOf(')', p + 1);
          if (close === -1) break;
          if (close === addr.length - 1) grouped = true;
          p = close + 1;
        } else {
          p++;
        }
      }
      if (grouped) break;
      addr = addr.slice(0, -1);
      continue;
    }
    break;
  }
  return addr;
}

function tryBareAutolink(text, i) {
  const prev = i > 0 ? charBefore(text, i) : '';
  // www addresses: the preceding character is the start, whitespace, or
  // one of ( * @ _ ~.
  if (text.startsWith('www.', i)) {
    if (!(prev === '' || isSpaceCh(prev) || prev === '(' || prev === '*' || prev === '@' || prev === '_' || prev === '~')) return null;
    const end = scanBareAddress(text, i);
    let addr = trimBareAddress(text.slice(i, end));
    if (addr.length <= 4) return null;
    const node = {
      t: 'link',
      href: cleanHref('http://' + addr),
      title: null,
      children: [{ t: 'text', s: addr }],
      auto: true,
    };
    return { node, end: i + addr.length };
  }
  // Scheme addresses: http, https, ftp. The scheme is matched
  // case-insensitively, but the href and the link text keep the
  // original case. No preceding-character restriction.
  let scheme = null;
  const low = text.slice(i, i + 8).toLowerCase();
  if (low.startsWith('http://')) scheme = 7;
  else if (low.startsWith('https://')) scheme = 8;
  else if (low.startsWith('ftp://')) scheme = 6;
  if (scheme !== null) {
    const end = scanBareAddress(text, i);
    const addr = trimBareAddress(text.slice(i, end));
    if (addr.length <= scheme) return null;
    const node = {
      t: 'link',
      href: cleanHref(addr),
      title: null,
      children: [{ t: 'text', s: addr }],
      auto: true,
    };
    return { node, end: i + addr.length };
  }
  // mailto: and xmpp: followed by an email address. An xmpp address may
  // also carry one resource segment after the email.
  if (text.startsWith('mailto:', i) || text.startsWith('xmpp:', i)) {
    const isXmpp = text.startsWith('xmpp:', i);
    const off = isXmpp ? 5 : 7;
    const em = scanBareEmail(text, i + off);
    if (!em) return null;
    let end = i + off + em.text.length;
    if (isXmpp && text[end] === '/') {
      let k = end + 1;
      while (k < text.length) {
        const c = text[k];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c === '/' || c === '?') break;
        k++;
      }
      const res = trimBareAddress(text.slice(end + 1, k));
      if (res.length > 0) end = end + 1 + res.length;
    }
    const addr = text.slice(i, end);
    const node = {
      t: 'link',
      href: cleanHref(addr),
      title: null,
      children: [{ t: 'text', s: addr }],
      auto: true,
    };
    return { node, end: i + addr.length };
  }
  // Bare email address.
  if (isLocalPartCh(text[i])) {
    const em = scanBareEmail(text, i);
    if (!em) return null;
    const addr = em.text;
    const node = {
      t: 'link',
      href: cleanHref('mailto:' + addr),
      title: null,
      children: [{ t: 'text', s: addr }],
      auto: true,
    };
    return { node, end: i + addr.length };
  }
  return null;
}

// Scan an email address starting at i. Returns {text} or null. The local
// part uses the CommonMark character set; the domain is labels of letters,
// digits, hyphens and underscores separated by single dots, with at least
// one dot, and it must not end with a hyphen or an underscore. Trailing
// dots are not part of the address.
function scanBareEmail(text, i) {
  const n = text.length;
  let j = i;
  while (j < n && isLocalPartCh(text[j])) j++;
  if (j === i || j >= n || text[j] !== '@') return null;
  j++;
  const domStart = j;
  while (j < n && (isDomainLabelCh(text[j]) || text[j] === '.')) j++;
  let end = j;
  while (end > domStart && text[end - 1] === '.') end--;
  const domain = text.slice(domStart, end);
  if (domain.length === 0) return null;
  if (domain[0] === '.') return null;
  let dots = 0;
  for (let k = 0; k < domain.length; k++) {
    if (domain[k] === '.') {
      dots++;
      if (domain[k - 1] === '.') return null;
    }
  }
  if (dots < 1) return null;
  const last = domain[domain.length - 1];
  if (last === '-' || last === '_') return null;
  return { text: text.slice(i, end) };
}

// ---------------------------------------------------------------------------
// Links and images.
// ---------------------------------------------------------------------------

function findClosingBracket(text, i) {
  // text[i] === '['. Find the matching ']' by depth, skipping backslash
  // escapes, code spans and raw HTML tags, which cannot contain brackets.
  const n = text.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < n) { j += 2; continue; }
    if (ch === '`') {
      let k = j;
      while (k < n && text[k] === '`') k++;
      const len = k - j;
      const close = findCodeClose(text, k, len);
      if (close === -1) { j = k; continue; }
      j = close + len;
      continue;
    }
    if (ch === '<') {
      const tag = tryRawHtml(text, j);
      if (tag) { j = tag.end; continue; }
      // A bracketed autolink can hold a ']' in its address, and that
      // bracket does not close the link text.
      const auto = tryBracketAutolink(text, j);
      if (auto) { j = auto.end; continue; }
      j++;
      continue;
    }
    if (ch === '[') { depth++; j++; continue; }
    if (ch === ']') {
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

function hasUnescapedOpenBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') {
      let bs = 0;
      for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) bs++;
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

// Skip spaces, tabs and line breaks; a blank line (two line breaks with
// only spaces between) fails with -1.
function skipInlineWs(s, i) {
  let j = i;
  let newlines = 0;
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ' || ch === '\t') { j++; continue; }
    if (ch === '\n') {
      newlines++;
      if (newlines >= 2) return -1;
      j++;
      continue;
    }
    break;
  }
  return j;
}

function parseBareDest(s, i) {
  const n = s.length;
  let dest = '';
  let depth = 0;
  let j = i;
  while (j < n) {
    const ch = s[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    if (ch.charCodeAt(0) < 32) break;
    if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
      dest += s[j + 1];
      j += 2;
      continue;
    }
    if (ch === '(') { depth++; dest += ch; j++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
      dest += ch;
      j++;
      continue;
    }
    dest += ch;
    j++;
  }
  return { dest, end: j };
}

function parseAngleDest(s, i) {
  // s[i] === '<'. No line break is allowed inside.
  const n = s.length;
  let dest = '';
  let j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\n') return null;
    if (ch === '>') return { dest, end: j + 1 };
    if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
      dest += s[j + 1];
      j += 2;
      continue;
    }
    dest += ch;
    j++;
  }
  return null;
}

function parseLinkTitle(s, i) {
  const n = s.length;
  const q = s[i];
  let title = '';
  let j;
  if (q === '"' || q === "'") {
    j = i + 1;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
        title += s[j + 1];
        j += 2;
        continue;
      }
      if (ch === q) return { title, end: j + 1 };
      if (ch === '\n') {
        let k = j + 1;
        while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
        if (k < n && s[k] === '\n') return null;
      }
      title += ch;
      j++;
    }
    return null;
  }
  j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
      title += s[j + 1];
      j += 2;
      continue;
    }
    if (ch === ')') return { title, end: j + 1 };
    if (ch === '(') return null;
    if (ch === '\n') {
      let k = j + 1;
      while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k < n && s[k] === '\n') return null;
    }
    title += ch;
    j++;
  }
  return null;
}

function parseInlineLink(s, j) {
  // s[j] === '('. Returns {dest, title, end} or null.
  let i = skipInlineWs(s, j + 1);
  if (i === -1) return null;
  let dest;
  if (s[i] === '<') {
    const d = parseAngleDest(s, i);
    if (!d) return null;
    dest = d.dest;
    i = d.end;
  } else {
    const d = parseBareDest(s, i);
    dest = d.dest;
    i = d.end;
  }
  i = skipInlineWs(s, i);
  if (i === -1) return null;
  let title = null;
  if (s[i] === '"' || s[i] === "'" || s[i] === '(') {
    const t = parseLinkTitle(s, i);
    if (!t) return null;
    title = t.title;
    i = t.end;
    i = skipInlineWs(s, i);
    if (i === -1) return null;
  }
  if (i >= s.length || s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

function makeLinkOrImage(isImage, dest, title, children) {
  if (isImage) {
    return {
      t: 'img',
      src: cleanHref(dest),
      title: title === null ? null : cleanTitle(title),
      alt: plainText(children),
    };
  }
  return {
    t: 'link',
    href: cleanHref(dest),
    title: title === null ? null : cleanTitle(title),
    children,
    auto: false,
  };
}

function tryLink(text, i, isImage, refs) {
  // text[i] === '['. Tries, in order: an inline link, a full reference,
  // a collapsed reference, a shortcut reference.
  const close = findClosingBracket(text, i);
  if (close === -1) return null;
  const rawText = text.slice(i + 1, close);
  const children = scanInline(rawText, refs, true);
  if (!isImage && containsLink(children)) return null;
  const j = close + 1;
  if (text[j] === '(') {
    const inl = parseInlineLink(text, j);
    if (inl) {
      return { node: makeLinkOrImage(isImage, inl.dest, inl.title, children), end: inl.end };
    }
  }
  if (text[j] === '[') {
    const labClose = findClosingBracket(text, j);
    if (labClose === -1) return null;
    const label = text.slice(j + 1, labClose);
    if (label.length === 0) {
      if (hasUnescapedOpenBracket(rawText)) return null;
      if (normalizeLabel(rawText) === '') return null;
      const def = refs.get(normalizeLabel(rawText));
      if (!def) return null;
      return { node: makeLinkOrImage(isImage, def.dest, def.title, children), end: labClose + 1 };
    }
    if (hasUnescapedOpenBracket(label)) return null;
    if (normalizeLabel(label) === '') return null;
    const def = refs.get(normalizeLabel(label));
    if (!def) return null;
    return { node: makeLinkOrImage(isImage, def.dest, def.title, children), end: labClose + 1 };
  }
  if (hasUnescapedOpenBracket(rawText)) return null;
  if (normalizeLabel(rawText) === '') return null;
  const def = refs.get(normalizeLabel(rawText));
  if (!def) return null;
  return { node: makeLinkOrImage(isImage, def.dest, def.title, children), end: close + 1 };
}

function containsLink(nodes) {
  for (const n of nodes) {
    if (n.t === 'link' && !n.auto) return true;
    if (n.children && containsLink(n.children)) return true;
  }
  return false;
}

// The plain text of a node's inline children, for an image's alt text:
// text and code contribute their content, emphasis and links contribute
// their inner text, images contribute their own alt text, raw HTML
// contributes nothing, and a break contributes a line break.
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'ent' || n.t === 'code') out += n.s;
    else if (n.t === 'em' || n.t === 'strong' || n.t === 'del' || n.t === 'link') out += plainText(n.children);
    else if (n.t === 'img') out += n.alt;
    else if (n.t === 'soft' || n.t === 'br') out += '\n';
    else if (n.t === 'delim') out += n.ch.repeat(n.len);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis, strong and strikethrough: the delimiter-stack algorithm.
// ---------------------------------------------------------------------------

function resolveEmphasis(nodes) {
  const delims = [];
  for (const n of nodes) if (n.t === 'delim') delims.push(n);
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (closer.len === 0 || !closer.canClose) { ci++; continue; }
    let matched = false;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = delims[oi];
      if (opener.len === 0 || !opener.canOpen || opener.ch !== closer.ch) continue;
      if (closer.ch === '~' && (opener.len !== closer.len || opener.len > 2)) continue;
      // Rule of three: when either run can both open and close, and the
      // sum of their lengths is a multiple of three, and the two lengths
      // have different residues modulo three, this opener cannot match
      // this closer; look for an earlier opener instead. When both
      // lengths are multiples of three the runs do match.
      if (((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) &&
          (opener.len + closer.len) % 3 === 0 && (opener.len % 3) !== (closer.len % 3)) continue;
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const oiPos = nodes.indexOf(opener);
      const ciPos = nodes.indexOf(closer);
      if (oiPos === -1 || ciPos === -1 || ciPos - oiPos < 2) continue;
      const kind = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const children = nodes.slice(oiPos + 1, ciPos);
      const newNode = { t: kind, children };
      nodes.splice(oiPos + 1, ciPos - oiPos - 1, newNode);
      opener.len -= use;
      closer.len -= use;
      if (opener.len === 0) {
        const op = nodes.indexOf(opener);
        if (op !== -1) nodes.splice(op, 1);
      }
      if (closer.len === 0) {
        const cp = nodes.indexOf(closer);
        if (cp !== -1) nodes.splice(cp, 1);
      }
      // Delimiters strictly between the opener and the closer now live
      // inside the new node and can never match again.
      delims.splice(oi + 1, ci - oi - 1);
      if (opener.len === 0) {
        delims.splice(oi, 1);
        ci = oi;
      } else {
        ci = oi + 1;
      }
      if (closer.len === 0) delims.splice(ci, 1);
      matched = true;
      break;
    }
    if (!matched) ci++;
  }
}

// ---------------------------------------------------------------------------
// Inline rendering.
// ---------------------------------------------------------------------------

function renderInline(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += escapeText(n.s);
    else if (n.t === 'ent') out += n.s;
    else if (n.t === 'code') out += '<code>' + escapeText(n.s) + '</code>';
    else if (n.t === 'delim') out += n.ch.repeat(n.len);
    else if (n.t === 'em') out += '<em>' + renderInline(n.children) + '</em>';
    else if (n.t === 'strong') out += '<strong>' + renderInline(n.children) + '</strong>';
    else if (n.t === 'del') out += '<del>' + renderInline(n.children) + '</del>';
    else if (n.t === 'link') {
      out += '<a href="' + n.href + '"';
      if (n.title !== null) out += ' title="' + n.title + '"';
      out += '>' + renderInline(n.children) + '</a>';
    } else if (n.t === 'img') {
      out += '<img src="' + n.src + '" alt="' + escapeAttr(n.alt) + '"';
      if (n.title !== null) out += ' title="' + n.title + '"';
      out += '>';
    } else if (n.t === 'html') out += n.s;
    else if (n.t === 'br') out += '<br>';
    else if (n.t === 'soft') out += '\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing helpers (pure functions over one line).
// ---------------------------------------------------------------------------

function matchQuote(rest, col) {
  // A block-quote marker: up to three spaces of indent, '>', then
  // optionally one space. A tab after the marker counts as that one space
  // and leaves the rest of the tab as spaces.
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return null;
  if (rest[ind.idx] !== '>') return null;
  const j = ind.idx + 1;
  const c = col + ind.cols + 1;
  if (rest[j] === ' ') return { s: rest.slice(j + 1), col: c + 1 };
  if (rest[j] === '\t') return stripCols(rest.slice(j), c, 1);
  return { s: rest.slice(j), col: c };
}

function matchListItem(rest, col) {
  // Returns the marker facts, or null. The content indent is relative
  // to col: the marker indent plus the marker width plus the whitespace
  // after the marker (one to four columns); five or more columns of
  // whitespace, or an empty item, give a content indent of marker plus
  // one. Relative, because a line inside a block quote can have quote
  // markers of a different width than the line that opened the item.
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return null;
  const s = rest.slice(ind.idx);
  const sc = col + ind.cols;
  let ordered, bullet, delim, start, markerWidth;
  const c0 = s[0];
  if (c0 === '*' || c0 === '-' || c0 === '+') {
    ordered = false;
    bullet = c0;
    markerWidth = 1;
  } else if (c0 >= '0' && c0 <= '9') {
    let k = 0;
    while (k < s.length && s[k] >= '0' && s[k] <= '9') k++;
    if (k === 0 || k > 9) return null;
    if (s[k] !== '.' && s[k] !== ')') return null;
    ordered = true;
    delim = s[k];
    start = parseInt(s.slice(0, k), 10);
    markerWidth = k + 1;
  } else {
    return null;
  }
  const after = s[markerWidth];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let wc = sc + markerWidth;
  let j = markerWidth;
  let wsCols = 0;
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ') { wsCols++; wc++; j++; }
    else if (ch === '\t') { const w = 4 - (wc % 4); wsCols += w; wc += w; j++; }
    else break;
  }
  const empty = j >= s.length;
  let contentIndent;
  if (empty) contentIndent = ind.cols + markerWidth + 1;
  else if (wsCols >= 1 && wsCols <= 4) contentIndent = ind.cols + markerWidth + wsCols;
  else contentIndent = ind.cols + markerWidth + 1;
  let content, contentCol;
  if (empty) {
    content = '';
    contentCol = sc + contentIndent;
  } else if (wsCols >= 1 && wsCols <= 4) {
    // The whitespace after the marker is fully consumed.
    content = rest.slice(ind.idx + j);
    contentCol = sc + contentIndent;
  } else {
    // More than four columns of whitespace: only one column after the
    // marker is consumed, and a partial tab leaves spaces behind.
    const afterMarker = rest.slice(ind.idx + markerWidth);
    const stripped = stripCols(afterMarker, sc + markerWidth, 1);
    content = stripped.s;
    contentCol = stripped.col;
  }
  return {
    ordered, bullet, delim, start, markerWidth, markerIndent: ind.cols,
    contentIndent, empty, content, contentCol,
  };
}

function matchItem(rest, col, item) {
  // Does this line belong to an open list item? A blank line always does;
  // otherwise the line's first non-whitespace character must sit at or
  // beyond the item's content indent (relative to col).
  if (isBlankStr(rest)) return { s: '', col };
  const ind = indentOf(rest, col);
  if (ind.cols < item.contentIndent) return null;
  return stripCols(rest, col, item.contentIndent);
}

function fenceStart(rest, col) {
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return null;
  const s = rest.slice(ind.idx);
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let k = 0;
  while (k < s.length && s[k] === ch) k++;
  if (k < 3) return null;
  const info = s.slice(k);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  const trimmed = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  let lang = '';
  let p = 0;
  while (p < trimmed.length) {
    const c = trimmed[p];
    if (c === ' ' || c === '\t') break;
    if (c === '\\' && p + 1 < trimmed.length && isAsciiPunct(trimmed[p + 1])) {
      lang += trimmed[p + 1];
      p += 2;
      continue;
    }
    lang += c;
    p++;
  }
  return { ch, len: k, lang };
}

function isClosingFence(rest, col, fence) {
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return false;
  const s = rest.slice(ind.idx);
  let k = 0;
  while (k < s.length && s[k] === fence.fenceCh) k++;
  if (k < fence.fenceLen) return false;
  for (let p = k; p < s.length; p++) {
    if (s[p] !== ' ' && s[p] !== '\t') return false;
  }
  return true;
}

function atxInfo(rest, col) {
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return null;
  const s = rest.slice(ind.idx);
  let level = 0;
  while (level < s.length && s[level] === '#') level++;
  if (level === 0 || level > 6) return null;
  if (s[level] !== undefined && s[level] !== ' ' && s[level] !== '\t') return null;
  let text = s.slice(level).replace(/^[ \t]+/, '');
  text = trimRightSpaces(text);
  if (/^#+$/.test(text)) {
    text = '';
  } else {
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') end--;
    if (end < text.length && end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
      text = trimRightSpaces(text.slice(0, end));
    }
  }
  return { level, text };
}

function setextLevel(rest, col) {
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return 0;
  const t = trimRightSpaces(rest.slice(ind.idx));
  if (t.length === 0) return 0;
  const c = t[0];
  if (c !== '=' && c !== '-') return 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== c) return 0;
  }
  return c === '=' ? 1 : 2;
}

function isThematicBreak(rest, col) {
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return false;
  const t = trimRightSpaces(rest.slice(ind.idx));
  if (t.length < 3) return false;
  const c = t[0];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let count = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === c) count++;
    else if (ch === ' ' || ch === '\t') continue;
    else return false;
  }
  return count >= 3;
}

function htmlBlockStart(rest, col, paraOpen) {
  // Returns {kind, name} or null. Kinds 6 and 7 never interrupt a paragraph,
  // and a kind-1 end tag does not interrupt one either.
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return null;
  const s = rest.slice(ind.idx);
  if (s[0] !== '<') return null;
  const m1 = /^<\/?(script|pre|style|textarea)(?:[\s/>]|$)/i.exec(s);
  if (m1) {
    if (paraOpen && s[1] === '/') return null;
    return { kind: 1, name: m1[1].toLowerCase() };
  }
  if (s.startsWith('<!--')) return { kind: 2, name: '' };
  if (s.startsWith('<?')) return { kind: 3, name: '' };
  if (s.startsWith('<![CDATA[')) return { kind: 5, name: '' };
  if (s.startsWith('<!') && isLetterCh(s[2] || '')) return { kind: 4, name: '' };
  // Kind 6: a start or end tag for a block-level element. The tag need not
  // be complete on this line; the name must be followed by whitespace,
  // '/', '>', or the end of the line. Kind 6 can interrupt a paragraph.
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/.exec(s);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { kind: 6, name: m6[1].toLowerCase() };
  // Kind 7: a complete tag of any other name, alone on the line. It never
  // interrupts a paragraph.
  if (paraOpen) return null;
  const end = parseTag(s, 0);
  if (end === -1) return null;
  for (let p = end; p < s.length; p++) {
    if (s[p] !== ' ' && s[p] !== '\t') return null;
  }
  const name = tagNameOf(s, 0);
  if (BLOCK_TAGS.has(name)) return { kind: 6, name };
  return { kind: 7, name };
}

function splitTableRow(line) {
  // Split a table row into cells. A leading or trailing pipe creates no
  // cell; an escaped pipe is literal. Cells are trimmed.
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] === '|') i++;
  while (i < n) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n) {
      const nx = line[i + 1];
      if (nx === '|') {
        // An escaped pipe is a literal pipe in the cell; unescaping it
        // here means a code span holding it renders as a plain pipe.
        cur += '|';
        i += 2;
        continue;
      }
      if (nx === '\\') {
        // An escaped backslash stays escaped, so the pipe after it is
        // still a cell separator.
        cur += '\\\\';
        i += 2;
        continue;
      }
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur);
  if (cells.length > 1) {
    let k = n - 1;
    while (k >= 0 && (line[k] === ' ' || line[k] === '\t')) k--;
    if (k >= 0 && line[k] === '|') {
      let bs = 0;
      for (let q = k - 1; q >= 0 && line[q] === '\\'; q--) bs++;
      if (bs % 2 === 0) cells.pop();
    }
  }
  for (let c = 0; c < cells.length; c++) {
    cells[c] = cells[c].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  }
  return cells;
}

function parseDelimiterRow(rest, col) {
  // Returns an array of alignments ('left' | 'center' | 'right' | null) or null.
  const ind = indentOf(rest, col);
  if (ind.cols > 3) return null;
  let cells = rest.slice(ind.idx).split('|').map((c) => c.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] === ':' && m[2] === ':') aligns.push('center');
    else if (m[1] === ':') aligns.push('left');
    else if (m[2] === ':') aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// Block parsing: the line loop.
// ---------------------------------------------------------------------------

function splitLines(src) {
  const parts = src.split('\n');
  const ended = src.length > 0 && src[src.length - 1] === '\n';
  if (ended) parts.pop();
  const lines = [];
  for (let i = 0; i < parts.length; i++) {
    lines.push({ s: parts[i], eol: i < parts.length - 1 || ended });
  }
  return lines;
}

function parseBlocks(src) {
  const lines = splitLines(src);
  const refs = new Map();
  const root = { t: 'doc', children: [] };
  const stack = [root];
  const tip = () => stack[stack.length - 1];

  function isTightList(list) {
    for (let i = 0; i < list.children.length; i++) {
      const item = list.children[i];
      if (i > 0 && item.blankBefore) return false;
      for (let k = 0; k < item.children.length; k++) {
        const ch = item.children[k];
        if (k > 0 && ch.blankBefore) return false;
      }
    }
    return true;
  }

  function popBlock(strip) {
    const node = stack.pop();
    if (node.t === 'html' && strip && node.lines.length > 0) {
      // A block that ends at a blank line, or because its container ends,
      // loses the trailing newline of its last line. A block that ends on
      // its own end tag, or at the end of the input, keeps it.
      const last = node.lines[node.lines.length - 1];
      if (last.endsWith('\n')) node.lines[node.lines.length - 1] = last.slice(0, -1);
    }
    if (node.t === 'code') {
      while (node.lines.length > 0) {
        const last = node.lines[node.lines.length - 1];
        if (last === '\n' || last === '') node.lines.pop();
        else break;
      }
    } else if (node.t === 'fence') {
      // A fenced code block drops exactly one trailing empty line.
      const last = node.lines[node.lines.length - 1];
      if (last === '\n') node.lines.pop();
    } else if (node.t === 'list') {
      node.tight = isTightList(node);
      // A blank line inside this list that was never consumed by a block
      // inside the list's parent item still separates the list from what
      // follows inside that item.
      const parent = stack[stack.length - 1];
      if (parent && parent.t === 'item' && node.sawBlank) parent.sawBlank = true;
    } else if (node.t === 'item') {
      const parent = stack[stack.length - 1];
      if (parent && parent.t === 'list' && node.sawBlank) parent.sawBlank = true;
    }
    return node;
  }

  function appendBlock(node) {
    const parent = tip();
    if (parent.t === 'item') {
      // A blank line after the previous child, whether it fell directly
      // inside this item or inside the previous child (a quote or a
      // nested list that has since ended), marks this block as coming
      // after a blank.
      const lastChild = parent.children[parent.children.length - 1];
      if ((parent.sawBlank || (lastChild && lastChild.sawBlank)) && parent.children.length > 0) node.blankBefore = true;
      parent.sawBlank = false;
      if (lastChild) lastChild.sawBlank = false;
    }
    parent.children.push(node);
    return node;
  }

  function innermostItem() {
    for (let i = stack.length - 1; i >= 1; i--) {
      if (stack[i].t === 'item') return stack[i];
    }
    return null;
  }

  function startsInterruptor(rest, col, paraOpen) {
    const ind = indentOf(rest, col);
    if (ind.cols > 3) return false;
    const s = rest.slice(ind.idx);
    if (s === '') return false;
    if (atxInfo(rest, col)) return true;
    if (fenceStart(rest, col)) return true;
    if (paraOpen && setextLevel(rest, col) > 0) return true;
    if (isThematicBreak(rest, col)) return true;
    if (htmlBlockStart(rest, col, true)) return true;
    if (s[0] === '>') return true;
    const li = matchListItem(rest, col);
    if (li) {
      if (!li.empty) {
        if (!li.ordered) return true;
        if (li.start === 1) return true;
        // An ordered item with any start number interrupts a paragraph
        // that lives inside a container (a list item, a quote): the new
        // list becomes a child block of that container. The "must start
        // at one" restriction only guards a top-level paragraph.
        if (paraOpen && stack[stack.length - 2].t !== 'doc') return true;
      }
      // A list item that continues an open list interrupts a paragraph,
      // even when it is empty or, for an ordered list, does not start
      // at one. An ordered item whose delimiter differs from the open
      // list's delimiter also interrupts: it starts a new list.
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].t === 'list') {
          const open = stack[s];
          if (open.ordered === li.ordered && open.delim === li.delim && open.bullet === li.bullet) return true;
          if (open.ordered && li.ordered && open.delim !== li.delim) return true;
          break;
        }
      }
    }
    return false;
  }

  function convertParaToTable(para, aligns) {
    const header = splitTableRow(para.lines[0]);
    const table = { t: 'table', header, aligns, rows: [] };
    if (para.blankBefore) table.blankBefore = true;
    const parent = stack[stack.length - 2];
    const idx = parent.children.indexOf(para);
    parent.children[idx] = table;
    stack[stack.length - 1] = table;
  }

  function tryParseDefinition(li, rest, col) {
    // Build a virtual text from this line and the following lines (each
    // stripped of the containers that are currently open), stopping at a
    // blank line or a line that leaves the containers.
    const firstInd = indentOf(rest, col);
    const parts = [rest.slice(firstInd.idx)];
    for (let k = li + 1; k < lines.length && parts.length < 5; k++) {
      let r = lines[k].s;
      let c = 0;
      let ok = true;
      for (let s = 1; s < stack.length; s++) {
        const b = stack[s];
        if (b.t === 'quote') {
          const m = matchQuote(r, c);
          if (!m) { ok = false; break; }
          r = m.s;
          c = m.col;
        } else if (b.t === 'item') {
          const m = matchItem(r, c, b);
          if (!m) { ok = false; break; }
          r = m.s;
          c = m.col;
        } else break;
      }
      if (!ok) break;
      if (isBlankStr(r)) break;
      parts.push(r);
    }
    const virt = parts.join('\n');
    const countLines = (pos) => {
      let c = 1;
      for (let p = 0; p < pos; p++) {
        if (virt[p] === '\n') c++;
      }
      return c;
    };
    // The definition ends on a line: skip spaces and tabs, then the line
    // must end (or the virtual text must end).
    const lineEnd = (pos) => {
      let j = pos;
      while (j < virt.length && (virt[j] === ' ' || virt[j] === '\t')) j++;
      if (j >= virt.length || virt[j] === '\n') return j;
      return -1;
    };
    if (virt[0] !== '[') return null;
    const close = findClosingBracket(virt, 0);
    if (close === -1) return null;
    const labelRaw = virt.slice(1, close);
    if (labelRaw.length === 0) return null;
    if (normalizeLabel(labelRaw) === '') return null;
    if (hasUnescapedOpenBracket(labelRaw)) return null;
    let i = close + 1;
    if (virt[i] !== ':') return null;
    i++;
    i = skipInlineWs(virt, i);
    if (i === -1) return null;
    let dest;
    if (virt[i] === '<') {
      const d = parseAngleDest(virt, i);
      if (!d) return null;
      dest = d.dest;
      i = d.end;
    } else {
      const d = parseBareDest(virt, i);
      if (d.dest === '') return null;
      dest = d.dest;
      i = d.end;
    }
    const destLine = countLines(i);
    const destEnd = lineEnd(i);
    // A title must be preceded by whitespace, and may sit on the next
    // line. If the title is malformed or followed by junk, and it sits on
    // a later line than the destination, the definition still stands
    // without a title; on the same line, the definition fails.
    const afterWs = skipInlineWs(virt, i);
    if (afterWs === -1) return null;
    if (virt[afterWs] === '"' || virt[afterWs] === "'" || virt[afterWs] === '(') {
      if (afterWs === i) return null;
      const t = parseLinkTitle(virt, afterWs);
      if (t) {
        const end = lineEnd(t.end);
        if (end !== -1) {
          return { label: normalizeLabel(labelRaw), dest, title: t.title, consumed: countLines(end) };
        }
        if (countLines(afterWs) > destLine && destEnd !== -1) {
          return { label: normalizeLabel(labelRaw), dest, title: null, consumed: countLines(destEnd) };
        }
        return null;
      }
      if (countLines(afterWs) > destLine && destEnd !== -1) {
        return { label: normalizeLabel(labelRaw), dest, title: null, consumed: countLines(destEnd) };
      }
      return null;
    }
    if (destEnd === -1) return null;
    return { label: normalizeLabel(labelRaw), dest, title: null, consumed: countLines(destEnd) };
  }

  function processLeaf(rest, col, eol, li) {
    // Processes one line after container matching. Returns the number of
    // extra lines consumed (link reference definitions may span lines).
    let extra = 0;
    for (;;) {
      const t = tip();
      if (isBlankStr(rest)) {
        // The last line of the input, when it holds only spaces after a
        // container marker, is kept as the paragraph's trailing line.
        if (rest !== '' && li === lines.length - 1 && col > 0 && t.t === 'para') {
          t.lines.push(rest);
          t.lastLazy = false;
          return extra;
        }
        // A blank line that ends a block, or sits directly inside a
        // container, marks that container as having seen a blank, so the
        // next block inside it (or the next item of its list) is marked
        // as coming after a blank. A blank line inside a fenced or
        // indented code block, or inside a type 1-5 HTML block, is
        // content of that block and marks nothing. This runs before the
        // empty item below is popped, so its mark propagates to the
        // list when it is popped.
        const marksBlank = t.t !== 'fence' && t.t !== 'code' && !(t.t === 'html' && t.kind <= 5 && !t.done);
        if (marksBlank) {
          const container = (t.t === 'item' || t.t === 'quote' || t.t === 'list') ? t : stack[stack.length - 2];
          if (container && (container.t === 'item' || container.t === 'quote' || container.t === 'list')) {
            container.sawBlank = true;
          }
        }
        if (t.t === 'para') popBlock();
        else if (t.t === 'item' && t.children.length === 0) popBlock();
        else if (t.t === 'code') {
          const stripped = stripCols(rest, col, 4, true);
          t.lines.push(stripped.s + (eol ? '\n' : ''));
        } else if (t.t === 'fence') {
          const stripped = stripCols(rest, col, t.indent);
          t.lines.push(stripped.s + (eol ? '\n' : ''));
        } else if (t.t === 'html') {
          // A finished HTML block loses its trailing newline only when
          // the next line is truly empty. A whitespace-only line keeps
          // it, like a non-blank line does.
          if (t.done) popBlock(rest === '');
          else if (t.kind <= 5) t.lines.push(rest + (eol ? '\n' : ''));
          else popBlock(true);
        } else if (t.t === 'table') {
          // A line holding only a tab is not a blank line for a table:
          // it becomes an empty body row (all cells empty). A truly
          // empty line, or a spaces-only line, ends the table.
          if (rest.indexOf('\t') !== -1) {
            const cells = [];
            while (cells.length < t.header.length) cells.push('');
            t.rows.push(cells);
          } else {
            popBlock();
          }
        }
        return extra;
      }
      if (t.t === 'fence') {
        if (isClosingFence(rest, col, t)) { popBlock(); return extra; }
        const stripped = stripCols(rest, col, t.indent);
        t.lines.push(stripped.s + (eol ? '\n' : ''));
        return extra;
      }
      if (t.t === 'code') {
        const ind = indentOf(rest, col);
        if (ind.cols >= 4) {
          const stripped = stripCols(rest, col, 4, true);
          t.lines.push(stripped.s + (eol ? '\n' : ''));
          return extra;
        }
        popBlock();
        continue;
      }
      if (t.t === 'html') {
        if (t.done) { popBlock(false); continue; }
        if (t.kind <= 5) {
          t.lines.push(rest + (eol ? '\n' : ''));
          if ((t.endRe && t.endRe.test(rest)) || htmlBlockEnds(t, rest)) t.done = true;
          return extra;
        }
        t.lines.push(rest + (eol ? '\n' : ''));
        return extra;
      }
      if (t.t === 'table') {
        const ind = indentOf(rest, col);
        // A body row need not contain a pipe: the whole line is the
        // first cell and the rest are empty. But a line that starts a
        // new block ends the table instead of becoming a row.
        if (ind.cols <= 3 && !startsInterruptor(rest, col, false) && !matchListItem(rest, col)) {
          const cells = splitTableRow(rest);
          while (cells.length < t.header.length) cells.push('');
          if (cells.length > t.header.length) cells.length = t.header.length;
          t.rows.push(cells);
          return extra;
        }
        popBlock();
        continue;
      }
      if (t.t === 'para') {
        const se = setextLevel(rest, col);
        if (se > 0) {
          const text = t.lines.join('\n').replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
          t.t = 'heading';
          t.level = se;
          t.lines = [text];
          popBlock();
          return extra;
        }
        if (t.lines.length === 1 && t.lines[0].indexOf('|') !== -1) {
          const d = parseDelimiterRow(rest, col);
          if (d && d.length >= splitTableRow(t.lines[0]).length) {
            convertParaToTable(t, d);
            return extra;
          }
        }
        if (startsInterruptor(rest, col, true)) { popBlock(); continue; }
        t.lines.push(rest);
        t.lastLazy = false;
        return extra;
      }
      // No open leaf: a new block starts here.
      const ind = indentOf(rest, col);
      const li2 = matchListItem(rest, col);
      if (tip().t === 'list') {
        const cur = tip();
        const continues = li2 && li2.ordered === cur.ordered && li2.delim === cur.delim && li2.bullet === cur.bullet && !isThematicBreak(rest, col);
        if (!continues) popBlock();
      }
      const qm = matchQuote(rest, col);
      if (qm) {
        const quote = { t: 'quote', children: [] };
        appendBlock(quote);
        stack.push(quote);
        if (!isBlankStr(qm.s)) processLeaf(qm.s, qm.col, eol, li);
        return extra;
      }
      if (ind.cols >= 4) {
        const code = { t: 'code', lines: [] };
        appendBlock(code);
        stack.push(code);
        const stripped = stripCols(rest, col, 4, true);
        code.lines.push(stripped.s + (eol ? '\n' : ''));
        return extra;
      }
      const f = fenceStart(rest, col);
      if (f) {
        const fence = { t: 'fence', lang: f.lang, lines: [], fenceCh: f.ch, fenceLen: f.len, indent: ind.cols, absIndent: col + ind.cols };
        appendBlock(fence);
        stack.push(fence);
        return extra;
      }
      const h = htmlBlockStart(rest, col, false);
      if (h) {
        const html = { t: 'html', kind: h.kind, name: h.name, lines: [rest + (eol ? '\n' : '')] };
        if (h.kind === 1) html.endRe = new RegExp('</' + h.name + '[ \\t]*>', 'i');
        appendBlock(html);
        // A block already complete on its opening line stays on the stack
        // as done, so the next line can decide whether its trailing
        // newline survives (kept before a non-blank line, dropped
        // before a blank line or when its container ends).
        html.done = h.kind <= 5 && ((html.endRe && html.endRe.test(rest)) || htmlBlockEnds(html, rest));
        stack.push(html);
        return extra;
      }
      const a = atxInfo(rest, col);
      if (a) {
        appendBlock({ t: 'heading', level: a.level, lines: [a.text] });
        return extra;
      }
      if (isThematicBreak(rest, col)) {
        appendBlock({ t: 'hr' });
        return extra;
      }
      const def = tryParseDefinition(li, rest, col);
      if (def) {
        if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
        return def.consumed - 1;
      }
      if (li2) {
        let list = null;
        let listOnStack = false;
        if (tip().t === 'list') {
          list = tip();
          listOnStack = true;
        } else {
          const parent = tip();
          if (parent.children.length > 0) {
            const last = parent.children[parent.children.length - 1];
            if (last.t === 'list' && last.ordered === li2.ordered && last.delim === li2.delim && last.bullet === li2.bullet) {
              list = last;
            }
          }
        }
        if (!list) {
          list = { t: 'list', ordered: li2.ordered, delim: li2.delim, bullet: li2.bullet, start: li2.start, tight: true, sawBlank: false, children: [] };
          appendBlock(list);
        }
        const item = { t: 'item', children: [], contentIndent: li2.contentIndent, sawBlank: false, blankBefore: false };
        if (list.sawBlank) { item.blankBefore = true; list.sawBlank = false; }
        list.children.push(item);
        if (!listOnStack) stack.push(list);
        stack.push(item);
        if (!li2.empty) processLeaf(li2.content, li2.contentCol, eol, li);
        return extra;
      }
      const para = { t: 'para', lines: [rest], lastLazy: false };
      appendBlock(para);
      stack.push(para);
      return extra;
    }
  }

  function htmlBlockEnds(block, rest) {
    if (block.kind === 2) return rest.indexOf('-->') !== -1;
    if (block.kind === 3) return rest.indexOf('?>') !== -1;
    if (block.kind === 4) return rest.indexOf('>') !== -1;
    if (block.kind === 5) return rest.indexOf(']]>') !== -1;
    return false;
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let rest = line.s;
    let col = 0;
    let i = 1;
    let failedAt = -1;
    while (i < stack.length) {
      const b = stack[i];
      if (b.t === 'quote') {
        const m = matchQuote(rest, col);
        if (!m) { failedAt = i; break; }
        rest = m.s;
        col = m.col;
        i++;
      } else if (b.t === 'item') {
        const m = matchItem(rest, col, b);
        if (!m) { failedAt = i; break; }
        rest = m.s;
        col = m.col;
        i++;
      } else if (b.t === 'list') {
        i++;
      } else break;
    }
    if (failedAt !== -1) {
      const t = tip();
      if (t.t === 'fence' && !isBlankStr(rest) && !isClosingFence(rest, col, t) && stack[failedAt].t === 'item') {
        // A line inside a fenced code block that does not match the
        // enclosing list item is still fence content: only a closing
        // fence ends the block. (For a block quote the fence does end:
        // a line without the quote marker closes the quote and the
        // fence.) The line is stripped to the fence's absolute indent
        // (the containers it missed contribute nothing).
        const strip = Math.max(0, (t.absIndent || 0) - col);
        const stripped = stripCols(rest, col, strip);
        t.lines.push(stripped.s + (line.eol ? '\n' : ''));
        continue;
      }
      if (t.t === 'para' && !isBlankStr(rest)) {
        if (t.lines.length === 1 && t.lines[0].indexOf('|') !== -1) {
          const d = parseDelimiterRow(rest, col);
          if (d && d.length >= splitTableRow(t.lines[0]).length) {
            convertParaToTable(t, d);
            continue;
          }
        }
        const se = setextLevel(rest, col);
        if (se === 1) {
          // A lazy level-one underline: inside a list item it still makes
          // a heading when the previous line was lazy too; inside a quote
          // it stays paragraph text, indented four spaces when the
          // previous line was lazy, so it cannot read as an underline.
          const parent = stack[stack.length - 2];
          if (parent && parent.t === 'item' && t.lastLazy) {
            const text = t.lines.join('\n').replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
            t.t = 'heading';
            t.level = 1;
            t.lines = [text];
            popBlock();
            continue;
          }
          if (parent && parent.t === 'quote') {
            t.lines.push((t.lastLazy ? '    ' : '') + rest);
            t.lastLazy = true;
            continue;
          }
          t.lines.push(rest);
          t.lastLazy = true;
          continue;
        }
        if (!startsInterruptor(rest, col, true)) {
          // A lazy continuation line loses leading whitespace: four
          // columns inside a block quote, the item's content indent
          // inside a list item.
          const failed = stack[failedAt];
          let line = rest;
          if (failed.t === 'quote') {
            const ind = indentOf(rest, col);
            if (ind.cols >= 4) line = stripCols(rest, col, 4).s;
          } else if (failed.t === 'item') {
            line = stripCols(rest, col, failed.contentIndent).s;
          }
          t.lines.push(line);
          t.lastLazy = true;
          continue;
        }
      }
      while (stack.length > failedAt) popBlock(true);
    }
    li += processLeaf(rest, col, line.eol, li);
  }
  while (stack.length > 1) popBlock(false);
  return { root, refs };
}

// ---------------------------------------------------------------------------
// Block rendering.
// ---------------------------------------------------------------------------

function renderInlineLines(lines, refs) {
  return renderInline(scanInline(lines.join('\n'), refs, false));
}

function inlineText(text, refs) {
  return renderInline(scanInline(text, refs, false));
}

function renderBlock(node, refs, tight) {
  switch (node.t) {
    case 'para': {
      const inner = renderInlineLines(node.lines, refs);
      if (tight) return inner;
      return '<p>' + inner + '</p>\n';
    }
    case 'heading': {
      const inner = inlineText(node.lines[0], refs);
      return '<h' + node.level + '>' + inner + '</h' + node.level + '>\n';
    }
    case 'code': {
      return '<pre><code>' + escapeText(node.lines.join('')) + '</code></pre>\n';
    }
    case 'fence': {
      const langAttr = node.lang !== '' ? ' class="language-' + escapeAttr(node.lang) + '"' : '';
      return '<pre><code' + langAttr + '>' + escapeText(node.lines.join('')) + '</code></pre>\n';
    }
    case 'html': {
      return node.lines.join('');
    }
    case 'hr': {
      return '<hr>\n';
    }
    case 'quote': {
      let inner = '';
      for (const ch of node.children) inner += renderBlock(ch, refs, false);
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const startAttr = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let inner = '';
      for (const ch of node.children) inner += renderItem(ch, refs, node.tight);
      return '<' + tag + startAttr + '>\n' + inner + '</' + tag + '>\n';
    }
    case 'item': {
      return renderItem(node, refs, tight);
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.header.length; i++) {
        const align = node.aligns[i];
        out += '<th' + (align ? ' align="' + align + '"' : '') + '>' + inlineText(node.header[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            const align = node.aligns[i];
            out += '<td' + (align ? ' align="' + align + '"' : '') + '>' + inlineText(row[i], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
  }
  return '';
}

function renderItem(item, refs, tight) {
  let inner = '';
  for (let i = 0; i < item.children.length; i++) {
    const ch = item.children[i];
    if (i === 0 && ch.t === 'para') inner += renderParaCheckbox(ch, refs, tight);
    else inner += renderBlock(ch, refs, tight);
  }
  return '<li>' + inner + '</li>\n';
}

function renderParaCheckbox(para, refs, tight) {
  // A task-list checkbox: '[ ]', '[x]' or '[X]' after up to three spaces,
  // followed by spaces or a tab. The marker and its whitespace are replaced
  // by the checkbox and a single space.
  const first = para.lines[0];
  const m = /^ {0,3}\[([ xX])\][ \t]+/.exec(first);
  if (!m) return renderBlock(para, refs, tight);
  const box = m[1] === ' ' ? '<input disabled="" type="checkbox">' : '<input checked="" disabled="" type="checkbox">';
  const lines = [first.slice(m[0].length)].concat(para.lines.slice(1));
  const inner = box + ' ' + renderInlineLines(lines, refs);
  if (tight) return inner;
  return '<p>' + inner + '</p>\n';
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  bareAutoOff = false;
  const src = normalizeInput(markdown);
  const { root, refs } = parseBlocks(src);
  let out = '';
  for (const node of root.children) out += renderBlock(node, refs, false);
  return out;
}
