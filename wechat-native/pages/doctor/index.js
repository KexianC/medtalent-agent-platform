const { getRuntime } = require('../../utils/runtime.js');
const { builderLayoutClass, getBuilderComponents, componentEnabled, configuredRecordConfig, configuredNavigation, healthContextEnabled, usesWellness, voiceEnabled, doctorExperiences } = require('../../utils/models/catalog.js');
const { getSpecialtyRecordConfig, buildHealthContextPayload, sortHealthRecords, healthRecordDateKey, formatHealthMetricsSummary, dailyTasksFromRecords } = require('../../utils/models/health.js');
const { CHAT_DISCLAIMER, stripChatDisclaimer, createChatDisclaimerFilter } = require('../../utils/models/chat.js');
const { genericExperience, decorateDoctor, portraitCropStyle, icon, sheetGeometry } = require('../../utils/presentation.js');
const { sections, defaults, id, medicalText, displayMessages, resolveEntry } = require('../../utils/chat-ui.js');
const sessionView = require('../../utils/session-view.js');
const { enterSheet, exitSheet, resetSheet } = require('../../utils/sheet-motion.js');
const { tabDuration = 200 } = require('../../utils/sheet-motion-config.js');
const PLAYBACK_FAILURE = '暂时无法播报，回复文字已保留，可点击“重试播报”。';
const tabs = [{id:'home',label:'首页',icon:'house'},{id:'ask',label:'问医生',icon:'chat',activeIcon:'chat-fill'},{id:'manage',label:'管理',icon:'chart',activeIcon:'chart-fill'},{id:'services',label:'服务',icon:'squares'},{id:'me',label:'我的',icon:'user',activeIcon:'user-fill'}];
const panelTitles = {profile:'编辑个人资料',favorites:'我的收藏',history:'浏览记录',records:'健康档案',privacy:'隐私与设置',about:'关于智能体'};
const panelEyebrows = {profile:'PERSONAL PROFILE',favorites:'SAVED ANSWERS',history:'QUESTION HISTORY',records:'HEALTH RECORDS',privacy:'PRIVACY SETTINGS',about:'ABOUT THIS AGENT'};
const privacyParagraphs = ['问答时，当前问题与相关对话历史会发送给配置的 AI 服务。你主动选择的健康记录摘要或记录内容会一并发送。','游客对话保存在本机。微信登录并开启保存后，对话与所保存的记录会存入账户数据库，用于跨设备查看。','使用在线语音功能时，录音或待播报文本会发送至配置的语音服务，外部服务按其隐私政策处理数据。','请勿发送身份证号、联系方式等不必要的敏感信息。保存设置和历史记录可在本页随时管理。'];
function meIcons(tone='ink'){const slug=tone.startsWith('theme-')?tone.slice(6):'';const regular=slug?'me-regular-'+slug:tone;const accent=slug?'me-accent-'+slug:'accent';return{clock:icon('clock',tone),clipboard:icon('clipboard',tone),chat:icon('chat',tone),checkWhite:icon('check','white'),editWhite:icon('edit','white'),lockMuted:icon('lock',slug==='tang-jinsong'?'me-disclaimer-tang':'me-disclaimer'),shieldMuted:icon('shield',slug==='tang-jinsong'?'me-disclaimer-tang':'me-disclaimer'),trashDanger:icon('trash','danger'),closeSheet:icon('close','sheet'),emptyBookmark:icon('book',accent),emptyClock:icon('clock',accent),emptyClipboard:icon('clipboard',accent),meShield:icon('shield',regular),meLock:icon('lock',regular),meSparkle:icon('sparkle',regular),meFile:icon('file',regular),meEdit:icon('edit',regular),meChevron:icon('chevron','me-menu'),wellnessChart:icon('chart','me-yuwen-ink'),wellnessClipboard:icon('clipboard','me-yuwen-ink'),wellnessChevron:icon('chevron','me-yuwen-ink')};}
const confirm = (content) => new Promise(resolve => wx.showModal({title:'请确认',content,success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
const toast = title => wx.showToast({title,icon:'none'});
Page({
  data: { ownerScopes:[],loading:true,error:'',doctor:null,experience:null,tab:'home',renderedTab:'home',renderedWellnessView:'',tabMotion:'',contentEntryMotion:false,reduceMotion:false,panelViewportMargins:null,chatScrollAnimated:false,statusBar:20,capsuleRight:98,theme:'',tabs:[],revision:0,wellnessView:'',dataBlocked:false,dataError:'',panelScrollTop:0,
    sheetTotalMax:0,sheetFeatureMax:0,
    windowHeight:0,keyboardHeight:0,safeBottom:0,suggestionsOpen:false,voiceStatusShown:false,voiceErrorExpanded:false,guidanceAck:null,messages:[],streamingReply:'',busy:false,interactionLocked:false,input:'',voiceMode:false,voiceStatus:'ready',voiceElapsed:'00:00',voiceError:'',playingId:'',playbackStatus:'idle',showHint:true,shareHealthRecords:false,healthContextNotice:'',copiedId:'',healthCount:0,scrollTarget:'chat-bottom',chatScrollTop:0,privacy:defaults,account:{status:'guest',user:null},syncNotice:'',accountBusy:false,conflicts:[],hasGuestData:false,profileName:'游客账户',draftName:'',favorites:[],history:[],records:[],activePanel:'',panelTitle:'',sheetMotion:'',backdropMotion:'',disclaimer:CHAT_DISCLAIMER,menu:[],icons:{} },
  onLoad(query) {
    this.runtime=getRuntime();this._alive=true;this._hidden=false;this._tabRun=0;this._messageEntries={};this._messageEntriesInitialized=false;this._run=0;this._voiceRun=0;this._accountKey=null;this._volatile=[];this._drafts={};this._messageDisclosure={};this._entry=query;
    const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync();const capsule=wx.getMenuButtonBoundingClientRect?wx.getMenuButtonBoundingClientRect():null;
    this._followChat=true;this.updateWindow(info);this._keyboardHandler=e=>this.keyboardChanged({detail:e});if(typeof wx.onKeyboardHeightChange==='function')wx.onKeyboardHeightChange(this._keyboardHandler);
    const entry=resolveEntry(query);this.slug=entry.slug;
    this.setData({statusBar:info.statusBarHeight||20,capsuleRight:capsule?info.windowWidth-capsule.left+8:98,tab:entry.tab,icons:{...Object.fromEntries(['back','speaker','stop','trash','microphone','keyboard','send','chart','copy','bookmark','user','close','lock','file','sparkle','edit','shield'].map(k=>[k,icon(k)])),...meIcons(),userWhite:icon('user','white'),waveWhite:icon('wave','white'),bookmarkFill:icon('book-fill')}});
    this._offSession=this.runtime.session.subscribe(()=>this.refreshData());this._offData=this.runtime.data.subscribe(()=>this.refreshData());
    if(!this.slug){this.setData({loading:false,error:'该智能体不存在或入口无效。'});return;}
    void this.load();
  },
  async load() {
    this.setData({loading:true,error:''});try {
      if(this.slug==='fu-junfen'&&typeof wx.loadSubpackage==='function')await new Promise((resolve,reject)=>wx.loadSubpackage({name:'knowledge',success:resolve,fail:()=>reject(new Error('成长图示资源加载失败，请重试。'))}));
      const raw=await this.runtime.api.getDoctor(this.slug);if(!this._alive)return;
      this.recordConfig=raw.builder?configuredRecordConfig(raw,getSpecialtyRecordConfig(raw.slug)):undefined;
      const decorated=decorateDoctor(raw);const doctor={...decorated,portrait:decorated.portraitUrl};const experience=doctorExperiences[this.slug]||genericExperience(raw);const t=experience.theme;
      this.greeting={id:`greeting-${this.slug}`,role:'assistant',text:raw.welcomeMessage||(this.slug==='tang-jinsong'?'你好，我先听你说。可以聊睡眠、情绪和日常状态；我会尽量用短话讲清楚，再给你一两个能做的建议。这里仅做科普，不能替代面诊。':`您好，这里是${raw.name}的健康问答。我可以围绕${raw.specialty||'日常健康知识'}提供健康科普和就医准备建议。我的回复不能替代医生面诊、诊断或处方。`),createdAt:new Date().toISOString()};
      const tone=doctorExperiences[this.slug]?`theme-${this.slug}`:'ink';
    this.setData({doctor,experience,layoutClass:builderLayoutClass(raw),builderMode:Boolean(raw.builder),builderModules:getBuilderComponents(raw.builder),isWellness:usesWellness(raw),voiceAllowed:voiceEnabled(raw),recordAllowed:componentEnabled(raw,'records'),serviceAllowed:componentEnabled(raw,'services'),assessmentAllowed:Boolean(raw.builder)&&componentEnabled(raw,'assessments'),healthSharing:healthContextEnabled(raw),theme:`--journey-accent:${t.accent};--journey-accent-strong:${t.accentStrong};--journey-accent-rgb:${t.accentRgb};--journey-surface:${t.surface};--journey-canvas:${t.canvas};--journey-ink:${t.ink};`,tabs:configuredNavigation(raw,tabs).map(t=>({...t,label:t.id==='ask'&&!raw.builder&&!doctorExperiences[this.slug]?'问智能体':t.label,image:icon(t.activeIcon||t.icon,tone),mutedImage:icon(t.icon,'muted')})),icons:{...Object.fromEntries(['back','speaker','stop','trash','microphone','keyboard','send','chart','copy','bookmark','user','close','lock','file','sparkle','edit','shield'].map(k=>[k,icon(k,tone)])),...meIcons(tone),userWhite:icon('user','white'),waveWhite:icon('wave','white'),bookmarkFill:icon('book-fill',tone),saveWhite:icon('save','white')},loading:false});
      await this.runtime.session.refresh();await this.runtime.data.load(this.slug);this.refreshData();
    } catch(e){if(this._alive)this.setData({loading:false,error:e.message||'暂时无法加载智能体，请重试。'});}
  },
  onShow(){this._hidden=false;this.updateWindow();this.measurePanelViewport();this.measureChatViewport();if(this.runtime&&this.data.doctor)void this.runtime.session.refresh().then(()=>this.runtime.data.load(this.slug)).then(()=>{this.refreshData();this.applyReportDraft();}).catch(e=>this.notice(e));},
  onResize(e){this.updateWindow(e&&e.size);this.measurePanelViewport();this.measureChatViewport();},
  onHide(){this.resetTabMotion();this._hidden=true;this.resetChatScroll();resetSheet(this);if(this._alive)this.setData({activePanel:'',sheetMotion:'',backdropMotion:'',keyboardHeight:0,windowHeight:this._fullWindowHeight||this.data.windowHeight});this.cancelWork();this.runtime&&this.runtime.data.flush().catch(()=>{});},
  onUnload(){this.resetTabMotion(false);this.resetChatScroll();resetSheet(this);this._alive=false;if(this._keyboardHandler&&typeof wx.offKeyboardHeightChange==='function')wx.offKeyboardHeightChange(this._keyboardHandler);this.cancelWork();this.clearFeedback();if(this._offSession)this._offSession();if(this._offData)this._offData();},
  updateWindow(size){
    if(!this._alive)return;const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync(),height=Number(size&&size.windowHeight||info.windowHeight);if(!Number.isFinite(height)||height<=0)return;
    // Focus precedes a keyboard resize: keep the unobscured baseline even when
    // the host's resize event arrives before its keyboard-height event.
    const width=Number(size&&size.windowWidth||info.windowWidth),widthChanged=this._windowWidth&&width!==this._windowWidth;this._windowWidth=width;
    if(!this._fullWindowHeight||(!this.data.keyboardHeight&&!this._inputFocused)||widthChanged)this._fullWindowHeight=height;
    const available=Math.max(1,Math.min(height,(this._fullWindowHeight||height)-this.data.keyboardHeight));const safeBottom=info.safeArea?Math.max(0,(Number(info.screenHeight)||0)-Number(info.safeArea.bottom)):0;
    const sheetInfo={...info,windowHeight:available};
    this.setData({windowHeight:available,safeBottom:Number.isFinite(safeBottom)?safeBottom:0,sheetTotalMax:sheetGeometry(sheetInfo).totalHeight,sheetFeatureMax:sheetGeometry(sheetInfo,720).totalHeight});
  },
  inputFocused(){this._inputFocused=true;},
  inputBlurred(){this._inputFocused=false;},
  keyboardChanged(e){
    if(!this._alive||this._hidden||this.data.renderedTab!=='ask')return;const height=Math.max(0,Number(e.detail&&e.detail.height)||0);if(height===this.data.keyboardHeight)return;
    this.setData({keyboardHeight:height,windowHeight:Math.max(1,(this._fullWindowHeight||this.data.windowHeight)-height)},()=>{this.updateWindow(height?undefined:{windowHeight:this._fullWindowHeight||this.data.windowHeight});this.measureChatViewport();if(this._followChat!==false)this.scrollBottom(false);});
  },
  measureChatViewport(){
    if(!this._alive||this._hidden||this.data.renderedTab!=='ask'||typeof this.createSelectorQuery!=='function')return;const owner=this._accountKey,request=this._chatViewportRequest=(this._chatViewportRequest||0)+1;
    this.createSelectorQuery().select('.messages').boundingClientRect(rect=>{if(this._alive&&!this._hidden&&this.data.renderedTab==='ask'&&owner===this._accountKey&&request===this._chatViewportRequest&&rect&&rect.height>0)this._messageViewportHeight=rect.height;}).exec();
  },
  pauseChatFollow(){this._followChat=false;clearTimeout(this._scrollTimer);this._scrollTimer=null;this._scrollRun=(this._scrollRun||0)+1;},
  messagesTouchStarted(e){const point=e.touches&&e.touches[0];this._chatTouchStart=point?{x:Number(point.clientX),y:Number(point.clientY)}:null;},
  messagesTouchMoved(e){const point=e.touches&&e.touches[0],start=this._chatTouchStart;if(point&&start){const x=Math.abs(Number(point.clientX)-start.x),y=Math.abs(Number(point.clientY)-start.y);if(y>4&&y>x)this.messagesDragStarted();}},
  messagesDragStarted(){this._manualChatScrollUntil=Date.now()+2000;this.pauseChatFollow();},
  messagesScrolled(e){
    const d=e.detail||{},top=Number(d.scrollTop),moved=Number.isFinite(top)&&top!==this._lastChatScrollTop;this._lastChatScrollTop=top;
    // Content growth and scroll-into-view also emit scroll events. Only a real
    // touch/drag, including its recent inertia, can change the reader's intent.
    if(!moved||Date.now()>(this._manualChatScrollUntil||0))return;this._manualChatScrollUntil=Date.now()+2000;
    if(this._messageViewportHeight>0){if(Number(d.scrollHeight)-top-this._messageViewportHeight<=64){this._followChat=true;this._manualChatScrollUntil=0;}else this.pauseChatFollow();}
  },
  messagesAtBottom(){if(Date.now()<=(this._manualChatScrollUntil||0)){this._followChat=true;this._manualChatScrollUntil=0;}},
  voiceStatusVisible(data=this.data){return Boolean(data.doctor&&voiceEnabled(data.doctor)&&((data.showHint&&(data.voiceMode||!data.messages.some(message=>message.role==='user')))||data.voiceStatus!=='ready'||data.playbackStatus!=='idle'||data.voiceError));},
  updateVoiceStatus(patch){
    const visible=this.voiceStatusVisible(),errorChanged='voiceError' in patch&&patch.voiceError!==this.data.voiceError;if(errorChanged&&!('voiceErrorExpanded' in patch))patch={...patch,voiceErrorExpanded:false};this.setData({...patch,voiceStatusShown:this.voiceStatusVisible({...this.data,...patch})},()=>{const visibilityChanged=visible!==this.voiceStatusVisible();if(visibilityChanged)this.measureChatViewport();if(visibilityChanged||errorChanged)this.scrollBottom(false);});
  },
  clearFeedback(){clearTimeout(this._contextTimer);clearTimeout(this._copyTimer);},
  notice(e){if(this._alive)this.setData({syncNotice:e&&e.message||String(e||'操作失败，请重试。')});},
  refreshData() {
    if(!this._alive||!this.data.doctor)return;
    const account=this.runtime.session.get();const key=account.user?account.user.id:this.runtime.data.getVisitorId?`guest:${this.runtime.data.getVisitorId()}`:'guest';
    if(key!==this._accountKey){const entry=this._accountKey===null?this._entry:{slug:this.slug,tab:this.data.tab==='ask'?'ask':''};this.resetTabMotion(false);this.resetChatScroll();resetSheet(this);this.cancelWork();this.clearFeedback();this._accountKey=key;this._volatile=[];this._replay=null;this._messageDisclosure={};this._messageEntries={};this._messageEntriesInitialized=false;const restored=resolveEntry(entry,()=>sessionView.read(key,this.slug,'active-tab',null));if(!this.data.tabs.some(item=>item.id===restored.tab))restored.tab=this.data.tabs[0].id;sessionView.write(key,this.slug,'active-tab',restored.tab);this.setData({ownerScopes:[key],chatScrollTop:0,suggestionsOpen:false,guidanceAck:null,input:sessionView.read(key,this.slug,'chat-draft'),tab:restored.tab,renderedTab:restored.tab,renderedWellnessView:'',tabMotion:'',contentEntryMotion:false,panelViewportMargins:null,messages:[],activePanel:'',sheetMotion:'',backdropMotion:'',wellnessView:'',shareHealthRecords:false,voiceMode:false,healthContextNotice:'',copiedId:'',syncNotice:''});}
    const store=this.runtime.data;const snapshot=store.get(this.slug,'privacy',defaults);const privacy={...defaults,...snapshot.value};
    const favorites=store.get(this.slug,'favorites',[]).value||[];const records=sortHealthRecords(store.get(this.slug,'health-records',[]).value||[],new Date(),370,this.recordConfig);
    const blocked=account.status==='loading'||Boolean(account.user&&!snapshot.canEdit);
    if(blocked!==this._dataBlocked){this.resetTabMotion(false);this.resetChatScroll();this._messageEntries={};this._messageEntriesInitialized=false;this.setData({renderedTab:this.data.tab,renderedWellnessView:'',wellnessView:'',tabMotion:'',contentEntryMotion:false,panelViewportMargins:null});if(blocked){resetSheet(this);this.cancelWork();this.clearFeedback();this.setData({activePanel:'',sheetMotion:'',backdropMotion:''});}this._dataBlocked=blocked;}
    let messages=privacy.saveChat?store.get(this.slug,'chat-messages',[]).value||[]:this._volatile;
    if(!messages.length&&this.greeting)messages=[this.greeting];
    this._messages=messages;const profileName=store.get(this.slug,'profile-name','游客账户').value||'游客账户';
    const snapshots=sections.map(section=>({section,...store.get(this.slug,section,null)}));
    const conflicts=snapshots.filter(s=>s.status==='conflict').map(s=>({section:s.section,label:({'chat-messages':'对话','health-records':'健康记录','chat-assessments-v1':'心理自评',favorites:'收藏','wellness-v1':'身心记录'})[s.section]||'个人设置'}));
    const errors=[...new Set(snapshots.map(s=>s.error).filter(Boolean))];const pending=snapshots.some(s=>['pending','saving','offline','error'].includes(s.status));
    const history=messages.filter(m=>m.role==='user').slice().reverse().map(m=>({...m,body:medicalText(m.text),createdLabel:new Date(m.createdAt).toLocaleString('zh-CN')}));
    const recordViews=records.map(r=>({...r,dateLabel:healthRecordDateKey(r),summary:formatHealthMetricsSummary(r,this.recordConfig)||(r.completedTitles||[]).join('、')||'自我记录'}));
    const wellness=store.get(this.slug,'wellness-v1',{}).value||{};const showHint=store.get(this.slug,'voice-input-hint-dismissed',false).value!==true;
    const messageIds=new Set(messages.map(m=>m.id));for(const id of Object.keys(this._messageDisclosure))if(!messageIds.has(id))delete this._messageDisclosure[id];
    const messageVersion=JSON.stringify(messages),scrollMessages=!blocked&&this.data.renderedTab==='ask'&&(!this._chatScrollMounted||this._chatMessageVersion!==messageVersion);this._chatMessageVersion=messageVersion;if(!blocked&&this.data.renderedTab==='ask')this._chatScrollMounted=true;
    this.setData({account,dataBlocked:blocked,dataError:snapshot.error||account.error||'正在读取你的云端记录…',privacy,profileName:account.user&&['游客账户','微信用户'].includes(profileName)?'微信用户':profileName,messages:this.messageRows(displayMessages(messages,favorites,this.greeting.id),blocked),favorites:favorites.map(f=>({...f,body:medicalText(stripChatDisclaimer(f.text)),consultQuestion:'请基于这条收藏内容继续说明：'+medicalText(stripChatDisclaimer(f.text)).slice(0,160),createdLabel:new Date(f.createdAt).toLocaleString('zh-CN')})),history,records:recordViews,healthCount:healthContextEnabled(this.data.doctor)?buildHealthContextPayload(records,new Date(),this.recordConfig).records.length:0,showHint,voiceStatusShown:this.voiceStatusVisible({...this.data,messages,showHint}),hasGuestData:store.hasGuestData?store.hasGuestData(this.slug):this.runtime.data.hasGuestData&&this.runtime.data.hasGuestData(this.slug),conflicts,syncNotice:errors.join('；')||this.data.syncNotice,syncLabel:account.user?(conflicts.length?'其他设备也修改了记录，请选择保留哪一份。':pending?'有记录尚未同步，联网后可重试。':'记录已同步，可在其他设备使用同一微信账号查看。'):'登录后，对话、收藏、健康记录和心理自评将保存在你的云端账户。你可在设置中关闭对话保存。',wellnessCounts:{records:(wellness.records||[]).length,sessions:(wellness.sessions||[]).length,assessments:(wellness.assessments||[]).length},menu:[{id:'favorites',title:'我的收藏',count:favorites.length},{id:'history',title:'浏览记录',count:history.length},{id:'records',title:'健康档案',count:this.slug==='yu-wen'?'':records.length},{id:'privacy',title:'隐私与设置',count:''},{id:'about',title:`关于${this.data.doctor.name}智能体`,count:''}],revision:this.data.revision+1},()=>{if(this._alive&&key===this._accountKey){if(scrollMessages)this.scrollBottom();this.measurePanelViewport();this.measureChatViewport();}});
  },
  messageRows(messages,blocked=false){
    const ids=new Set(messages.map(m=>m.id));for(const id of Object.keys(this._messageEntries))if(!ids.has(id))delete this._messageEntries[id];
    const rows=messages.map(m=>{if(!Object.prototype.hasOwnProperty.call(this._messageEntries,m.id))this._messageEntries[m.id]=!blocked&&this._messageEntriesInitialized&&this.data.renderedTab==='ask';return{...m,...this._messageDisclosure[m.id],enterMotion:this._messageEntries[m.id]};});
    if(!blocked)this._messageEntriesInitialized=true;return rows;
  },
  resetTabMotion(settle=true){clearTimeout(this._tabTimer);clearTimeout(this._tabEntryTimer);this._tabTimer=null;this._tabEntryTimer=null;this._tabRun=(this._tabRun||0)+1;if(settle&&this._alive)this.mountRenderedTab(this.data.tab,this.data.wellnessView,false);},
  mountRenderedTab(tab,view,animate){
    clearTimeout(this._tabEntryTimer);this._tabEntryTimer=null;const entry=animate&&!this.data.reduceMotion,run=++this._tabRun,owner=this._accountKey;
    const patch={renderedTab:tab,renderedWellnessView:view||'',tabMotion:entry?'tab-initial':'',contentEntryMotion:Boolean(entry),panelViewportMargins:null};
    if(tab==='ask'){for(const message of this.data.messages)this._messageEntries[message.id]=Boolean(animate);patch.messages=this.data.messages.map(m=>({...m,enterMotion:Boolean(animate)}));this._messageEntriesInitialized=true;}
    this.setData(patch,()=>{if(!this._alive||this._hidden||owner!==this._accountKey||run!==this._tabRun)return;this.measurePanelViewport();this.measureChatViewport();if(tab==='ask'){this._chatScrollMounted=true;this.scrollBottom(!this.data.streamingReply);}if(!entry)return;const enter=()=>{this._tabEntryTimer=null;if(this._alive&&!this._hidden&&!this.data.dataBlocked&&owner===this._accountKey&&run===this._tabRun&&this.data.renderedTab===tab&&this.data.tabMotion==='tab-initial')this.setData({tabMotion:'tab-enter'});};if(typeof wx.nextTick==='function')wx.nextTick(enter);else{this._tabEntryTimer=setTimeout(enter,16);if(this._tabEntryTimer&&this._tabEntryTimer.unref)this._tabEntryTimer.unref();}});
  },
  transitionTab(next,view){
    if(next===this.data.renderedTab){this.resetTabMotion(false);this.setData({renderedWellnessView:view||'',tabMotion:''});return;}
    if(this.data.reduceMotion||this._hidden||this.data.dataBlocked){this.resetTabMotion(false);this.mountRenderedTab(next,view,!this._hidden&&!this.data.dataBlocked);return;}
    if(this._tabTimer)return;
    clearTimeout(this._tabEntryTimer);this._tabEntryTimer=null;const run=++this._tabRun,owner=this._accountKey;this.setData({tabMotion:'tab-exit'});
    this._tabTimer=setTimeout(()=>{this._tabTimer=null;if(!this._alive||this._hidden||this.data.dataBlocked||run!==this._tabRun||owner!==this._accountKey)return;this.mountRenderedTab(this.data.tab,this.data.wellnessView,true);},tabDuration);
    if(this._tabTimer&&this._tabTimer.unref)this._tabTimer.unref();
  },
  measurePanelViewport(){
    if(!this._alive||this._hidden||this.data.dataBlocked||this.data.renderedTab!=='manage'||this.slug!=='tang-jinsong'||typeof this.createSelectorQuery!=='function')return;
    const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync(),height=Number(info.windowHeight);if(!Number.isFinite(height)||height<=0)return;
    const owner=this._accountKey,run=this._tabRun,request=this._viewportRequest=(this._viewportRequest||0)+1,target=this.createSelectorQuery().select('.panel-scroll');if(!target||typeof target.boundingClientRect!=='function')return;
    target.boundingClientRect(rect=>{if(!this._alive||this._hidden||this.data.dataBlocked||owner!==this._accountKey||run!==this._tabRun||request!==this._viewportRequest||this.data.renderedTab!=='manage'||!rect||!Number.isFinite(rect.top)||!Number.isFinite(rect.bottom)||rect.bottom<=rect.top)return;const margins={top:-Math.max(0,rect.top),bottom:Math.min(height,rect.bottom)-height,left:0,right:0};if(JSON.stringify(margins)!==JSON.stringify(this.data.panelViewportMargins))this.setData({panelViewportMargins:margins});}).exec();
  },
  saveMessages(messages) { this._messages=messages.slice(-100);if(this.data.privacy.saveChat)this.runtime.data.set(this.slug,'chat-messages',this._messages);else this._volatile=this._messages;this.refreshData(); },
  switchTab(e,view='') { const next=typeof e==='string'?e:e.currentTarget.dataset.tab;if(!this.data.tabs.some(t=>t.id===next))return;resetSheet(this);if(this.data.tab==='ask'&&next!=='ask'){this.resetChatScroll();this.cancelWork();this.clearFeedback();this._replay=null;this._messageDisclosure={};this.updateVoiceStatus({suggestionsOpen:false,voiceMode:false,shareHealthRecords:false,healthContextNotice:'',copiedId:'',messages:this.data.messages.map(m=>({...m,expanded:false,citationsExpanded:false}))});}if(next!==this.data.tab){this._panelScroll=0;this.setData({panelScrollTop:0});}sessionView.write(this._accountKey,this.slug,'active-tab',next);this.setData({tab:next,wellnessView:view,activePanel:'',sheetMotion:'',backdropMotion:''});this.transitionTab(next,view); },
  panelScrolled(e){this._panelScroll=Math.max(0,Number(e.detail.scrollTop)||0);},
  focusHealthEditor(e){const top=e.detail&&e.detail.top;if(!Number.isFinite(top))return;let target=Math.max(0,(this._panelScroll||0)+top-this.data.statusBar-44-16);if(target===this.data.panelScrollTop&&Math.abs(target-(this._panelScroll||0))>1)target+=1;this.setData({panelScrollTop:target});},
  openAsk(e) { if(!componentEnabled(this.data.doctor,'chat'))return;const detail=e.detail||e||{};const question=detail.question||detail.text||sessionView.read(this._accountKey,this.slug,'chat-draft');this.switchTab('ask');this.setData({input:question,shareHealthRecords:Boolean(detail.withHealthContext||detail.shareHealthRecords)&&this.data.healthCount>0});this.saveDraft(question);if(detail.sendNow){const owner=this._accountKey;const acknowledge=accepted=>{if(detail.guidanceRequestId&&this._alive&&owner===this._accountKey)this.setData({guidanceAck:{requestId:detail.guidanceRequestId,accepted:accepted===true}});};void this.sendQuestion(question).then(acknowledge,()=>acknowledge(false));} },
  navigateFeature(e) { const d=e.detail||{};if(d.view){this.openWellness(d.view);return;}this.switchTab(d.tab||'manage'); },
  openWellness(e) { const view=typeof e==='string'?e:e.currentTarget.dataset.view;this.switchTab(['diary','health','report','goals'].includes(view)?'manage':'services',view); },
  closeWellness(){this.setData({wellnessView:'',renderedWellnessView:''});},
  chooseWellness(e){this.openWellness(e.detail.view);},
  back(){wx.navigateBack({fail:()=>wx.reLaunch({url:'/pages/index/index'})});},
  openConsumerServices(){wx.navigateTo({url:'/subpackages/consumer/pages/services/index?slug='+encodeURIComponent(this.slug)});},
  applyReportDraft(){const draft=this.runtime.reportChatDraft;if(!draft)return;const user=this.runtime.session.get().user;if(!user||draft.ownerId!==user.id){delete this.runtime.reportChatDraft;return;}if(draft.slug!==this.slug)return;delete this.runtime.reportChatDraft;if(!componentEnabled(this.data.doctor,'chat')){this.notice('当前智能体未启用问答，报告文字仍保存在本人私有报告中。');return;}this.switchTab('ask');this.setData({input:draft.text});this.saveDraft(draft.text);this.notice('报告文字已放入输入框，请核对后手动发送。');},
  saveDraft(value){this._drafts[this._accountKey]=value;sessionView.write(this._accountKey,this.slug,'chat-draft',value);},
  inputChanged(e){this.setData({input:e.detail.value});this.saveDraft(e.detail.value);},
  sendInput(){void this.sendQuestion(this.data.input);},
  quickAsk(e){void this.sendQuestion(e.currentTarget.dataset.question);},
  async sendQuestion(text,voice=false,retryId='',duration=0) {
    const question=String(text||'').trim();if(!question||this._request||this.data.dataBlocked||(!voice&&['starting','recording','transcribing'].includes(this.data.voiceStatus)))return false;
    this._manualChatScrollUntil=0;this._chatTouchStart=null;this._followChat=true;const run=++this._run;const owner=this._accountKey;this.stopSpeaking();const history=(this._messages||[]).filter(m=>!m.error).slice(-12).map(m=>({role:m.role,content:m.role==='assistant'?stripChatDisclaimer(m.text):m.text}));
    const before=retryId?this._messages.filter(m=>m.id!==retryId):[...this._messages,{id:id('chat-user'),role:'user',text:question,createdAt:new Date().toISOString(),...(voice?{inputMode:'voice',voiceDurationSeconds:duration}: {})}];this.saveMessages(before);
    if(!retryId&&question===this.data.input){this.setData({input:''});this.saveDraft('');}
    this.updateVoiceStatus({busy:true,interactionLocked:true,streamingReply:'',voiceError:'',voiceStatus:voice?'thinking':'ready'});this.scrollBottom();
    const health=this.data.shareHealthRecords&&this.data.healthCount?buildHealthContextPayload(this.runtime.data.get(this.slug,'health-records',[]).value,new Date(),this.recordConfig):undefined;
    const shouldSpeak=this.data.privacy.voicePlayback&&(this.data.doctor.builder?voiceEnabled(this.data.doctor)&&this.data.doctor.builder.voice.autoPlay:(this.slug==='tang-jinsong'||voice));const playbackRun=this._playRun;let speechHandedOff=false;
    const queue=shouldSpeak?this.runtime.speech.createQueue({doctorSlug:this.slug,isActive:()=>this._alive&&playbackRun===this._playRun&&owner===this._accountKey&&this.data.privacy.voicePlayback,onState:state=>{if(this._alive&&playbackRun===this._playRun)this.updateVoiceStatus({playbackStatus:state==='loading'?'preparing':state});}}):null;this._queue=queue;
    const filter=createChatDisclaimerFilter();let full='';const handle=this.runtime.chat.send({doctorSlug:this.slug,message:question,history,...(health?{healthContext:health}:{})},{onDelta:delta=>{if(this._alive&&run===this._run){const body=filter.push(delta);full+=body;if(queue)queue.push(body);this.setData({streamingReply:medicalText(full)});this.scrollBottom(false);}}});this._request=handle;
    try { const result=await handle.promise;if(!this._alive||run!==this._run||owner!==this._accountKey)return false;
      const reply=stripChatDisclaimer(result.reply||full);if(!reply.trim())throw new Error('暂时没有收到回复，请重试。');const message={id:id('chat-assistant'),role:'assistant',text:reply,createdAt:new Date().toISOString(),citations:result.citations||[],retrievalMode:result.retrievalMode};
      const tail=filter.finish();if(queue){queue.push(tail);if(!full)queue.push(reply);}
      this.saveMessages([...this._messages,message]);this.updateVoiceStatus({streamingReply:'',voiceStatus:'ready',...(health?{shareHealthRecords:false}:{})});this._replay=message;
      if(queue){speechHandedOff=true;this.setData({playingId:message.id});void queue.finish().then(()=>{if(this._alive&&playbackRun===this._playRun)this.updateVoiceStatus({playbackStatus:'idle',playingId:''});}).catch(e=>{if(this._alive&&playbackRun===this._playRun)this.updateVoiceStatus({playbackStatus:'error',playingId:'',voiceError:PLAYBACK_FAILURE});}).finally(()=>{if(this._queue===queue)this._queue=null;});}
      return true;
    } catch(e) { if(!this._alive||run!==this._run||owner!==this._accountKey)return false;this.saveMessages([...this._messages,{id:id('chat-error'),role:'assistant',text:e.message||'回复暂时没有完成，请重试。',error:true,retryText:question,createdAt:new Date().toISOString(),...(voice?{inputMode:'voice',voiceDurationSeconds:duration}: {})}]);this.updateVoiceStatus({streamingReply:'',voiceStatus:'error',voiceError:e.message||'回复暂时没有完成，请重试。'});return false;
    } finally { if(queue&&!speechHandedOff){queue.cancel();if(this._queue===queue)this._queue=null;}if(this._request===handle)this._request=null;if(this._alive&&run===this._run){this.setData({busy:false,interactionLocked:false});this.scrollBottom();} }
  },
  resetChatScroll(){clearTimeout(this._errorScrollTimer);this._errorScrollTimer=null;clearTimeout(this._scrollTimer);this._scrollTimer=null;this._scrollRun=(this._scrollRun||0)+1;this._chatScrollMounted=false;this._chatMessageVersion='';this._followChat=true;this._messageViewportHeight=0;this._manualChatScrollUntil=0;this._chatTouchStart=null;this._lastChatScrollTop=0;},
  scrollBottom(animate=true){
    if(!this._alive||this._hidden||this.data.dataBlocked||this.data.renderedTab!=='ask'||this._followChat===false||!(this._messages||[]).some(message=>message.role==='user'))return;
    this._pendingScrollAnimated=Boolean(animate);this.setData({chatScrollAnimated:this._pendingScrollAnimated});if(this._scrollTimer)return;
    const owner=this._accountKey,run=this._scrollRun=(this._scrollRun||0)+1;this.setData({scrollTarget:''});
    this._scrollTimer=setTimeout(()=>{this._scrollTimer=null;if(this._alive&&!this._hidden&&!this.data.dataBlocked&&owner===this._accountKey&&run===this._scrollRun&&this.data.renderedTab==='ask'&&(this._messages||[]).some(message=>message.role==='user'))this.setData({scrollTarget:'chat-bottom',chatScrollAnimated:this._pendingScrollAnimated});},30);
    if(this._scrollTimer&&this._scrollTimer.unref)this._scrollTimer.unref();
  },
  retryMessage(e){const m=this._messages.find(m=>m.id===e.currentTarget.dataset.id);if(m)void this.sendQuestion(m.retryText,m.inputMode==='voice',m.id,m.voiceDurationSeconds);},
  async clearChat(){if(!await confirm('确定清空全部对话记录吗？'))return;this.cancelWork();this.saveMessages([this.greeting]);},
  toggleDisclosure(e,field){const target=e.currentTarget.dataset.id;const message=this.data.messages.find(m=>m.id===target);if(!message)return;this._manualChatScrollUntil=0;this.pauseChatFollow();this._messageDisclosure[target]={...this._messageDisclosure[target],[field]:!message[field]};this.setData({messages:this.data.messages.map(m=>m.id===target?{...m,...this._messageDisclosure[target]}:m)});},
  toggleSuggestions(){this._manualChatScrollUntil=0;this.pauseChatFollow();this.setData({suggestionsOpen:!this.data.suggestionsOpen});},
  toggleTranscript(e){this.toggleDisclosure(e,'expanded');},
  toggleCitations(e){this.toggleDisclosure(e,'citationsExpanded');},
  portraitLoaded(e){const d=this.data.doctor;if(!d||!e.detail.width||!e.detail.height)return;const styles={avatar36Style:portraitCropStyle(d,e.detail.width,e.detail.height,36,36),avatar48Style:portraitCropStyle(d,e.detail.width,e.detail.height,48,48),avatar31Style:portraitCropStyle(d,e.detail.width,e.detail.height,31,31),avatar62Style:portraitCropStyle(d,e.detail.width,e.detail.height,56,56)};if(d.avatar48Style!==styles.avatar48Style||d.avatar36Style!==styles.avatar36Style||d.avatar62Style!==styles.avatar62Style)this.setData({doctor:{...d,...styles}});},
  portraitFailed(){if(this.data.doctor)this.setData({doctor:{...this.data.doctor,portrait:''}});},
  copyMessage(e){const m=this._messages.find(m=>m.id===e.currentTarget.dataset.id)||this.data.favorites.find(m=>m.id===e.currentTarget.dataset.id);const owner=this._accountKey;if(m)wx.setClipboardData({data:stripChatDisclaimer(m.text),success:()=>{if(!this._alive||owner!==this._accountKey)return false;clearTimeout(this._copyTimer);this.setData({copiedId:m.id});this._copyTimer=setTimeout(()=>{if(this._alive)this.setData({copiedId:''});},1500);}});},
  openExcerpt(e){const url=e.currentTarget.dataset.url;if(/^\/api\/citations\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/\d+$/.test(url))wx.navigateTo({url:'/subpackages/knowledge/pages/excerpt/index?url='+encodeURIComponent(url)});},
  feedbackAnswer(e){const answer=this._messages.find(item=>item.id===e.currentTarget.dataset.id);if(!answer)return;const question=this._messages.slice(0,this._messages.indexOf(answer)).reverse().find(item=>item.role==='user');if(!question)return;this.runtime.feedbackDraft={ownerKey:this.runtime.session.get().user?.id||'guest',doctorSlug:this.slug,messageId:answer.id,question:question.text,answer:answer.text};wx.navigateTo({url:'/subpackages/knowledge/pages/excerpt/index?mode=feedback'});},
  toggleFavorite(e){const m=this._messages.find(m=>m.id===e.currentTarget.dataset.id);if(!m||m.error)return;const current=this.runtime.data.get(this.slug,'favorites',[]).value||[];this.runtime.data.set(this.slug,'favorites',current.some(f=>f.id===m.id)?current.filter(f=>f.id!==m.id):[{id:m.id,text:stripChatDisclaimer(m.text),createdAt:m.createdAt},...current].slice(0,50));},
  readMessage(e){const m=this._messages.find(m=>m.id===e.currentTarget.dataset.id);if(!m||this.data.interactionLocked)return;if(this.data.playingId===m.id)this.stopSpeaking();else void this.speak(m);},
  async speak(message){this.stopSpeaking();const run=++this._playRun;this._replay=message;this.updateVoiceStatus({playingId:message.id,playbackStatus:'preparing',voiceError:'',voiceErrorExpanded:false});const playback=this.runtime.speech.speak(stripChatDisclaimer(message.text),{doctorSlug:this.slug,onState:state=>{const status=typeof state==='string'?state:state.status;if(this._alive&&run===this._playRun)this.updateVoiceStatus({playbackStatus:status==='loading'?'preparing':status});}});this._playback=playback;
    try{await playback.promise;if(this._alive&&run===this._playRun)this.updateVoiceStatus({playbackStatus:'idle',playingId:''});}catch(e){if(this._alive&&run===this._playRun)this.updateVoiceStatus({playbackStatus:'error',playingId:'',voiceError:PLAYBACK_FAILURE});}
  },
  stopSpeaking(){this._playRun=(this._playRun||0)+1;if(this._queue)this._queue.cancel();this._queue=null;if(this._playback)this._playback.cancel();this._playback=null;if(this.runtime)this.runtime.speech.stopPlayback();if(this._alive)this.updateVoiceStatus({playingId:'',playbackStatus:'idle'});},
  retrySpeaking(){if(this._replay)void this.speak(this._replay);},
  toggleAutoplay(){const privacy={...this.data.privacy,voicePlayback:!this.data.privacy.voicePlayback};this.runtime.data.set(this.slug,'privacy',privacy);if(!privacy.voicePlayback)this.stopSpeaking();},
  toggleHealth(){clearTimeout(this._contextTimer);if(!this.data.healthCount){this.setData({healthContextNotice:'暂无健康记录，请先到“管理”添加'});this._contextTimer=setTimeout(()=>{if(this._alive)this.setData({healthContextNotice:''});},1800);return;}this.setData({healthContextNotice:'',shareHealthRecords:!this.data.shareHealthRecords});},
  toggleVoice(){if(this.data.voiceMode){if(['starting','recording','transcribing'].includes(this.data.voiceStatus))this.cancelWork();this.updateVoiceStatus({voiceMode:false});}else{this.updateVoiceStatus({voiceMode:true});void this.startVoice();}},
  voiceAction(){if(this.data.voiceStatus==='recording')void this.finishVoice();else void this.startVoice();},
  async startVoice(){if(!voiceEnabled(this.data.doctor))return;if(this.data.busy||this.data.dataBlocked||['starting','recording','transcribing'].includes(this.data.voiceStatus))return;this.stopSpeaking();const run=++this._voiceRun;this.updateVoiceStatus({voiceMode:true,voiceStatus:'starting',voiceError:'',interactionLocked:true});
    try{await this.runtime.speech.startRecording({onState:state=>{const value=typeof state==='string'?state:state.status;if(value==='recording'&&this._alive&&run===this._voiceRun)this.updateVoiceStatus({voiceStatus:'recording'});}});if(!this._alive||run!==this._voiceRun)return;this._voiceStarted=Date.now();this.updateVoiceStatus({voiceStatus:'recording',voiceElapsed:'00:00'});this._voiceTimer=setInterval(()=>{const sec=Math.min(60,Math.floor((Date.now()-this._voiceStarted)/1000));this.setData({voiceElapsed:sec===60?'01:00':`00:${String(sec).padStart(2,'0')}`});},1000);this._voiceLimit=setTimeout(()=>void this.finishVoice(),59000);
    }catch(e){if(this._alive&&run===this._voiceRun)this.updateVoiceStatus({voiceStatus:'error',voiceError:e.message||'无法开启麦克风，请检查授权。',interactionLocked:false});}
  },
  async finishVoice(){if(this.data.voiceStatus!=='recording')return;const run=this._voiceRun;this.clearVoiceTimers();this.updateVoiceStatus({voiceStatus:'transcribing'});try{const result=await this.runtime.speech.stopRecording();if(!this._alive||run!==this._voiceRun)return;this.setData({interactionLocked:false});if(this.data.doctor.builder&&this.data.doctor.builder.voice.autoSend===false){this.updateVoiceStatus({voiceMode:false,voiceStatus:'ready',input:result.text});this.saveDraft(result.text);return;}await this.sendQuestion(result.text,true,'',result.durationSeconds);}catch(e){if(this._alive&&run===this._voiceRun)this.updateVoiceStatus({voiceStatus:'error',voiceError:e.message||'语音识别失败，请重试。',interactionLocked:false});}},
  clearVoiceTimers(){clearInterval(this._voiceTimer);clearTimeout(this._voiceLimit);this._voiceTimer=null;this._voiceLimit=null;},
  cancelWork(){this._run=(this._run||0)+1;this._voiceRun=(this._voiceRun||0)+1;this.clearVoiceTimers();if(this._request)this._request.cancel();this._request=null;if(this.runtime)this.runtime.speech.cancelRecording();this.stopSpeaking();if(this._alive)this.updateVoiceStatus({busy:false,interactionLocked:false,voiceStatus:'ready',voiceError:'',streamingReply:''});},
  dismissHint(){this.dismissVoiceError();},
  dismissVoiceError(){this.runtime.data.set(this.slug,'voice-input-hint-dismissed',true);this.updateVoiceStatus({voiceError:'',voiceErrorExpanded:false,voiceStatus:'ready',playbackStatus:'idle'});},
  toggleVoiceError(){
    this._manualChatScrollUntil=0;this.pauseChatFollow();clearTimeout(this._errorScrollTimer);this._errorScrollTimer=null;
    const expanded=!this.data.voiceErrorExpanded,owner=this._accountKey,run=this._scrollRun,error=this.data.voiceError;
    const active=()=>this._alive&&!this._hidden&&!this.data.dataBlocked&&this.data.renderedTab==='ask'&&owner===this._accountKey&&run===this._scrollRun&&this.data.voiceErrorExpanded&&this.data.voiceError===error;
    this.setData({voiceErrorExpanded:expanded},()=>{
      this.measureChatViewport();if(!expanded||!error)return;
      const locate=()=>{
        this._errorScrollTimer=null;if(!active()||typeof this.createSelectorQuery!=='function')return;
        let viewport,details;const query=this.createSelectorQuery();
        query.select('.messages').boundingClientRect(rect=>{viewport=rect;});query.select('.voice-error-details').boundingClientRect(rect=>{details=rect;});
        query.exec(()=>{
          if(!active()||!viewport||!details||!Number.isFinite(viewport.top)||!Number.isFinite(details.top))return;
          const current=this._lastChatScrollTop||0;let top=Math.max(0,current+details.top-viewport.top-8);
          if(top===this.data.chatScrollTop&&Math.abs(top-current)>1)top+=1;
          this.setData({scrollTarget:'',chatScrollAnimated:false,chatScrollTop:top});
        });
      };
      if(typeof wx.nextTick==='function')wx.nextTick(locate);else{this._errorScrollTimer=setTimeout(locate,16);if(this._errorScrollTimer&&this._errorScrollTimer.unref)this._errorScrollTimer.unref();}
    });
  },
  openPanel(e){const panel=typeof e==='string'?e:e.currentTarget.dataset.panel;if(panel==='records'&&usesWellness(this.data.doctor)&&!this.data.doctor.builder){this.openWellness('report');return;}enterSheet(this,{activePanel:panel,panelTitle:panel==='about'?`关于${this.data.doctor.name}智能体`:panelTitles[panel]||'',panelEyebrow:panelEyebrows[panel]||'',privacyParagraphs,draftName:this.data.profileName});},
  openLegacyRecords(){enterSheet(this,{activePanel:'records',panelTitle:panelTitles.records,panelEyebrow:panelEyebrows.records});},
  closePanel(){const panel=this.data.activePanel,owner=this._accountKey;if(!panel)return;exitSheet(this,()=>{if(this._alive&&owner===this._accountKey&&this.data.activePanel===panel)this.setData({activePanel:'',sheetMotion:'',backdropMotion:''});});},noop(){},
  draftNameChanged(e){this.setData({draftName:e.detail.value});},
  saveProfile(){if(this.runtime.data.set(this.slug,'profile-name',this.data.draftName.trim()||'游客账户'))this.closePanel();},
  continueQuestion(e){this.closePanel();this.openAsk({question:e.currentTarget.dataset.question,withHealthContext:e.currentTarget.dataset.health});},
  deleteFavorite(e){this.runtime.data.set(this.slug,'favorites',(this.runtime.data.get(this.slug,'favorites',[]).value||[]).filter(f=>f.id!==e.currentTarget.dataset.id));},
  async clearSection(e){const section=e.currentTarget.dataset.section;if(!['favorites','chat-messages','health-records'].includes(section))return;if(!await confirm('确定清空这些记录吗？'))return;if(section==='chat-messages'){this.cancelWork();this.saveMessages([this.greeting]);}else{this.runtime.data.set(this.slug,section,[]);if(section==='health-records')this.runtime.data.set(this.slug,'health-daily-tasks',dailyTasksFromRecords([],this.data.experience.steps));}},
  async deleteRecord(e){if(!await confirm('确定删除这条健康记录吗？'))return;const records=this.runtime.data.get(this.slug,'health-records',[]).value.filter(r=>r.id!==e.currentTarget.dataset.id);this.runtime.data.set(this.slug,'health-records',records);this.runtime.data.set(this.slug,'health-daily-tasks',dailyTasksFromRecords(records,this.data.experience.steps));},
  goManage(){this.closePanel();this.switchTab('manage');},
  togglePrivacy(e){const key=e.currentTarget.dataset.key;if(!['saveChat','voicePlayback','reminders'].includes(key))return;return this.changePrivacy({currentTarget:e.currentTarget,detail:{value:!this.data.privacy[key]}});},
  async changePrivacy(e){const key=e.currentTarget.dataset.key;const value=e.detail.value;if(key==='saveChat'&&!value&&!await confirm(this.data.account.user?'关闭后将清除账户中保存的对话与心理自评，其他设备也会同步此设置。确定继续吗？':'关闭后将清除本机对话与心理自评，确定继续吗？')){this.setData({'privacy.saveChat':true});return;}
    if(key==='saveChat'&&!value){this.cancelWork();this.runtime.data.set(this.slug,'chat-messages',[]);this.runtime.data.set(this.slug,'chat-assessments-v1',null);this._volatile=[this.greeting];}if(key==='voicePlayback'&&!value)this.stopSpeaking();this.runtime.data.set(this.slug,'privacy',{...this.data.privacy,[key]:value});
  },
  async resetGuest(){if(!await confirm('这将清除本机保存的对话、收藏、健康记录、任务和游客资料，且无法恢复。确定开始新的游客体验吗？'))return;this.cancelWork();try{this.runtime.data.resetGuest(this.slug);}catch(e){this.notice(e);return;}sessionView.clearOwner('guest');this._volatile=[];this._drafts={};this._messageDisclosure={};this._replay=null;this.clearFeedback();this.setData({input:'',voiceMode:false,shareHealthRecords:false,healthContextNotice:'',copiedId:''});this.closePanel();this.switchTab('home');this.refreshData();},
  async accountAction(e){if(this.data.accountBusy)return;const action=e.currentTarget.dataset.action;this.setData({accountBusy:true,syncNotice:''});try{
    if(action==='login')await this.runtime.session.login(this.slug);
    if(action==='refresh'){await this.runtime.session.refresh();await this.runtime.data.load(this.slug);await this.runtime.data.flush();}
    if(action==='import'){if(!await confirm('将此智能体的本机游客记录合并到微信账户？请确认这些记录属于你本人；云端已有资料会保留。'))return;await this.runtime.data.importGuest(this.slug);this.setData({syncNotice:'本机记录已合并到微信账户。'});}
    if(action==='logout'){await this.runtime.data.flush();const pending=sections.some(s=>['pending','saving','offline','error','conflict'].includes(this.runtime.data.get(this.slug,s,null).status));if(pending&&!await confirm('当前账户还有尚未同步的记录，仍要退出吗？本机缓存会保留在此账户下。'))return;await this.runtime.session.logout();}
  }catch(e){this.notice(e);}finally{if(this._alive){this.setData({accountBusy:false});this.refreshData();}}},
  async resolveConflict(e){const d=e.currentTarget.dataset;if(!await confirm(d.choice==='cloud'?'使用云端版本会放弃本机这项修改，确定继续吗？':'保留本机会替换云端这项记录，确定继续吗？'))return;try{await this.runtime.data.resolveConflict(this.slug,d.section,d.choice);}catch(e){this.notice(e);}},
  openPrivacy(){wx.navigateTo({url:'/pages/policy/index?type=privacy'});},
  onShareAppMessage(){return{title:this.data.doctor?`${this.data.doctor.name} · 健康科普智能体`:'Medtalent 智能体',path:`/pages/doctor/index?slug=${encodeURIComponent(this.slug)}${this.data.tab==='ask'?'&tab=ask':''}`,imageUrl:'/assets/brand/medtalent-logo.png'};}
});
