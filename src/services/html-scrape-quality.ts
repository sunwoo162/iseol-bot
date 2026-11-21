// Fail-closed HTML decoding and quality diagnostics for public page collectors.
// The checker reports suspicious content; it never silently "repairs" fields.
const MAX_HTML_BYTES = 2_000_000;
const normalizeEncoding = (value: unknown): 'utf-8' | 'euc-kr' | null => {
  const name=String(value??'').trim().toLowerCase().replaceAll('_','-');
  if(['utf-8','utf8'].includes(name))return 'utf-8';
  if(['euc-kr','euckr','ks-c-5601-1987','ks-c-5601','ks-c-5601-1989','windows-949','cp949','x-windows-949'].includes(name))return 'euc-kr';
  return null;
};
function report(code: string,context: string,details=''): Error & {code:string}{
  return Object.assign(new Error('HTML_QUALITY:'+code+' ['+context+'] '+details),{code:'HTML_QUALITY_'+code});
}
function contentText(html: string): string{
  return html.replace(/<script\b[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/&(?:amp|nbsp|lt|gt|quot);/gi,' ')
    .replace(/\s+/g,' ').trim();
}
/** Conservative checks: corrupted bytes, replacement characters, block pages and non-HTML. */
export function inspectScrapedHtml(html: unknown,{context='public-page',minText=3}: {context?:string;minText?:number}={}){
  if(typeof html!=='string'||!/<(?:html|head|body|title|a|div|main|article|section|h1|h2|p|table|ul)\b/i.test(html))
    throw report('NOT_HTML',context,'No recognizable HTML structure');
  const head=html.slice(0,20_000), title=(head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]??'').replace(/<[^>]*>/g,' ').trim();
  if(/(?:access denied|just a moment|captcha|robot check|보안\s*확인|비정상적인\s*접근)/i.test(title))
    throw report('BLOCK_PAGE',context,'Protection/login challenge detected in title');
  const text=contentText(html);
  if(text.length<minText)throw report('EMPTY_CONTENT',context,'Extracted visible text is empty');
  const replacement=(text.match(/\uFFFD/g)||[]).length;
  const mojibake=(text.match(/(?:Ã[\u0080-\u00bf]|Â[\u0080-\u00bf]|[ìëê][\u0080-\u00bf])/g)||[]).length;
  const controls=(text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g)||[]).length;
  if(replacement>0||mojibake>=2||controls>0||text.includes('占쏙옙'))
    throw report('MOJIBAKE',context,'replacement='+replacement+', suspicious='+mojibake+', controls='+controls);
  return {ok:true,visibleTextLength:text.length,replacement,mojibake,title:title.slice(0,160)};
}
export async function decodeScrapedHtml(response: Response,{context='public-page',maxBytes=MAX_HTML_BYTES}: {context?:string;maxBytes?:number}={}){
  if(!response.ok)throw report('HTTP',context,'HTTP '+response.status);
  const type=response.headers?.get('content-type')??'';
  if(type&&!/(?:text\/html|application\/xhtml\+xml)/i.test(type))
    throw report('CONTENT_TYPE',context,'Unexpected content type');
  const declaredSize=Number(response.headers?.get('content-length')??0);
  if(declaredSize>maxBytes)throw report('TOO_LARGE',context,'Declared HTML response too large');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(!bytes.length||bytes.length>maxBytes)throw report('TOO_LARGE',context,'HTML body missing or over limit');
  const ascii=new TextDecoder('latin1').decode(bytes.subarray(0,4096));
  const declared=type.match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1];
  const meta=ascii.match(/<meta\b[^>]*charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]??
    ascii.match(/<meta\b[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i)?.[1];
  const candidates=[...(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf?['utf-8']:[]),
    normalizeEncoding(declared),normalizeEncoding(meta),'utf-8','euc-kr'].filter(Boolean);
  const errors: string[]=[];
  for(const encoding of new Set(candidates)){
    try{
      const html=new TextDecoder(encoding,{fatal:true}).decode(bytes);
      const quality=inspectScrapedHtml(html,{context});
      return {html,encoding,quality,reportedCharset:declared??meta??null};
    }catch(error){errors.push(encoding+':'+(error instanceof Error?error.message:String(error)).slice(0,140));}
  }
  throw report('UNREADABLE',context,errors.join(' | ').slice(0,420));
}
