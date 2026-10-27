const { builderLayoutClass, canWriteBuilderData } = require('../../utils/models/catalog');
'use strict';
const { getRuntime } = require('../../utils/runtime');
const section = 'builder-assessments-v1';
const blank = () => ({version:1,results:[]});
Component({
  options:{styleIsolation:'apply-shared'}, properties:{doctor:{type:Object,value:null}},
  data:{definitions:[],active:null,questions:[],results:[],notice:'',canEdit:true,storageNotice:''},
  observers:{doctor(){if(this.runtime)this.refresh();}},
  lifetimes:{attached(){this._alive=true;this.runtime=getRuntime();this._off=this.runtime.subscribe(()=>this.refresh());this.refresh();},detached(){this._alive=false;if(this._off)this._off();}},
  methods:{
    owner(){const account=this.runtime.session.get();return account.user&&account.user.id||'guest:'+(this.runtime.data.getVisitorId?this.runtime.data.getVisitorId():'guest');},
    refresh(){const doctor=this.properties.doctor;if(!doctor)return;const scope=doctor.slug+':'+this.owner();if(scope!==this._scope){this._scope=scope;this.answers={};this.setData({active:null,questions:[],notice:''});}const meta=this.runtime.data.get(doctor.slug,section,blank()),value=meta.value||blank();this.setData({layoutClass:builderLayoutClass(doctor),definitions:doctor.builder&&doctor.builder.assessments||[],results:(value.results||[]).map(result=>({...result,dateLabel:new Date(result.createdAt).toLocaleString('zh-CN')})),readOnly:!canWriteBuilderData(doctor,'assessments'),canDelete:meta.canEdit!==false,canEdit:meta.canEdit!==false&&canWriteBuilderData(doctor,'assessments'),storageNotice:this.runtime.storageNotice(doctor.slug,section)||''});},
    open(event){const active=this.data.definitions.find(item=>item.id===event.currentTarget.dataset.id);if(!active)return;this.answers={};this.setData({active,questions:active.questions.map((question,index)=>({...question,index:index+1,choices:question.options.map((option,choice)=>({...option,choice:String(choice),checked:false}))})),notice:''});},
    answer(event){const question=this.data.active.questions.find(item=>item.id===event.currentTarget.dataset.id),choice=question&&question.options[Number(event.detail.value)];if(choice)this.answers[question.id]=choice.value;},
    cancel(){this.answers={};this.setData({active:null,questions:[]});},
    save(){const doctor=this.properties.doctor,active=this.data.active;if(!active||!this.data.canEdit)return;if(active.questions.some(question=>this.answers[question.id]===undefined)){this.setData({notice:'请完成所有问题后再保存。'});return;}const answers=active.questions.map(question=>this.answers[question.id]),result={id:'assessment-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),assessmentId:active.id,title:active.title,answers,score:answers.reduce((sum,value)=>sum+value,0),createdAt:new Date().toISOString()},band=(active.resultBands||[]).find(band=>result.score>=band.min&&result.score<=band.max);if(active.source)result.source=active.source;if(active.version)result.definitionVersion=active.version;if(band){result.resultLabel=band.label;if(band.description)result.resultDescription=band.description;}const current=this.runtime.data.get(doctor.slug,section,blank()).value||blank();if(!this.runtime.data.set(doctor.slug,section,{version:1,results:[result,...(current.results||[])].slice(0,100)})){this.setData({notice:'保存暂未完成，请重试。'});return;}this.cancel();this.setData({notice:'自评已保存。总分仅用于个人记录，不构成诊断。'});this.refresh();},
    async remove(event){const id=event.currentTarget.dataset.id,scope=this._scope,confirmed=await new Promise(resolve=>wx.showModal({title:'请确认',content:'确定删除这条自评记录吗？',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(!confirmed||!this._alive||scope!==this._scope)return;const slug=this.properties.doctor.slug,current=this.runtime.data.get(slug,section,blank()).value||blank();this.runtime.data.set(slug,section,{version:1,results:(current.results||[]).filter(item=>item.id!==id)});},
    ask(event){const result=this.data.results.find(item=>item.id===event.currentTarget.dataset.id);if(result)this.triggerEvent('ask',{question:'我完成“'+result.title+'”，总分'+result.score+'。我想了解怎样继续观察日常感受。'});},
    retry(){this.runtime.data.retry(this.properties.doctor.slug,section);}
  }
});
