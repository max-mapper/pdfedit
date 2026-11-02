// Paragraph-to-segment links: the source hash (against node:crypto), links from the matcher, verification of stored
// links against a detection (a changed source, a missing box), and the blob's validation. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeLinks, LinksError, parseLinks, sha256Hex, srcSha, verifyLinks, type Slot } from './links.ts';
import { normalise } from './match.ts';

const nodeSha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('sha256Hex is SHA-256 of the UTF-8 bytes, at every padding length', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(63), 'd'.repeat(64), 'e'.repeat(119), '見出しの文。'.repeat(17), '𠮷野家 😀']) {
    assert.equal(sha256Hex(s), nodeSha(s), JSON.stringify(s.slice(0, 20)));
  }
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the source hash is of the normalised text: spacing and full-width forms do not change it', () => {
  assert.equal(srcSha('第３四半期の 売上高'), srcSha('第3四半期の売上高'));
  assert.equal(srcSha('見出し'), nodeSha(normalise('見出し')));
  assert.notEqual(srcSha('見出し'), srcSha('別の見出し'));
});

const slot = (box: string, para: number, text: string, seg_ids: string[] | null): Slot => ({ box, para, text, src_sha: srcSha(text), seg_ids });

test('links from the matcher: every slot that matched, with its ids and hash', () => {
  const slots = [slot('b0', 0, '見出し', ['g1']), slot('b1', 0, '一文目。二文目。', ['g2', 'g3']), slot('b2', 0, '対応なし', null)];
  assert.deepEqual(computeLinks(3, slots), [
    { page: 3, box: 'b0', para: 0, seg_ids: ['g1'], src_sha: srcSha('見出し') },
    { page: 3, box: 'b1', para: 0, seg_ids: ['g2', 'g3'], src_sha: srcSha('一文目。二文目。') },
  ]);
});

test('stored links verified: the same source holds, another text is source_changed, no box is box_missing', () => {
  const stored = computeLinks(0, [slot('b0', 0, '見出し', ['g1']), slot('b1', 0, '本文', ['g2']), slot('b9', 0, '消えた箱', ['g3']), slot('b1', 1, '二段落目', ['g4'])]);
  const now = [slot('b0', 0, '見出し', null), slot('b1', 0, '書き換えられた本文', null)];
  const v = verifyLinks(stored, now, ['b0', 'b1']);
  assert.deepEqual(v.map((l) => [l.box, l.para, l.ok, l.why_not]), [['b0', 0, true, null], ['b1', 0, false, 'source_changed'], ['b9', 0, false, 'box_missing'], ['b1', 1, false, 'source_changed']]);
});

test('a links blob is checked', () => {
  const ok = parseLinks({ links_version: 1, engine: 'e1', links: [{ page: 0, box: 'b0', para: 0, seg_ids: ['g1'], src_sha: 'x' }] });
  assert.equal(ok.links.length, 1);
  assert.equal(ok.engine, 'e1');
  assert.throws(() => parseLinks({ links_version: 2, links: [] }), LinksError);
  assert.throws(() => parseLinks({ links_version: 1, links: [{ page: 0, box: 'b0', para: 0, seg_ids: [], src_sha: 'x' }] }), LinksError);
  assert.throws(() => parseLinks({ links_version: 1, links: [{ page: -1, box: 'b0', para: 0, seg_ids: ['g'], src_sha: 'x' }] }), LinksError);
  assert.throws(() => parseLinks(null), LinksError);
});
