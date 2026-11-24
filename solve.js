// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
//
// run(input) returns exactly what makefun-site 1.0.0's build(input) returns: the output tree of the
// case's site, byte for byte. Same semantics as the reference (front matter, template dialect, Markdown
// subset, slug rule, report), rewritten for speed in dependency-free ES module code:
//
// - no intermediate token trees: Markdown renders straight into a string-parts array, line by line;
// - HTML escaping scans once and returns the input untouched when nothing needs escaping (the
//   reference escapes every single character through a regex, which dominates its CPU time);
// - slugify has an ASCII fast path plus a per-case cache (titles and tag names repeat heavily);
// - template rendering pushes into a shared parts array and uses prototype-chained scopes, so a
//   loop's bindings cost one object creation; templates that depend only on the case globals
//   (site/tags/recent) render once per case, and templates that depend on one loop element render
//   once per element (a post's card is identical on its index page and on every tag page);
// - link targets resolve once per (directory, target) per case; front matter is parsed by scanning
//   lines without splitting and re-joining the whole file.
//
// Nothing is cached from one case to the next: every cache below lives in the per-run context.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether a code unit is whitespace in JavaScript's \s sense (the exact set \s matches). */
function isWSCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. A native regex scan returns the input itself when nothing
 *  needs escaping; matches are rare, so the callback runs only for them. */
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

const SLUG_MAX = 64;

