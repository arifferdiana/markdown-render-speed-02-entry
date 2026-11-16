// parse.js — a dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 returns with its default options (gfm on,
// breaks off, pedantic off). Written from scratch against the CommonMark 0.31.2
// and GFM 0.29 specifications plus marked's observable behaviour; it does not
// copy marked's source. parse() is stateless: nothing is kept between calls.

// ---------------- shared helpers ----------------

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}
function isSpace(ch) {
  // Unicode whitespace per CommonMark (space, tab, LF, VT, FF, CR, NBSP, etc.)
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r' ||
    ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') ||
    ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' || ch === '\u3000';
}
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Escape text content: & < > " ' are all encoded.
const ESCAPE_RE = /[&<>"']/;
function escapeText(s) {
  if (!ESCAPE_RE.test(s)) return s;
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
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape a URL or title attribute value: & is left alone when it starts a
// valid entity reference (&word; or &#123; or &#x1f;), otherwise encoded.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!isEntityStart(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's cleanUrl: encode a link href the way encodeURI does, but keep a
// literal '%' as '%' (undo encodeURI's %25) so already-encoded sequences are
// not double-encoded.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Is there a valid entity reference starting at s[i] ('&')? Named (&word;),
// decimal (&# + 1-7 digits + ;) or hex (&#x + 1-6 hex + ;).
function isEntityStart(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return false;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const st = j;
      while (j < n && isHex(s.charCodeAt(j))) j++;
      const len = j - st;
      return len >= 1 && len <= 6 && j < n && s[j] === ';';
    }
    const st = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    const len = j - st;
    return len >= 1 && len <= 7 && j < n && s[j] === ';';
  }
  const st = j;
  while (j < n && isWordChar(s.charCodeAt(j))) j++;
  return j > st && j < n && s[j] === ';';
}
function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function isWordChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

// Decode a numeric character reference body ('#123' or '#x1f') to a string.
// Returns null when the body is not a valid numeric reference.
function decodeNumericRef(body) {
  let code;
  if (body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88) {
    code = parseInt(body.slice(2), 16);
  } else {
    code = parseInt(body.slice(1), 10);
  }
  if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(code);
}

// Normalize a link label: collapse internal whitespace runs to one space,
// trim, lowercase.
function normalizeLabel(s) {
  // Unicode case folding: sharp s (ß, ẞ) folds to "ss", so [ẞ] matches [SS]
  const folded = s.replace(/[\u00DF\u1E9E]/g, 'ss');
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i];
    if (isSpace(ch) || ch === '\n') {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      out += ch;
      started = true;
    }
  }
  return out.toLowerCase();
}

// Unescape backslash escapes and decode numeric references inside a URL or
// title, the way marked does for link destinations and titles.
function cleanInlineText(s) {
  // Backslash before ASCII punctuation -> the punctuation; numeric refs decode;
  // named refs pass through unchanged; other & -> &amp; is NOT applied here
  // (callers escape afterwards).
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(s[i + 1])) { // backslash
      out += s[i + 1];
      i += 2;
    } else if (c === 38 && isEntityStart(s, i)) { // &
      // numeric reference: decode; named: keep verbatim
      if (s[i + 1] === '#') {
        let j = i + 2;
        if (s[j] === 'x' || s[j] === 'X') j++;
        const st = j;
        while (j < n && s[j] !== ';') j++;
        out += decodeNumericRef(s.slice(i + 1, j));
        i = j + 1;
      } else {
        let j = i + 1;
        while (j < n && s[j] !== ';') j++;
        out += s.slice(i, j + 1);
        i = j + 1;
      }
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

// ---------------- inline parsing ----------------
// The inline parser scans a string once into a flat list of items, then
// resolves emphasis with a delimiter stack (CommonMark algorithm), then
// renders. Items:
//  {t:'text', s} {t:'code', s} {t:'delim', ch, n, open, close}
//  {t:'link', href, title, kids} {t:'img', href, title, alt}
//  {t:'auto', href, text} {t:'html', s} {t:'br'} {t:'ent', s} (verbatim entity)

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// True when the inline items so far contain an unmatched '_' emphasis
// opener. A trailing '_' after a bare email is an emphasis closer (and
// the email still linkifies) exactly in that case; without an opener the
// '_' blocks the autolink.
function openUnderscoreDelim(items) {
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.t === 'delim' && it.ch === '_' && it.open) return true;
  }
  return false;
}

