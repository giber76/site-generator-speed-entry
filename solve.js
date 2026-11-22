// A faster drop-in for makefun-site 1.0.0: run(input) returns byte-for-byte the
// answer makefun-site's build returns for the same input, but much faster.
//
// Winning approach, in one sentence: a single-pass, allocation-light
// reimplementation that scans front matter and Markdown lines by hand,
// renders inline Markdown in bulk-escaped runs instead of one regex call per
// character, caches slugs, and compiles each template to a straight-line
// JavaScript function with prototype-chained scopes instead of walking a node
// tree with a scope-chain lookup per variable.
//
// The semantics below mirror the reference (README + code) exactly: the same
// dialect, the same refusal reasons, the same slug rule, the same report.
// Nothing here is copied from the reference: every function is written fresh
// against the documented rules, and the result is checked against the
// reference on the practice instance and on freshly drawn instances.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. Fast path: most strings hold none of them. */
function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// Slug cache: titles, tag names and headings repeat a lot across a site.
const slugCache = new Map();

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 *  of characters other than a-z and 0-9 one "-", none at either end, at most
 *  64 characters (a "-" left at the cut dropped), "untitled" when empty.
 *  Pure ASCII is NFKD-stable and holds no combining marks, so it skips the
 *  normalise + mark-strip pass entirely. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const r = out === '' ? 'untitled' : out;
  if (slugCache.size < 200000) slugCache.set(text, r);
  return r;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace (native regex). */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** Whether `t` holds no '"' '[' or ']' and is non-empty. */
function tagOk(t) {
  if (t === '') return false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === '[' || c === ']') return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        if (!tagOk(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw[i];
        ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // a slug may not open on '-'
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false; // may not close on '-'
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z or _
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are scanned
 * with indexOf instead of splitting the whole text.
 */
function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  const first = firstNL === -1 ? text : text.slice(0, firstNL);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = firstNL === -1 ? text.length : firstNL + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') { closeStart = pos; closeEnd = nl === -1 ? text.length : nl; break; }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let li = firstNL === -1 ? text.length : firstNL + 1;
  let lineno = 2;
  while (li < closeStart) {
    const nl = text.indexOf('\n', li);
    const line = nl === -1 || nl >= closeStart ? text.slice(li, closeStart) : text.slice(li, nl);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) { // not blank, not '#...'
      const colon = line.indexOf(':');
      if (colon <= 0) return { error: `line ${lineno} is not "key: value"` };
      let keyOk = true;
      for (let i = 0; i < colon; i++) if (!isKeyChar(line.charCodeAt(i))) { keyOk = false; break; }
      if (!keyOk) return { error: `line ${lineno} is not "key: value"` };
      const key = line.slice(0, colon);
      let raw;
      if (colon === line.length - 1) raw = '';
      else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
      else return { error: `line ${lineno} is not "key: value"` };
      let end = raw.length;
      while (end > 0) {
        const c = raw.charCodeAt(end - 1);
        if (c !== 32 && c !== 9) break;
        end--;
      }
      if (end !== raw.length) raw = raw.slice(0, end);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    li = nl === -1 ? text.length : nl + 1;
    lineno++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (i < 6 && line.charCodeAt(i) === 35) i++; // '#'
  if (i === 0) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null; // needs at least one space/tab
  let j = i;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: i, text: line.slice(j, end) };
}

/** A fence-open line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` is a thematic break. */
function isHR(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2); // '-' or '*', ' '
  return null;
}

/** An ordered item's { num, text }, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0) return null;
  if (line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) return null; // 10+ digits
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // '. '
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

/** Whether code unit `c` is whitespace in the /\s/ sense. */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i < 2) return false;
  const c = line.charCodeAt(i);
  return i < line.length && !isWS(c);
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break.
 *  Only the first character can start one of those, so other lines return
 *  false without any further test. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpen(line) !== null; // '`'
  if (c0 === 35) return headingOf(line) !== null; // '#'
  if (c0 === 45 || c0 === 42) return isHR(line); // '-' or '*'
  if (line.length === 0 || c0 === 32 || c0 === 9) return isBlankLine(line);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that interrupt a plain inline run. One native regex scan
 *  finds the next one; lastIndex is set at the top of every loop turn, so a
 *  recursive inline() on a slice cannot disturb the caller's scan. */