/** The slug of `text`, exactly as the reference computes it (NFKD, combining marks dropped, A-Z lowered,
 *  each run of other characters one "-", at most 64 chars, "untitled" when nothing is left). */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = null;
      if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = text[i];
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out[e - 1] === '-') e--;
    out = out.slice(0, e);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDateRaw(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace (the reference's /\S+/g count). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A slug made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken.
 *  `taken` is { set, next } where next maps a base slug to the suffix to try first; equivalent to the
 *  reference's scan from 2 every time, because the taken set only grows. */
function uniqueSlug(slug, taken) {
  if (!taken.set.has(slug)) {
    taken.set.add(slug);
    taken.next.set(slug, 2);
    return slug;
  }
  let n = taken.next.get(slug) || 2;
  let out = `${slug}-${n}`;
  while (taken.set.has(out)) { n++; out = `${slug}-${n}`; }
  taken.set.add(out);
  taken.next.set(slug, n + 1);
  return out;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
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
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw[i];
        ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw[i];
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else if (c === '-' && !prevDash) prevDash = true;
        else ok = false;
      }
      if (ok && prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Parse one front-matter line: { key, raw } with the raw value's trailing spaces/tabs dropped,
 *  or null when the line is not "key: value" (the reference's /^([a-z_]+):(?: (.*))?$/). */
function parseFMKeyLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (!((c >= 'a' && c <= 'z') || c === '_')) break;
    i++;
  }
  if (i === 0) return null;
  const key = line.slice(0, i);
  if (line[i] !== ':') return null;
  let raw;
  if (i + 1 === line.length) raw = '';
  else if (line[i + 1] === ' ') raw = line.slice(i + 2);
  else return null;
  let e = raw.length;
  while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
  return { key, raw: raw.slice(0, e) };
}

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 *  `text` has "\n" line ends. Scans lines by index instead of splitting the whole file. */
function parseFrontMatter(text) {
  const firstEnd = text.indexOf('\n');
  const firstLine = firstEnd === -1 ? text : text.slice(0, firstEnd);
  if (firstLine !== '---') return { error: 'no front matter' };
  // Find the closing line.
  let pos = firstEnd === -1 ? text.length : firstEnd + 1;
  let closeNo = -1;
  let closeEnd = -1;
  let curPos = pos;
  let curNo = 2;
  while (curPos <= text.length) {
    const e = text.indexOf('\n', curPos);
    const lineEnd = e === -1 ? text.length : e;
    if (text.slice(curPos, lineEnd) === '---') { closeNo = curNo; closeEnd = lineEnd; break; }
    if (e === -1) break;
    curNo++;
    curPos = e + 1;
  }
  if (closeNo === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = pos;
  let no = 2;
  while (no < closeNo) {
    const e = text.indexOf('\n', p);
    const lineEnd = e === -1 ? text.length : e;
    const line = text.slice(p, lineEnd);
    if (!isBlankLine(line) && line[0] !== '#') {
      const m = parseFMKeyLine(line);
      if (m === null) return { error: `line ${no} is not "key: value"` };
      if (!KEYS.includes(m.key)) return { error: `unknown key "${m.key}"` };
      if (Object.hasOwn(data, m.key)) return { error: `key "${m.key}" is given twice` };
      if (m.raw === '') return { error: `key "${m.key}" has no value` };
      const v = valueOf(m.key, m.raw);
      if ('error' in v) return v;
      data[m.key] = v.value;
    }
    no++;
    p = e === -1 ? text.length + 1 : e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd >= text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  if (line.length === 0) return line;
  const first = line[0];
  const last = line[line.length - 1];
  if (first !== ' ' && first !== '\t' && last !== ' ' && last !== '\t') return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** A fence opening line: its language, or null. A line of three backticks and an optional language
 *  (A-Z, a-z, 0-9, _, +, -), then spaces or tabs only. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-')) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty; 7+ '#' is not a heading). */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line[c] === '#') c++;
  if (c < 1 || c > 6) return null;
  if (line[c] !== ' ' && line[c] !== '\t') return null;
  let i = c;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  let e = line.length;
  while (e > i && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === i) return null;
  return { depth: c, text: line.slice(i, e) };
}

function isHR(line) {
  if (line !== '---' && line !== '***') {
    if (!line.startsWith('---') && !line.startsWith('***')) return false;
    for (let i = 3; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') return false;
    }
    return true;
  }
  return true;
}

function endsParagraph(line) {
  const ch = line[0];
  if (ch === undefined) return true;
  if (ch === ' ' || ch === '\t') return isBlankLine(line);
  if (ch === '`') return fenceOpen(line) !== null;
  if (ch === '#') return headingOf(line) !== null;
  if (ch === '-' || ch === '*') return isHR(line);
  return false;
}

/** A bullet item's text, or null: a line "- " or "* " plus its text (which may be empty). */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item: { num, text }, or null: digits (1-9 of them) and ". " plus its text. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j < 1 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { num: line.slice(0, j), text: line.slice(j + 2) };
}

/** A list-item continuation line: two or more spaces then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i < 2 || i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) {
    if (isWSCode(s.charCodeAt(i))) return true;
  }
  return false;
}

/** A link target's href for a source in directory `dir`, with a per-case cache. A target that names
 *  neither a page nor a static file is a broken link (recorded once per source) and kept as written. */
function resolveLink(target, env) {
  const C = env.C;
  const key = `${env.dir}\n${target}`;
  let e = C.linkCache.get(key);
  if (e === undefined) {
    let href;
    let broken = false;
    let scheme = false;
    const first = target[0];
    if ((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z')) {
      // scheme: a letter, then letters/digits/+/-/. then ':'
      let i = 1;
      while (i < target.length) {
        const c = target[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.')) break;
        i++;
      }
      scheme = target[i] === ':';
    }
    if (scheme || target[0] === '/' || target[0] === '#') href = target;
    else {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(env.dir, rel);
      if (path !== null && C.bySource.has(path)) href = `${C.bySource.get(path).url}${frag}`;
      else if (path !== null && C.staticPaths.has(path)) href = `${C.base}/${path}${frag}`;
      else { broken = true; href = target; }
    }
    e = { href, broken };
    C.linkCache.set(key, e);
  }
  if (e.broken) C.broken.add(`broken-link ${env.path} -> ${target}`);
  return e.href;
}

/** `s` rendered inline into `out`; `env` carries the source's directory, path and the run context.
 *  The scan jumps from one markup character (\ ` * [) to the next with native indexOf calls instead
 *  of visiting every character in JavaScript; the plain text between them is escaped in one go. */
function inlineInto(s, env, out) {
  let i = 0;
  let plainStart = 0;
  const n = s.length;
  while (i < n) {
    let j = s.indexOf('\\', i);
    let k = s.indexOf('`', i);
    if (k !== -1 && (j === -1 || k < j)) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && (j === -1 || k < j)) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && (j === -1 || k < j)) j = k;
    if (j === -1) break;
    i = j;
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (i > plainStart) out.push(esc(s.slice(plainStart, i)));
      out.push(esc(s[i + 1]));
      i += 2;
      plainStart = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plainStart) out.push(esc(s.slice(plainStart, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        plainStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plainStart) out.push(esc(s.slice(plainStart, i)));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          plainStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plainStart) out.push(esc(s.slice(plainStart, i)));
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
        plainStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWS(target)) {
        if (i > plainStart) out.push(esc(s.slice(plainStart, i)));
        out.push('<a href="', esc(resolveLink(target, env)), '">');
        inlineInto(s.slice(i + 1, k), env, out);
        out.push('</a>');
        i = m + 1;
        plainStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (n > plainStart) out.push(esc(s.slice(plainStart, n)));
}

function inline(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/** `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 *  contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 *  paragraph's inline HTML, or ""). Renders blocks straight into the output parts, with no tokens. */
function renderMarkdown(src, env, C) {
  const lines = src.split('\n');
  const parts = [];
  const toc = [];
  let excerpt = null;
  const ids = { set: new Set(), next: new Map() };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ch = line[0];
    if (ch === undefined) { i++; continue; }
    if ((ch === ' ' || ch === '\t') && isBlankLine(line)) { i++; continue; }
    const fence = ch === '`' ? fenceOpen(line) : null;
    if (fence !== null) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      parts.push(`<pre><code${fence === '' ? '' : ` class="language-${esc(fence)}"`}>`);
      for (const bl of body) { parts.push(esc(bl), '\n'); }
      parts.push('</code></pre>\n');
      continue;
    }
    const heading = ch === '#' ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugifyCached(heading.text, C), ids);
      if (heading.depth === 2 || heading.depth === 3) {
        const html = inline(heading.text, env);
        parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        toc.push({ level: heading.depth, id, html });
      } else {
        parts.push(`<h${heading.depth} id="${id}">`);
        inlineInto(heading.text, env, parts);
        parts.push(`</h${heading.depth}>\n`);
      }
      i++;
      continue;
    }
    if ((ch === '-' || ch === '*') && isHR(line)) { parts.push('<hr>\n'); i++; continue; }
    if (ch === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') {
        const l = lines[i];
        body.push(trimLine(l[1] === ' ' ? l.slice(2) : l.slice(1)));
        i++;
      }
      const inner = body.filter((l) => l !== '');
      if (inner.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(inner.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = (ch === '-' || ch === '*') ? bulletOf(line) : null;
    const ordered = bullet === null && ch >= '0' && ch <= '9' ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = Number(ordered.num);
      while (i < lines.length) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (items.length > 0 && isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      parts.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const item of items) {
        parts.push('<li>');
        inlineInto(item.join('\n'), env, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inline(text, env);
      excerpt = html;
      parts.push(`<p>${html}</p>\n`);
    } else {
      parts.push('<p>');
      inlineInto(text, env, parts);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

function slugifyCached(text, C) {
  let v = C.slugCache.get(text);
  if (v === undefined) { v = slugifyRaw(text); C.slugCache.set(text, v); }
  return v;
}

function longDateCached(date, C) {
  let v = C.dateCache.get(date);
  if (v === undefined) { v = longDateRaw(date); C.dateCache.set(date, v); }
  return v;
}

// ---------------------------------------------------------------- Templates

export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
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

/** The value at `path` in the scope chain: its first name from the nearest scope holding it
 *  (the scope objects form a prototype chain rooted at a null-prototype object, so a plain
 *  property read is that lookup), then own properties of the value so far. */
function lookup(scope, path) {
  let v = scope[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's
 *  items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const GLOBALS = ['site', 'tags', 'recent'];

/** The first-segment names a template reads that no enclosing `for` binds (its free variables),
 *  following includes in the same scope. Memoised per (template, bound set) — but never memoised
 *  when an include cycle cut the analysis short (the cut returns an empty set for the repeated
 *  template, whose own direct references the outer analysis already collects). */
function freeVarsOf(name, bound, C, visiting) {
  if (visiting.has(name)) { C.freeCut++; return EMPTY_SET; }
  const key = `${name}|${[...bound].sort().join(',')}`;
  let cached = C.freeMemo.get(key);
  if (cached !== undefined) return cached;
  const cutBefore = C.freeCut;
  const out = new Set();
  const nodes = C.templates.get(name);
  if (nodes !== undefined) {
    visiting.add(name);
    collectFree(nodes, bound, out, C, visiting);
    visiting.delete(name);
  }
  if (C.freeCut === cutBefore) C.freeMemo.set(key, out);
  return out;
}

function collectFree(nodes, bound, out, C, visiting) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      if (n.kind === 'if') {
        collectFree(n.then, bound, out, C, visiting);
        if (n.else !== null) collectFree(n.else, bound, out, C, visiting);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      collectFree(n.body, b2, out, C, visiting);
    } else if (n.kind === 'include') {
      for (const v of freeVarsOf(n.name, bound, C, visiting)) out.add(v);
    }
  }
}

/** Render an included template, using the per-case memo when its output depends only on the case
 *  globals, or on the globals plus one loop element. Returns true when it rendered (memoised or not
 *  applicable it returns false and the caller renders normally). `loop` is never memoised: the loop
 *  object is one mutable object per `for` execution. */
function renderInclude(name, nodes, scope, depth, out, C) {
  let plan = C.includePlan.get(name);
  if (plan === undefined) {
    const free = freeVarsOf(name, EMPTY_SET, C, new Set());
    if (free.has('loop')) plan = { kind: 'none' };
    else {
      let extra = null;
      for (const v of free) {
        if (GLOBALS.includes(v)) continue;
        if (extra !== null) { extra = 'MULTI'; break; }
        extra = v;
      }
      plan = extra === 'MULTI' ? { kind: 'none' } : extra === null ? { kind: 'global' } : { kind: 'elem', extra };
    }
    C.includePlan.set(name, plan);
  }
  if (plan.kind === 'none') return false;
  if (plan.kind === 'global') {
    const key = `${name}\n${depth}`;
    let s = C.globalCache.get(key);
    if (s === undefined) {
      const tmp = [];
      renderNodes(nodes, scope, depth + 1, tmp, C);
      s = tmp.join('');
      C.globalCache.set(key, s);
    }
    out.push(s);
    return true;
  }
  const val = lookup(scope, [plan.extra]);
  let byDepth = C.elemCache.get(name);
  if (byDepth === undefined) { byDepth = new Map(); C.elemCache.set(name, byDepth); }
  let byVal = byDepth.get(depth);
  if (byVal === undefined) { byVal = new Map(); byDepth.set(depth, byVal); }
  let s = byVal.get(val);
  if (s === undefined) {
    const tmp = [];
    renderNodes(nodes, scope, depth + 1, tmp, C);
    s = tmp.join('');
    byVal.set(val, s);
  }
  out.push(s);
  return true;
}

const EMPTY_SET = new Set();

/** `nodes` rendered into `out` (a string-parts array) in `scope` (a prototype-chained vars object). */
function renderNodes(nodes, scope, depth, out, C) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, depth, out, C);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: false, last: false, length: xs.length };
        // One child scope per `for` execution, rebound each iteration: rendering is fully
        // synchronous, so no iteration's render can observe the next one's bindings. `loop`
        // is assigned after the element (as in the reference's object literal) so it wins
        // when a loop is itself named "loop"; "__proto__" is defined as an own property.
        const child = Object.create(scope);
        for (let k = 0; k < xs.length; k++) {
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          if (n.name === '__proto__') {
            Object.defineProperty(child, n.name, { value: xs[k], writable: true, enumerable: true, configurable: true });
          } else child[n.name] = xs[k];
          child.loop = loop;
          renderNodes(n.body, child, depth, out, C);
        }
        break;
      }
      case 'include': {
        const t = C.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (!renderInclude(n.name, t, scope, depth, out, C)) renderNodes(t, scope, depth + 1, out, C);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(s, C) {
  return s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDateCached(s.data.date, C),
      };
}

/** A post's card, as lists show it. Reading minutes and the tag records are computed once per source. */
function cardOf(s, C) {
  if (s._card === undefined) {
    s._card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDateCached(s.data.date, C),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  return s._card;
}

/** A page as its layout reads it. */
function pageOf(s, C) {
  return {
    ...cardOf(s, C),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, C),
    older: linkOf(s.older ?? null, C),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(t, cards, C) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const C = {
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    report: [],
    broken: new Set(),
    bySource: new Map(),
    staticPaths: new Set(),
    slugCache: new Map(),
    dateCache: new Map(),
    linkCache: new Map(),
    freeMemo: new Map(),
    freeCut: 0,
    includePlan: new Map(),
    globalCache: new Map(),
    elemCache: new Map(),
  };

  // Templates, parsed in code-unit order of their names. One that does not parse is reported and left out.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      C.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      C.report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  C.staticPaths = new Set(statics.map((f) => f.path));

  // Each source's front matter: a refused source is reported and dropped, and so is a draft.
  // The checks run in the reference's order, and the first one that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      C.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      C.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      C.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!C.templates.has(layout)) {
      C.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      C.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) {
      t = { set: new Set(dir === '' ? RESERVED : []), next: new Map() };
      taken.set(dir, t);
    }
    return t;
  };
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugifyCached(s.data.title, C), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${C.base}/${s.outDir}/`;
    C.bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved to the pages and static files they name.
  for (const s of sources) {
    const env = { dir: dirOf(s.path), path: s.path, C };
    const md = renderMarkdown(s.body, env, C);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by their slug, each named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugifyCached(name, C);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugifyCached(name, C);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${C.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugifyCached(name, C);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p, C)]));
  const site = { title: input.site.title, base_url: C.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = C.templates.get(name);
    if (nodes === undefined) return null;
    const rootVars = Object.create(null);
    rootVars.site = site;
    rootVars.tags = allTags;
    rootVars.recent = recent;
    for (const k of Object.keys(vars)) rootVars[k] = vars[k];
    const parts = [];
    renderNodes(nodes, rootVars, 0, parts, C);
    return parts.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, C) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${C.base}/` : `${C.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t, cards, C) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) C.report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...C.report, ...C.broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
