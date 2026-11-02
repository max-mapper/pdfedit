// The segment link template (?seglink=): what is accepted, what is refused, and the id put in URL-encoded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segLinkFor, segLinkTemplate } from './seglink.ts';

const FRAME = 'https://host.example/editor/index.html?doc=d1&api=/api/d1';

test('a path or a same-origin URL holding {seg} is taken as given; none is null', () => {
  assert.deepEqual(segLinkTemplate(null, FRAME), { template: null });
  assert.deepEqual(segLinkTemplate('', FRAME), { template: null });
  assert.deepEqual(segLinkTemplate('/segments/view?seg={seg}', FRAME), { template: '/segments/view?seg={seg}' });
  assert.deepEqual(segLinkTemplate('https://host.example/s/{seg}/open', FRAME), { template: 'https://host.example/s/{seg}/open' });
});

test('other origins, protocol-relative paths, relative paths, script URLs and templates without {seg} are refused', () => {
  for (const bad of ['https://other.example/s/{seg}', '//other.example/s/{seg}', '/\\other.example/s/{seg}', 's/{seg}',
    'javascript:alert({seg})', '/segments/view', 'http://host.example/s/{seg}']) {
    assert.ok('error' in segLinkTemplate(bad, FRAME), bad);
  }
});

test('every {seg} is replaced by the URL-encoded id', () => {
  assert.equal(segLinkFor('/s/{seg}?again={seg}', 'a b/c&d'), '/s/a%20b%2Fc%26d?again=a%20b%2Fc%26d');
  assert.equal(segLinkFor('/s?seg={seg}', '42'), '/s?seg=42');
});
