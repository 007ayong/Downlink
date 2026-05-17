const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeHttpFilename,
  filenameFromCD,
  filenameFromUrl,
  ensureFilenameExtension,
  pickDisplayFilename,
  fallbackMediaFilename,
  mediaKindOf,
} = require('../filename-logic.js');

test('decodes RFC 2047 Chinese filenames', () => {
  assert.equal(
    decodeHttpFilename('=?UTF-8?B?5Lit5paH5rWL6K+VLm1wNA==?='),
    '中文测试.mp4'
  );
});

test('decodes percent-encoded Chinese filenames', () => {
  assert.equal(
    decodeHttpFilename('%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.mp4'),
    '中文 空格.mp4'
  );
});

test('preserves plus signs while decoding percent-encoded filenames', () => {
  assert.equal(decodeHttpFilename('C++%20Primer.pdf'), 'C++ Primer.pdf');
  assert.equal(filenameFromUrl('https://example.com/files/C++%20Primer.pdf?token=1'), 'C++ Primer.pdf');
});

test('does not infer filenames from query parameters', () => {
  assert.equal(filenameFromUrl('https://example.com/download?filename=C++%20Primer.pdf'), 'download');
});

test('extracts UTF-8 filename* from content-disposition', () => {
  assert.equal(
    filenameFromCD("attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%B5%8B%E8%AF%95.mp4"),
    '中文测试.mp4'
  );
});

test('preserves plus signs in content-disposition filenames', () => {
  assert.equal(
    filenameFromCD("attachment; filename*=UTF-8''C++%20Primer.pdf"),
    'C++ Primer.pdf'
  );
  assert.equal(
    filenameFromCD('attachment; filename="C++%20Primer.pdf"'),
    'C++ Primer.pdf'
  );
});

test('extracts basic quoted Chinese filename from content-disposition', () => {
  assert.equal(
    filenameFromCD('attachment; filename="%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.mp4"'),
    '中文 空格.mp4'
  );
});

test('extracts Chinese filename from URL path', () => {
  assert.equal(
    filenameFromUrl('https://example.com/files/%E4%B8%AD%E6%96%87%E8%A7%86%E9%A2%91.mp4?token=1'),
    '中文视频.mp4'
  );
});

test('appends extension for Chinese filename when missing', () => {
  assert.equal(
    ensureFilenameExtension('中文测试', 'https://example.com/video', 'video/mp4'),
    '中文测试.mp4'
  );
});

test('prefers explicit Chinese media filename over generic placeholders', () => {
  assert.equal(
    pickDisplayFilename({
      filename: 'video',
      resourceUrl: 'https://cdn.example.com/%E4%B8%AD%E6%96%87%E5%90%8D.mp4',
      pageTitle: '播放页',
      kind: 'video',
    }),
    '中文名.mp4'
  );
});

test('falls back to page title and inferred extension when media filename is low quality', () => {
  assert.equal(
    fallbackMediaFilename({
      filename: 'media',
      resourceUrl: 'https://cdn.example.com/stream',
      pageTitle: '中文专辑',
      kind: 'audio',
      mime: 'audio/mpeg',
    }),
    '中文专辑-audio.mp3'
  );
});

test('detects media kind from Chinese filenames and mime', () => {
  assert.equal(mediaKindOf('https://example.com/%E4%B8%AD%E6%96%87.mp4', ''), 'video');
  assert.equal(mediaKindOf('https://example.com/stream', 'audio/mpeg'), 'audio');
});
