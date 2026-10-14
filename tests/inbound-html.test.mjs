import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/worker/email/receive.ts';

test('HTML fallback keeps readable content and excludes style and script bodies', () => {
  assert.equal(htmlToText('<p>Hello&nbsp;team</p><STYLE type="text/css">.x { color:red }</STYLE><script>ignore()</script><div>&lt;next&gt; &amp; last</div>'), 'Hello team <next> & last');
  assert.equal(htmlToText('Text with an unmatched <'), 'Text with an unmatched <');
  assert.equal(htmlToText('Before<style>unclosed style'), 'Before');
});

test('repeated unclosed HTML blocks do not rescan every suffix', t => {
  const input = 'Readable text' + '<style>'.repeat(32_000);
  let scans = 0;
  const exec = RegExp.prototype.exec;
  t.mock.method(RegExp.prototype, 'exec', function (text) {
    if (text === input) scans++;
    return exec.call(this, text);
  });
  assert.equal(htmlToText(input), 'Readable text');
  assert.ok(scans <= 2, `Scanned the remaining HTML ${scans} times`);
});
