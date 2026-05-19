/*
 * Unit tests for the pure JavaScript helpers defined in ../index.html.
 *
 * The functions live inside a <script> block and reference browser globals,
 * so we can't import them directly. The implementations below are verbatim
 * copies — if you change one in index.html, mirror the change here.
 *
 * Run in a browser: open tests/test_index.html.
 * Run on the command line: node tests/test_index.js (requires Node 18+).
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────
 * Shared constants (mirrored from index.html)
 * ───────────────────────────────────────────────────────────────────────── */
const MS_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_MARGIN = 0.3;

/* ─────────────────────────────────────────────────────────────────────────
 * Functions under test — copies of the pure helpers in index.html.
 * Line numbers reference index.html at the time of writing.
 * ───────────────────────────────────────────────────────────────────────── */

// index.html:1230
function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// index.html:1453
function parsePreds(s) {
  if (!s) return [];
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

// index.html:1777
function clampPercent(v) {
  if (v === '' || v == null) return '';
  let n = parseFloat(v);
  if (isNaN(n)) return '';
  if (n < 0)   n = 0;
  if (n > 100) n = 100;
  return n;
}

// index.html:1787
function defaultSaleFromEst(est, margin = DEFAULT_MARGIN) {
  const e = parseFloat(est);
  if (isNaN(e) || e <= 0) return '';
  return +(e / (1 - margin)).toFixed(2);
}

// index.html:1880
function fmtMoney(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return '';
  if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return '$' + n.toFixed(0);
}

// index.html:1956
function typeFromId(id) {
  if (!id) return 'project';
  const parts = id.split('-');
  if (parts.length === 1) return 'project';
  if (parts.length === 2) return 'task';
  return 'subtask';
}

// index.html:1963
function parentOf(id) {
  if (!id) return null;
  const parts = id.split('-');
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('-');
}

// index.html:1970 — depends on a NODES array for uniqueness checks.
function makeNextId(NODES) {
  return function nextId(parentId) {
    if (!parentId) {
      let n = 1;
      while (NODES.some(x => x.id === 'P' + n)) n++;
      return 'P' + n;
    }
    const ptype = typeFromId(parentId);
    const prefix = ptype === 'project' ? '-T' : '-S';
    let n = 1;
    while (NODES.some(x => x.id === parentId + prefix + n)) n++;
    return parentId + prefix + n;
  };
}

// index.html:2031
function naturalCompare(a, b) {
  const ax = String(a || '').match(/(\d+|\D+)/g) || [];
  const bx = String(b || '').match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    if (ax[i] !== bx[i]) {
      const na = parseInt(ax[i]), nb = parseInt(bx[i]);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return ax[i].localeCompare(bx[i]);
    }
  }
  return ax.length - bx.length;
}

// index.html:3220
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// index.html:3221
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// index.html:3224
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// index.html:3611
function colLetter(idx) {
  let s = ''; idx += 1;
  while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

// index.html:3616
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// index.html:3619
function isoToExcelSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const base   = Date.UTC(1899, 11, 30);
  return Math.round((target - base) / MS_DAY);
}

// index.html:3627
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Tiny test runner — no dependencies.
 * ───────────────────────────────────────────────────────────────────────── */
