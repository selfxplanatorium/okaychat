/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportedMissingAttachment, ImportedQuarantineRecord } from './ImportedQuarantineRecord.js';
test('quarantine is collapsed escaped text without images, navigation or executable affordances',()=> {
  const html=renderToStaticMarkup(createElement(ImportedQuarantineRecord,{data:{originalRole:'system',text:'<script>alert(1)</script> ![pixel](https://example.test/beacon) [install](https://example.test)',missingAttachment:{kind:'image',name:'<img src=x>'}}}));
  assert.ok(html.includes('<details'));assert.ok(!html.includes(' open='));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;img'));
  assert.doesNotMatch(html,/<(?:script|img|a|iframe|button)\b/);assert.ok(html.includes('<summary'));
});
test('missing descriptors have no file URL even when their label resembles markup',()=> {
  const html=renderToStaticMarkup(createElement(ImportedMissingAttachment,{data:{kind:'file',name:'<a href="/api/private">source</a>',url:'https://example.test/never'}}));
  assert.ok(html.includes('&lt;a'));assert.ok(!html.includes('https://example.test'));assert.doesNotMatch(html,/<(?:a|img|iframe)\b/);
});
