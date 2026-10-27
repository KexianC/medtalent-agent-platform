import {XMLValidator} from "fast-xml-parser";

export const LARGE_DOCX_XML_BYTES = 8 * 1024 * 1024;
const WORD = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const MAX_XML_DEPTH = 256;
const MAX_XML_TAG = 256 * 1024;
export class DocxTextError extends Error {
  constructor(message, code = "INVALID_DOCX", statusCode = 400) { super(message); this.code = code; this.statusCode = statusCode; }
}
const invalid = () => { throw new DocxTextError("DOCX 正文XML结构无效，请重新导出文件。"); };
const complex = () => { throw new DocxTextError("DOCX 正文XML结构过于复杂，请拆分后上传。", "DOCUMENT_TOO_COMPLEX", 413); };
function xmlText(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);)/i.test(value)) invalid();
  return value.replace(/&([^;\s<&]{1,32});/g, (_match, entity) => {
    const common = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
    if (Object.prototype.hasOwnProperty.call(common,entity)) return common[entity];
    if (!/^#(?:x[0-9a-f]+|\d+)$/i.test(entity)) invalid();
    const point = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2),16) : Number.parseInt(entity.slice(1),10);
    if (![9,10,13].includes(point) && !(point>=0x20&&point<=0xd7ff) && !(point>=0xe000&&point<=0xfffd) && !(point>=0x10000&&point<=0x10ffff)) invalid();
    return String.fromCodePoint(point);
  });
}
function decodeXml(buffer) {
  try {
    if (buffer[0]===0xff&&buffer[1]===0xfe) return new TextDecoder("utf-16le",{fatal:true}).decode(buffer);
    if (buffer[0]===0xfe&&buffer[1]===0xff) return new TextDecoder("utf-16be",{fatal:true}).decode(buffer);
    return new TextDecoder("utf-8",{fatal:true}).decode(buffer);
  } catch { invalid(); }
}
/** Linear, bounded text-only OOXML extraction. It builds no XML DOM and never opens relationships or external resources. */
export function extractLargeDocxText(buffer, {maxCharacters=5_000_000}={}) {
  const xml=decodeXml(buffer);
  // No DTD or user-defined entities. Validation is a non-DOM pass over the already size-limited member.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml,{allowBooleanAttributes:false})!==true) invalid();
  const output=[],stack=[];
  let length=0,cursor=0;
  const append=value=>{length+=value.length;if(length>maxCharacters)throw new DocxTextError("提取的文本超过 500 万字符，请拆分文档。","DOCUMENT_TOO_COMPLEX",413);if(value)output.push(value);};
  while(cursor<xml.length){
    if(xml[cursor]!=="<"){
      let end=xml.indexOf("<",cursor);if(end<0)end=xml.length;
      const current=stack.at(-1);
      if(current?.isText&&!current.hidden)append(xmlText(xml.slice(cursor,end)));
      cursor=end;continue;
    }
    if(xml.startsWith("<!--",cursor)){const end=xml.indexOf("-->",cursor+4);if(end<0)invalid();cursor=end+3;continue;}
    if(xml.startsWith("<?",cursor)){const end=xml.indexOf("?>",cursor+2);if(end<0)invalid();cursor=end+2;continue;}
    if(xml.startsWith("<![CDATA[",cursor)){const end=xml.indexOf("]]>",cursor+9);if(end<0)invalid();const current=stack.at(-1);if(current?.isText&&!current.hidden)append(xml.slice(cursor+9,end));cursor=end+3;continue;}
    let end=cursor+1,quote=null;
    for(;end<xml.length;end++){
      const c=xml[end];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c===">")break;
      if(end-cursor>MAX_XML_TAG)complex();
    }
    if(end>=xml.length)invalid();
    const tag=xml.slice(cursor+1,end),closing=tag[0]==="/",selfClosing=/\/\s*$/.test(tag);
    const body=closing?tag.slice(1).trim():tag.trim();
    const match=/^([A-Za-z_][\w.:-]*)(?:\s|\/|$)/.exec(body);if(!match)invalid();
    const name=match[1];
    if(closing){
      const current=stack.pop();if(!current||current.name!==name)invalid();
      if(current.isWord&&!current.hidden){if(current.local==="p")append("\n\n");else if(current.local==="tc")append("\t");}
    }else{
      const parent=stack.at(-1);let namespaces=parent?.namespaces||Object.create(null);
      const definitions=[...body.matchAll(/\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
      if(definitions.length){namespaces=Object.assign(Object.create(null),namespaces);for(const definition of definitions)namespaces[definition[1]||""]=xmlText(definition[2]??definition[3]);}
      const separator=name.indexOf(":"),prefix=separator<0?"":name.slice(0,separator),local=separator<0?name:name.slice(separator+1),namespace=namespaces[prefix],isWord=WORD.has(namespace);
      const hidden=!!parent?.hidden||(isWord&&["del","moveFrom"].includes(local))||(namespace===MC&&local==="Fallback");
      const current={name,local,isWord,isText:isWord&&local==="t",hidden,namespaces};
      if(!hidden&&isWord&&["tab","br","cr"].includes(local))append(local==="tab"?"\t":"\n");
      if(!selfClosing){stack.push(current);if(stack.length>MAX_XML_DEPTH)complex();}
    }
    cursor=end+1;
  }
  if(stack.length)invalid();
  return output.join("");
}
