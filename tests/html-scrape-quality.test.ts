import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeScrapedHtml} from '../src/services/html-scrape-quality.js';

const eucKorean=[60,104,116,109,108,62,60,104,101,97,100,62,60,109,101,116,97,32,99,104,97,114,115,101,116,61,34,101,117,99,45,107,114,34,62,60,116,105,116,108,101,62,176,248,184,240,192,252,60,47,116,105,116,108,101,62,60,47,104,101,97,100,62,60,98,111,100,121,62,187,245,32,176,248,184,240,192,252,32,190,200,179,187,60,47,98,111,100,121,62,60,47,104,116,109,108,62];
test('UTF-8 public HTML is decoded and checked',async()=>{
  const response=new Response('<html><head><title>AI 공모전</title></head><body>접수기간과 참가자격</body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
  const result=await decodeScrapedHtml(response,{context:'test-utf8'});
  assert.equal(result.encoding,'utf-8');
  assert.match(result.html,/AI 공모전/);
  assert.equal(result.quality.ok,true);
});
test('EUC-KR bytes decode correctly with meta charset, including header mismatch',async()=>{
  for(const header of ['text/html','text/html; charset=UTF-8']){
    const response=new Response(new Uint8Array(eucKorean),{headers:{'content-type':header}});
    const result=await decodeScrapedHtml(response,{context:'test-euckr'});
    assert.equal(result.encoding,'euc-kr');
    assert.match(result.html,/<title>공모전<\/title>/);
    assert.match(result.html,/새 공모전 안내/);
  }
});
test('replacement characters, silent mojibake, block title and wrong content type fail closed',async()=>{
  for(const html of [
    '<html><title>AI 공�전</title><body>본문</body></html>',
    '<html><title>Just a moment...</title><body>Verifying browser</body></html>',
    '<html><title>공모전</title><body>ê²°ê³¼ ë°í</body></html>',
    '<html><title>안내</title><body>占쏙옙</body></html>',
  ])await assert.rejects(decodeScrapedHtml(new Response(html,{headers:{'content-type':'text/html'}}),{context:'bad-html'}),/HTML_QUALITY:/);
  await assert.rejects(decodeScrapedHtml(new Response('{"error":"blocked"}',{headers:{'content-type':'application/json'}})),/CONTENT_TYPE/);
  await assert.rejects(decodeScrapedHtml(new Response('<html></html>',{headers:{'content-type':'text/html'}})),/EMPTY_CONTENT/);
});
test('HTTP errors and oversized responses do not pass quality gates',async()=>{
  await assert.rejects(decodeScrapedHtml(new Response('blocked',{status:429})),/HTTP 429/);
  await assert.rejects(decodeScrapedHtml(new Response('<html><body>ok</body></html>',{headers:{'content-type':'text/html','content-length':'2000001'}})),/TOO_LARGE/);
});