const SPECIALS = ['\\', '`', '*', '[', '&', '<', '>', '"', "'"];
const SPECIAL_RE = new RegExp(`[${SPECIALS.map((c) => `\\${c}`).join('')}]`, 'g');

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs are
 * copied in bulk: the scanner jumps from one inline marker to the next with
 * one native regex scan, so the per-character regex escape of the reference
 * becomes one slice per run.
 */
function inline(s, env) {
  let out = '';
  let i = 0; // start of the current unflushed plain run
  let pos = 0; // where the next marker search starts (past literal markers)
  const n = s.length;
  for (;;) {
    SPECIAL_RE.lastIndex = pos;
    const m = SPECIAL_RE.exec(s);
    if (m === null) {
      if (i < n) out += s.slice(i);
      return out;
    }
    const j = m.index;
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (i < j) out += s.slice(i, j);
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        i = pos = j + 2;
      } else pos = j + 1; // a backslash before anything else is itself
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (i < j) out += s.slice(i, j);
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = pos = k + 1;
      } else pos = j + 1; // a backtick with no closer is itself
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (i < j) out += s.slice(i, j);
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = pos = k + 2;
        } else pos = j + 2; // '**' with no closer is itself
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (i < j) out += s.slice(i, j);
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = pos = k + 1;
      } else pos = j + 1; // a '*' with no closer is itself
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        if (i < j) out += s.slice(i, j);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = pos = m2 + 1;
      } else pos = j + 1; // '[' with no link is itself
      continue;
    }
    // An escape-table character: flush the run, emit the entity.
    if (i < j) out += s.slice(i, j);
    out += ESCAPES[c];
    i = pos = j + 1;
  }
}

/**
 * `src` rendered in one pass over its lines (no token array): its HTML, its
 * table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const L = lines.length;
  let i = 0;
  while (i < L) {
    const line = lines[i];
    // Dispatch on the first character: only it can start a fence, a heading,
    // a break, a quote or a list. Anything else is paragraph text.
    const c0 = line.charCodeAt(0);
    if (c0 === 96) { // '`': a fence, or paragraph text
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < L && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        let code = '';
        for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) { // '#': a heading, or paragraph text
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*': a break, a list, or paragraph text
      if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [];
        while (i < L) {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
          if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let inner = '';
        for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
        blocks.push(`<ul>\n${inner}</ul>`);
        continue;
      }
    } else if (c0 === 62) { // '>': a blockquote
      const raw = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        raw.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (let k = 0; k < raw.length; k++) {
        const t = trimLine(raw[k]);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(ls.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // a digit: an ordered list, or paragraph text
      const o = orderedOf(line);
      if (o !== null) {
        const start = Number(o.num);
        const items = [];
        while (i < L) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
          if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let inner = '';
        for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
        blocks.push(`${open}\n${inner}</ol>`);
        continue;
      }
    } else if (line.length === 0 || c0 === 32 || c0 === 9) { // blank, or indented
      if (isBlankLine(line)) { i++; continue; }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** One own-property step of a path lookup, or undefined. */
function hv(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

/**
 * A path lookup compiled to an expression over a prototype-chained scope
 * object `S`: the first name reads from the innermost scope that binds it
 * (a prototype-chain read), each next name one own-property step.
 */
function lkExpr(path, S) {
  let e = `${S}[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) e = `hv(${e},${JSON.stringify(path[k])})`;
  return e;
}

/**
 * Compile a parsed template to a function (S, T, E, D, hv, X, Y) -> string,
 * where S is the scope (prototype-chained vars objects), T the map of
 * compiled templates, E the HTML escape, D the include depth, X textOf and
 * Y truthy. Falls back to null when the generated code cannot be compiled
 * (the walker below renders it instead).
 */
function compileTemplate(nodes) {
  let uid = 0;
  const parts = ['let o="";'];
  const gen = (ns, S) => {
    for (const n of ns) {
      if (n.kind === 'text') parts.push(`o+=${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') parts.push(`o+=E(X(${lkExpr(n.path, S)}));`);
      else if (n.kind === 'raw') parts.push(`o+=X(${lkExpr(n.path, S)});`);
      else if (n.kind === 'if') {
        parts.push(`if(${n.not ? '!' : ''}Y(${lkExpr(n.path, S)})){`);
        gen(n.then, S);
        if (n.else !== null) { parts.push('}else{'); gen(n.else, S); }
        parts.push('}');
      } else if (n.kind === 'for') {
        const id = ++uid;
        const s2 = `s${id}`;
        const xs = `x${id}`;
        const k = `k${id}`;
        const lp = `l${id}`;
        // One child scope and one loop record per loop execution, mutated per
        // element: rendering is synchronous, so nothing retains them.
        parts.push(`{const ${xs}=${lkExpr(n.path, S)};if(Array.isArray(${xs})){const ${s2}=Object.create(${S});const ${lp}={index:0,first:false,last:false,length:${xs}.length};${s2}.loop=${lp};for(let ${k}=0;${k}<${xs}.length;${k}++){${s2}[${JSON.stringify(n.name)}]=${xs}[${k}];${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${xs}.length-1;`);
        gen(n.body, s2);
        parts.push('}}}');
      } else if (n.kind === 'include') {
        const id = ++uid;
        parts.push(`if(D<${INCLUDE_DEPTH}){const f${id}=T.get(${JSON.stringify(n.name)});if(f${id}!==undefined)o+=f${id}(${S},T,E,D+1,hv,X,Y);}`);
      }
    }
  };
  gen(nodes, 'S');
  parts.push('return o;');
  try {
    return new Function('S', 'T', 'E', 'D', 'hv', 'X', 'Y', parts.join(''));
  } catch {
    return null;
  }
}