const tests = [];
let currentSuite = '';
function describe(name, fn) { currentSuite = name; fn(); }
function it(name, fn) { tests.push({ suite: currentSuite, name, fn }); }

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'eq'}: expected ${e}, got ${a}`);
}
function ok(cond, label) {
  if (!cond) throw new Error(`${label || 'ok'}: expected truthy, got ${cond}`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Test cases
 * ───────────────────────────────────────────────────────────────────────── */

describe('cap1', () => {
  it('capitalizes the first letter', () => eq(cap1('hello'), 'Hello'));
  it('leaves already-capitalized strings alone', () => eq(cap1('Hello'), 'Hello'));
  it('returns empty string unchanged', () => eq(cap1(''), ''));
  it('returns null unchanged', () => eq(cap1(null), null));
  it('handles single-character strings', () => eq(cap1('a'), 'A'));
});

describe('parsePreds', () => {
  it('splits on comma', () => eq(parsePreds('a,b,c'), ['a', 'b', 'c']));
  it('splits on semicolon', () => eq(parsePreds('a;b;c'), ['a', 'b', 'c']));
  it('mixes comma and semicolon', () => eq(parsePreds('a, b; c'), ['a', 'b', 'c']));
  it('trims whitespace', () => eq(parsePreds('  a , b  '), ['a', 'b']));
  it('drops empty entries', () => eq(parsePreds('a,,b,'), ['a', 'b']));
  it('returns [] for empty input', () => eq(parsePreds(''), []));
  it('returns [] for null', () => eq(parsePreds(null), []));
});

describe('clampPercent', () => {
  it('passes valid values through', () => eq(clampPercent(50), 50));
  it('clamps below 0 to 0', () => eq(clampPercent(-25), 0));
  it('clamps above 100 to 100', () => eq(clampPercent(150), 100));
  it('parses numeric strings', () => eq(clampPercent('75'), 75));
  it('returns "" for empty string', () => eq(clampPercent(''), ''));
  it('returns "" for null', () => eq(clampPercent(null), ''));
  it('returns "" for undefined', () => eq(clampPercent(undefined), ''));
  it('returns "" for non-numeric strings', () => eq(clampPercent('abc'), ''));
  it('keeps boundary values', () => { eq(clampPercent(0), 0); eq(clampPercent(100), 100); });
});

describe('defaultSaleFromEst', () => {
  it('applies the default 30% margin', () => eq(defaultSaleFromEst(70), 100));
  it('honors an explicit margin', () => eq(defaultSaleFromEst(80, 0.2), 100));
  it('returns "" for zero', () => eq(defaultSaleFromEst(0), ''));
  it('returns "" for negative', () => eq(defaultSaleFromEst(-5), ''));
  it('returns "" for non-numeric', () => eq(defaultSaleFromEst('abc'), ''));
  it('rounds to 2 decimals', () => eq(defaultSaleFromEst(33.333), +(33.333 / 0.7).toFixed(2)));
});

describe('fmtMoney', () => {
  it('formats sub-$1K as dollars', () => eq(fmtMoney(500), '$500'));
  it('rounds sub-$1K to whole dollars', () => eq(fmtMoney(499.7), '$500'));
  it('formats $1K-$10K with one decimal', () => eq(fmtMoney(1500), '$1.5K'));
  it('formats $10K+ without decimal', () => eq(fmtMoney(15000), '$15K'));
  it('formats negative values', () => eq(fmtMoney(-2500), '$-2.5K'));
  it('returns "" for non-numeric', () => eq(fmtMoney('abc'), ''));
  it('returns "" for empty', () => eq(fmtMoney(''), ''));
});

describe('typeFromId', () => {
  it('classifies a project ID', () => eq(typeFromId('P1'), 'project'));
  it('classifies a task ID', () => eq(typeFromId('P1-T1'), 'task'));
  it('classifies a subtask ID', () => eq(typeFromId('P1-T1-S1'), 'subtask'));
  it('classifies deep IDs as subtask', () => eq(typeFromId('P1-T1-S1-X1'), 'subtask'));
  it('defaults to project for null/empty', () => { eq(typeFromId(null), 'project'); eq(typeFromId(''), 'project'); });
});

describe('parentOf', () => {
  it('returns null for a project', () => eq(parentOf('P1'), null));
  it('returns project for a task', () => eq(parentOf('P1-T1'), 'P1'));
  it('returns task for a subtask', () => eq(parentOf('P1-T1-S1'), 'P1-T1'));
  it('returns null for empty/null', () => { eq(parentOf(null), null); eq(parentOf(''), null); });
});

describe('nextId', () => {
  it('returns P1 when no projects exist', () => {
    const nextId = makeNextId([]);
    eq(nextId(null), 'P1');
  });
  it('skips used project IDs', () => {
    const nextId = makeNextId([{ id: 'P1' }, { id: 'P2' }]);
    eq(nextId(null), 'P3');
  });
  it('fills gaps in project IDs', () => {
    const nextId = makeNextId([{ id: 'P1' }, { id: 'P3' }]);
    eq(nextId(null), 'P2');
  });
  it('uses -T prefix under a project', () => {
    const nextId = makeNextId([{ id: 'P1' }]);
    eq(nextId('P1'), 'P1-T1');
  });
  it('uses -S prefix under a task', () => {
    const nextId = makeNextId([{ id: 'P1-T1' }]);
    eq(nextId('P1-T1'), 'P1-T1-S1');
  });
  it('skips used child IDs', () => {
    const nextId = makeNextId([{ id: 'P1-T1' }, { id: 'P1-T2' }]);
    eq(nextId('P1'), 'P1-T3');
  });
});

describe('naturalCompare', () => {
  it('sorts numerically within IDs (P2 before P10)', () => {
    const ids = ['P10', 'P2', 'P1'].sort(naturalCompare);
    eq(ids, ['P1', 'P2', 'P10']);
  });
  it('sorts hierarchical IDs correctly', () => {
    const ids = ['P1-T10', 'P1-T2', 'P1-T1'].sort(naturalCompare);
    eq(ids, ['P1-T1', 'P1-T2', 'P1-T10']);
  });
  it('returns 0 for equal values', () => eq(naturalCompare('P1', 'P1'), 0));
  it('handles null safely', () => { ok(naturalCompare(null, 'P1') !== undefined); });
  it('shorter string with same prefix sorts first', () => ok(naturalCompare('P1', 'P1-T1') < 0));
});

describe('addDays', () => {
  it('adds positive days', () => {
    const r = addDays(new Date('2024-01-01T00:00:00'), 5);
    eq(fmtDate(r), '2024-01-06');
  });
  it('subtracts with negative days', () => {
    const r = addDays(new Date('2024-01-10T00:00:00'), -3);
    eq(fmtDate(r), '2024-01-07');
  });
  it('crosses month boundaries', () => {
    const r = addDays(new Date('2024-01-30T00:00:00'), 5);
    eq(fmtDate(r), '2024-02-04');
  });
  it('crosses year boundaries', () => {
    const r = addDays(new Date('2024-12-30T00:00:00'), 5);
    eq(fmtDate(r), '2025-01-04');
  });
  it('does not mutate the input', () => {
    const d = new Date('2024-01-01T00:00:00');
    addDays(d, 5);
    eq(fmtDate(d), '2024-01-01');
  });
});

describe('fmtDate', () => {
  it('formats as YYYY-MM-DD', () => eq(fmtDate(new Date(2024, 0, 5)), '2024-01-05'));
  it('zero-pads single-digit month and day', () => eq(fmtDate(new Date(2024, 8, 9)), '2024-09-09'));
  it('handles double-digit components', () => eq(fmtDate(new Date(2024, 10, 25)), '2024-11-25'));
});

describe('esc (HTML escape)', () => {
  it('escapes ampersand', () => eq(esc('a & b'), 'a &amp; b'));
  it('escapes less-than', () => eq(esc('<div>'), '&lt;div&gt;'));
  it('escapes double quote', () => eq(esc('say "hi"'), 'say &quot;hi&quot;'));
  it('escapes single quote with &#39;', () => eq(esc("it's"), 'it&#39;s'));
  it('coerces null to empty string', () => eq(esc(null), ''));
  it('coerces undefined to empty string', () => eq(esc(undefined), ''));
  it('coerces numbers to strings', () => eq(esc(42), '42'));
  it('escapes ampersand before other entities (order matters)', () => eq(esc('&<'), '&amp;&lt;'));
});

describe('xmlEsc', () => {
  it('escapes single quote with &apos; (XML, not HTML)', () => eq(xmlEsc("it's"), 'it&apos;s'));
  it('escapes all five XML entities', () => eq(xmlEsc(`<a b="c">&'`), '&lt;a b=&quot;c&quot;&gt;&amp;&apos;'));
});

