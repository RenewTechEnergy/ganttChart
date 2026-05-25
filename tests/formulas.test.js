import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure-function copies that mirror the production formulas (kept DOM-free).
const num = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };

function computeVariance(quoted, actual, committed) {
  // Empty when ALL three are missing (display "—" in UI).
  if (quoted === '' && actual === '' && committed === '') return '';
  return (num(quoted) - num(actual) - num(committed)).toFixed(2);
}

function computeProjectMargin(sale, rawCost) {
  if (sale === '' && rawCost === '') return '';
  return (num(sale) - num(rawCost)).toFixed(2);
}

function computeFinalMargin(sale, actual, committed, allSubtasksDone) {
  if (!allSubtasksDone) return '';
  if (sale === '' && actual === '' && committed === '') return '';
  return (num(sale) - num(actual) - num(committed)).toFixed(2);
}

describe('computeVariance', () => {
  it('matches the spec example: 80000 - 64000 - 19999 = -3999', () => {
    assert.equal(computeVariance(80000, 64000, 19999), '-3999.00');
  });

  it('returns 0 when quoted matches actual + committed exactly', () => {
    assert.equal(computeVariance(10000, 5000, 5000), '0.00');
  });

  it("returns '' when all three are empty strings", () => {
    assert.equal(computeVariance('', '', ''), '');
  });

  it('treats missing fields as 0, not NaN', () => {
    assert.equal(computeVariance(10000, '', ''), '10000.00');
  });
});

describe('computeProjectMargin', () => {
  it('matches the spec: 100000 - 75000 = 25000', () => {
    assert.equal(computeProjectMargin(100000, 75000), '25000.00');
  });

  it("returns '' when both inputs are empty", () => {
    assert.equal(computeProjectMargin('', ''), '');
  });
});

describe('computeFinalMargin', () => {
  it('returns "" when not all subtasks are Done (still in-flight)', () => {
    assert.equal(computeFinalMargin(100000, 64000, 19999, false), '');
  });

  it('locks at sale - (actual + committed) when all done', () => {
    assert.equal(computeFinalMargin(100000, 64000, 19999, true), '16001.00');
  });
});
