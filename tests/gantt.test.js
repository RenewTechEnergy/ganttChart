import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('scaffold smoke test', () => {
  it('npm test runs', () => {
    assert.equal(1 + 1, 2);
  });
});