describe('colLetter', () => {
  it('0-indexed: 0 → A', () => eq(colLetter(0), 'A'));
  it('25 → Z', () => eq(colLetter(25), 'Z'));
  it('26 → AA', () => eq(colLetter(26), 'AA'));
  it('27 → AB', () => eq(colLetter(27), 'AB'));
  it('51 → AZ', () => eq(colLetter(51), 'AZ'));
  it('52 → BA', () => eq(colLetter(52), 'BA'));
  it('701 → ZZ', () => eq(colLetter(701), 'ZZ'));
  it('702 → AAA', () => eq(colLetter(702), 'AAA'));
});

describe('isoToExcelSerial', () => {
  // Excel's epoch is 1899-12-30 (the "1900 leap year bug" puts 1900-01-01 at serial 2).
  it('1900-01-01 → 2', () => eq(isoToExcelSerial('1900-01-01'), 2));
  it('2024-01-01 → 45292', () => eq(isoToExcelSerial('2024-01-01'), 45292));
  it('successive days differ by 1', () => {
    eq(isoToExcelSerial('2024-01-02') - isoToExcelSerial('2024-01-01'), 1);
  });
});

describe('crc32', () => {
  // Known CRC32 values (IEEE 802.3 polynomial, same as zip/gzip).
  it('empty input → 0', () => eq(crc32(new Uint8Array([])), 0));
  it('"123456789" → 0xCBF43926', () => {
    const bytes = new TextEncoder().encode('123456789');
    eq(crc32(bytes), 0xCBF43926);
  });
  it('"hello" → 0x3610A686', () => {
    const bytes = new TextEncoder().encode('hello');
    eq(crc32(bytes), 0x3610A686);
  });
  it('"The quick brown fox jumps over the lazy dog" → 0x414FA339', () => {
    const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    eq(crc32(bytes), 0x414FA339);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Runner — works in both Node (stdout) and the browser (DOM + console).
 * ───────────────────────────────────────────────────────────────────────── */
function runTests() {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const out = isBrowser ? document.getElementById('out') : null;
  const write = (line, cls) => {
    if (isBrowser && out) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = line;
      out.appendChild(div);
    } else {
      console.log(line);
    }
  };

  let passed = 0, failed = 0;
  let lastSuite = '';
  for (const t of tests) {
    if (t.suite !== lastSuite) {
      write('');
      write(t.suite, 'suite');
      lastSuite = t.suite;
    }
    try {
      t.fn();
      write(`  ok   ${t.name}`, 'pass');
      passed++;
    } catch (e) {
      write(`  FAIL ${t.name}`, 'fail');
      write(`       ${e.message}`, 'fail');
      failed++;
    }
  }

  write('');
  write(`${passed} passed, ${failed} failed (of ${tests.length})`, failed ? 'fail' : 'pass');

  if (!isBrowser && typeof process !== 'undefined') {
    process.exit(failed === 0 ? 0 : 1);
  }
  return { passed, failed, total: tests.length };
}

if (typeof window === 'undefined') {
  runTests();
} else {
  // Browser: wait for DOMContentLoaded so #out exists.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runTests);
  } else {
    runTests();
  }
}
