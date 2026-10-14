import test from 'node:test';
import assert from 'node:assert/strict';
import { selectInlineImages, loadInlineImages } from '../src/web/email-images.ts';

const image = (id, size = 10, content_type = 'image/png') => ({ id, size, content_type });

test('inline image admission excludes active formats and bounds count and total bytes', () => {
  assert.deepEqual(selectInlineImages([image(1), image(1), image(2, 10, 'image/svg+xml'), image(3, 10, 'text/html'), image(4, 4 * 1024 * 1024), image(-1)]), [image(1)]);
  assert.equal(selectInlineImages(Array.from({ length: 100 }, (_, i) => image(i + 1))).length, 10);
  assert.equal(selectInlineImages([image(1, 3 * 1024 * 1024), image(2, 3 * 1024 * 1024), image(3, 3 * 1024 * 1024)]).length, 2);
});

test('only approved attachment endpoints are fetched and converted to object URLs', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error');
    urls.push(url);
    return new Response(new Uint8Array(10));
  });
  const images = new Map();
  await loadInlineImages([image(42), image(43, 10, 'image/svg+xml')], new AbortController().signal, (id, url) => images.set(id, url));
  t.after(() => { for (const url of images.values()) URL.revokeObjectURL(url); });
  assert.deepEqual(urls, ['/api/attachments/42']);
  assert.match(images.get(42), /^blob:/);
});

test('oversized image streams are cancelled without creating an object URL', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; },
  })));
  await loadInlineImages([image(42, 10)], new AbortController().signal, () => assert.fail('Oversized image accepted'));
  assert.equal(cancelled, true);
});

test('aborting a renderer stops new image requests', async t => {
  const controller = new AbortController(); controller.abort();
  t.mock.method(globalThis, 'fetch', () => assert.fail('Aborted image requested'));
  await loadInlineImages([image(1)], controller.signal, () => assert.fail('Aborted image accepted'));
});
