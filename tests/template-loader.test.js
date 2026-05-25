import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'index.html');

describe('template loader bug fix — scheduler.js inlined into index.html', () => {
  const html = readFileSync(HTML_PATH, 'utf8');

  it("does not load scheduler via <script type='module'>", () => {
    assert.equal(
      html.includes("import * as Scheduler from './scripts/scheduler.js'"),
      false,
      "scheduler.js should be inlined, not imported as a module (breaks under file://)"
    );
  });

  it('exposes window.Scheduler with a schedule function (inline assignment present)', () => {
    // The inline IIFE wires window.Scheduler = { schedule, ... }.
    assert.match(html, /window\.Scheduler\s*=\s*\{[\s\S]*?schedule\b/);
  });

  it('inlines the schedule() function body', () => {
    assert.match(html, /function schedule\(tasks,\s*projectStart/);
  });

  it('inlines the parsePredecessor function (sanity that more than just `schedule` was inlined)', () => {
    assert.match(html, /function parsePredecessor\(s\)/);
  });
});