/** The node-tree walker, used only when a template cannot be compiled. */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var' || n.kind === 'raw') {
      let s = scope;
      while (s !== null && !Object.hasOwn(s.vars, n.path[0])) s = s.parent;
      let v = s === null ? undefined : s.vars[n.path[0]];
      for (let k = 1; k < n.path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, n.path[k])) { v = undefined; break; }
        v = v[n.path[k]];
      }
      out += n.kind === 'var' ? escapeHtml(textOf(v)) : textOf(v);
    } else if (n.kind === 'if') {
      let s = scope;
      while (s !== null && !Object.hasOwn(s.vars, n.path[0])) s = s.parent;
      let v = s === null ? undefined : s.vars[n.path[0]];
      for (let k = 1; k < n.path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, n.path[k])) { v = undefined; break; }
        v = v[n.path[k]];
      }
      const branch = truthy(v) !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodes(branch, scope, templates, depth);
    } else if (n.kind === 'for') {
      let s = scope;
      while (s !== null && !Object.hasOwn(s.vars, n.path[0])) s = s.parent;
      let v = s === null ? undefined : s.vars[n.path[0]];
      for (let k = 1; k < n.path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, n.path[k])) { v = undefined; break; }
        v = v[n.path[k]];
      }
      if (Array.isArray(v)) {
        v.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === v.length - 1, length: v.length } };
          out += renderNodes(n.body, { vars, parent: scope }, templates, depth);
        });
      }
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, templates, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed and compiled in code-unit order of their name.
  const templates = new Map(); // name -> compiled fn
  const fallback = new Map(); // name -> node tree (only when compile failed)
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      const fn = compileTemplate(nodes);
      if (fn !== null) templates.set(name, fn);
      else fallback.set(name, nodes);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const hasTemplate = (name) => templates.has(name) || fallback.has(name);

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; refused sources and drafts are reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!hasTemplate(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags, grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      const t = bySlug.get(slug);
      s.tagRefs.push(t !== undefined ? t : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages, and rendering.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  const output = {};
  // One scope object per case, mutated per render: rendering is synchronous,
  // so no render retains it. Stale per-render keys are deleted first.
  const scope = Object.create(null);
  scope.site = site;
  scope.tags = allTags;
  scope.recent = recent;
  let prevKeys = [];
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn !== undefined) {
      for (let i = 0; i < prevKeys.length; i++) delete scope[prevKeys[i]];
      prevKeys = Object.keys(vars);
      for (let i = 0; i < prevKeys.length; i++) scope[prevKeys[i]] = vars[prevKeys[i]];
      return fn(scope, templates, escapeHtml, 0, hv, textOf, truthy);
    }
    const nodes = fallback.get(name);
    if (nodes === undefined) return null;
    const rootVars = { site, tags: allTags, recent, ...vars };
    return renderNodes(nodes, { vars: rootVars, parent: null }, fallback, 0);
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const page = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const html = render('tag', { tag: tagOf(tags[i]) });
    if (html !== null) output[`tags/${tags[i].slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
