// Regression test for failureReasons.js — ensures all known swat
// failure_reason enum identifiers are mapped in the centralised dictionary.
// Run with: node --test static/failureReasons.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load failureReasons.js into this context (it uses plain globals, not ESM)
const src = fs.readFileSync(path.join(__dirname, 'failureReasons.js'), 'utf8');
const fn = new Function(src + '\nreturn { FAILURE_REASONS, FAILURE_BUCKETS, getFailureBucket };');
const { FAILURE_REASONS, FAILURE_BUCKETS, getFailureBucket } = fn();

// The 8 canonical failure_reason identifiers from swat/commander/operation.
const KNOWN_ENUMS = [
  'cancelled_by_user',
  'process_exited_without_completion',
  'classify_spawn_failed',
  'classify_no_squad',
  'classify_squad_not_installed',
  'classify_move_failed',
  'provision_failed',
  'launch_failed',
];

describe('failureReasons dictionary', () => {
  it('maps all 8 known failure_reason enums', () => {
    for (const k of KNOWN_ENUMS) {
      assert.ok(FAILURE_REASONS[k], `missing mapping for ${k}`);
    }
  });

  it('every mapped entry has required fields', () => {
    for (const [key, entry] of Object.entries(FAILURE_REASONS)) {
      assert.ok(entry.bucket, `${key}: missing bucket`);
      assert.ok(entry.label, `${key}: missing label`);
      assert.ok(entry.hint, `${key}: missing hint`);
      assert.ok(FAILURE_BUCKETS[entry.bucket], `${key}: bucket "${entry.bucket}" not in FAILURE_BUCKETS`);
    }
  });

  it('FAILURE_BUCKETS has all expected buckets', () => {
    for (const b of ['cancelled', 'crashed', 'setup', 'config']) {
      assert.ok(FAILURE_BUCKETS[b], `missing bucket: ${b}`);
      assert.ok(FAILURE_BUCKETS[b].label, `bucket ${b}: missing label`);
      assert.ok(FAILURE_BUCKETS[b].dotClass, `bucket ${b}: missing dotClass`);
    }
  });

  it('getFailureBucket resolves known reasons', () => {
    const result = getFailureBucket('cancelled_by_user');
    assert.ok(result);
    assert.equal(result.dotClass, 'cancelled');
  });

  it('getFailureBucket returns null for unknown reasons', () => {
    assert.equal(getFailureBucket('unknown_reason'), null);
  });
});
