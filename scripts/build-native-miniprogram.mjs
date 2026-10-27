import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { deflateSync, inflateSync, crc32, constants as zlibConstants } from 'node:zlib';
import { build, transform } from 'esbuild';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from '@phosphor-icons/react';
import { Heart as GuidanceHeart, ClipboardList as GuidanceClipboard, RotateCcw as GuidanceRepeat, ArrowRight as GuidanceArrow, ChevronUp as GuidanceChevronUp, ChevronDown as GuidanceChevronDown, X as GuidanceX, ArrowLeft as GuidanceBack, Trash2 as WellnessHistoryTrash, Check as WellnessCheck, Sparkles as WellnessSparkles } from 'lucide-react';
import { spring, calcGeneratorDuration, getDefaultTransition } from 'motion-dom';
import { doctorExperiences } from '../src/data/doctorExperience.ts';
import { doctorTopics } from '../src/lib/doctorTopics.ts';
import { createNativeLoader } from './native-module-loader.mjs';
import { TANG_MOODS } from '../src/features/tang/guidanceModel.ts';
import { guidanceMoodGlyphSvg } from './native-guidance-mood-glyphs.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceNative=path.join(root,'wechat-native');
const outIndex=process.argv.indexOf('--outDir');
const requestedOutput=outIndex>=0?process.argv[outIndex+1]:process.env.NATIVE_OUTPUT_DIR;
if(outIndex>=0&&!requestedOutput)throw new Error('--outDir requires an absolute path');
if(requestedOutput&&!path.isAbsolute(requestedOutput))throw new Error('Native output directory must be absolute');
const native=requestedOutput?path.resolve(requestedOutput):sourceNative;
if(path.resolve(native)!==path.resolve(sourceNative)){
 if(path.resolve(sourceNative).startsWith(native+path.sep)||native.startsWith(path.resolve(sourceNative)+path.sep))throw new Error('Native candidate must not overlap source directory');
 let existing;try{existing=await fs.readdir(native);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing?.length)throw new Error('Native candidate output must be empty');
 await fs.mkdir(native,{recursive:true});
 await fs.cp(sourceNative,native,{recursive:true,filter:source=>!['project.private.config.json','build-manifest.json'].includes(path.basename(source))});
}
const {icon:nativeIcon}=createNativeLoader()(path.join(native,'utils/presentation.js'));
const bundles={
  'service-plans':['src/lib/servicePlans.ts'],
  catalog:['src/lib/builderRuntime.ts','src/data/doctorProfiles.ts','src/data/doctorExperience.ts','src/lib/doctorTopics.ts'],
  health:['src/lib/healthRecords.ts','src/lib/specialtyRecords.ts','src/lib/tangHealthRecords.ts'],
  wellness:['src/features/yuwen/types.ts','src/features/yuwen/assessmentModel.ts','src/features/yuwen/recordModel.ts','src/features/yuwen/stateModel.ts','src/features/yuwen/wellnessPractice.ts','src/features/yuwen/meditationCourses.ts'],
  guidance:['src/features/tang/guidanceModel.ts'],
  chat:['src/lib/chatDisclaimer.ts','src/lib/medicalText.ts','src/lib/doctorEntry.ts'],
};
await fs.mkdir(path.join(native,'utils/models'),{recursive:true});
for(const [name,inputs] of Object.entries(bundles)) {
  await build({stdin:{contents:inputs.map(p=>`export * from './${p}';`).join('\n'),resolveDir:root,sourcefile:`native-${name}.ts`,loader:'ts'},outfile:path.join(native,`utils/models/${name}.js`),bundle:true,format:'cjs',platform:'browser',target:'es2018',charset:'utf8',minifyWhitespace:true,minifySyntax:true,minifyIdentifiers:true,legalComments:'none'});
}
// This small bundle exposes only the same spring and easing math used by H5.
// It allows native step animations to retarget from their current value.
await build({stdin:{contents:"export {spring,calcGeneratorDuration} from 'motion-dom'; export {cubicBezier} from 'motion-utils';",resolveDir:root},outfile:path.join(native,'utils/models/motion.js'),bundle:true,format:'cjs',platform:'browser',target:'es2018',minify:true,legalComments:'none'});
// Browser globals are replaced only at the adapter boundary; CAS and deletion
// semantics are emitted directly from the same H5 sources on every build.
const sharedAdapters = [
  {input:'src/lib/consumerData.ts',output:'consumer-data.js',convert:source=>source.replace(/export const consumerDataStore = createConsumerDataStore\(\);?\s*$/, '').replace(/new AbortController\(\)/g,'new NativeAbortController()'),prefix:"const { NativeAbortController } = require('./cancel.js');\n"},
  {input:'src/lib/chatDisclaimer.ts',output:'chat-disclaimer.js'},
  {input:'src/lib/chatStream.ts',output:'speech-chunker.js',convert:source=>source.slice(source.indexOf('const speakableLength'))},
];
for (const adapter of sharedAdapters) {
  const source=await fs.readFile(path.join(root,adapter.input),'utf8');
  const text=adapter.convert?adapter.convert(source):source;
  const output=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}}).outputText;
  // Minify the generated CommonJS adapters without changing their exported API.
  const compact = await transform(output,{target:'es2019',minifyWhitespace:true,minifyIdentifiers:true,minifySyntax:true,legalComments:'none'});
  await fs.writeFile(path.join(native,'utils',adapter.output),`// Generated from ${adapter.input}; run npm run build:native.\n${adapter.prefix||''}${compact.code}`);
}
// Sample the installed H5 motion engine, using the actual sheet transitions.
// Native keyframes keep the same spring overshoot rather than using a new easing.
const doctorAppSource = await fs.readFile(path.join(root,'src/pages/DoctorApp.tsx'),'utf8');
function sheetSpec(name) {
  const source = doctorAppSource.slice(doctorAppSource.indexOf(`function ${name}(`));
  const distance = Number(source.match(/initial=\{\{ y: (\d+), opacity: 0 \}\}/)?.[1]);
  const transition = source.match(/transition=\{\{ type: "spring", damping: (\d+), stiffness: (\d+) \}\}/);
  if (!distance || !transition) throw new Error(`H5 sheet transition unavailable: ${name}`);
  return { distance, damping:Number(transition[1]), stiffness:Number(transition[2]) };
}
const sheetSpecs = [sheetSpec('FeatureSheet'),sheetSpec('TangHomeRecordSheet')];
const css = [];
let exitDuration = 300;
const frameCss = (name, from, to, spec, property) => {
  const options = {...spec,keyframes:[from,to]};
  const duration = calcGeneratorDuration(spring(options));
  const generator = spring(options), steps = Math.ceil(duration/16);
  const frames = Array.from({length:steps+1},(_,i)=> {
    const value = Number(generator.next(i*duration/steps).value.toFixed(3));
    return `${Number((i*100/steps).toFixed(3))}%{${property(value)}}`;
  }).join('');
  css.push(`@keyframes ${name}{${frames}}`);
  return duration;
};
for(const [index,spec] of sheetSpecs.entries()) {
  const enter = frameCss(`native-sheet-in-${index}`,spec.distance,0,spec,value=>`transform:translateY(${value}px)`);
  const leave = frameCss(`native-sheet-out-${index}`,0,spec.distance,spec,value=>`transform:translateY(${value}px)`);
  const opacityIn = frameCss(`native-sheet-opacity-in-${index}`,0,1,spec,value=>`opacity:${value}`);
  const opacityOut = frameCss(`native-sheet-opacity-out-${index}`,1,0,spec,value=>`opacity:${value}`);
  const prefix = index === 0 ? '' : '.sheet-distance-60';
  css.push(`${prefix}.sheet-enter{animation:native-sheet-in-${index} ${enter}ms linear both,native-sheet-opacity-in-${index} ${opacityIn}ms linear both}`);
  css.push(`${prefix}.sheet-exit{animation:native-sheet-out-${index} ${leave}ms linear both,native-sheet-opacity-out-${index} ${opacityOut}ms linear both;pointer-events:none}`);
  exitDuration = Math.max(exitDuration,leave,opacityOut);
}
css.push('@keyframes native-backdrop-in{from{opacity:0}to{opacity:1}}@keyframes native-backdrop-out{from{opacity:1}to{opacity:0}}.backdrop-enter{animation:native-backdrop-in 300ms cubic-bezier(0,0,.58,1) both}.backdrop-exit{animation:native-backdrop-out 300ms cubic-bezier(0,0,.58,1) both;pointer-events:none}');
// Read entry distances and explicit durations from the same H5 component. For
// implicit transitions, use this project's installed Motion defaults directly.
const fadeSpec = doctorAppSource.match(/const fadeUp[\s\S]*?initial: reduced \? false : \{ opacity: 0, y: (\d+) \}[\s\S]*?duration: reduced \? 0 : ([\d.]+)/);
const noticeSpec = doctorAppSource.match(/className="journey-notice" initial=\{\{ opacity: 0, y: (-?\d+) \}\}/);
const messageSpec = doctorAppSource.match(/key=\{message.id\} initial=\{\{ opacity: 0, y: (\d+) \}\}/);
const tabSource = doctorAppSource.slice(doctorAppSource.indexOf('<AnimatePresence mode="wait" initial={false}>'));
const tabInitial = tabSource.match(/initial=\{reduced \? false : \{ opacity: 0, x: (\d+) \}\}/);
const tabExit = tabSource.match(/exit=\{reduced \? undefined : \{ opacity: 0, x: (-?\d+) \}\}/);
const tabTime = tabSource.match(/transition=\{\{ duration: reduced \? 0 : ([\d.]+) \}\}/);
const fabSpec = doctorAppSource.match(/className="journey-add-record-fab"[\s\S]*?initial=\{\{ opacity: 0, scale: ([\d.]+) \}\}/);
if (![fadeSpec,noticeSpec,messageSpec,tabInitial,tabExit,tabTime,fabSpec].every(Boolean)) throw new Error('H5 entry motion contract changed; review native motion before packaging.');
const opacity = getDefaultTransition('opacity',{keyframes:[0,1]});
const opacityTime = opacity.duration*1000;
const opacityEase = `cubic-bezier(${opacity.ease.join(',')})`;
css.push('@keyframes native-entry-opacity{from{opacity:0}to{opacity:1}}@keyframes native-exit-opacity{from{opacity:1}to{opacity:0}}');
css.push(`@keyframes native-home-fade{from{opacity:0;transform:translateY(${fadeSpec[1]}px)}to{opacity:1;transform:translateY(0)}}.home-fade-up{animation:native-home-fade ${Number(fadeSpec[2])*1000}ms cubic-bezier(0,0,.58,1) backwards}`);
const defaultFrames = (name,key,from,to,property) => frameCss(name,from,to,getDefaultTransition(key,{keyframes:[from,to]}),property);
const noticeIn = defaultFrames('native-notice-in','y',Number(noticeSpec[1]),0,v=>`transform:translateY(${v}px)`);
const noticeOut = defaultFrames('native-notice-out','y',0,Number(noticeSpec[1]),v=>`transform:translateY(${v}px)`);
css.push(`.home-notice-enter{animation:native-notice-in ${noticeIn}ms linear both,native-entry-opacity ${opacityTime}ms ${opacityEase} both}.home-notice-exit{animation:native-notice-out ${noticeOut}ms linear both,native-exit-opacity ${opacityTime}ms ${opacityEase} both;pointer-events:none}`);
const messageIn = defaultFrames('native-message-in','y',Number(messageSpec[1]),0,v=>`transform:translateY(${v}px)`);
css.push(`.message-enter{animation:native-message-in ${messageIn}ms linear backwards,native-entry-opacity ${opacityTime}ms ${opacityEase} backwards}`);
const fabIn = defaultFrames('native-fab-in','scale',Number(fabSpec[1]),1,v=>`transform:scale(${v})`);
css.push(`.floating-enter{animation:native-fab-in ${fabIn}ms linear backwards,native-entry-opacity ${opacityTime}ms ${opacityEase} backwards}`);
const tabDuration = Number(tabTime[1])*1000;
css.push(`.tab-motion{opacity:1;transform:none;transition:opacity ${tabDuration}ms cubic-bezier(0,0,.58,1),transform ${tabDuration}ms cubic-bezier(0,0,.58,1)}.tab-initial{opacity:0;transform:translateX(${tabInitial[1]}px);transition:none}.tab-enter{opacity:1;transform:none}.tab-exit{opacity:0;transform:translateX(${tabExit[1]}px);pointer-events:none}.is-reduced-motion .tab-motion{transition:none}`);
await fs.writeFile(path.join(native,'utils/sheet-motion.wxss'),css.join('\n')+'\n');
await fs.writeFile(path.join(native,'utils/sheet-motion-config.js'),`// Generated from H5 transitions by build:native.\nmodule.exports = { exitDuration: ${exitDuration}, tabDuration: ${tabDuration}, motionDefaultDuration: ${opacityTime} };\n`);
await fs.writeFile(path.join(native,'utils/home-motion-config.js'),`// Generated from the installed H5 motion engine by build:native.\nmodule.exports = ${JSON.stringify({noticeExitDuration:Math.max(noticeOut,opacityTime),noticeDistance:Math.abs(Number(noticeSpec[1])),noticeSpring:getDefaultTransition('y',{keyframes:[Number(noticeSpec[1]),0]}),noticeOpacityDuration:opacityTime,noticeOpacityEase:opacity.ease})};\n`);
// Native wx.image uses packaged PNGs of the same H5 Phosphor artwork.
const map={baby:'Baby',drop:'Drop',ear:'Ear',wind:'Wind',plusCircle:'PlusCircle',firstAid:'FirstAidKit',women:'GenderFemale',brain:'Brain',search:'MagnifyingGlass',arrowRight:'ArrowRight',chevron:'CaretRight',shield:'ShieldCheck',bell:'BellSimple',chat:'ChatCircleDots',clipboard:'ClipboardText',calendar:'CalendarDots',clock:'ClockCounterClockwise',check:'CheckCircle',ruler:'Ruler',bone:'Bone',sparkle:'Sparkle',wave:'WaveSine',leaf:'Leaf',pulse:'Pulse',heart:'Heart',fork:'ForkKnife',run:'PersonSimpleRun',moon:'MoonStars',flower:'FlowerTulip',needle:'Needle',thermometer:'Thermometer',stethoscope:'Stethoscope',file:'FileText',headphones:'Headphones',chart:'ChartLineUp',book:'BookmarkSimple',close:'X',user:'UserCircle',home:'House',services:'SquaresFour',edit:'NotePencil',delete:'Trash',save:'FloppyDisk',mic:'Microphone',send:'PaperPlaneTilt',speaker:'SpeakerHigh',lock:'LockKey',back:'ArrowLeft',stop:'Stop',keyboard:'Keyboard',squares:'SquaresFour',copy:'Copy'};
Object.assign(map,{play:'Play',pause:'Pause',rotate:'ArrowClockwise',plus:'Plus',calendarCheck:'CalendarCheck',imageSquare:'ImageSquare'});
// squares and services are the same Phosphor SVG; presentation aliases them.
delete map.squares;
const tones={ink:'#31564f',muted:'#9ba8a4',white:'#ffffff',accent:'#2f8f65',hub:'#3287e8',hubMuted:'#6d8ba8',...Object.fromEntries(Object.entries(doctorExperiences).map(([slug,e])=>[`theme-${slug}`,e.theme.accentStrong]))};
// Resolve the directory's real topic aliases through the same native presenter.
// A new topic without known artwork must fail here, rather than ship a missing PNG.
const hubIcons=new Set(['shield','arrowRight','brain']);
for(const topic of doctorTopics) {
  const key=nativeIcon(topic.key,'hub').match(/^\/assets\/icons\/([a-zA-Z]+)-hub\.png$/)?.[1];
  if(!key||!map[key])throw new Error(`Directory topic has no native icon: ${topic.key}`);
  hubIcons.add(key);
}
// Keep every actual white control and completed-step icon. Unknown dynamic
// requests fail the build instead of silently losing artwork during pruning.
const wellnessRoleIcons=[
  ['wellness-clipboard-list',GuidanceClipboard,'#5c528b',66],
  ['wellness-repeat-strong',GuidanceRepeat,'#5c528b',48],
  ['wellness-repeat-white',GuidanceRepeat,'#ffffff',48],
  ['wellness-sparkles-strong',WellnessSparkles,'#5c528b',66],
  ['wellness-sparkles-white-16',WellnessSparkles,'#ffffff',48],
  ['wellness-sparkles-white-17',WellnessSparkles,'#ffffff',51],
  ['wind-wellness-regular',icons.WindIcon,'#5c528b',90,'regular'],
];
const wellnessWhiteAssets=new Set(wellnessRoleIcons.filter(([, ,color])=>color==='#ffffff').map(([key])=>key));
const whiteIcons=new Set();
function keepWhite(name) {
  const key=nativeIcon(name,'white').match(/^\/assets\/icons\/([a-zA-Z][\w-]*)-white\.png$/)?.[1];
  if(!key||(!map[key]&&!['book-fill','chat-fill','guidance-arrow'].includes(key)))throw new Error(`White control has no native icon: ${name}`);
  whiteIcons.add(key);
}
for(const filename of (await files(native)).filter(p=>/\.(?:js|wxml)$/.test(p))) {
  const source=await fs.readFile(path.join(native,filename),'utf8');
  for(const asset of source.matchAll(/\/assets\/icons\/([a-zA-Z][\w-]*-white(?:-\d+)?)\.png/g)) {
    if(wellnessWhiteAssets.has(asset[1]))continue;
    if(!asset[1].endsWith('-white'))throw new Error(`White control has no native icon: ${asset[1]}`);
    keepWhite(asset[1].slice(0,-6));
  }
  if(!filename.endsWith('.js'))continue;
  const tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  function visit(node) {
    if(ts.isStringLiteral(node)&&node.text==='white') {
      let call=node.parent;
      if(ts.isConditionalExpression(call))call=call.parent;
      if(!ts.isCallExpression(call)||call.expression.getText(tree)!=='icon'||call.arguments[1]!==node&&call.arguments[1]!==node.parent)throw new Error(`Unaudited white icon expression: ${filename}`);
      const name=call.arguments[0];
      if(ts.isStringLiteral(name))keepWhite(name.text);
      else if(filename==='components/home/index.js'&&name.getText(tree)==='step.icon'&&call.arguments[1].getText(tree)==="step.complete ? 'white' : tone") {
        if(!source.includes('const steps = isTang ? exp.steps.map(')||!source.includes(": config.fields.slice(0, 3).map(field => ({ icon: 'clipboard'"))throw new Error('Review home completed-step icon sources before pruning white assets');
        for(const step of doctorExperiences['tang-jinsong'].steps)keepWhite(step.icon);
        keepWhite('clipboard');
      } else if(ts.isIdentifier(name)) {
        let loop=call.parent;while(loop&&!ts.isForOfStatement(loop))loop=loop.parent;
        if(!loop||!ts.isArrayLiteralExpression(loop.expression)||!ts.isVariableDeclarationList(loop.initializer)||loop.initializer.declarations[0]?.name.getText(tree)!==name.text||!loop.expression.elements.every(ts.isStringLiteral))throw new Error(`Unaudited white icon loop: ${filename}`);
        for(const value of loop.expression.elements)keepWhite(value.text);
      } else throw new Error(`Unaudited white icon source: ${filename}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);
}
const iconDir=path.join(native,'assets/icons');await fs.mkdir(iconDir,{recursive:true});
// Search is currently requested only by the two directory controls. Inspect the
// generated catalog as well as handwritten JS/WXML before dropping other tones.
// A new ambiguous request keeps the complete tone family for human review.
function inspectSearchIconUse(sources,toneNames) {
  const keep=new Set(['hubMuted','hub-empty']),reasons=[];
  const preserveAll=reason=>{if(!reasons.includes(reason))reasons.push(reason);};
  const keepTone=(tone,filename)=>{
    if(toneNames.includes(tone)||tone==='hub-empty')keep.add(tone);
    else preserveAll(`${filename}: unknown search tone ${tone}`);
  };
  // These existing dynamic domains are bounded by literal icon names in native
  // configuration/shared catalogs, which are scanned below. A different call
  // expression cannot inherit that audit and therefore restores every tone.
  const dynamicDomains={
    'components/education/index.js':new Set(['serviceIcons[i%serviceIcons.length],tone']),
    'components/guidance/index.js':new Set(["name,'theme-tang-jinsong'"]),
    'components/health/index.js':new Set(["name,'theme-'+artworkSlug"]),
    'components/home/index.js':new Set(["section.icon,'accent'","feature.icon,'accent'",'exp.heroIcon,tone',"step.icon,step.complete?'white':tone",'concern.icon,tone','section.icon,tone','feature.icon,tone']),
    'components/wellness/index.js':new Set(["feature.icon,'theme-yu-wen'","name,'theme-yu-wen'","name,'white'"]),
    'pages/doctor/index.js':new Set(['k','t.activeIcon||t.icon,tone',"t.icon,'muted'",'k,tone']),
    'pages/index/index.js':new Set(["topic.key,'hub'"]),
  };
  const literal=node=>node&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node));
  for(const {filename,source}of sources) {
    if(filename.endsWith('.wxml')) {
      // Event names/confirm-type="search" are input semantics, not JS strings
      // or icon paths. Only image sources and bound search strings matter here.
      if(/\{\{[^}]*(['"`])search\1[^}]*\}\}/.test(source))preserveAll(`${filename}: bound search string`);
      for(const match of source.matchAll(/\bsrc\s*=\s*(["'])([\s\S]*?)\1/g)) {
        const value=match[2],asset=value.match(/^\/assets\/icons\/search-([\w-]+)\.png$/),unknownPath=value.replace(/\/assets\/icons\/[\w-]+\.png/g,'').includes('/assets/icons/');
        if(asset)keepTone(asset[1],filename);
        else if(value.includes('/assets/icons/search-')||unknownPath&&value.includes('{{')||/search/i.test(value)&&value.includes('{{')&&!/^\{\{\s*icons\.(?:search|emptySearch)\s*\}\}$/.test(value))preserveAll(`${filename}: unknown search image template`);
      }
      continue;
    }
    const tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    if(tree.parseDiagnostics.length)preserveAll(`${filename}: source parse diagnostics`);
    function visitSearch(node) {
      if(ts.isCallExpression(node)&&node.expression.getText(tree)==='icon'&&!literal(node.arguments[0])) {
        const signature=node.arguments.map(arg=>arg.getText(tree).replace(/\s+/g,'')).join(',');
        if(!dynamicDomains[filename]?.has(signature))preserveAll(`${filename}: unaudited dynamic icon request`);
      }
      if(literal(node)) {
        if(node.text==='search') {
          const call=node.parent;
          if(ts.isCallExpression(call)&&call.expression.getText(tree)==='icon'&&call.arguments[0]===node&&literal(call.arguments[1]))keepTone(call.arguments[1].text,filename);
          else preserveAll(`${filename}: search literal outside a literal-tone icon call`);
        }
        if(node.text.includes('/assets/icons/search-')) {
          const asset=node.text.match(/^\/assets\/icons\/search-([\w-]+)\.png$/);
          if(asset)keepTone(asset[1],filename);else preserveAll(`${filename}: incomplete search asset path`);
        }
        if(node.text==='/assets/icons/') {
          let factory=node.parent;while(factory&&!ts.isFunctionDeclaration(factory))factory=factory.parent;
          const statement=factory?.body?.statements.length===1?factory.body.statements[0]:null;
          const audited=filename==='utils/presentation.js'&&factory?.name?.text==='icon'&&statement&&ts.isReturnStatement(statement)&&statement.expression?.getText(tree).replace(/\s+/g,'')==="'/assets/icons/'+(iconAliases[name]||name||'clipboard')+'-'+(tone||'ink')+'.png'";
          if(!audited)preserveAll(`${filename}: unaudited dynamic icon asset path`);
        }
      }
      if(ts.isTemplateExpression(node)&&(/search|\/assets\/icons\//i.test(node.getText(tree))))preserveAll(`${filename}: unknown search template literal`);
      ts.forEachChild(node,visitSearch);
    }
    visitSearch(tree);
  }
  return {allTones:reasons.length>0,tones:keep,reasons};
}
const iconSources=await Promise.all((await files(native)).filter(filename=>/\.(?:js|wxml)$/.test(filename)).map(async filename=>({filename,source:await fs.readFile(path.join(native,filename),'utf8')})));
const searchUsage=inspectSearchIconUse(iconSources,Object.keys(tones));
// These four artworks are selected only from the bundled doctor experiences.
// Keep generic tones and every actual doctor's use. Any new source literal or
// unaudited dynamic icon request restores the full family before pruning.
const catalogToneIcons=new Map(['ruler','thermometer','needle','flower'].map(key=>[key,new Set(['ink','muted','accent'])]));
for(const {filename,source} of iconSources) {
  if(filename==='utils/models/catalog.js')continue;
  if(filename.endsWith('.wxml')) {
    for(const key of catalogToneIcons.keys())if(source.includes(`/assets/icons/${key}-`))catalogToneIcons.delete(key);
    continue;
  }
  const tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);
  function inspectCatalogArtwork(node) {
    if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))for(const key of catalogToneIcons.keys())if(nativeIcon(node.text,'ink')===`/assets/icons/${key}-ink.png`||node.text.includes(`/assets/icons/${key}-`))catalogToneIcons.delete(key);
    ts.forEachChild(node,inspectCatalogArtwork);
  }
  inspectCatalogArtwork(tree);
}
if(searchUsage.allTones)catalogToneIcons.clear();
for(const [slug,experience] of Object.entries(doctorExperiences)) {
  for(const name of [experience.heroIcon,...experience.steps.map(step=>step.icon),...experience.concerns.map(concern=>concern.icon)]) {
    const key=nativeIcon(name,'ink').match(/^\/assets\/icons\/([a-zA-Z]+)-ink\.png$/)?.[1];
    catalogToneIcons.get(key)?.add(`theme-${slug}`);
  }
}
// Bone has no current source use. Inspect generated catalog/model literals as
// well as handwritten code, so introducing a real use restores its assets.
const unusedArt=new Set(['bone']);
for(const {filename,source}of iconSources){
  if(filename.endsWith('.wxml')){for(const key of unusedArt)if(source.includes(`/assets/icons/${key}-`))unusedArt.delete(key);continue;}
  const tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);
  function visitArt(node){
    if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))for(const key of unusedArt)if(nativeIcon(node.text,'ink')===`/assets/icons/${key}-ink.png`||node.text.includes(`/assets/icons/${key}-`))unusedArt.delete(key);
    ts.forEachChild(node,visitArt);
  }
  visitArt(tree);
}
// Remove only known generated files inside this exact directory. Never recurse.
async function removeGeneratedIcon(filename) {
  const file=path.resolve(iconDir,filename);
  if(path.dirname(file)!==path.resolve(iconDir)||path.basename(file)!==filename||!filename.endsWith('.png'))throw new Error('Icon escaped asset directory');
  await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
}
// The player uses the existing duotone theme icon; these unused QA variants
// must not remain in an incremental build.
for(const filename of ['pause-wellness-ink.png','headphones-wellness-player.png'])await removeGeneratedIcon(filename);
// The chat clear control uses the H5 control color, independently of doctor themes.
await sharp(Buffer.from(renderToStaticMarkup(React.createElement(icons.TrashIcon,{size:64,color:'#84938e',weight:'regular'})))).png({compressionLevel:9}).toFile(path.join(iconDir,'delete-chat-control.png'));
await sharp(Buffer.from(renderToStaticMarkup(React.createElement(icons.TrashIcon,{size:64,color:'#9a504a',weight:'regular'})))).png({compressionLevel:9}).toFile(path.join(iconDir,'delete-danger.png'));
for(const [key,Icon,color,weight] of [
  ['speaker-chat-action',icons.SpeakerHighIcon,'#8d9b96','regular'],
  ['stop-chat-action',icons.StopIcon,'#8d9b96','regular'],
  ['book-chat-action',icons.BookmarkSimpleIcon,'#8d9b96','regular'],
  ['copy-chat-action',icons.CopyIcon,'#8d9b96','regular'],
  ['shield-chat-warning',icons.ShieldCheckIcon,'#806839','duotone'],
  ['wave-chat-status',icons.WaveSineIcon,doctorExperiences['tang-jinsong'].theme.accentStrong,'regular'],
  ['close-sheet',icons.XIcon,'#71817c','regular'],
  ['chat-fill-white',icons.ChatCircleDotsIcon,'#ffffff','fill'],
  ['check-wellness-empty',icons.CheckCircleIcon,'#857991','regular'],
  ['headphones-wellness-ink',icons.HeadphonesIcon,'#38334e','regular'],
  ['play-wellness-ink',icons.PlayIcon,'#38334e','regular'],
  ['chevron-me-menu',icons.CaretRightIcon,'#aab5b1','regular'],
  ['chevron-home-tang-trend',icons.CaretRightIcon,'#246d50','regular'],
  ['chevron-home-tang-disclosure',icons.CaretRightIcon,'#214437','regular'],
  ['chevron-wellness-feature',icons.CaretRightIcon,'#b2a8c2','regular'],
  ['lock-me-disclaimer',icons.LockKeyIcon,'#87958f','regular'],
  ['shield-me-disclaimer',icons.ShieldCheckIcon,'#87958f','regular'],
  ['lock-me-disclaimer-tang',icons.LockKeyIcon,'#52685d','regular'],
  ['shield-me-disclaimer-tang',icons.ShieldCheckIcon,'#52685d','regular'],
  ['clock-secondary-tang-jinsong',icons.ClockCounterClockwiseIcon,'#647671','regular'],
  ['search-hub-empty',icons.MagnifyingGlassIcon,'#408de2','regular'],
  ['arrowRight-hub-topics',icons.ArrowRightIcon,'#2777dc','regular'],
  ['arrowRight-hub-link',icons.ArrowRightIcon,'#176fea','regular'],
  ['close-hub-search',icons.XIcon,'#3567a2','bold'],
  ['delete-health-specialty-danger',icons.TrashIcon,'#aa4c42','regular'],
  ['delete-health-tang-danger',icons.TrashIcon,'#a1544d','regular'],
  ['lock-health-specialty-private',icons.LockKeyIcon,'#718079','regular'],
  ['delete-wellness-goal',icons.TrashIcon,'#5c528b','regular'],
  ['chat-health-tang',icons.ChatCircleDotsIcon,doctorExperiences['tang-jinsong'].theme.accentStrong,'regular'],
  ['close-health-sheet',icons.XIcon,'#71817c','regular'],
  ['speaker-autoplay-off',icons.SpeakerHighIcon,'#6f6a62','regular'],
  ['chart-context-unavailable',icons.ChartLineUpIcon,'#a4afab','regular'],
  ['chart-context-ready',icons.ChartLineUpIcon,'#246d50','regular'],
  ['imageSquare-chat-upload',icons.ImageSquareIcon,'#84938e','regular'],
  ['wave-chat-error',icons.WaveSineIcon,'#944333','regular'],
  ['close-chat-error',icons.XIcon,'#944333','regular'],
  ['wave-chat-recording',icons.WaveSineIcon,'#a24f43','regular'],
]) {
  await sharp(Buffer.from(renderToStaticMarkup(React.createElement(Icon,{size:64,color,weight})))).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}.png`));
}
for(const [slug,experience] of Object.entries(doctorExperiences)) {
  for(const [key,Icon] of [['book',icons.BookmarkSimpleIcon],['clock',icons.ClockCounterClockwiseIcon],['clipboard',icons.ClipboardTextIcon]]) {
    await sharp(Buffer.from(renderToStaticMarkup(React.createElement(Icon,{size:64,color:experience.theme.accent,weight:'duotone'})))).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}-me-accent-${slug}.png`));
  }
  for(const [key,Icon] of [['shield',icons.ShieldCheckIcon],['lock',icons.LockKeyIcon],['sparkle',icons.SparkleIcon],['file',icons.FileTextIcon],['edit',icons.NotePencilIcon]]) {
    await sharp(Buffer.from(renderToStaticMarkup(React.createElement(Icon,{size:64,color:experience.theme.accentStrong,weight:'regular'})))).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}-me-regular-${slug}.png`));
  }
}
for(const [key,Icon] of [['chart',icons.ChartLineUpIcon],['clipboard',icons.ClipboardTextIcon],['chevron',icons.CaretRightIcon]]) {
  await sharp(Buffer.from(renderToStaticMarkup(React.createElement(Icon,{size:64,color:doctorExperiences['yu-wen'].theme.ink,weight:'regular'})))).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}-me-yuwen-ink.png`));
}
for(const [key,Icon,color=doctorExperiences['tang-jinsong'].theme.accentStrong] of [['guidance-heart',GuidanceHeart],['guidance-clipboard',GuidanceClipboard],['guidance-repeat',GuidanceRepeat,'#73533e'],['guidance-arrow',GuidanceArrow],['guidance-arrow-ink',GuidanceArrow,'#214437'],['guidance-arrow-white',GuidanceArrow,'#ffffff'],['guidance-chevron-up',GuidanceChevronUp],['guidance-chevron-down',GuidanceChevronDown],['guidance-close',GuidanceX,'#7f6c5d'],['guidance-cancel',GuidanceX,'#665348'],['guidance-back',GuidanceBack,'#73533e'],['delete-wellness-history',WellnessHistoryTrash,'#8c8197'],['wellness-check',WellnessCheck,'#684786'],['wellness-back',GuidanceBack,'#5c528b']]) {
  await sharp(Buffer.from(renderToStaticMarkup(React.createElement(Icon,{size:64,color,strokeWidth:2})))).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}.png`));
}
for(const mood of TANG_MOODS) {
  const svg = guidanceMoodGlyphSvg(mood);
  if(svg) await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,`guidance-mood-${mood.id}.png`));
}
// Match the health trend/empty icon's H5 accent, rather than the strong tone.
for(const [slug,experience] of Object.entries(doctorExperiences).filter(([slug])=>slug!=='yu-wen')) {
  if(slug!=='tang-jinsong') {
    await sharp(Buffer.from(renderToStaticMarkup(React.createElement(icons.ClipboardTextIcon,{size:64,color:experience.theme.ink,weight:'regular'})))).png({compressionLevel:9}).toFile(path.join(iconDir,`clipboard-health-${slug}.png`));
    await sharp(Buffer.from(renderToStaticMarkup(React.createElement(icons.ClipboardTextIcon,{size:64,color:experience.theme.accent,weight:'regular'})))).png({compressionLevel:9}).toFile(path.join(iconDir,`clipboard-regular-accent-${slug}.png`));
  }
  for(const weight of slug==='tang-jinsong'?['duotone']:['duotone','regular']) {
    const key=weight==='regular'?'chart-regular-accent':'chart-accent';
    await sharp(Buffer.from(renderToStaticMarkup(React.createElement(icons.ChartLineUpIcon,{size:64,color:experience.theme.accent,weight})))).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}-${slug}.png`));
  }
}
const wellnessOnlyIcons=new Set(['play','pause','rotate']);
// Only these Wellness roles use the H5 family/weight and exact 3x display raster.
for(const [key,Icon,color,size,weight] of wellnessRoleIcons){
  const svg=renderToStaticMarkup(React.createElement(Icon,{size,color,...(weight?{weight}:{strokeWidth:2})}));
  await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,key+'.png'));
}
// Only these3directory roles mirror the final H5 ShieldCheck size/color/weight.
for(const [key,color,size,weight] of [
  ['shield-directory-badge','#4386be',45,'regular'],
  ['shield-directory-hero','#3d77b6',48,'duotone'],
  ['shield-directory-footer','#3d77b6',54,'duotone'],
]){
  const svg=renderToStaticMarkup(React.createElement(icons.ShieldCheckIcon,{size,color,weight}));
  await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,key+'.png'));
}
// Only these2Home privacy roles mirror H5 currentColor and duotone artwork.
for(const [key,color] of [['shield-home-privacy','#99a5a1'],['shield-home-privacy-tang','#52685d']]){
  const svg=renderToStaticMarkup(React.createElement(icons.ShieldCheckIcon,{size:45,color,weight:'duotone'}));
  await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,key+'.png'));
}
const regularHealthPlusTones=new Set(["theme-fu-junfen","theme-chen-zhiling","theme-gong-wenbo","theme-chen-jinbiao","theme-wu-yuqin","theme-lin-jinfang","theme-luo-jun","theme-yu-weihua","theme-zhou-yong"]);
const regularIcons=new Set(['bell','back','speaker','stop','mic','keyboard','send','copy','close']);
for (const [tone,color] of Object.entries(tones)) {
  if(tone==='hub'||tone==='hubMuted'||tone==='white'&&!whiteIcons.has('book-fill')) { await removeGeneratedIcon(`book-fill-${tone}.png`);continue; }
  const svg=renderToStaticMarkup(React.createElement(icons.BookmarkSimpleIcon,{size:64,color,weight:'fill'}));
  await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,`book-fill-${tone}.png`));
}
for(const [key,Icon,weight] of [['goalEdit',icons.PencilSimpleIcon,'regular'],['check-fill',icons.CheckCircleIcon,'fill']]) {
  const svg=renderToStaticMarkup(React.createElement(Icon,{size:64,color:tones['theme-yu-wen'],weight}));
  await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}-theme-yu-wen.png`));
}
for(const [key,name] of Object.entries(map)) for(const [tone,color] of Object.entries(tones)) {
  // Only the directory search uses hubMuted. Keep that one asset, not a tone set.
  if(key==='search'?!searchUsage.allTones&&!searchUsage.tones.has(tone):unusedArt.has(key)||(tone==='hubMuted')||(tone==='hub'&&!hubIcons.has(key))||(tone==='white'&&!whiteIcons.has(key))||(wellnessOnlyIcons.has(key)&&!['white','theme-yu-wen'].includes(tone))||(catalogToneIcons.has(key)&&!catalogToneIcons.get(key).has(tone)&&!(tone==='white'&&whiteIcons.has(key))&&!(tone==='hub'&&hubIcons.has(key)))) {
    await removeGeneratedIcon(`${key}-${tone}.png`);
    continue;
  }
  const Icon=icons[`${name}Icon`]||icons[name];if(!Icon)throw new Error(`Missing H5 icon ${name}`);
  const weight=key==='plus'&&regularHealthPlusTones.has(tone)?'regular':key==='send'&&tone==='white'?'fill':regularIcons.has(key)?'regular':(['home','services'].includes(key)&&tone!=='muted'?'fill':(['hub','accent'].includes(tone)||tone.startsWith('theme-')?'duotone':'regular'));
  const svg=renderToStaticMarkup(React.createElement(Icon,{size:64,color,weight}));
  await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}-${tone}.png`));
}
for(const [key,name] of [['chat','ChatCircleDots'],['chart','ChartLineUp'],['user','UserCircle']])for(const [tone,color]of Object.entries(tones).filter(([tone])=>tone==='ink'||tone.startsWith('theme-'))) {
  const svg=renderToStaticMarkup(React.createElement(icons[`${name}Icon`],{size:64,color,weight:'fill'}));
  await sharp(Buffer.from(svg)).png({compressionLevel:9}).toFile(path.join(iconDir,`${key}-fill-${tone}.png`));
}
for(const tone of Object.keys(tones)) {
  if(tone==='hub'||tone==='hubMuted'||tone==='white'&&!whiteIcons.has('services')) { await removeGeneratedIcon(`squares-${tone}.png`);continue; }
  const duplicate=path.join(iconDir,`squares-${tone}.png`);
  if(path.dirname(path.resolve(duplicate))!==path.resolve(iconDir))throw new Error('Icon alias escaped asset directory');
  let old;try{old=await fs.readFile(duplicate);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const original=await fs.readFile(path.join(iconDir,`services-${tone}.png`));
  const [before,after]=await Promise.all([sharp(old).raw().toBuffer(),sharp(original).raw().toBuffer()]);
  if(!before.equals(after))throw new Error(`Icon alias pixels differ: ${tone}`);
  await fs.unlink(duplicate);
}
const artwork=['assets/brand/medtalent-logo.png','assets/brand/ai-knowledge-hero.png','assets/doctors/fu-growth-hero.png','assets/doctors/fu-growth-curve.png'];
// Recompress only PNG entropy. Keep palette, transparency, colour metadata and
// the original filtered scanlines byte-for-byte; reject any decoded pixel change.
async function losslessPng(input) {
  if(!input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Expected generated PNG');
  const chunks=[];
  for(let p=8;p<input.length;){const length=input.readUInt32BE(p),end=p+12+length;if(end>input.length)throw new Error('Truncated generated PNG');chunks.push({type:input.toString('ascii',p+4,p+8),data:input.subarray(p+8,p+8+length),encoded:input.subarray(p,end)});p=end;}
  const scanlines=inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data)));let best=input;
  for(const strategy of [zlibConstants.Z_DEFAULT_STRATEGY,zlibConstants.Z_FILTERED]){
    const compressed=deflateSync(scanlines,{level:9,strategy,memLevel:8});if(!inflateSync(compressed).equals(scanlines))throw new Error('PNG scanlines changed');
    const type=Buffer.from('IDAT'),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(compressed.length);crc.writeUInt32BE(crc32(Buffer.concat([type,compressed])));
    const idat=Buffer.concat([length,type,compressed,crc]);let inserted=false;
    const candidate=Buffer.concat([input.subarray(0,8),...chunks.flatMap(c=>{if(c.type!=='IDAT')return[c.encoded];if(inserted)return[];inserted=true;return[idat];})]);
    if(candidate.length<best.length)best=candidate;
  }
  if(best!==input){const [before,after]=await Promise.all([sharp(input).ensureAlpha().raw().toBuffer(),sharp(best).ensureAlpha().raw().toBuffer()]);if(!before.equals(after))throw new Error('Lossless PNG pixels changed');}
  return best;
}
for(const file of artwork) {
  const relative=file.includes('/fu-growth-')?'subpackages/knowledge/'+file:file;
  const destination=path.join(native,relative);await fs.mkdir(path.dirname(destination),{recursive:true});
  const generated=await sharp(path.join(root,'public',file)).resize({width:file.includes('logo')?256:864,withoutEnlargement:true}).png({compressionLevel:9,palette:true,quality:95}).toBuffer();
  await fs.writeFile(destination,await losslessPng(generated));
  if(relative!==file){const old=path.resolve(native,file);if(!old.startsWith(path.resolve(native)+path.sep))throw new Error('Asset escaped native workspace');await fs.unlink(old).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
for(const name of await fs.readdir(iconDir))if(/^[a-zA-Z0-9_-]+\.png$/.test(name)){
  const target=path.join(iconDir,name),original=await fs.readFile(target),compact=await losslessPng(original);
  if(compact.length<original.length)await fs.writeFile(target,compact);
}
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
async function files(dir,prefix='') { let out=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=path.posix.join(prefix,entry.name);if(entry.isDirectory())out.push(...await files(path.join(dir,entry.name),name));else out.push(name);}return out.sort(); }
const all=(await files(native)).filter(p=>!['build-manifest.json','project.private.config.json'].includes(p));
const entries=await Promise.all(all.map(async p=>{const b=await fs.readFile(path.join(native,p));return{path:p,bytes:b.length,sha256:hash(b)};}));
const app=JSON.parse(await fs.readFile(path.join(native,'app.json'),'utf8'));
const packageRoots=(app.subpackages||app.subPackages||[]).map(p=>p.root.replace(/\/$/,'')+'/');
const packageEntries=Object.fromEntries(packageRoots.map(p=>[p,entries.filter(e=>e.path.startsWith(p))]));
const totalProjectBytes=entries.reduce((a,b)=>a+b.bytes,0);
const subpackagesBytes=Object.fromEntries(Object.entries(packageEntries).map(([p,v])=>[p,v.reduce((a,b)=>a+b.bytes,0)]));
const bytes=entries.filter(e=>!packageRoots.some(p=>e.path.startsWith(p))).reduce((a,b)=>a+b.bytes,0);if(bytes>2*1024*1024)throw new Error(`Native main package exceeds 2MB (${bytes}); split assets before release.`);
for(const [p,n] of Object.entries(subpackagesBytes))if(n>2*1024*1024)throw new Error(`Native subpackage exceeds 2MB: ${p} (${n})`);
if(totalProjectBytes>20*1024*1024)throw new Error(`Native project exceeds 20MB (${totalProjectBytes})`);
const manifest={type:'native-wechat',generatedAt:new Date().toISOString(),uploaded:false,auditSubmitted:false,published:false,totalBytes:bytes,totalProjectBytes,subpackagesBytes,files:entries,sharedSources:await Promise.all([...new Set([...Object.values(bundles).flat(),...sharedAdapters.map(a=>a.input),'src/pages/DoctorApp.tsx'])].map(async p=>({path:p,sha256:hash(await fs.readFile(path.join(root,p)))})))};
await fs.writeFile(path.join(native,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Native build: ${entries.length} files, ${bytes} bytes; shared H5 models generated. No upload/deploy.`);
