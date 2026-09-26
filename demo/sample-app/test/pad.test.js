const test = require('node:test');
const assert = require('node:assert');
const status = require('..');

test('pads the label', () => {
  assert.strictEqual(status('ok', 0), '⠋         ok');
});