function inlineItems(src, refs) {
  // Per-block state: a failed link's emphasis suppression never leaks
  // from one block (or one recursive label parse) into another.
  NO_EMPHASIS_UNTIL = -1;
  const items = [];
  let textStart = 0;
  const n = src.length;
  let i = 0;
  const flushText = (end) => {
    if (end > textStart) items.push({ t: 'text', s: src.slice(textStart, end) });
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    // newline: hard break (backslash or two trailing spaces) or soft break.
    // A hard break also strips the next line's leading whitespace.
    if (c === 10) {
      // count spaces immediately before the newline in the source
      let k = 0;
      while (i - 1 - k >= textStart && src[i - 1 - k] === ' ') k++;
      if (k >= 2) {
        flushText(i - k);
        items.push({ t: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        flushText(i);
        items.push({ t: 'text', s: '\n' });
        i++;
      }
      textStart = i;
      continue;
    }
    // backslash escape
    if (c === 92) {
      const nx = src[i + 1];
      if (nx === '\n') {
        flushText(i);
        items.push({ t: 'br' });
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        flushText(i);
        items.push({ t: 'text', s: nx });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // code span
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      const close = findCodeClose(src, j, run);
      if (close >= 0) {
        let content = src.slice(j, close);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText(i);
        items.push({ t: 'code', s: content });
        i = close + run;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // emphasis delimiters * and _ (string boundaries count as whitespace,
    // i.e. a newline, for flanking purposes, as in cmark). Inside a
    // failed link's label (i < NO_EMPHASIS_UNTIL) they are plain text.
    if ((c === 42 || c === 95) && i >= NO_EMPHASIS_UNTIL) {
      const ch = src[i];
      let j = i;
      while (j < n && src[j] === ch) j++;
      const run = j - i;
      const before = i > 0 ? src[i - 1] : '\n';
      const after = j < n ? src[j] : '\n';
      const leftFlank = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const rightFlank = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      let canOpen, canClose;
      if (ch === '*') {
        canOpen = leftFlank;
        canClose = rightFlank;
      } else {
        canOpen = leftFlank && (!rightFlank || isPunct(before));
        canClose = rightFlank && (!leftFlank || isPunct(after));
      }
      flushText(i);
      items.push({ t: 'delim', ch, n: run, open: canOpen, close: canClose, aw: after !== '\n' && isWordChar(after.charCodeAt(0)) });
      i = j;
      textStart = i;
      continue;
    }
    // strikethrough ~ : a run of 1 or 2 tildes is a delimiter (a run of 3+
    // is literal text); it opens when not followed by whitespace and closes
    // when not preceded by whitespace; open and close runs must match.
    // Inside a failed link's label it is plain text, like * and _.
    if (c === 126 && i >= NO_EMPHASIS_UNTIL) {
      let j = i;
      while (j < n && src[j] === '~') j++;
      const run = j - i;
      if (run === 1 || run === 2) {
        const before = i > 0 ? src[i - 1] : '\n';
        const after = j < n ? src[j] : '\n';
        flushText(i);
        items.push({ t: 'delim', ch: '~', n: run, open: !isSpace(after), close: !isSpace(before) });
        i = j;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // entity reference (verbatim) or numeric reference (decoded)
    if (c === 38 && isEntityStart(src, i)) {
      flushText(i);
      if (src[i + 1] === '#') {
        let j = i + 2;
        if (src[j] === 'x' || src[j] === 'X') j++;
        const st = j;
        while (j < n && src[j] !== ';') j++;
        items.push({ t: 'text', s: decodeNumericRef(src.slice(i + 1, j)) });
        i = j + 1;
      } else {
        let j = i + 1;
        while (j < n && src[j] !== ';') j++;
        items.push({ t: 'ent', s: src.slice(i, j + 1) });
        i = j + 1;
      }
      textStart = i;
      continue;
    }
    // raw HTML tag
    if (c === 60) {
      const tag = matchHtmlTag(src, i);
      if (tag !== null) {
        flushText(i);
        items.push({ t: 'html', s: tag });
        // track <a> / </a>: an unclosed <a> suppresses later autolinks
        const tl = tag.toLowerCase();
        if (tl.startsWith('</a') && (tl.length === 3 || tl[3] === '>' || tl[3] === ' ' || tl[3] === '\t' || tl[3] === '\n')) INSIDE_A_TAG = false;
        else if (tl.startsWith('<a') && (tl.length === 2 || tl[2] === '>' || tl[2] === ' ' || tl[2] === '\t' || tl[2] === '\n')) {
          // A self-closing '<a ... />' followed by other content in the
          // same paragraph opens an anchor that persists (marked
          // suppresses autolinks in later paragraphs); alone in its
          // paragraph it does not ('<a  />' alone leaves the next
          // paragraph's autolink intact, but '<a  /><b2>' suppresses
          // it). So a '/>' tag sets the flag only when non-whitespace
          // content follows it in this inline run.
          if (!tl.endsWith('/>')) INSIDE_A_TAG = true;
          else {
            let k = i + tag.length;
            while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
            if (k < n) INSIDE_A_TAG = true;
          }
        }
        i += tag.length;
        textStart = i;
        continue;
      }
      // autolink <scheme:...> or <email>. NOTE: unlike bare autolinks,
      // the <...> form is NOT suppressed inside a link label or an <a>
      // tag (marked nests it).
      const auto = matchAutolink(src, i);
      if (auto !== null) {
        flushText(i);
        items.push(auto);
        i += auto.len;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // links and images
    if (c === 91 || (c === 33 && src[i + 1] === '[')) {
      const isImg = c === 33;
      const start = i;
      const open = isImg ? i + 1 : i;
      const link = tryParseLink(src, open, refs, isImg);
      if (link !== null) {
        flushText(start);
        items.push(link.item);
        // Odd-backtick label: a link whose label holds a code span with
        // mismatched opening/closing runs (odd total backticks) leaves
        // emphasis suppressed until the last code span in the paragraph
        // ('[a ``b`](u) _x y_ ``c``' leaves '_x y_' literal). Use the
        // LAST backtick run at/after the link: an intervening complete
        // span such as '`deno`' does not end it (doc-09), while
        // emphasis after the last span still forms (doc-16's '**two
        // small many**'). If there is no backtick after the link,
        // nothing is suppressed.
        if (link.labelOddTicks) {
          const lastBt = src.lastIndexOf('`');
          if (lastBt >= link.end) {
            let rs = lastBt;
            while (rs > link.end && src.charCodeAt(rs - 1) === 96) rs--;
            if (rs > NO_EMPHASIS_UNTIL) NO_EMPHASIS_UNTIL = rs;
          }
        }
        i = link.end;
        textStart = i;
        continue;
      }
      // Failed link attempt. When the text has the shape [label](...)
      // with a ')' after the '(' (so marked's link pattern matched and
      // the label's emphasis delimiters were consumed while attempting
      // the link), the label holds no link or image, and every backtick
      // run in the label belongs to a complete code span, emphasis
      // inside the label does not form: suppress * _ ~ delimiters up
      // to the label's closing ']'. Code spans, autolinks, HTML and
      // entities inside the label still parse. (When there is no '(' or
      // no ')', the label holds a link/image, or a backtick run is left
      // unpaired, the delimiters are untouched.)
      const close2 = findLabelClose(src, open);
      if (close2 > open && src[close2 + 1] === '(' && src.indexOf(')', close2 + 2) >= 0) {
        const labelRaw = src.slice(open + 1, close2);
        if (!hasUnpairedBacktickRun(labelRaw)) {
          const savedUntil = NO_EMPHASIS_UNTIL;
          NO_EMPHASIS_UNTIL = -1;
          const kids = inlineItems(labelRaw, refs);
          NO_EMPHASIS_UNTIL = savedUntil;
          if (!labelHasLinkOrImg(kids) && close2 > NO_EMPHASIS_UNTIL) NO_EMPHASIS_UNTIL = close2;
        }
      }
      i++;
      continue;
    }
    // extended autolinks: www., http://, https://, ftp://, bare email.
    // 'www.' must be lowercase (Www. is plain text); schemes are
    // case-insensitive (Https:// is an autolink).
    // (suppressed inside a link's label text, and inside an <a> tag)
    if (!NO_AUTOLINK && !INSIDE_A_TAG && (c === 119 || c === 87 || c === 104 || c === 72 || c === 102 || c === 70)) {
      // Scheme check by direct charCodeAt (case-insensitive), avoiding
      // a slice+toLowerCase allocation on every w/h/f character.
      let isScheme = false;
      if (src.startsWith('www.', i)) isScheme = true;
      else if (c === 104 || c === 72) {
        const t1 = src.charCodeAt(i + 1), t2 = src.charCodeAt(i + 2), p = src.charCodeAt(i + 3);
        if ((t1 === 116 || t1 === 84) && (t2 === 116 || t2 === 84) && (p === 112 || p === 80)) {
          const s = src.charCodeAt(i + 4);
          if (s === 58 && src.charCodeAt(i + 5) === 47 && src.charCodeAt(i + 6) === 47) isScheme = true;
          else if ((s === 115 || s === 83) && src.charCodeAt(i + 5) === 58 && src.charCodeAt(i + 6) === 47 && src.charCodeAt(i + 7) === 47) isScheme = true;
        }
      } else if (c === 102 || c === 70) {
        const t1 = src.charCodeAt(i + 1), p = src.charCodeAt(i + 2);
        if ((t1 === 116 || t1 === 84) && (p === 112 || p === 80) && src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47) isScheme = true;
      }
      if (isScheme) {
        const ext = matchExtendedUrl(src, i);
        if (ext !== null) {
          flushText(i);
          items.push(ext);
          i += ext.len;
          textStart = i;
          continue;
        }
      }
      // not an autolink (or no valid one here): fall through to the
      // email check below, then advance one char
      if (!isEmailStart(src, i)) { i++; continue; }
    }
    // scheme autolink: lowercase mailto:/xmpp: + email (+ one path seg
    // for xmpp) is a single link covering the whole span
    // (suppressed inside a link's label text, and inside an <a> tag)
    if (!NO_AUTOLINK && !INSIDE_A_TAG && (c === 109 || c === 120)) {
      const sch = matchSchemeEmail(src, i, openUnderscoreDelim(items));
      if (sch !== null) {
        flushText(i);
        items.push(sch);
        i += sch.len;
        textStart = i;
        continue;
      }
    }
    // bare email (only when preceded by start or a non-word char, and the
    // local part starts here). Suppressed inside a link's label text,
    // and inside an <a> tag.
    if (!NO_AUTOLINK && !INSIDE_A_TAG && isEmailStart(src, i)) {
      const em = matchEmail(src, i, openUnderscoreDelim(items));
      if (em !== null) {
        flushText(i);
        items.push(em);
        i += em.len;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  flushText(n);
  resolveEmphasis(items);
  return items;
}

// Inline-parse src to an HTML string.
function inline(src, refs) {
  return renderInline(inlineItems(src, refs));
}

function findCodeClose(src, from, run) {
  const n = src.length;
  let i = from;
  while (i < n) {
    if (src.charCodeAt(i) === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      if (j - i === run) return i;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

// Match an inline HTML tag at src[i] ('<'). Returns the tag string or null.
function matchHtmlTag(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j >= n) return null;
  const c = src.charCodeAt(j);
  // comment <!-- ... --> ; <!--> and <!---> are complete (abruptly
  // closed) comments on their own
  if (src.startsWith('!--', j)) {
    if (src[j + 3] === '>') return src.slice(i, j + 4);
    if (src.startsWith('->', j + 3)) return src.slice(i, j + 5);
    const end = src.indexOf('-->', j + 3);
    if (end >= 0) return src.slice(i, end + 3);
    return null;
  }
  // processing instruction <? ... ?>
  if (c === 63) {
    const end = src.indexOf('?>', j + 1);
    if (end >= 0) return src.slice(i, end + 2);
    return null;
  }
  // declaration <!A ... > or CDATA <![CDATA[ ... ]]>
  if (c === 33) {
    if (src.startsWith('[CDATA[', j + 1)) {
      const end = src.indexOf(']]>', j + 8);
      if (end >= 0) return src.slice(i, end + 3);
      return null;
    }
    if (j + 1 < n && src.charCodeAt(j + 1) >= 65 && src.charCodeAt(j + 1) <= 90) {
      const end = src.indexOf('>', j + 1);
      if (end >= 0) return src.slice(i, end + 1);
      return null;
    }
    return null;
  }
  // open or close tag: name, then attributes. A tag may span lines
  // (whitespace inside it includes newlines). After the name the next char
  // must be whitespace, '/' or '>' — anything else (e.g. ':' in
  // <https://...>) means this is not a tag at all. A closing tag takes
  // no attributes: only whitespace may follow its name before '>'.
  let k = j;
  let isClose = false;
  if (src[k] === '/') { k++; isClose = true; }
  if (k >= n || !/[A-Za-z]/.test(src[k])) return null;
  while (k < n && /[A-Za-z0-9-]/.test(src[k])) k++;
  if (isClose) {
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
    if (k < n && src[k] === '>') return src.slice(i, k + 1);
    return null;
  }
  for (;;) {
    let skipped = 0;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) { k++; skipped++; }
    if (k >= n) return null;
    if (src[k] === '>') return src.slice(i, k + 1);
    if (src[k] === '/') {
      if (src[k + 1] === '>') return src.slice(i, k + 2);
      return null;
    }
    // an attribute name must be preceded by whitespace (also true right
    // after the tag name, so ':' after a name is not a tag: <m:abc>,
    // <https://...>)
    if (skipped === 0) return null;
    if (!/[A-Za-z_:-]/.test(src[k])) return null;
    while (k < n && /[A-Za-z0-9_.:-]/.test(src[k])) k++;
    // peek for '=' without consuming the whitespace: a valueless attribute
    // leaves the whitespace for the next attribute's spacing check
    let k2 = k;
    while (k2 < n && (src[k2] === ' ' || src[k2] === '\t' || src[k2] === '\n')) k2++;
    if (src[k2] === '=') {
      k = k2 + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
      if (src[k] === '"') {
        k++;
        while (k < n && src[k] !== '"') k++;
        if (k >= n) return null;
        k++;
      } else if (src[k] === "'") {
        k++;
        while (k < n && src[k] !== "'") k++;
        if (k >= n) return null;
        k++;
      } else {
        // unquoted value: non-empty, no spaces, quotes, =, <, > or backtick
        if (k >= n) return null;
        const ch0 = src[k];
        if (ch0 === '>' || ch0 === '"' || ch0 === "'" || ch0 === '=' || ch0 === '<' || ch0 === '`') return null;
        while (k < n && src[k] !== ' ' && src[k] !== '\t' && src[k] !== '\n' && src[k] !== '>') {
          const ch = src[k];
          if (ch === '"' || ch === "'" || ch === '=' || ch === '<' || ch === '`') return null;
          k++;
        }
      }
    }
  }
}

// Match <scheme:...> or <email> autolink at src[i]. Returns item or null.
function matchAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  // scheme: 2-32 chars, letter first, then letters/digits/+/-/.
  const st = j;
  if (j < n && /[A-Za-z]/.test(src[j])) {
    j++;
    while (j < n && /[A-Za-z0-9+.-]/.test(src[j])) j++;
    if (j - st >= 2 && j - st <= 32 && src[j] === ':' && j + 1 < n) {
      // find '>' with no space or '<' before it
      let k = j + 1;
      while (k < n && src[k] !== '>' && src[k] !== ' ' && src[k] !== '<' && src[k] !== '\n') k++;
      if (k < n && src[k] === '>') {
        const href = src.slice(i + 1, k);
        return { t: 'auto', href, text: href, len: k + 1 - i };
      }
    }
  }
  // email: local@domain
  j = i + 1;
  let k = j;
  while (k < n && src[k] !== '>' && src[k] !== ' ' && src[k] !== '<' && src[k] !== '\n') k++;
  if (k < n && src[k] === '>') {
    const cand = src.slice(j, k);
    if (EMAIL_RE.test(cand)) {
      return { t: 'auto', href: 'mailto:' + cand, text: cand, len: k + 1 - i };
    }
  }
  return null;
}

// Extended autolink for a bare http(s)://, ftp:// or www. URL at src[i].
function matchExtendedUrl(src, i) {
  const n = src.length;
  let j = i;
  // find the end: stop at whitespace, '<', or control
  while (j < n) {
    const ch = src[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch.charCodeAt(0) < 32) break;
    j++;
  }
  let end = j;
  // an unmatched '(' (one never closed by a ')' before the end of the
  // candidate) ends the URL just before it: 'x)](https://y' is the link
  // 'x)]' followed by '(https://y', not one link. Only the LAST '('
  // matters: 'a(b](c)' keeps its '(' before 'b' because the last '('
  // (before 'c') is closed. A ')' with no '(' before it is fine mid-URL
  // and is handled by the trailing strip below.
  {
    let lastOpen = -1;
    for (let k = i; k < end; k++) if (src[k] === '(') lastOpen = k;
    if (lastOpen >= 0) {
      let closed = false;
      for (let k = lastOpen + 1; k < end; k++) if (src[k] === ')') { closed = true; break; }
      if (!closed) end = lastOpen;
    }
  }
  // strip trailing punctuation per GFM: ? ! . , : * _ ~ and unmatched )
  // and a trailing ; that would complete an entity reference
  while (end > i) {
    const ch = src[end - 1];
    if (ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === '*' || ch === '_' || ch === '~') {
      end--;
    } else if (ch === ')') {
      // the trailing ')' is kept only when it is the first ')' after the
      // last '(' in the candidate, i.e. it closes that paren; a ')' with
      // no '(' before it, or one that follows an already-closed paren, is
      // dropped. This is what lets 'x)](./y)' keep its ')' (the ')' after
      // 'x' does not close the '(' before './y') while '((a))' drops one.
      let lastOpen = -1;
      let closedAfter = false;
      for (let k = i; k < end - 1; k++) {
        if (src[k] === '(') { lastOpen = k; closedAfter = false; }
        else if (src[k] === ')' && lastOpen >= 0) closedAfter = true;
      }
      if (lastOpen < 0 || closedAfter) end--;
      else break;
    } else if (ch === ';') {
      // if the ; completes an entity-like &...; sequence, drop the WHOLE
      // sequence (the &...; is literal text after the link, not part of it);
      // otherwise a trailing ; is plain punctuation and is dropped too
      let k = end - 2;
      while (k > i && isWordChar(src.charCodeAt(k))) k--;
      if (k > i && src[k] === '&') end = k;
      else end--;
    } else break;
  }
  if (end <= i) return null;
  const url = src.slice(i, end);
  // a www. link needs a dot in the domain part; the www. must be lowercase
  if (url.startsWith('www.')) {
    const after = url.slice(4);
    if (!after.includes('.')) return null;
    if (after.includes(' ') || after.includes('<')) return null;
  }
  // must contain a dot after the scheme for scheme links too (host check is
  // loose: require at least one '.' in the authority)
  const href = url.startsWith('www.') ? 'http://' + url : url;
  return { t: 'auto', href, text: url, len: end - i };
}

// Lookup table for characters valid in an email address (local part,
// domain, and '@'). Replaces a long boolean chain in the hot
// isEmailStart/matchEmail paths.
const EMAIL_CHARS = new Uint8Array(128);
for (let c = 48; c <= 57; c++) EMAIL_CHARS[c] = 1;
for (let c = 65; c <= 90; c++) EMAIL_CHARS[c] = 1;
for (let c = 97; c <= 122; c++) EMAIL_CHARS[c] = 1;
for (const ch of ".!#$%&'*+/=?^_`{|}~-@") EMAIL_CHARS[ch.charCodeAt(0)] = 1;

function isEmailStart(src, i) {
  // an email starts here if the char is a valid local-part char and the
  // previous char is not a word char (to avoid matching inside a word)
  const c = src.charCodeAt(i);
  if (c >= 128 || !EMAIL_CHARS[c] || c === 64) return false;
  if (i > 0) {
    const p = src.charCodeAt(i - 1);
    if (isWordChar(p) || p === 46) return false;
  }
  return true;
}

function matchEmail(src, i, underscoreOpen) {
  const n = src.length;
  let j = i;
  let seenAt = false;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 64) seenAt = true;
    // '/' is valid in the local part but NOT in the domain: stop the scan
    // at a '/' once the '@' has been seen (mailto:a@b.c/ must link a@b.c)
    if (c === 47 && seenAt) break;
    if (c >= 128 || !EMAIL_CHARS[c]) break;
    j++;
  }
  let end = j;
  // a trailing '-' after the domain blocks the autolink entirely: the
  // char could continue the address, so a partial match is not a link at
  // all (GFM: 'a@b.com-' stays plain). A trailing '_' blocks it too,
  // UNLESS the '_' is an emphasis closer (underscoreOpen: an unmatched
  // '_' opener precedes the email in this inline run, e.g. the email
  // inside '__...__' or '_..._') — then the '_' closes the emphasis and
  // the link forms. Other trailing punctuation (including a following
  // emphasis delimiter such as '*' or '~') is stripped and the link forms.
  if (end > i && src[end - 1] === '-') return null;
  if (end > i && src[end - 1] === '_' && !underscoreOpen) return null;
  // strip trailing punctuation: the domain part (after '@') must end with
  // a letter or digit, so drop any trailing char that cannot end a domain.
  // This also drops a following emphasis delimiter such as '*' or '_',
  // which the scan above had included as a valid local-part char (so an
  // email just before a closing '*' still linkifies).
  const atPos = src.indexOf('@', i);
  if (atPos >= i) {
    while (end - 1 > atPos) {
      const ch = src[end - 1];
      if ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) break;
      end--;
    }
  }
  if (end <= i) return null;
  const cand = src.slice(i, end);
  if (!EMAIL_RE.test(cand)) return null;
  // the char before the match must not be part of a longer local part
  return { t: 'auto', href: 'mailto:' + cand, text: cand, len: end - i };
}

// Scheme autolink (GFM extension): lowercase 'mailto:' or 'xmpp:' followed
// by a valid email. xmpp additionally takes ONE path segment (/seg);
// mailto takes none. The whole scheme:email[/seg] is one link whose href
// and text are the whole span. Only the lowercase schemes work.
function matchSchemeEmail(src, i, underscoreOpen) {
  let schemeLen = 0;
  let isXmpp = false;
  if (src.startsWith('mailto:', i)) schemeLen = 7;
  else if (src.startsWith('xmpp:', i)) { schemeLen = 5; isXmpp = true; }
  else return null;
  const em = matchEmail(src, i + schemeLen, underscoreOpen);
  if (em === null) return null;
  let end = i + schemeLen + em.len;
  if (isXmpp && end < src.length && src[end] === '/') {
    // one path segment: '/' + chars (not '/', whitespace, '<', '(', ')')
    let j = end + 1;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch === '(' || ch === ')') break;
      j++;
    }
    let segEnd = j;
    while (segEnd > end + 1) {
      const ch = src[segEnd - 1];
      if (ch === '.' || ch === '!' || ch === '?' || ch === ',' || ch === ';' || ch === ':' || ch === '*' || ch === '_' || ch === '~') segEnd--;
      else break;
    }
    if (segEnd > end + 1) end = segEnd;
  }
  const text = src.slice(i, end);
  return { t: 'auto', href: text, text, len: end - i };
}

// Does this inline item list contain a link (recursively, through emphasis
// and friends)? A link's text may not contain a link, so such a link is
// rejected and its '[' stays literal.
function containsLink(items) {
  for (const it of items) {
    if (it.t === 'link') return true;
    if ((it.t === 'em' || it.t === 'strong' || it.t === 'del') && containsLink(it.kids)) return true;
  }
  return false;
}

// Does the parsed label hold a link or an image (at any depth)? A
// failed link whose label holds one does not suppress the label's
// emphasis (marked leaves the delimiters alone there).
function labelHasLinkOrImg(items) {
  for (const it of items) {
    if (it.t === 'link' || it.t === 'img') return true;
    if ((it.t === 'em' || it.t === 'strong' || it.t === 'del') && labelHasLinkOrImg(it.kids)) return true;
  }
  return false;
}

// Try to parse a link (or image, when isImg) starting at src[open] ('[').
// Returns {item, end} or null. refs maps normalized labels to {href, title}.
// Length-aware label scan (the original): find the matching ']' for the
// label, honouring nesting, code spans (a run closes at the next run of
// the same length), and <...> tags/autolinks.
function findLabelClose(src, open) {
  const n = src.length;
  let depth = 0;
  let i = open + 1;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; }
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      const cc = findCodeClose(src, j, run);
      if (cc >= 0) { i = cc + run; continue; }
      i = j;
      continue;
    }
    if (c === 60) {
      const tag = matchHtmlTag(src, i);
      if (tag !== null) { i += tag.length; continue; }
      const auto = matchAutolink(src, i);
      if (auto !== null) { i += auto.len; continue; }
    }
    if (c === 91) depth++;
    else if (c === 93) {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return -1;
}

// Toggle label scan: like findLabelClose, but a backtick RUN of any
// length flips an in-code-span flag at bracket depth 0, and while the
// flag is set '[' and ']' at depth 0 are plain text (they do not open
// or close anything). Inside a nested level, brackets are counted
// normally and backticks do not flip the flag. Returns the index of
// the label's closing ']' or -1.
function findLabelCloseToggle(src, open) {
  const n = src.length;
  let depth = 0;
  let inCode = false;
  let i = open + 1;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; }
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      if (depth === 0) inCode = !inCode;
      i = j;
      continue;
    }
    if (c === 60) {
      const tag = matchHtmlTag(src, i);
      if (tag !== null) { i += tag.length; continue; }
      const auto = matchAutolink(src, i);
      if (auto !== null) { i += auto.len; continue; }
    }
    if (c === 91) {
      if (!(depth === 0 && inCode)) depth++;
    } else if (c === 93) {
      if (depth === 0) {
        if (!inCode) return i;
      } else depth--;
    }
    i++;
  }
  return -1;
}

// Does the label end with a code span whose content contains a
// backtick? Code spans are paired greedily left to right: a run of
// length n opens a span that closes at the next run of length n.
function labelEndsWithBacktickSpan(label) {
  const n = label.length;
  if (n === 0 || label.charCodeAt(n - 1) !== 96) return false;
  const runs = [];
  let i = 0;
  while (i < n) {
    if (label.charCodeAt(i) === 96) {
      let j = i;
      while (j < n && label.charCodeAt(j) === 96) j++;
      runs.push({ start: i, len: j - i });
      i = j;
    } else i++;
  }
  if (runs.length === 0) return false;
  let k = 0;
  let lastSpan = null;
  while (k < runs.length) {
    const r = runs[k];
    let m = k + 1;
    while (m < runs.length && runs[m].len !== r.len) m++;
    if (m < runs.length) {
      lastSpan = { open: r, close: runs[m] };
      k = m + 1;
    } else {
      k++;
    }
  }
  if (lastSpan === null) return false;
  if (lastSpan.close !== runs[runs.length - 1]) return false;
  const cs = lastSpan.open.start + lastSpan.open.len;
  const ce = lastSpan.close.start;
  for (let p = cs; p < ce; p++) {
    if (label.charCodeAt(p) === 96) return true;
  }
  return false;
}

// Does the label hold a backtick run that is not part of a complete
// code span? Runs pair greedily left to right: a run of length n opens
// a span that closes at the next run of length n; runs in between are
// content. A run with no later run of the same length is unpaired.
function hasUnpairedBacktickRun(label) {
  const n = label.length;
  const runs = [];
  let i = 0;
  while (i < n) {
    if (label.charCodeAt(i) === 96) {
      let j = i;
      while (j < n && label.charCodeAt(j) === 96) j++;
      runs.push(j - i);
      i = j;
    } else i++;
  }
  let k = 0;
  while (k < runs.length) {
    const len = runs[k];
    let m = k + 1;
    while (m < runs.length && runs[m] !== len) m++;
    if (m >= runs.length) return true;
    k = m + 1;
  }
  return false;
}

function tryParseLink(src, open, refs, isImg) {
  const n = src.length;
  // Find the label's closing ']'. marked's bracket scan toggles an
  // in-code-span flag at every backtick RUN (any length) at bracket
  // depth 0, and a ']' seen while the flag is set does not close the
  // label; brackets inside a nested level are counted normally and
  // backticks there do not toggle. If that scan finds no close, fall
  // back to the length-aware scan, but only when the label so found
  // ends with a code span whose content contains a backtick (a label
  // ending in such a span is accepted by marked even though its
  // backtick runs are odd in number); otherwise the link is rejected.
  let close = findLabelCloseToggle(src, open);
  if (close < 0) {
    const close2 = findLabelClose(src, open);
    if (close2 < 0) return null;
    if (!labelEndsWithBacktickSpan(src.slice(open + 1, close2))) return null;
    close = close2;
  }
  const labelRaw = src.slice(open + 1, close);
  if (labelRaw.length > 999) return null;
  // A label holds an unpaired backtick run when its backtick runs do
  // not pair up as code spans (a run pairs with the next run of the
  // same length). Such a label ('a ``b`', runs 2 then 1) leaves an
  // unpaired backtick that suppresses emphasis later in the paragraph
  // until the last code span ('[a ``b`](u) _x y_ ``c``' leaves '_x y_'
  // literal). A label whose runs all pair ('a ``b``', '[a `b`]', or a
  // valid span containing a backtick such as '``a ` b``' with runs 2,
  // 1, 2) does NOT suppress, even when the total backtick count is
  // odd. Escaped backticks ('\\`') are literal text and do not count
  // (doc-07's '[... \\` path]' label).
  let labelOddTicks = false;
  {
    const runs = [];
    for (let q = 0; q < labelRaw.length; q++) {
      if (labelRaw.charCodeAt(q) === 96 && (q === 0 || labelRaw.charCodeAt(q - 1) !== 92)) {
        let r = q;
        while (r < labelRaw.length && labelRaw.charCodeAt(r) === 96) r++;
        runs.push(r - q);
        q = r - 1;
      }
    }
    // Greedy left-to-right pairing: a run pairs with the next unpaired
    // run of the same length, and pairing consumes every run between
    // them (the span's content, e.g. the inner 1-run in '``a ` b``').
    // Any run left unpaired marks the label.
    const paired = new Array(runs.length).fill(false);
    for (let a = 0; a < runs.length; a++) {
      if (paired[a]) continue;
      let found = -1;
      for (let b = a + 1; b < runs.length; b++) {
        if (!paired[b] && runs[b] === runs[a]) { found = b; break; }
      }
      if (found >= 0) { for (let k = a; k <= found; k++) paired[k] = true; }
      else { labelOddTicks = true; break; }
    }
  }
  let j = close + 1;
  // inline link: (dest "title")
  if (src[j] === '(') {
    const parsed = parseLinkDestination(src, j + 1);
    if (parsed !== null) {
      let k = parsed.end;
      let title;
      // optional title after whitespace
      const saveK = k;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
      if (k < n && (src[k] === '"' || src[k] === "'" || src[k] === '(')) {
        const t = parseLinkTitle(src, k);
        if (t !== null) {
          title = t.title;
          k = t.end;
          while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
        } else {
          k = saveK;
        }
      }
      if (k < n && src[k] === ')') {
        if (isImg) {
          return { item: { t: 'img', href: parsed.dest, title, alt: plainText(labelRaw, refs) }, end: k + 1 };
        }
        const prevNoAuto = NO_AUTOLINK;
        NO_AUTOLINK = true;
        const savedUntil = NO_EMPHASIS_UNTIL;
        NO_EMPHASIS_UNTIL = -1;
        const kids = inlineItems(labelRaw, refs);
        NO_EMPHASIS_UNTIL = savedUntil;
        NO_AUTOLINK = prevNoAuto;
        // a link may not contain a link in its text
        if (containsLink(kids)) return null;
        return { item: { t: 'link', href: parsed.dest, title, kids }, end: k + 1, labelOddTicks };
      }
    }
    // not a valid inline link: fall through and try it as a reference
    // (shortcut) link instead of giving up entirely
  }
  // reference link: [label][ref] or [label][] or shortcut [label]
  let refLabel = null;
  let end = close + 1;
  if (src[j] === '[') {
    let k = j + 1;
    while (k < n && src[k] !== ']') k++;
    if (k < n) {
      refLabel = k === j + 1 ? labelRaw : src.slice(j + 1, k);
      end = k + 1;
    }
  } else {
    refLabel = labelRaw;
  }
  if (refLabel === null || refLabel.length === 0) return null;
  const ref = refs.get(normalizeLabel(refLabel));
  if (!ref) return null;
  if (isImg) {
    return { item: { t: 'img', href: ref.href, title: ref.title, alt: plainText(labelRaw, refs) }, end };
  }
  const prevNoAuto = NO_AUTOLINK;
  NO_AUTOLINK = true;
  const savedUntil = NO_EMPHASIS_UNTIL;
  NO_EMPHASIS_UNTIL = -1;
  const kids = inlineItems(labelRaw, refs);
  NO_EMPHASIS_UNTIL = savedUntil;
  NO_AUTOLINK = prevNoAuto;
  // a link may not contain a link in its text
  if (containsLink(kids)) return null;
  return { item: { t: 'link', href: ref.href, title: ref.title, kids }, end, labelOddTicks };
}

// Plain-text rendering of a link label (for image alt text): inline-parse
// then strip any tags, keeping the text.
function plainTextFromItems(items) {
  let out = '';
  for (const it of items) {
    switch (it.t) {
      case 'text': case 'ent': case 'code': out += it.s; break;
      case 'br': out += '\n'; break;
      case 'auto': out += it.text; break;
      case 'img': out += it.alt; break;
      case 'link': case 'em': case 'strong': case 'del':
        out += plainTextFromItems(it.kids); break;
      case 'delim': out += it.ch.repeat(it.n); break;
      default: break; // html and anything else contributes nothing
    }
  }
  return out;
}

function plainText(s, refs) {
  const savedUntil = NO_EMPHASIS_UNTIL;
  NO_EMPHASIS_UNTIL = -1;
  const out = plainTextFromItems(inlineItems(s, refs));
  NO_EMPHASIS_UNTIL = savedUntil;
  return out;
}

// Parse a link destination starting at src[i] (after '('). Returns
// {dest, end} (end = index just past the destination) or null.
function parseLinkDestination(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  if (j >= n) return null;
  if (src[j] === '<') {
    // <...> destination: no newlines, no <, backslash escapes allowed
    let k = j + 1;
    let dest = '';
    while (k < n && src[k] !== '>') {
      if (src[k] === '\n') return null;
      if (src[k] === '\\' && k + 1 < n && isAsciiPunct(src[k + 1])) { dest += src[k + 1]; k += 2; continue; }
      dest += src[k];
      k++;
    }
    if (k >= n) return null;
    return { dest: cleanInlineText(dest), end: k + 1 };
  }
  // bare destination: no spaces/control, balanced parens allowed
  let depth = 0;
  let k = j;
  let dest = '';
  while (k < n) {
    const ch = src[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) break;
    if (ch === '(') { depth++; dest += ch; k++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; dest += ch; k++; continue;
    }
    if (ch === '\\' && k + 1 < n && isAsciiPunct(src[k + 1])) { dest += src[k + 1]; k += 2; continue; }
    dest += ch;
    k++;
  }
  if (dest.length === 0 && src[k] !== ')') return null;
  return { dest: cleanInlineText(dest), end: k };
}

// Parse a link title at src[i] ('"' or '\'' or '('). Returns {title, end} or null.
function parseLinkTitle(src, i) {
  const n = src.length;
  const q = src[i];
  const closeQ = q === '(' ? ')' : q;
  let j = i + 1;
  let title = '';
  while (j < n) {
    const ch = src[j];
    if (ch === closeQ) return { title: cleanInlineText(title), end: j + 1 };
    if (ch === '\n' && q === '(') return null;
    if (ch === '\\' && j + 1 < n && isAsciiPunct(src[j + 1])) { title += src[j + 1]; j += 2; continue; }
    if (ch === '\\' && j + 1 < n) { title += ch; j++; continue; }
    title += ch;
    j++;
  }
  return null;
}

// Resolve emphasis/strong/strikethrough in a flat item list, in place.
function resolveEmphasis(items) {
  // collect delimiter positions
  const delims = [];
  for (let idx = 0; idx < items.length; idx++) {
    if (items[idx].t === 'delim') delims.push(idx);
  }
  // process closers in order; for each, find the nearest matching opener
  for (let d = 0; d < delims.length; d++) {
    const ci = delims[d];
    const closer = items[ci];
    if (!closer || closer.t !== 'delim' || !closer.close) continue;
    // find opener: scan backwards
    let oi = -1;
    for (let k = d - 1; k >= 0; k--) {
      const oj = delims[k];
      const op = items[oj];
      if (!op || op.t !== 'delim') continue;
      if (op.ch !== closer.ch || !op.open) continue;
      // strikethrough runs must be the same length on both sides
      if (op.ch === '~' && op.n !== closer.n) continue;
      // rule of three: if either delimiter can both open and close, the sum
      // of the two runs must not be a multiple of 3 (unless both are)
      if (op.ch === '*' || op.ch === '_') {
        const eitherBoth = (op.open && op.close) || (closer.open && closer.close);
        if (eitherBoth && (op.n + closer.n) % 3 === 0 && !(op.n % 3 === 0 && closer.n % 3 === 0)) continue;
      }
      // blocking strong: when this pair would be an em (not a strong)
      // with '*' delimiters, a blocking strong node (opener could not
      // close, closer could open) that is the nearest em/strong node
      // before the closer, with no OPENER delimiter between it and the
      // closer, forbids pairing across it. '_' outer delimiters are not
      // blocked (doc-05/20/31 form their outer em across such a strong).
      // A later closer (past another em/strong node) may still pair. A
      // closer-only delimiter (e.g. the '*' after 'parse' in '**a
      // *input **parse**parse* b**', itself blocked from pairing) does
      // not hide the strong: it is skipped, not a break.
      if (op.ch === '*' && closer.ch === '*' && !(op.n >= 2 && closer.n >= 2)) {
        let blocked = false;
        for (let s = ci - 1; s > oj; s--) {
          const it = items[s];
          if (!it) continue;
          if (it.t === 'delim') {
            if (it.open) break;
            continue;
          }
          if (it.t === 'strong' || it.t === 'em' || it.t === 'del') {
            blocked = it.t === 'strong' && !!it.blk;
            break;
          }
        }
        if (blocked) continue;
      }
      // prefer strong: a single-asterisk closer must not steal one
      // asterisk from a '**' opener (exactly two) when a later '**'
      // closer could pair with that opener to form a strong ('**public
      // as *so*other* option html**' keeps the strong and leaves
      // 'other*' literal, instead of forming nested ems). An opener of
      // three or more has asterisks enough for both an em and a strong
      // ('***foo* bar**'), so it is not skipped. Skip such an opener.
      if (op.n === 2 && closer.n === 1 && (op.ch === '*' || op.ch === '_')) {
        let laterStrong = false;
        for (let m = d + 1; m < delims.length; m++) {
          const later = items[delims[m]];
          if (later && later.t === 'delim' && later.ch === closer.ch && later.n >= 2 && later.close) { laterStrong = true; break; }
        }
        if (laterStrong) continue;
      }
      oi = oj;
      break;
    }
    if (oi < 0) continue;
    const opener = items[oi];
    let use = 1;
    if (opener.ch === '~') use = opener.n;
    else if (opener.n >= 2 && closer.n >= 2) use = 2;
    // build the emphasized node from items between opener and closer
    const inner = items.slice(oi + 1, ci);
    resolveEmphasis(inner);
    // A strong whose opener could not close and whose closer could open
    // and is followed by a word character "blocks" an outer
    // single-asterisk emphasis from pairing across it: '*a **b**c*'
    // stays literal, while '*a **b** c*' (closer cannot open) and
    // '*a**b**c*' (opener can close) form the outer em. A closer followed
    // by punctuation (e.g. the outer '*') does not block. The block only
    // applies to the first closer after the strong, which the opener
    // search below enforces by looking at the nearest node.
    const blk = !opener.close && closer.open && !!closer.aw;
    const node = opener.ch === '~'
      ? { t: 'del', kids: inner }
      : use === 2 ? { t: 'strong', kids: inner, blk } : { t: 'em', kids: inner, blk };
    // consume delimiters
    opener.n -= use;
    closer.n -= use;
    const replacement = [];
    if (opener.n > 0) replacement.push(opener);
    replacement.push(node);
    if (closer.n > 0) replacement.push(closer);
    items.splice(oi, ci - oi + 1, ...replacement);
    // rebuild delim index list after splice
    delims.length = 0;
    for (let idx = 0; idx < items.length; idx++) {
      if (items[idx].t === 'delim') delims.push(idx);
    }
    d = -1; // restart scan (indices changed)
  }
  // leftover delimiters become literal text
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (it.t === 'delim') items[idx] = { t: 'text', s: it.ch.repeat(it.n) };
  }
  // A leftover single '*' from a strong closer renders INSIDE the
  // strong when the strong's kids end with an <em> immediately
  // followed by word text ('**a *b*c***' -> '<strong>a
  // <em>b</em>c*</strong>', while '**a *b* c***' with a space after
  // the em leaves the '*' outside). This applies to strong nodes
  // only: an <em> node's leftover '*' stays outside ('<em>changes
  // <em>else</em>returns</em>*', doc-04/20/27). Move such a '*'
  // text item into the strong's kids.
  for (let idx = 0; idx + 1 < items.length; idx++) {
    const node = items[idx];
    const next = items[idx + 1];
    if (node.t !== 'strong' || !next || next.t !== 'text' || next.s !== '*') continue;
    const kids = node.kids;
    if (kids.length < 2) continue;
    const last = kids[kids.length - 1];
    const prev = kids[kids.length - 2];
    if (prev.t !== 'em' || last.t !== 'text' || last.s.length === 0) continue;
    if (!isWordChar(last.s.charCodeAt(0))) continue;
    last.s += '*';
    items.splice(idx + 1, 1);
  }
}

function renderInline(items) {
  let out = '';
  for (const it of items) {
    switch (it.t) {
      case 'text': out += escapeText(it.s); break;
      case 'ent': out += it.s; break;
      case 'code': out += '<code>' + escapeText(it.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'html': out += it.s; break;
      case 'em': out += '<em>' + renderInline(it.kids) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(it.kids) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(it.kids) + '</del>'; break;
      case 'auto': {
        const href = escapeAttr(cleanHref(it.href));
        out += '<a href="' + href + '">' + escapeText(it.text) + '</a>';
        break;
      }
      case 'link': {
        const href = escapeAttr(cleanHref(it.href));
        const title = it.title !== undefined ? ' title="' + escapeAttr(it.title) + '"' : '';
        out += '<a href="' + href + '"' + title + '>' + renderInline(it.kids) + '</a>';
        break;
      }
      case 'img': {
        const href = escapeAttr(cleanHref(it.href));
        const title = it.title !== undefined ? ' title="' + escapeAttr(it.title) + '"' : '';
        out += '<img src="' + href + '" alt="' + escapeAttr(it.alt) + '"' + title + '>';
        break;
      }
    }
  }
  return out;
}

// ---------------- block parsing ----------------
// Lines are raw strings (no trailing \n). Tabs count as advancing to the next
// multiple of 4 columns for indentation purposes.
//
// COLLECT_ONLY: when true, parseBlocks only collects link reference
// definitions and block structure and returns '' (no inline rendering).
// parse() runs one collect pass over the whole document first so that a
// reference defined after its use still resolves (marked's behaviour).
let COLLECT_ONLY = false;

// True while parseBlocks is rendering a list item's content: inside a list
// item ANY ordered marker interrupts a paragraph (a nested list), while at
// the top level only a marker numbered 1 (or a bullet) does.
let IN_LIST_ITEM = false;

// True while parsing a link's label text: autolinks inside a label are
// plain text, not links (a link's text may not contain a link).
let NO_AUTOLINK = false;

// True while inside an unclosed <a> HTML tag: autolinks are suppressed
// (an unclosed <a> makes everything after it "inside a link" until a
// </a> closes it). Set/cleared by the inline parser on <a> / </a> tags;
// reset at the start of each parse() call.
let INSIDE_A_TAG = false;

// Source position (in the current block) before which * _ ~ runs are
// plain text, not emphasis delimiters. Set when a link attempt fails
// after marked has already consumed the label's emphasis delimiters
// (see the '[' handling in inlineItems); -1 means no suppression.
// Saved/restored around recursive inline parses, whose positions are
// in a different string.
let NO_EMPHASIS_UNTIL = -1;

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// Column count of leading whitespace, and index of first non-whitespace char.
function lineIndent(s) {
  let col = 0;
  let idx = 0;
  while (idx < s.length) {
    const ch = s[idx];
    if (ch === ' ') { col++; idx++; }
    else if (ch === '\t') { col += 4 - (col % 4); idx++; }
    else break;
  }
  return { cols: col, idx };
}

// Remove n columns of leading whitespace (a tab straddling the boundary
// becomes the remaining spaces).
function stripCols(s, n) {
  let col = 0;
  let idx = 0;
  while (idx < s.length && col < n) {
    const ch = s[idx];
    if (ch === ' ') { col++; idx++; }
    else if (ch === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv > n) return ' '.repeat(col + adv - n) + s.slice(idx + 1);
      col += adv;
      idx++;
    } else break;
  }
  return s.slice(idx);
}

// Remove n columns of leading whitespace where the line starts at column
// startCol: every leading tab is first expanded to spaces (to the next
// multiple of 4), then n columns are removed. This is how marked dedents
// list item content (a tab inside the indent becomes spaces, never a tab).
function stripColsExpand(s, n, startCol) {
  let expanded = '';
  let col = startCol;
  let idx = 0;
  while (idx < s.length && (s[idx] === ' ' || s[idx] === '\t')) {
    if (s[idx] === ' ') { expanded += ' '; col++; idx++; }
    else { const adv = 4 - (col % 4); expanded += ' '.repeat(adv); col += adv; idx++; }
  }
  const rest = s.slice(idx);
  if (expanded.length <= n) return rest;
  return expanded.slice(n) + rest;
}

// Remove up to n leading whitespace characters (a space or a tab each counts
// as one) — how marked dedents fenced code content by the fence's indent.
function stripFenceContent(s, n) {
  let i = 0;
  while (i < s.length && i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(i);
}

// ATX heading: up to 3 spaces, 1-6 #, then space/EOL. Returns {level, text}
// or null. text is the raw content (inline-parsed by the caller).
function matchAtx(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  let i = idx;
  let hashes = 0;
  while (i < line.length && line[i] === '#') { hashes++; i++; }
  if (hashes === 0 || hashes > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  // skip spaces after the hashes
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  let end = line.length;
  while (end > i && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  // closing sequence: spaces + hashes at the end
  if (end > i && line[end - 1] === '#') {
    let j = end;
    while (j > i && line[j - 1] === '#') j--;
    if (j > 0 && (line[j - 1] === ' ' || line[j - 1] === '\t')) {
      end = j;
      while (end > i && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    }
  }
  return { level: hashes, text: line.slice(i, end) };
}

// Fenced code opening: up to 3 spaces, 3+ backticks or tildes.
// Returns {ch, len, indent, info} or null.
function matchFence(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  const ch = line[idx];
  if (ch !== '`' && ch !== '~') return null;
  let i = idx;
  while (i < line.length && line[i] === ch) i++;
  const len = i - idx;
  if (len < 3) return null;
  const info = line.slice(i);
  if (ch === '`' && info.includes('`')) return null;
  // backslash escapes in the info string are resolved (``` foo\+bar -> foo+bar)
  const unescaped = info.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  return { ch, len, indent: cols, info: unescaped.trim() };
}

// Does this line close an open fence (same char, run >= fence length,
// only whitespace after the run)?
function isFenceClose(line, fence) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3 || line[idx] !== fence.ch) return false;
  let k = idx;
  while (k < line.length && line[k] === fence.ch) k++;
  if (k - idx < fence.len) return false;
  return /^[ \t]*$/.test(line.slice(k));
}

// Thematic break: 3+ of the same marker (*, -, _) with spaces between.
function matchHr(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  let i = idx;
  const ch = line[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return null;
  let count = 0;
  while (i < line.length) {
    if (line[i] === ch) { count++; i++; }
    else if (line[i] === ' ' || line[i] === '\t') i++;
    else return null;
  }
  return count >= 3;
}

// Setext underline: === (level 1) or --- (level 2), up to 3 spaces indent,
// a run of one marker char, then only trailing whitespace (no internal
// spaces: '= =' and '--- -' are not underlines).
function matchSetext(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  let i = idx;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return null;
  let count = 0;
  while (i < line.length && line[i] === ch) { count++; i++; }
  if (count === 0) return null;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i < line.length) return null;
  return ch === '=' ? 1 : 2;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start. Returns type 1-7 or 0.
function htmlBlockType(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3 || line[idx] !== '<') return 0;
  const rest = line.slice(idx + 1);
  const lower = rest.toLowerCase();
  // type 1: script, pre, style, textarea
  if (/^(script|pre|style|textarea)(?:\s|>|$)/.test(lower)) return 1;
  // type 2: comment
  if (rest.startsWith('!--')) return 2;
  // type 3: processing instruction
  if (rest.startsWith('?')) return 3;
  // type 4: declaration <!A-Z
  if (rest.startsWith('!') && rest.length > 1 && rest[1] >= 'A' && rest[1] <= 'Z') return 4;
  // type 5: CDATA
  if (rest.startsWith('![CDATA[')) return 5;
  // type 6: block-level tag
  const m6 = /^(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m6) {
    const name = m6[2].toLowerCase();
    const after = rest[m6[0].length];
    if (BLOCK_TAGS.has(name) && (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/')) return 6;
  }
  // type 7: complete open or close tag alone on the line (nothing but
  // whitespace after it)
  {
    const tag = matchHtmlTag(line, idx);
    if (tag !== null && /^[ \t]*$/.test(line.slice(idx + tag.length))) return 7;
  }
  return 0;
}

// HTML block end test for types 1-5: does this line contain the closer?
function htmlBlockEnds(type, line, tagName) {
  const lower = line.toLowerCase();
  switch (type) {
    case 1: return lower.includes('</' + tagName);
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
    default: return false;
  }
}

// List marker at line start. Returns null or:
// {kind:'bullet'|'ordered', marker, num, digits, delim, indent, contentCol, empty}
function matchListMarker(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  const ch = line[idx];
  let markerLen, kind, num, digits = 0, delim;
  if (ch === '*' || ch === '-' || ch === '+') {
    kind = 'bullet';
    markerLen = 1;
  } else if (ch >= '0' && ch <= '9') {
    let j = idx;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    digits = j - idx;
    if (digits > 9) return null;
    const d = line[j];
    if (d !== '.' && d !== ')') return null;
    kind = 'ordered';
    num = parseInt(line.slice(idx, j), 10);
    delim = d;
    markerLen = digits + 1;
  } else {
    return null;
  }
  // whitespace after the marker, counted in columns: a tab advances to the
  // next multiple of 4 — except a tab that is the first whitespace char
  // after the marker, which forces the content indent to marker + 1
  // (marked's rule: '-\tfoo' has content indent 2, not 4).
  let i = idx + markerLen;
  let col = cols + markerLen;
  let wsCols = 0;
  let firstWs = true;
  const startsWithTab = line[i] === '\t';
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { wsCols++; col++; i++; firstWs = false; }
    else if (c === '\t') {
      if (firstWs) { wsCols += 1; col += 1; }
      else { const adv = 4 - (col % 4); wsCols += adv; col += adv; }
      i++;
      firstWs = false;
    } else break;
  }
  const empty = i >= line.length;
  // a marker with no space (or tab) after it is not a list marker
  if (!empty && wsCols === 0) return null;
  // content indent: marker + 1..4 columns of whitespace, or marker + 1 when
  // blank, 5+ columns of whitespace, or the whitespace starts with a tab
  let contentCol;
  if (empty) contentCol = cols + markerLen + 1;
  else if (startsWithTab) contentCol = cols + markerLen + 1;
  else if (wsCols >= 1 && wsCols <= 4) contentCol = cols + markerLen + wsCols;
  else contentCol = cols + markerLen + 1;
  return { kind, marker: line.slice(idx, idx + markerLen), num, digits, delim, indent: cols, contentCol, empty };
}

// Split a table row line into cells (unescaped | separators), trimming the
// optional leading/trailing pipes and cell whitespace.
function splitTableRow(line) {
  let s = line;
  // trim leading/trailing whitespace
  let a = 0, b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  s = s.slice(a, b);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  // Fast path (the common case: no escaped pipes): split on '|' by index
  // and slice each cell, instead of accumulating char by char.
  if (!s.includes('\\|')) {
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) === 124) {
        cells.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    cells.push(s.slice(start).trim());
    return cells;
  }
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Is this line a table delimiter row? Returns alignments array or null.
function matchTableDelim(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Try to parse a table starting at lines[i]. Returns {html, end} or null.
function tryTable(lines, i, end, refs) {
  if (i + 1 >= end) return null;
  const headerCells = splitTableRow(lines[i]);
  if (headerCells.length === 0) return null;
  // the header line must contain a pipe
  if (!lines[i].includes('|')) return null;
  const aligns = matchTableDelim(lines[i + 1]);
  if (!aligns || aligns.length !== headerCells.length) return null;
  let header = '<tr>\n';
  for (let c = 0; c < headerCells.length; c++) {
    const al = aligns[c] ? ' align="' + aligns[c] + '"' : '';
    header += '<th' + al + '>' + (COLLECT_ONLY ? '' : inline(headerCells[c], refs)) + '</th>\n';
  }
  header += '</tr>\n';
  let body = '';
  let j = i + 2;
  // body rows need no pipe: a bare line is a one-cell row (padded with
  // empty cells). Rows run until a blank line or a line that starts
  // another block (e.g. a blockquote, gfm-201). A whitespace-only line
  // that contains a TAB is an empty row, not a blank line (a spaces-only
  // line does end the table).
  while (j < end && (!isBlankLine(lines[j]) || lines[j].includes('\t')) && !interruptsParagraph(lines, j, end)) {
    const cells = splitTableRow(lines[j]);
    let row = '<tr>\n';
    for (let c = 0; c < headerCells.length; c++) {
      const cell = c < cells.length ? cells[c] : '';
      const al = aligns[c] ? ' align="' + aligns[c] + '"' : '';
      row += '<td' + al + '>' + (COLLECT_ONLY ? '' : inline(cell, refs)) + '</td>\n';
    }
    row += '</tr>\n';
    body += row;
    j++;
  }
  let html = '<table>\n<thead>\n' + header + '</thead>\n';
  if (body) html += '<tbody>' + body + '</tbody>';
  html += '</table>\n';
  return { html, end: j };
}

// Try to match one link reference definition at lines[i] (possibly spanning
// two lines for the title). Returns {end} (lines consumed) or null. Adds to refs.
function tryDef(lines, i, end, refs) {
  const line0 = lines[i];
  const { cols, idx } = lineIndent(line0);
  if (cols > 3 || line0[idx] !== '[') return null;
  // label: [ ... ] with balanced brackets, no unescaped [ inside.
  // May span multiple lines. Backslash escapes are kept RAW in the label
  // (so [foo\!] does not match a [foo!] definition); the escape only
  // stops the ] closing it.
  let j = idx + 1;
  let label = '';
  let depth = 0;
  let li = i;
  let foundClose = false;
  while (li < end) {
    const cur = lines[li];
    while (j < cur.length) {
      const ch = cur[j];
      if (ch === '\\' && j + 1 < cur.length) { label += cur[j] + cur[j + 1]; j += 2; continue; }
      if (ch === '[') return null;
      if (ch === ']') {
        if (depth === 0) { foundClose = true; break; }
        depth--;
      }
      label += ch;
      j++;
    }
    if (foundClose) break;
    if (label.length > 999) return null;
    li++;
    if (li >= end) return null;
    label += '\n';
    j = 0;
  }
  if (!foundClose || label.length === 0 || label.length > 999) return null;
  j++; // past ] on line li
  const line = lines[li];
  // optional spaces, then ':'
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (line[j] !== ':') return null;
  j++;
  // destination + optional title, possibly on the next line
  let rest = line.slice(j);
  let consumed = li - i + 1;
  let dest, title;
  // skip spaces/tabs/newline
  const skipWs = (s, k) => {
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    return k;
  };
  let k = skipWs(rest, 0);
  if (k >= rest.length) {
    // destination on the next line (after the label's closing line)
    if (li + 1 >= end) return null;
    rest = lines[li + 1];
    consumed = li - i + 2;
    k = skipWs(rest, 0);
    if (k >= rest.length) return null;
  }
  // destination: <...> or bare
  if (rest[k] === '<') {
    let m = k + 1;
    let d = '';
    while (m < rest.length && rest[m] !== '>') {
      if (rest[m] === '\n') return null;
      if (rest[m] === '\\' && m + 1 < rest.length && isAsciiPunct(rest[m + 1])) { d += rest[m + 1]; m += 2; continue; }
      d += rest[m];
      m++;
    }
    if (m >= rest.length) return null;
    dest = cleanInlineText(d);
    k = m + 1;
  } else {
    let m = k;
    let d = '';
    let depthP = 0;
    while (m < rest.length) {
      const ch = rest[m];
      if (ch === ' ' || ch === '\t' || ch.charCodeAt(0) < 32) break;
      if (ch === '(') { depthP++; d += ch; m++; continue; }
      if (ch === ')') {
        if (depthP === 0) break;
        depthP--; d += ch; m++; continue;
      }
      if (ch === '\\' && m + 1 < rest.length && isAsciiPunct(rest[m + 1])) { d += rest[m + 1]; m += 2; continue; }
      d += ch;
      m++;
    }
    if (d.length === 0) return null;
    dest = cleanInlineText(d);
    k = m;
  }
  // optional title on the same line or on the line after the destination.
  // A title on the same line must be separated from the destination by
  // whitespace ([foo]: <bar>(baz) is not a definition).
  const kBeforeWs = k;
  k = skipWs(rest, k);
  if (k < rest.length) {
    if (k === kBeforeWs) return null;
    const t = parseLinkTitle(rest, k);
    if (t === null) {
      // maybe a multi-line title (" or ' only; ( ) titles cannot span
      // lines). Join the remainder with following lines and retry.
      const q = rest[k];
      if (q === '"' || q === "'") {
        let joined = rest.slice(k);
        let li2 = i + consumed;
        let found = null;
        // a title may span lines but NOT a blank line
        while (li2 < end && !isBlankLine(lines[li2])) {
          joined += '\n' + lines[li2];
          found = parseLinkTitle(joined, 0);
          if (found !== null) break;
          li2++;
        }
        if (found !== null) {
          let nl = 0;
          for (let p = 0; p < found.end; p++) if (joined[p] === '\n') nl++;
          const tail = joined.slice(found.end);
          if (tail.trim().length === 0) {
            title = found.title;
            consumed += nl;
          } else {
            return null;
          }
        } else {
          if (rest.slice(k).trim().length > 0) return null;
        }
      } else {
        if (rest.slice(k).trim().length > 0) return null;
      }
    } else {
      title = t.title;
      k = t.end;
      k = skipWs(rest, k);
      if (k < rest.length) return null;
    }
  } else {
    const nextIdx = i + consumed;
    if (nextIdx < end) {
      const next = lines[nextIdx];
      const k2 = skipWs(next, 0);
      if (k2 < next.length && (next[k2] === '"' || next[k2] === "'" || next[k2] === '(')) {
        const t = parseLinkTitle(next, k2);
        if (t !== null) {
          const e = skipWs(next, t.end);
          if (e >= next.length) {
            title = t.title;
            consumed++;
          }
        }
      }
    }
  }
  const key = normalizeLabel(label);
  if (key.length === 0) return null;
  if (!refs.has(key)) refs.set(key, { href: dest, title });
  return { end: i + consumed };
}

// Is this line the start of a block that can interrupt a paragraph?
// (ATX heading, fenced code, HTML block type 1-6, blockquote, list with
// interruption rules, thematic break, table header.)
function interruptsParagraph(lines, i, end) {
  const line = lines[i];
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  const { cols, idx } = lineIndent(line);
  if (cols <= 3 && line[idx] === '>') return true;
  if (matchHr(line)) return true;
  const lm = matchListMarker(line);
  if (lm) {
    if (!lm.empty && (lm.kind === 'bullet' || lm.num === 1 || IN_LIST_ITEM)) return true;
  }
  if (tryTable(lines, i, end, new Map()) !== null) return true;
  return false;
}

// Parse a paragraph starting at lines[i]. Returns {html, end}.
// lazy: a Set of line indices (into lines) that are lazy continuations
// of this paragraph (added by an enclosing blockquote/list); such a line
// is paragraph text even when it looks like a block start.
function parseParagraph(lines, i, end, refs, lazy) {
  const collected = [lines[i]];
  let j = i + 1;
  let setextLevel = 0;
  while (j < end) {
    const line = lines[j];
    // a whitespace-only line ends the paragraph, UNLESS it is the last
    // line of the block and non-empty (a trailing space line is paragraph
    // content, cm-241: '> foo' + '>  ' -> 'foo\n ')
    if (isBlankLine(line)) {
      if (j === end - 1 && line.length > 0) { collected.push(line); j++; }
      break;
    }
    // a lazy continuation line is paragraph text even if it looks like a
    // setext underline (cm-093) or another block start; a lazy line that
    // IS a setext underline is kept as text indented by 4 spaces so it
    // cannot be re-read as a heading
    if (lazy && lazy.has(j)) {
      collected.push(matchSetext(line) ? '    ' + line : line);
      j++;
      continue;
    }
    const st = matchSetext(line);
    if (st) { setextLevel = st; j++; break; }
    if (interruptsParagraph(lines, j, end)) break;
    collected.push(line);
    j++;
  }
  const text = collected.join('\n');
  if (setextLevel) {
    // a setext heading's content is trimmed at the very start and end only;
    // leading whitespace of continuation lines is kept
    const trimmed = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    return { html: '<h' + setextLevel + '>' + (COLLECT_ONLY ? '' : inline(trimmed, refs)) + '</h' + setextLevel + '>\n', end: j };
  }
  return { html: '<p>' + (COLLECT_ONLY ? '' : inline(text, refs)) + '</p>\n', end: j };
}

// Parse a blockquote starting at lines[i]. Returns {html, end}.
function parseBlockquote(lines, i, end, refs, endLosesNL) {
  const sub = [];
  const lazy = new Set();
  let j = i;
  let inPara = false;
  let fence = null;
  while (j < end) {
    const line = lines[j];
    const { cols, idx } = lineIndent(line);
    if (cols <= 3 && line[idx] === '>') {
      const subline = stripBlockquotePrefix(line);
      sub.push(subline);
      // track fenced code: its content lines are not paragraph lines, so
      // a lazy line after the fence must not be absorbed as a continuation
      if (fence) {
        if (isFenceClose(subline, fence)) fence = null;
        inPara = false;
      } else {
        const f = matchFence(subline);
        if (f) { fence = f; inPara = false; }
        else inPara = sublineIsParagraphLine(subline);
      }
      j++;
      continue;
    }
    // a line without '>' never continues a fenced code block inside a
    // blockquote (the fence's content needs the prefix); it falls through
    // to the lazy-paragraph check below, which fails while a fence is
    // open (inPara is false), so the quote ends there
    if (inPara && !isBlankLine(line) && !interruptsParagraph(lines, j, end)) {
      // a lazy continuation line with indent >= 4 (indented-code depth)
      // loses 4 columns; shallower indent is kept verbatim. It is marked
      // lazy so the paragraph parser keeps it as text even when the
      // stripped form looks like a block start (e.g. '- bar').
      lazy.add(sub.length);
      sub.push(cols >= 4 ? stripCols(line, 4) : line);
      j++;
      continue;
    }
    break;
  }
  // drop trailing blank lines from the sub-content; a space-only line
  // (from '>  ') is paragraph content, not a blank line (cm-241), so
  // only truly empty lines are dropped
  let droppedBlanks = false;
  while (sub.length && sub[sub.length - 1] === '') { sub.pop(); droppedBlanks = true; }
  // an HTML block ending at the end of the quote loses its newline when the
  // quote is followed by a blank line (or the dropped trailing blanks)
  const subEndLosesNL = droppedBlanks ? true
    : (j < end && isBlankLine(lines[j])) ? true
    : (j >= end ? endLosesNL : false);
  return { html: '<blockquote>\n' + parseBlocks(sub, 0, sub.length, refs, subEndLosesNL, undefined, lazy.size ? lazy : undefined) + '</blockquote>\n', end: j };
}

// The first line of a list item's content: the text after the marker,
// dedented by (contentCol - marker column) with tabs expanded to spaces.
function listItemFirstLine(line, lm) {
  const { cols, idx } = lineIndent(line);
  const markerLen = lm.kind === 'bullet' ? 1 : lm.digits + 1;
  const rest = line.slice(idx + markerLen);
  return stripColsExpand(rest, lm.contentCol - (cols + markerLen), cols + markerLen);
}

// Strip the blockquote prefix ('>' plus up to one column of whitespace)
// from a line, expanding leading tabs to spaces by column.
function stripBlockquotePrefix(line) {
  const { cols, idx } = lineIndent(line);
  let k = idx + 1;
  let col = cols + 1;
  if (line[k] === ' ') {
    k++;
    col++;
    return expandLeadingTabs(line.slice(k), col);
  }
  if (line[k] === '\t') {
    const adv = 4 - (col % 4);
    return ' '.repeat(adv - 1) + expandLeadingTabs(line.slice(k + 1), col + adv);
  }
  return line.slice(k);
}

// Expand leading tabs of s to spaces, given s starts at column startCol.
function expandLeadingTabs(s, startCol) {
  let out = '';
  let col = startCol;
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; col++; i++; }
    else { const adv = 4 - (col % 4); out += ' '.repeat(adv); col += adv; i++; }
  }
  return out + s.slice(i);
}

// Is this (quote-stripped) line the start of a block (for laziness checks)?
// Indented code counts: such a line opens a code block, not a paragraph.
function startsAnyBlock(line) {
  if (matchAtx(line) || matchFence(line) || matchHr(line)) return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  const { cols, idx } = lineIndent(line);
  if (cols <= 3 && line[idx] === '>') return true;
  if (matchListMarker(line)) return true;
  if (cols >= 4) return true;
  return false;
}

// Does this sub-line leave a paragraph open (so a following line without '>'
// may be a lazy continuation)? Recurses through list items and blockquotes:
// a list item leaves a paragraph open when its content does, and a
// blockquote line when its stripped content does.
function sublineIsParagraphLine(line) {
  if (isBlankLine(line)) return false;
  if (!startsAnyBlock(line)) return true;
  const { cols, idx } = lineIndent(line);
  if (cols <= 3 && line[idx] === '>') {
    return sublineIsParagraphLine(stripBlockquotePrefix(line));
  }
  const lm = matchListMarker(line);
  if (lm) {
    const content = listItemFirstLine(line, lm);
    return content !== '' && !isBlankLine(content) && sublineIsParagraphLine(content);
  }
  return false;
}

// In a tight list item, strip the <p>...</p> wrapper from every paragraph
// that is a direct child of the item (depth 0). Paragraphs nested inside
// a blockquote, list, table, etc. keep their <p>.
function stripTightP(body) {
  const containers = ['blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'pre', 'div', 'section'];
  let out = '';
  let i = 0;
  let depth = 0;
  const n = body.length;
  while (i < n) {
    if (body[i] === '<') {
      if (body[i + 1] === '/') {
        const m = /^\/([a-z]+)>/.exec(body.slice(i + 2, i + 18));
        if (m && containers.includes(m[1])) depth--;
        out += body[i];
        i++;
        continue;
      }
      if (depth === 0 && body.startsWith('<p>', i)) {
        const close = body.indexOf('</p>', i + 3);
        if (close === -1) { out += body.slice(i); break; }
        out += body.slice(i + 3, close);
        i = close + 4;
        if (body[i] === '\n') i++;
        continue;
      }
      const m = /^([a-z]+)[\s>]/.exec(body.slice(i + 1, i + 18));
      if (m && containers.includes(m[1])) depth++;
    }
    out += body[i];
    i++;
  }
  return out;
}

// Parse a list starting at lines[i]. Returns {html, end}.
function parseList(lines, i, end, refs, endLosesNL) {
  const first = matchListMarker(lines[i]);
  const kind = first.kind;
  const delim = first.delim;
  const bullet = first.marker;
  const baseIndent = first.indent;
  // a later item of this list may sit at any indent from the container's
  // base (0) up to 3 columns deeper than the first item; a more-indented
  // marker is absorbed as the item's content before this check runs, so
  // it never reaches here as a would-be sibling
  const isSibling = (lm) => lm && lm.indent <= baseIndent + 3
    && lm.kind === kind && (kind === 'bullet' ? lm.marker === bullet : lm.delim === delim);
  const items = [];
  let j = i;
  let loose = false;
  while (j < end) {
    // a thematic break at the list's indent ends the list
    if (matchHr(lines[j])) break;
    const lm = matchListMarker(lines[j]);
    if (!isSibling(lm)) break;
    const contentCol = lm.contentCol;
    const itemLines = [];
    const itemLazy = new Set();
    // first line: content after the marker
    itemLines.push(listItemFirstLine(lines[j], lm));
    // parent index just after the item's last non-blank line (for the
    // trailing-newline rule of an HTML block at the end of the item)
    let itemEndIdx = j + 1;
    let k = j + 1;
    // does the item's content end with an open paragraph (so a following
    // line may be a lazy continuation of it)?
    const itemHasOpenPara = () => {
      for (let t = itemLines.length - 1; t >= 0; t--) {
        if (!isBlankLine(itemLines[t])) return sublineIsParagraphLine(itemLines[t]);
      }
      return false;
    };
    while (k < end) {
      const line = lines[k];
      if (isBlankLine(line)) {
        // a blank line belongs to the item if the next non-blank line is
        // indented enough; if the next non-blank line is a new item of this
        // list, the blank line separates items (loose) and is not kept.
        // An EMPTY item ends at a blank line: indented content after it
        // is not part of the item (cm-280), though a sibling item still
        // continues the list (cm-315).
        let m = k + 1;
        while (m < end && isBlankLine(lines[m])) m++;
        if (m >= end) break;
        let hasContent = false;
        for (const l of itemLines) if (!isBlankLine(l)) { hasContent = true; break; }
        const { cols: mc } = lineIndent(lines[m]);
        if (hasContent && mc >= contentCol) {
          itemLines.push(line);
          k++;
          continue;
        }
        const nm = matchListMarker(lines[m]);
        if (isSibling(nm)) {
          loose = true;
          k = m;
          break;
        }
        break;
      }
      const { cols: mc } = lineIndent(line);
      // a line indented to the item's content column belongs to the item
      // (even a nested list marker); only a line outside it can be a
      // sibling item or end the list
      if (mc >= contentCol) {
        itemLines.push(stripColsExpand(line, contentCol, 0));
        itemEndIdx = k + 1;
        k++;
        continue;
      }
      const nm = matchListMarker(line);
      if (isSibling(nm)) break;
      // lazy paragraph continuation: the item's paragraph is open and
      // this line does not interrupt a paragraph, so it belongs to the
      // item's paragraph (indent >= 4 loses 4 columns, as in blockquotes).
      // A list marker is never a lazy continuation (it starts a new list).
      if (itemHasOpenPara() && !interruptsParagraph(lines, k, end) && !matchListMarker(line)) {
        itemLazy.add(itemLines.length);
        itemLines.push(mc >= 4 ? stripCols(line, 4) : line);
        itemEndIdx = k + 1;
        k++;
        continue;
      }
      break;
    }
    // (within-item looseness is determined from the parsed block ranges
    // in the render phase, not from raw lines: blanks inside a nested
    // list or blockquote must not make the outer list loose)
    // drop trailing blank lines
    while (itemLines.length && isBlankLine(itemLines[itemLines.length - 1])) itemLines.pop();
    // an HTML block ending at the end of the item always loses its
    // trailing newline (the </li> follows immediately, whatever comes
    // next in the parent)
    const itemEndLosesNL = true;
    items.push({ lines: itemLines, startNum: lm.num, endLosesNL: itemEndLosesNL, lazy: itemLazy });
    j = k;
  }
  const tag = kind === 'bullet' ? 'ul' : 'ol';
  const startAttr = kind === 'ordered' && items[0].startNum !== 1 ? ' start="' + items[0].startNum + '"' : '';
  // first pass: parse every item's body, recording its top-level block
  // ranges; an item is loose iff two of its DIRECT blocks are separated
  // by a blank line (a gap between consecutive ranges). Blanks inside a
  // nested list or blockquote do not count.
  let listLoose = loose;
  const parsed = [];
  for (const item of items) {
    // task list checkbox? '[ ]' or '[x]' followed by one or more spaces and
    // non-whitespace content on the first line
    let task = null;
    if (item.lines.length > 0) {
      const m = /^\[([ xX])\] +/.exec(item.lines[0]);
      if (m && item.lines[0].slice(m[0].length).trim().length > 0) {
        task = m[1] !== ' ';
        item.lines[0] = item.lines[0].slice(m[0].length);
      }
    }
    const ranges = [];
    const prevInList = IN_LIST_ITEM;
    IN_LIST_ITEM = true;
    const body = parseBlocks(item.lines, 0, item.lines.length, refs, item.endLosesNL, ranges, item.lazy.size ? item.lazy : undefined);
    IN_LIST_ITEM = prevInList;
    for (let k = 1; k < ranges.length; k++) {
      if (ranges[k].start > ranges[k - 1].end) { listLoose = true; break; }
    }
    parsed.push({ body, task });
  }
  // second pass: render with the final looseness
  let html = '<' + tag + startAttr + '>\n';
  for (const p of parsed) {
    let body = p.body;
    if (!listLoose) {
      // tight: strip the <p>...</p> wrapper from every paragraph that is
      // a direct child of the item (cm-300: a paragraph after a heading
      // is stripped too, not just a leading one)
      body = stripTightP(body);
    }
    if (p.task !== null) {
      const cb = (p.task ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">') + ' ';
      if (body.startsWith('<p>')) body = '<p>' + cb + body.slice(3);
      else body = cb + body;
    }
    html += '<li>' + body + '</li>\n';
  }
  html += '</' + tag + '>\n';
  return { html, end: j };
}

// Main block parser over lines[start..end). endLosesNL: an HTML block that
// consumes to the end of this range loses its trailing newline (the range
// ends at the input's last line without a trailing newline, or at a blank
// line in the parent).
function parseBlocks(lines, start, end, refs, endLosesNL, ranges, lazy) {
  let out = '';
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const blockStart = i;
    const rec = () => { if (ranges) ranges.push({ start: blockStart, end: i }); };
    // link reference definitions
    const def = tryDef(lines, i, end, refs);
    if (def) { i = def.end; rec(); continue; }
    // ATX heading
    const atx = matchAtx(line);
    if (atx) {
      out += '<h' + atx.level + '>' + (COLLECT_ONLY ? '' : inline(atx.text, refs)) + '</h' + atx.level + '>\n';
      i++;
      rec(); continue;
    }
    // fenced code
    const fence = matchFence(line);
    if (fence) {
      let content = '';
      let j = i + 1;
      let closed = false;
      let lastBlank = false;
      while (j < end) {
        const l = lines[j];
        const { cols, idx } = lineIndent(l);
        if (cols <= 3 && l[idx] === fence.ch) {
          let k = idx;
          while (k < l.length && l[k] === fence.ch) k++;
          if (k - idx >= fence.len) {
            let rest = l.slice(k);
            if (/^[ \t]*$/.test(rest)) { closed = true; j++; break; }
          }
        }
        // marked dedents fenced code content by the fence's indent for
        // BACKTICK fences only; a tilde fence's content keeps its
        // indentation verbatim (probed: `  ~~~js` keeps `  foo`, while
        // `  ```js` strips it to `foo`). Do not "fix" this to strip both.
        const stripped = stripFenceContent(l, fence.ch === '`' ? fence.indent : 0);
        lastBlank = stripped === '';
        content += stripped + '\n';
        j++;
      }
      // a closed fence drops exactly one trailing blank line (the newline
      // before the closing fence is the last content line's terminator)
      if (closed && lastBlank) content = content.slice(0, -1);
      const info = fence.info;
      const lang = info.split(/[ \t]+/)[0] || '';
      const cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
      out += '<pre><code' + cls + '>' + escapeText(content) + '</code></pre>\n';
      i = j;
      rec(); continue;
    }
    // indented code
    {
      const { cols } = lineIndent(line);
      if (cols >= 4) {
        let content = '';
        let j = i;
        while (j < end) {
          const l = lines[j];
          if (isBlankLine(l)) {
            // include blank lines only if a code line follows; a blank line
            // contributes its content after the 4-column strip (so a line of
            // six spaces contributes two spaces)
            let m = j + 1;
            while (m < end && isBlankLine(lines[m])) m++;
            if (m < end && lineIndent(lines[m]).cols >= 4) {
              content += stripCols(l, 4) + '\n';
              j++;
              continue;
            }
            break;
          }
          if (lineIndent(l).cols >= 4) {
            content += stripCols(l, 4) + '\n';
            j++;
            continue;
          }
          break;
        }
        out += '<pre><code>' + escapeText(content) + '</code></pre>\n';
        i = j;
        rec(); continue;
      }
    }
    // HTML block
    const ht = htmlBlockType(line);
    if (ht >= 1) {
      const blockLines = [];
      let j = i + 1;
      if (ht <= 5) {
        let tagName = '';
        if (ht === 1) {
          const m = /^<\s*(script|pre|style|textarea)/i.exec(line);
          tagName = m ? m[1].toLowerCase() : '';
        }
        blockLines.push(line);
        if (!htmlBlockEnds(ht, line, tagName)) {
          while (j < end) {
            blockLines.push(lines[j]);
            if (htmlBlockEnds(ht, lines[j], tagName)) { j++; break; }
            j++;
          }
        } else {
          j = i + 1;
        }
      } else {
        let k = i;
        while (k < end && !isBlankLine(lines[k])) { blockLines.push(lines[k]); k++; }
        j = k;
      }
      // the block's last line keeps its newline unless the next line is
      // blank, or this range ends where a newline is lost (the input's
      // last line without a trailing newline, propagated into
      // containers). For types 1-5 (pre/script/comment/etc., which end at
      // a terminator) a line holding only spaces/tabs is NOT blank here:
      // marked still emits the newline after the block for it. For types
      // 6-7 (block-level tags, which end at a blank line) any blank line
      // ends the block without a trailing newline.
      let content = blockLines.join('\n');
      let addNL = true;
      if (j < end && (ht >= 6 ? isBlankLine(lines[j]) : lines[j] === '')) addNL = false;
      else if (j >= end && endLosesNL) addNL = false;
      if (addNL) content += '\n';
      out += content;
      i = j;
      rec(); continue;
    }
    // blockquote
    {
      const { cols, idx } = lineIndent(line);
      if (cols <= 3 && line[idx] === '>') {
        const r = parseBlockquote(lines, i, end, refs, endLosesNL);
        out += r.html;
        i = r.end;
        rec(); continue;
      }
    }
    // thematic break (checked before list: '- - -' is an <hr>, not a list)
    if (matchHr(line)) {
      out += '<hr>\n';
      i++;
      rec(); continue;
    }
    // list
    if (matchListMarker(line)) {
      const r = parseList(lines, i, end, refs, endLosesNL);
      out += r.html;
      i = r.end;
      rec(); continue;
    }
    // table
    const tbl = tryTable(lines, i, end, refs);
    if (tbl) {
      out += tbl.html;
      i = tbl.end;
      rec(); continue;
    }
    // paragraph (handles setext headings)
    const para = parseParagraph(lines, i, end, refs, lazy);
    out += para.html;
    i = para.end;
    rec();
  }
  return out;
}

// ---------------- entry point ----------------

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const endLosesNL = !src.endsWith('\n');
  // collect pass: gather every link reference definition in the document
  // (including ones defined after their use) before rendering
  COLLECT_ONLY = true;
  INSIDE_A_TAG = false;
  parseBlocks(lines, 0, lines.length, refs, endLosesNL);
  COLLECT_ONLY = false;
  INSIDE_A_TAG = false;
  return parseBlocks(lines, 0, lines.length, refs, endLosesNL);
}
