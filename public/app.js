const $=s=>document.querySelector(s);
const CAMPAIGN_STORAGE_KEY='cold-mailbot-current-campaign-id';
const POLL_MS=4000;
const PREVIEW_LEN=320;
const BULK_DELAY_MIN_MS=1000;
const BULK_DELAY_MAX_MS=10000;
const BULK_DOMAIN_LIMIT=30;
const state={view:'campaign',file:null,campaign:null,campaignSig:'',expanded:null,selectedRows:new Set(),selectionAnchorRow:null,previews:new Map(),poll:null,pollBusy:false,eventSource:null,eventReconnect:null,eventCampaignId:'',verification:new Map(),bulkSend:{active:false,total:0,sent:0,failed:0,currentRow:null,nextDelayMs:0,message:'',stopRequested:false},mailSenders:{loading:false,error:'',list:[],selectedEmail:'',selectedName:'',defaultEmail:'',defaultName:'',bulkUsageByDomain:{},bulkUsageBySender:{}}};

const form=$('#leadForm');
const navBtns=document.querySelectorAll('.nav-item');
const mailerView=$('#mailerView');
const campaignView=$('#campaignView');
const warmupView=$('#warmupView');
const breadcrumb=$('#breadcrumb');
const pageTitle=$('#pageTitle');
const statusBadge=$('#statusBadge');
const complianceBadge=$('#complianceBadge');
const subjectOutput=$('#subjectOutput');
const bodyOutput=$('#bodyOutput');
const complianceOutput=$('#complianceOutput');
const variantsOutput=$('#variantsOutput');
const rawOutput=$('#rawOutput');
const sendPreviewCard=$('#sendPreviewCard');
const draftProgressBar=$('#draftProgressBar');
const draftProgressText=$('#draftProgressText');

const uploadZone=$('#uploadZone');
const uploadStateText=$('#uploadStateText');
const fileInput=$('#campaignFile');
const countInput=$('#campaignCount');
const draftIterInput=$('#draftIterations');
const startRunBtn=$('#startRun');
const runConsole=$('#runConsole');
const runIdLabel=$('#runIdLabel');
const runStatusTitle=$('#runStatusTitle');
const runStatusBadge=$('#runStatusBadge');
const pauseResumeBtn=$('#pauseResumeBtn');
const stopRunBtn=$('#stopRunBtn');
const resetRunBtn=$('#resetRunBtn');
const runProgressText=$('#runProgressText');
const runEtaText=$('#runEtaText');
const runMetaText=$('#runMetaText');
const runProgressBar=$('#runProgressBar');
const queueRowsEl=$('#queueRows');
const queueSelectAllBtn=$('#queueSelectAllBtn');
const queueDeleteSelectedBtn=$('#queueDeleteSelectedBtn');
const queueSelectedMeta=$('#queueSelectedMeta');
const runSummary=$('#runSummary');
const historyList=$('#historyList');
const sendAllBtn=$('#sendAllBtn');
const sendAllMeta=$('#sendAllMeta');
const sendAllCountInput=$('#sendAllCountInput');
const sendBulk30Btn=$('#sendBulk30Btn');
const senderSelect=$('#senderSelect');
const senderMeta=$('#senderMeta');
const refreshSendersBtn=$('#refreshSendersBtn');

const ollamaDot=$('#ollamaDot');
const ollamaText=$('#ollamaText');
const mailDot=$('#mailDot');
const mailText=$('#mailText');
const chromeDot=$('#chromeDot');
const chromeText=$('#chromeText');

const sampleLead={
companyName:'Acme Logistics',websiteUrl:'https://acme-logistics.com',industry:'Logistics',
companyDescription:'Mid-market logistics provider focused on fulfillment and regional freight operations.',
linkedInSummary:'Scaling operations across multiple depots.',prospectContextDetails:'Expanding depots across the North.',
operationalArea:'Dispatch and SLA tracking',painHypothesis:'Manual dispatch coordination causes delays and inconsistent response times.',
targetPersona:'Operations Manager',yourServiceAngle:'Workflow automation for dispatch and SLA tracking.',
productOrService:'Workflow automation for dispatch and SLA tracking.',primaryOutcome:'Faster dispatch response times and clearer SLA visibility.',
frontEndOfferDeliverable:'1-page dispatch and SLA checklist',timeOrEffortConstraint:'takes 2 minutes to review',objectionToPreHandle:'you may already have a TMS'
};

const j=v=>{try{return JSON.stringify(v,null,2);}catch{return String(v);}};
const statusNorm=s=>['running','paused','completed','stopped','failed'].includes(String(s||'').toLowerCase())?String(s).toLowerCase():'queued';
const fmtMs=ms=>{const n=Math.max(0,Number(ms)||0);if(n<1000)return `${n}ms`;const s=n/1000;if(s<60)return `${s.toFixed(1)}s`;return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;};
const ago=iso=>{const ts=Date.parse(String(iso||''));if(!Number.isFinite(ts))return '-';const d=Math.max(0,Math.round((Date.now()-ts)/1000));if(d<60)return `${d}s ago`;if(d<3600)return `${Math.floor(d/60)}m ago`;return `${Math.floor(d/3600)}h ago`;};
const compact=v=>String(v||'').trim();
const lower=v=>compact(v).toLowerCase();
const senderDomainFromEmail=email=>{const v=lower(email);const at=v.lastIndexOf('@');if(at<1||at>=v.length-1)return'';return v.slice(at+1);};
function senderActiveFlag(item){if(typeof item?.active==='boolean')return item.active;if(item?.active!==undefined&&item?.active!==null){const n=lower(item.active);if(['false','0','no','off','inactive','disabled'].includes(n))return false;if(['true','1','yes','on','active','enabled'].includes(n))return true;}const status=lower(item?.status);if(status){if(['inactive','disabled','blocked'].includes(status))return false;if(['active','enabled'].includes(status))return true;}return true;}
function normalizeSender(item){const email=compact(item?.email);return{id:Number.isFinite(Number(item?.id))?Number(item.id):null,name:compact(item?.name),email,domain:senderDomainFromEmail(email),active:senderActiveFlag(item)};}
function domainUsage(domain){const d=lower(domain);if(!d)return 0;return Math.max(0,Number(state.mailSenders.bulkUsageByDomain?.[d]||0));}
function senderUsage(email){const e=lower(email);if(!e)return 0;return Math.max(0,Number(state.mailSenders.bulkUsageBySender?.[e]||0));}
function senderRemainingForBulk(sender){const domain=senderDomainFromEmail(sender?.email||'');if(!domain)return 0;return Math.max(0,BULK_DOMAIN_LIMIT-domainUsage(domain));}
function selectedSender(){const email=lower(state.mailSenders.selectedEmail);const list=Array.isArray(state.mailSenders.list)?state.mailSenders.list:[];const found=list.find(item=>lower(item.email)===email);if(found)return found;const fallbackEmail=compact(state.mailSenders.defaultEmail);if(fallbackEmail)return {id:null,email:fallbackEmail,name:compact(state.mailSenders.defaultName),domain:senderDomainFromEmail(fallbackEmail),active:true};return null;}
function incDomainUsage(domain,count=1){const d=lower(domain);if(!d)return;const next=Math.max(0,domainUsage(d)+Math.max(0,Number(count)||0));state.mailSenders.bulkUsageByDomain[d]=next;}
function incSenderUsage(email,count=1){const e=lower(email);if(!e)return;const next=Math.max(0,senderUsage(e)+Math.max(0,Number(count)||0));state.mailSenders.bulkUsageBySender[e]=next;}
function campaignFingerprint(c){const rows=Array.isArray(c?.rows)?c.rows:[];return j({id:c?.id,status:c?.status,processedRows:c?.processedRows,succeeded:c?.succeeded,failed:c?.failed,resumeFromRow:c?.resumeFromRow,pausedAtRow:c?.pausedAtRow,rows:rows.map(r=>[r?.rowNumber,r?.status,r?.durationMs,r?.error,r?.jinaFetchMethod,r?.jinaError,r?.emailStatus,r?.emailSubject,r?.emailTo,r?.docFileName,r?.startedAt,r?.completedAt])});}
function setCampaign(next,{force=false}={}){
if(!next)return false;
const nextId=String(next?.id||'');
const prevId=String(state.campaign?.id||'');
if(nextId&&nextId!==prevId){
state.verification.clear();
state.selectedRows.clear();
state.selectionAnchorRow=null;
state.mailSenders.bulkUsageByDomain={};
state.mailSenders.bulkUsageBySender={};
closeVerificationPopup();
void loadMailSenders({silent:true});
}
const fp=campaignFingerprint(next);
if(!force&&fp===state.campaignSig)return false;
state.campaign=next;
state.campaignSig=fp;
const keep=new Set((Array.isArray(next?.rows)?next.rows:[]).map(r=>Number(r?.rowNumber)).filter(n=>Number.isFinite(n)));
for(const selected of Array.from(state.selectedRows)){if(!keep.has(Number(selected)))state.selectedRows.delete(Number(selected));}
if(!keep.has(Number(state.selectionAnchorRow)))state.selectionAnchorRow=null;
return true;
}

function setView(v){state.view=v;navBtns.forEach(b=>b.classList.toggle('active',b.dataset.view===v));mailerView.classList.toggle('active-view',v==='mailer');campaignView.classList.toggle('active-view',v==='campaign');if(warmupView)warmupView.classList.toggle('active-view',v==='warmup');if(v==='mailer'){breadcrumb.textContent='Cold Mailbot / The Mailer';pageTitle.textContent='Content Console';}else if(v==='warmup'){breadcrumb.textContent='Cold Mailbot / Warmup';pageTitle.textContent='Email Warmup';}else{breadcrumb.textContent='Cold Mailbot / Campaign';pageTitle.textContent='Run Console';}}
function setMainStatus(t,text){statusBadge.className=`pill ${t==='success'?'pill-pass':t==='error'?'pill-fail':'pill-idle'}`;statusBadge.textContent=String(text||'IDLE').toUpperCase();}
function setComplianceBadge(c){if(!c||typeof c!=='object'){complianceBadge.className='pill pill-idle';complianceBadge.textContent='No checks';return;}const dv=Array.isArray(c?.draft?.violations)?c.draft.violations.length:0;const sv=Array.isArray(c?.subject?.violations)?c.subject.violations.length:0;const bad=dv+sv;const ok=c?.draft?.ok!==false&&c?.subject?.ok!==false&&!bad;complianceBadge.className=`pill ${ok?'pill-pass':'pill-fail'}`;complianceBadge.textContent=ok?'PASS':`FAIL ${bad}`;}
function setDraftProgress(p,text){draftProgressBar.style.width=`${Math.max(0,Math.min(100,p))}%`;draftProgressText.textContent=text;}
function lead(){const f=new FormData(form);return {companyName:String(f.get('companyName')||'').trim(),websiteUrl:String(f.get('websiteUrl')||'').trim(),industry:String(f.get('industry')||'').trim(),companyDescription:String(f.get('companyDescription')||'').trim(),linkedInSummary:String(f.get('linkedInSummary')||'').trim(),prospectContextDetails:String(f.get('prospectContextDetails')||'').trim(),operationalArea:String(f.get('operationalArea')||'').trim(),painHypothesis:String(f.get('painHypothesis')||'').trim(),targetPersona:String(f.get('targetPersona')||'').trim(),yourServiceAngle:String(f.get('yourServiceAngle')||'').trim(),productOrService:String(f.get('productOrService')||'').trim(),primaryOutcome:String(f.get('primaryOutcome')||'').trim(),frontEndOfferDeliverable:String(f.get('frontEndOfferDeliverable')||'').trim(),timeOrEffortConstraint:String(f.get('timeOrEffortConstraint')||'').trim(),objectionToPreHandle:String(f.get('objectionToPreHandle')||'').trim()};}
function fill(vals){Object.entries(vals||{}).forEach(([k,v])=>{const i=form.elements.namedItem(k);if(i)i.value=v;});}

async function api(endpoint,payload,method){const m=method||(endpoint==='/health'?'GET':'POST');const r=await fetch(endpoint,{method:m,cache:'no-store',headers:m==='GET'?{'Cache-Control':'no-cache'}:{'Content-Type':'application/json','Cache-Control':'no-cache'},body:m==='GET'?undefined:JSON.stringify(payload)});if(r.status===304)return {ok:true,notModified:true};const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error||`Request failed (${r.status})`);return d;}
function disableMailer(x){['#fillSample','#testHealth','#generateDraft','#generateSubject','#generateVariants','#generateFull'].forEach(s=>{const n=$(s);if(n)n.disabled=x;});}
async function mailerRun(fn){try{disableMailer(true);setMainStatus('loading','RUNNING');await fn();setMainStatus('success','SUCCESS');}catch(e){rawOutput.textContent=j({error:e.message||'Request failed'});bodyOutput.textContent=e.message||'Request failed';setMainStatus('error','ERROR');setComplianceBadge(null);}finally{disableMailer(false);}}
function renderSenderSelect(){if(!senderSelect)return;const list=Array.isArray(state.mailSenders.list)?state.mailSenders.list:[];senderSelect.innerHTML='';if(state.mailSenders.loading){const option=document.createElement('option');option.value='';option.textContent='Loading senders...';senderSelect.appendChild(option);senderSelect.disabled=true;return;}if(list.length<1){const option=document.createElement('option');option.value='';option.textContent='No senders';senderSelect.appendChild(option);senderSelect.disabled=true;return;}const selectedEmail=lower(state.mailSenders.selectedEmail);list.forEach(item=>{const option=document.createElement('option');option.value=item.email;const used=senderUsage(item.email);const isSelected=lower(item.email)===selectedEmail;const statusLabel=isSelected?'[ACTIVE]':(item.active?'[AVAILABLE]':'[INACTIVE]');option.textContent=`${item.email} ${statusLabel} | ${used}/${BULK_DOMAIN_LIMIT} used`;senderSelect.appendChild(option);});const selectedItem=list.find(item=>lower(item.email)===selectedEmail);if(selectedItem){state.mailSenders.selectedEmail=selectedItem.email;state.mailSenders.selectedName=selectedItem.name||'';senderSelect.value=selectedItem.email;}else{const fallback=list.find(item=>item.active)||list[0];state.mailSenders.selectedEmail=fallback?.email||'';state.mailSenders.selectedName=fallback?.name||'';senderSelect.value=state.mailSenders.selectedEmail;}senderSelect.disabled=false;}
function renderSenderMeta(){if(!senderMeta)return;const sender=selectedSender();if(!sender){senderMeta.textContent='No sender selected.';return;}const domain=sender.domain||senderDomainFromEmail(sender.email);const usedBySender=senderUsage(sender.email);const domainRemaining=Math.max(0,BULK_DOMAIN_LIMIT-domainUsage(domain));const availability=sender.active===false?'INACTIVE':'ACTIVE';senderMeta.textContent=`Sender: ${sender.email} (${availability}) | Sender usage: ${usedBySender}/${BULK_DOMAIN_LIMIT} | Domain remaining: ${domainRemaining}`;}
async function loadMailSenders({silent=false}={}){if(state.mailSenders.loading)return;state.mailSenders.loading=true;state.mailSenders.error='';renderSenderSelect();if(refreshSendersBtn)refreshSendersBtn.disabled=true;try{const cid=compact(state.campaign?.id);const endpoint=cid?`/api/mail/senders?campaignId=${encodeURIComponent(cid)}`:'/api/mail/senders';const payload=await api(endpoint,null,'GET');const allSenders=(Array.isArray(payload?.senders)?payload.senders:[]).map(normalizeSender).filter(item=>Boolean(item.email));const activeSenders=allSenders.filter(item=>item.active);const usagePayload=payload?.domainUsage&&typeof payload.domainUsage==='object'?payload.domainUsage:{};const senderUsagePayload=payload?.senderUsage&&typeof payload.senderUsage==='object'?payload.senderUsage:{};const usageByDomain={};Object.entries(usagePayload).forEach(([domain,count])=>{const key=lower(domain);if(!key)return;usageByDomain[key]=Math.max(0,Number(count)||0);});const usageBySender={};Object.entries(senderUsagePayload).forEach(([email,count])=>{const key=lower(email);if(!key)return;usageBySender[key]=Math.max(0,Number(count)||0);});state.mailSenders.bulkUsageByDomain=usageByDomain;state.mailSenders.bulkUsageBySender=usageBySender;state.mailSenders.defaultEmail=compact(payload?.defaultSender?.email);state.mailSenders.defaultName=compact(payload?.defaultSender?.name);state.mailSenders.list=allSenders;const selectedEmail=lower(state.mailSenders.selectedEmail);const selectedActive=activeSenders.find(item=>lower(item.email)===selectedEmail);const defaultActive=activeSenders.find(item=>lower(item.email)===lower(state.mailSenders.defaultEmail));const preferred=selectedActive||defaultActive||activeSenders[0]||allSenders[0]||null;state.mailSenders.selectedEmail=preferred?.email||'';state.mailSenders.selectedName=preferred?.name||'';renderSenderSelect();renderSenderMeta();if(!silent&&state.mailSenders.list.length<1){setMainStatus('error','NO SENDERS');}}catch(e){state.mailSenders.error=e.message||'Failed to load senders';if(!silent){rawOutput.textContent=j({error:state.mailSenders.error});setMainStatus('error','SENDERS FAILED');}renderSenderSelect();renderSenderMeta();}finally{state.mailSenders.loading=false;if(refreshSendersBtn)refreshSendersBtn.disabled=false;renderSenderSelect();renderSenderMeta();}}

function renderVariants(v){if(!Array.isArray(v)||!v.length){variantsOutput.innerHTML='<p class="muted">No variants yet.</p>';return;}variantsOutput.innerHTML='';v.forEach((it,idx)=>{const a=document.createElement('article');a.className='variant-item';a.innerHTML=`<h4 class="mono">Variant ${it.label||String.fromCharCode(65+idx)}</h4><p>Subject: ${it.subject||'-'}</p><p>${it.body||'-'}</p>`;variantsOutput.appendChild(a);});}
function renderMailer(d){if(Array.isArray(d?.variants)){subjectOutput.textContent='Generated variants';bodyOutput.textContent=`${d.variants.length} variants returned.`;complianceOutput.textContent=j({attempts:d.attempts,requiresHumanReview:d.requiresHumanReview});renderVariants(d.variants);rawOutput.textContent=j(d);setComplianceBadge(null);return;}subjectOutput.textContent=d.subject||'No subject returned.';bodyOutput.textContent=d.body||d.draft||'No body returned.';complianceOutput.textContent=d.compliance?j(d.compliance):'No compliance data.';rawOutput.textContent=j(d);setComplianceBadge(d.compliance);renderVariants([]);}

async function refreshChromeCookiesStatus(){if(!chromeDot||!chromeText)return;try{const d=await api('/api/settings/chrome-cookies',null,'GET');chromeDot.className=`dot ${d?.available?'dot-green':'dot-grey'}`;chromeText.textContent=d?.available?'Available':'Unavailable';const holder=$('#chromeCookiesStatus');if(holder)holder.title=d?.available?'Chrome cookies available':(d?.reason||'Chrome cookies unavailable');}catch{chromeDot.className='dot dot-red';chromeText.textContent='Error';}}
async function refreshHealth(show){await refreshChromeCookiesStatus();try{const d=await api('/health',null,'GET');ollamaDot.className=`dot ${d?.ok?'dot-green':'dot-red'}`;ollamaText.textContent=d?.ok?'Healthy':'Offline';mailDot.className=`dot ${d?.mailConfigured?'dot-green':'dot-amber'}`;mailText.textContent=d?.mailConfigured?'Configured':'Unconfigured';if(show){rawOutput.textContent=j(d);subjectOutput.textContent='Health endpoint OK.';bodyOutput.textContent=`Model: ${d.model}`;complianceOutput.textContent='No compliance data for health.';}}catch(e){ollamaDot.className='dot dot-red';ollamaText.textContent='Unavailable';if(show){rawOutput.textContent=j({error:e.message});}}}

function getDraftIterations(){const n=Number.parseInt(draftIterInput.value,10);if(!Number.isFinite(n)||n<1){draftIterInput.value='1';return 1;}return n;}
async function doDraft(){const l=lead();const n=getDraftIterations();let out=null;setDraftProgress(0,`0 / ${n}`);for(let i=1;i<=n;i++){out=await api('/api/content/draft',{lead:l});setDraftProgress(Math.round((i/n)*100),`${i} / ${n}`);}if(out)renderMailer(out);}

function setStoreId(id){try{if(id)localStorage.setItem(CAMPAIGN_STORAGE_KEY,id);}catch{}}
function getStoreId(){try{return localStorage.getItem(CAMPAIGN_STORAGE_KEY)||'';}catch{return '';}}
function clearStoreId(){try{localStorage.removeItem(CAMPAIGN_STORAGE_KEY);}catch{}}

function closeVerificationPopup(){document.getElementById('verification-popup')?.remove();}
function closeCampaignEvents(keepCampaignId=false){if(state.eventReconnect){clearTimeout(state.eventReconnect);state.eventReconnect=null;}if(state.eventSource){state.eventSource.close();state.eventSource=null;}if(!keepCampaignId)state.eventCampaignId='';}
function markVerification(rowNumber,payload){const rn=Number(rowNumber);if(!Number.isFinite(rn)||rn<1)return;state.verification.set(rn,{rowNumber:rn,...(payload||{})});}
function clearVerification(rowNumber){const rn=Number(rowNumber);if(!Number.isFinite(rn)||rn<1)return;state.verification.delete(rn);}
function parseEventRow(event){return Number(event?.rowNumber||event?.rowIndex||0);}
function showVerificationPopup(event){const campaignId=String(event?.campaignId||state.campaign?.id||'').trim();const rowNumber=parseEventRow(event);const domain=String(event?.domain||'').trim();const message=String(event?.message||'Verification required.').trim();if(!campaignId||!rowNumber)return;closeVerificationPopup();const popup=document.createElement('div');popup.id='verification-popup';popup.innerHTML=`<div class="verification-overlay"><div class="verification-modal"><div class="verification-icon">!</div><h3>Verification Required</h3><p class="verification-domain">${domain||'target website'}</p><p class="verification-message">${message}</p><div class="verification-steps"><div class="step">1. Look at the opened Chrome window</div><div class="step">2. Solve the verification/CAPTCHA</div><div class="step">3. Click Continue</div></div><div class="verification-actions"><button class="btn-verification-continue" type="button">Continue</button><button class="btn-verification-skip" type="button">Skip This Row</button></div></div></div>`;const continueBtn=popup.querySelector('.btn-verification-continue');const skipBtn=popup.querySelector('.btn-verification-skip');continueBtn?.addEventListener('click',async()=>{continueBtn.disabled=true;try{await api(`/api/campaigns/${encodeURIComponent(campaignId)}/resume-row`,{rowIndex:rowNumber});clearVerification(rowNumber);closeVerificationPopup();try{const fresh=await api(`/api/campaigns/${encodeURIComponent(campaignId)}`,null,'GET');if(fresh?.campaign&&setCampaign(fresh.campaign)){renderCampaign();}}catch{}}catch(e){rawOutput.textContent=j({error:e.message||'Resume failed'});continueBtn.disabled=false;}});skipBtn?.addEventListener('click',async()=>{skipBtn.disabled=true;try{await api(`/api/campaigns/${encodeURIComponent(campaignId)}/skip-row`,{rowIndex:rowNumber});clearVerification(rowNumber);closeVerificationPopup();try{const fresh=await api(`/api/campaigns/${encodeURIComponent(campaignId)}`,null,'GET');if(fresh?.campaign&&setCampaign(fresh.campaign,{force:true})){renderCampaign();}}catch{}}catch(e){rawOutput.textContent=j({error:e.message||'Skip failed'});skipBtn.disabled=false;}});document.body.appendChild(popup);}
function handleCampaignEvent(event){if(!event||typeof event!=='object')return;const eventType=String(event.type||'').toLowerCase();const rowNumber=parseEventRow(event);if(eventType==='verification_required'){markVerification(rowNumber,{status:'awaiting',domain:event.domain,message:event.message});showVerificationPopup(event);renderCampaign();return;}if(eventType==='verification_cleared'){clearVerification(rowNumber);closeVerificationPopup();renderCampaign();return;}if(eventType==='row_skipped'){clearVerification(rowNumber);closeVerificationPopup();renderCampaign();}}
function connectCampaignEvents(campaignId){const cid=String(campaignId||'').trim();if(!cid)return;if(state.eventCampaignId===cid&&state.eventSource)return;closeCampaignEvents();state.eventCampaignId=cid;try{const es=new EventSource(`/api/campaigns/${encodeURIComponent(cid)}/events`);state.eventSource=es;es.onmessage=(evt)=>{try{const payload=JSON.parse(evt.data||'{}');handleCampaignEvent(payload);}catch{}};es.onerror=()=>{if(state.eventCampaignId!==cid)return;closeCampaignEvents(true);state.eventReconnect=setTimeout(()=>{if(state.eventCampaignId===cid)connectCampaignEvents(cid);},3000);};}catch{}}

function resetCampaignUi(){state.bulkSend={active:false,total:0,sent:0,failed:0,currentRow:null,nextDelayMs:0,message:'',stopRequested:false};state.campaign=null;state.campaignSig='';state.expanded=null;state.selectedRows.clear();state.selectionAnchorRow=null;state.previews.clear();state.verification.clear();state.mailSenders.bulkUsageByDomain={};state.mailSenders.bulkUsageBySender={};closeVerificationPopup();runConsole.classList.add('hidden');runSummary.classList.add('hidden');queueRowsEl.innerHTML='';if(sendAllMeta)sendAllMeta.textContent='';if(sendAllBtn)sendAllBtn.disabled=true;if(sendAllCountInput)sendAllCountInput.disabled=true;if(sendBulk30Btn)sendBulk30Btn.disabled=true;if(senderMeta)senderMeta.textContent='';if(queueSelectAllBtn)queueSelectAllBtn.disabled=true;if(queueDeleteSelectedBtn)queueDeleteSelectedBtn.disabled=true;if(queueSelectedMeta)queueSelectedMeta.textContent='';stopPolling();closeCampaignEvents();clearStoreId();}
async function fileToBase64(file){return await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>{const v=String(r.result||'');const c=v.indexOf(',');res(c>=0?v.slice(c+1):v);};r.onerror=()=>rej(new Error('Unable to read selected file'));r.readAsDataURL(file);});}
function setFile(file){state.file=file||null;startRunBtn.disabled=!state.file;if(!state.file){uploadStateText.textContent='No file selected';return;}uploadStateText.textContent=`Loaded: ${state.file.name} (${(state.file.size/(1024*1024)).toFixed(2)} MB)`;}

function stopPolling(){if(state.poll){clearInterval(state.poll);state.poll=null;}}
function startPolling(){stopPolling();if(!state.campaign?.id)return;const st=statusNorm(state.campaign.status);if(!['running','paused'].includes(st))return;state.poll=setInterval(async()=>{if(state.pollBusy||!state.campaign?.id)return;state.pollBusy=true;try{const p=await api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}`,null,'GET');if(p?.campaign&&setCampaign(p.campaign)){renderCampaign();}}catch{}finally{state.pollBusy=false;}},POLL_MS);}

function runStats(c){const rows=Array.isArray(c?.rows)?c.rows:[];const total=rows.length;const done=rows.filter(r=>['ready','sent','done'].includes(String(r?.status||'').toLowerCase())).length;const failed=rows.filter(r=>String(r?.status||'').toLowerCase()==='failed').length;const processed=done+failed;const times=rows.filter(r=>Number(r?.durationMs)>0).map(r=>Number(r.durationMs));const avg=times.length?times.reduce((a,b)=>a+b,0)/times.length:0;return {total,done,failed,processed,eta:avg>0?Math.max(0,total-processed)*avg:0};}
function runUi(c){const s=statusNorm(c?.status);const m={running:{label:'RUNNING',cls:'status-running',title:'Run in progress'},paused:{label:'PAUSED',cls:'status-paused',title:'Run paused'},completed:{label:'COMPLETE',cls:'status-completed',title:'Run complete'},stopped:{label:'STOPPED',cls:'status-failed',title:'Run stopped'},failed:{label:'FAILED',cls:'status-failed',title:'Run failed'},queued:{label:'QUEUED',cls:'status-queued',title:'Queued'}};return m[s]||m.queued;}
function isFetchBlocked(row){const method=String(row?.jinaFetchMethod||row?.sourceRow?.jina_fetch_method||'').toLowerCase();const content=String(row?.jinaContent||row?.sourceRow?.jina_content||'').trim();const err=String(row?.jinaError||row?.sourceRow?.jina_error||'').trim();return method==='fetch_blocked'||Boolean(err&&!content);}
function isProtectedRow(row){const method=String(row?.jinaFetchMethod||row?.sourceRow?.jina_fetch_method||'').toLowerCase();const err=String(row?.jinaError||row?.sourceRow?.jina_error||'').toLowerCase();if(method==='kasada_protected')return true;return err.includes('kasada protected')||err.includes('protected website blocked automated fetch')||err.includes('captcha')||err.includes('human verification')||err.includes('manual verification')||err.includes('cloudflare')||err.includes('datadome')||err.includes('access denied');}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(ms)||0)));
const randomBulkDelayMs=()=>Math.floor(Math.random()*(BULK_DELAY_MAX_MS-BULK_DELAY_MIN_MS+1))+BULK_DELAY_MIN_MS;
function isRowSent(row){const rs=String(row?.status||'').toLowerCase();const es=String(row?.emailStatus||row?.sourceRow?.email_status||'').toLowerCase();return rs==='sent'||es==='sent';}
function getCampaignRow(rowNumber){const rows=Array.isArray(state.campaign?.rows)?state.campaign.rows:[];return rows.find(item=>Number(item?.rowNumber)===Number(rowNumber))||null;}
function buildPreviewFromRow(row){if(!row)return null;const to=String(row.emailTo||row.sourceRow?.email_to||row.contactEmail||row.sourceRow?.email||row.sourceRow?.Email||'').trim();const subject=String(row.emailSubject||row.sourceRow?.email_subject||'').trim();const generatedBody=String(row.emailGeneratedBody||row.sourceRow?.email_generated_body||'').trim();const body=String(row.emailBody||row.sourceRow?.email_body||generatedBody||'').trim();if(!subject||!body)return null;return {ok:true,to,subject,generatedBody,body,mailerFields:row.mailerFields||{}};}
function ensurePreviewStateForRow(rowNumber){const rn=Number(rowNumber);if(!Number.isFinite(rn)||rn<1)return null;const existing=pGet(rn);if(existing?.preview)return existing;const row=getCampaignRow(rn);const preview=buildPreviewFromRow(row);if(!preview)return null;const rs=String(row?.status||'').toLowerCase();const sent=isRowSent(row);pSet(rn,{phase:sent||rs==='sent'?'sent':'ready',message:sent?'Email already sent.':'Preview ready',preview,editingBody:false,to:preview.to,subject:preview.subject,body:preview.body});return pGet(rn);}
function isRowSendReady(row){if(isRowSent(row))return false;const rs=String(row?.status||'').toLowerCase();const es=String(row?.emailStatus||row?.sourceRow?.email_status||'').toLowerCase();if(!(rs==='ready'||es==='preview_ready'))return false;const preview=buildPreviewFromRow(row);if(!preview)return false;if(!String(preview.to||'').trim())return false;return true;}
function getSendReadyRows(campaign){const rows=Array.isArray(campaign?.rows)?campaign.rows:[];return rows.filter(row=>isRowSendReady(row));}
function rowUi(row){const rn=Number(row?.rowNumber);const rs=String(row?.status||'').toLowerCase();const es=String(row?.emailStatus||row?.sourceRow?.email_status||'').toLowerCase();const blocked=isFetchBlocked(row);const protectedRow=isProtectedRow(row);const vr=state.verification.get(rn);const previewState=pGet(rn);if(vr||rs==='awaiting_verification')return {dot:'warning',label:'Awaiting verification'};if(previewState?.phase==='sending')return {dot:'processing',label:'Sending email...'};if(previewState?.phase==='sent')return {dot:'sent',label:blocked?'Sent (fetch blocked)':'Sent'};if(es==='sent'||rs==='sent')return {dot:'sent',label:blocked?'Sent (fetch blocked)':'Sent'};if(protectedRow)return {dot:'failed',label:'Protected website (mail disabled)'};if(rs==='ready'||es==='preview_ready'){if(isRowSendReady(row))return {dot:blocked?'warning':'done',label:blocked?'Ready (fetch blocked)':'Ready'};return {dot:'paused',label:blocked?'Ready (fetch blocked, no mail)':'Ready (no mail preview)'};}if(rs==='fetched')return {dot:'queued',label:blocked?'Fetched (blocked context)':'Fetched (waiting preview)'};if(rs==='generating_preview')return {dot:'processing',label:'Generating preview...'};if(rs==='generating_mail')return {dot:'processing',label:'Generating mail info...'};if(rs==='fetching')return {dot:'processing',label:'Fetching website...'};if(rs==='paused')return {dot:'paused',label:'Paused'};if(rs==='failed')return {dot:'failed',label:'Failed'};return {dot:'queued',label:'Queued'};}
function btnCopy(text){const b=document.createElement('button');b.type='button';b.className='copy-btn';b.textContent='Copy';b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(String(text||''));b.textContent='Copied';setTimeout(()=>b.textContent='Copy',900);}catch{b.textContent='Failed';setTimeout(()=>b.textContent='Copy',900);}});return b;}
function expandText(content,empty='No content'){const wrap=document.createElement('div');wrap.className='expand-content';const v=String(content||'').trim();if(!v){wrap.textContent=empty;return wrap;}if(v.length<=PREVIEW_LEN){wrap.textContent=v;return wrap;}const preview=`${v.slice(0,PREVIEW_LEN).trimEnd()}...`;const p=document.createElement('p');p.style.margin='0';p.textContent=preview;let ex=false;const t=document.createElement('button');t.type='button';t.className='btn btn-ghost';t.style.marginTop='8px';t.style.height='28px';t.textContent='Read more';t.addEventListener('click',()=>{ex=!ex;p.textContent=ex?v:preview;t.textContent=ex?'Read less':'Read more';});wrap.append(p,t);return wrap;}

function pGet(n){return state.previews.get(Number(n))||null;}
function pSet(n,val){state.previews.set(Number(n),{...(state.previews.get(Number(n))||{}),...val});}
function pClear(n){state.previews.delete(Number(n));}

async function rowGenerate(row,{silent=false}={}){if(!state.campaign)return false;const campaignStatus=String(state.campaign.status||'').toLowerCase();if(campaignStatus==='stopped'){if(!silent){setMainStatus('error','CAMPAIGN STOPPED');rawOutput.textContent=j({error:'Campaign is stopped. Resume or restart before generating preview.'});}return false;}const cid=state.campaign.id;const rn=Number(row.rowNumber);pSet(rn,{phase:'generating',message:'Generating preview...'});renderCampaign();try{const prev=await api('/api/campaigns/send-preview',{campaignId:cid,rowNumber:rn,websiteUrl:row.websiteUrl,jinaContent:row.jinaContent||row.sourceRow?.jina_content||'',sourceRow:row.sourceRow||{},contactEmail:row.contactEmail||row.sourceRow?.email||row.sourceRow?.Email||undefined,draftIterations:getDraftIterations()});if(prev?.mailerFields)fill(prev.mailerFields);pSet(rn,{phase:'ready',message:'Preview ready',preview:prev,editingBody:false,to:prev.to,subject:prev.subject,body:prev.body});sendPreviewCard.classList.remove('muted');sendPreviewCard.textContent=`To: ${prev.to}\nSubject: ${prev.subject}\n\n${prev.body}`;try{const fresh=await api(`/api/campaigns/${encodeURIComponent(cid)}`,null,'GET');if(fresh?.campaign&&setCampaign(fresh.campaign)){renderCampaign();}}catch{}if(!silent)setMainStatus('success','PREVIEW READY');return true;}catch(e){pSet(rn,{phase:'error',message:e.message||'Failed to generate preview'});renderCampaign();if(!silent)setMainStatus('error','PREVIEW FAILED');return false;}}

async function rowSend(rn,{silent=false,countBulkUsage=false}={}){const rowNumber=Number(rn);if(!Number.isFinite(rowNumber)||rowNumber<1||!state.campaign)return false;let st=ensurePreviewStateForRow(rowNumber);if(!st?.preview){if(!silent){setMainStatus('error','SEND FAILED');rawOutput.textContent=j({error:'Preview data is missing for this row. Generate preview first.'});}return false;}const sender=selectedSender();if(!sender||!sender.email){if(!silent){setMainStatus('error','SENDER REQUIRED');rawOutput.textContent=j({error:'Select a sender before sending emails.'});}return false;}if(sender.active===false){if(!silent){setMainStatus('error','SENDER INACTIVE');rawOutput.textContent=j({error:'Selected sender is inactive in Brevo. Choose an active sender.'});}return false;}const cid=state.campaign.id;pSet(rowNumber,{phase:'sending',message:'Sending email...'});renderCampaign();try{const out=await api('/api/campaigns/send',{campaignId:cid,rowNumber:rowNumber,to:String(st.to||'').trim(),subject:String(st.subject||'').trim(),body:String(st.body||'').trim(),senderEmail:sender.email,senderName:sender.name||'',enforceDomainBulkLimit:countBulkUsage===true,mailerFields:st.preview.mailerFields||{}});const sentSenderEmail=compact(out?.sender?.email)||sender.email;const sentSenderDomain=senderDomainFromEmail(sentSenderEmail);if(out?.domainUsage&&typeof out.domainUsage==='object'){const usage={};Object.entries(out.domainUsage).forEach(([domain,count])=>{const key=lower(domain);if(!key)return;usage[key]=Math.max(0,Number(count)||0);});state.mailSenders.bulkUsageByDomain=usage;}else if(countBulkUsage&&sentSenderDomain){incDomainUsage(sentSenderDomain,1);}if(out?.senderUsage&&typeof out.senderUsage==='object'){const usage={};Object.entries(out.senderUsage).forEach(([email,count])=>{const key=lower(email);if(!key)return;usage[key]=Math.max(0,Number(count)||0);});state.mailSenders.bulkUsageBySender=usage;}else if(countBulkUsage&&sentSenderEmail){incSenderUsage(sentSenderEmail,1);}renderSenderSelect();renderSenderMeta();pSet(rowNumber,{phase:'sent',message:`Email sent to ${out.to}. Message ID: ${out.messageId||'-'} | Sender: ${sentSenderEmail}`,preview:st.preview,statusOverride:'sent'});try{const fresh=await api(`/api/campaigns/${encodeURIComponent(cid)}`,null,'GET');if(fresh?.campaign&&setCampaign(fresh.campaign)){renderCampaign();}}catch{}if(!silent)setMainStatus('success','EMAIL SENT');return true;}catch(e){pSet(rowNumber,{phase:'ready',message:`Send failed: ${e.message||'Send failed'}`,preview:st.preview,editingBody:st.editingBody,to:st.to,subject:st.subject,body:st.body,statusOverride:''});renderCampaign();if(!silent)setMainStatus('error','SEND FAILED');return false;}}

function getSendBatchSize(maxReady,maxAllowed=maxReady){const cappedMax=Math.max(0,Math.min(maxReady,maxAllowed));const raw=Number.parseInt(String(sendAllCountInput?.value||''),10);if(!Number.isFinite(raw)||raw<1){if(sendAllCountInput)sendAllCountInput.value='1';return cappedMax>0?1:0;}if(raw>cappedMax){return cappedMax;}return raw;}

async function sendAllReadyRows({forceThirtyLimit=false}={}){if(!state.campaign?.id||state.bulkSend.active)return;const sender=selectedSender();if(!sender||!sender.email){setMainStatus('error','SENDER REQUIRED');if(sendAllMeta)sendAllMeta.textContent='Select a sender before bulk send.';return;}const domain=sender.domain||senderDomainFromEmail(sender.email);const remaining=senderRemainingForBulk(sender);const candidates=getSendReadyRows(state.campaign);if(candidates.length===0){setMainStatus('error','NO READY ROWS');if(sendAllMeta)sendAllMeta.textContent='No send-ready rows with preview data.';return;}if(remaining<1){setMainStatus('error','DOMAIN LIMIT REACHED');if(sendAllMeta)sendAllMeta.textContent=`Bulk limit reached for ${domain}. Used ${BULK_DOMAIN_LIMIT}/${BULK_DOMAIN_LIMIT}.`;return;}const hardCap=forceThirtyLimit?Math.min(remaining,BULK_DOMAIN_LIMIT):remaining;const batchSize=forceThirtyLimit?Math.min(candidates.length,hardCap):getSendBatchSize(candidates.length,hardCap);if(batchSize<1){setMainStatus('error','INVALID BATCH');if(sendAllMeta)sendAllMeta.textContent='Batch size must be at least 1 and within domain limit.';return;}const batch=candidates.slice(0,batchSize);state.bulkSend={active:true,total:batch.length,sent:0,failed:0,currentRow:null,nextDelayMs:0,message:`Starting batch send (${batch.length}) via ${sender.email}...`,stopRequested:false};renderCampaign();setMainStatus('loading','BULK SENDING');for(let i=0;i<batch.length;i++){if(state.bulkSend.stopRequested){break;}const rn=Number(batch[i].rowNumber);state.bulkSend.currentRow=rn;state.bulkSend.message=`Sending row ${rn} (${i+1}/${state.bulkSend.total}) via ${sender.email}`;renderCampaign();const ok=await rowSend(rn,{silent:true,countBulkUsage:true});if(ok){state.bulkSend.sent+=1;}else{state.bulkSend.failed+=1;}state.bulkSend.currentRow=null;if(state.bulkSend.stopRequested){break;}if(i<batch.length-1){const delayMs=randomBulkDelayMs();state.bulkSend.nextDelayMs=delayMs;state.bulkSend.message=`Waiting ${Math.ceil(delayMs/1000)}s before next send`;renderCampaign();await wait(delayMs);}}state.bulkSend.active=false;state.bulkSend.currentRow=null;state.bulkSend.nextDelayMs=0;if(state.bulkSend.stopRequested){state.bulkSend.message=`Bulk send stopped (${sender.email}): ${state.bulkSend.sent} sent, ${state.bulkSend.failed} failed`;state.bulkSend.stopRequested=false;setMainStatus('error',`BULK STOPPED ${state.bulkSend.sent}/${state.bulkSend.total}`);}else{state.bulkSend.message=`Batch complete (${sender.email}): ${state.bulkSend.sent} sent, ${state.bulkSend.failed} failed`;if(state.bulkSend.failed>0){setMainStatus('error',`BULK DONE ${state.bulkSend.sent}/${state.bulkSend.total}`);}else{setMainStatus('success',`BULK SENT ${state.bulkSend.sent}`);}}renderCampaign();}
async function retryRow(rn,mode='refetch_only'){if(!state.campaign?.id)return;try{const p=await api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}/rows/${rn}/retry`,{mode});if(p?.campaign){setCampaign(p.campaign,{force:true});pClear(rn);renderCampaign();setMainStatus('success',mode==='refetch_and_preview'?'ROW REFETCH+PREVIEW':'ROW REFETCH STARTED');}}catch(e){setMainStatus('error','RETRY FAILED');rawOutput.textContent=j({error:e.message||'Retry failed'});}}

function getSelectedRowNumbers(){return Array.from(state.selectedRows).map(v=>Number(v)).filter(v=>Number.isFinite(v)).sort((a,b)=>a-b);}
function getQueueRowNumbers(campaign=state.campaign){
const rows=Array.isArray(campaign?.rows)?campaign.rows:[];
return rows.map(r=>Number(r?.rowNumber)).filter(n=>Number.isFinite(n));
}
function getRowSelectionRange(rowNumbers,startRow,endRow){
if(!Array.isArray(rowNumbers)||rowNumbers.length<1)return [];
const s=Number(startRow);
const e=Number(endRow);
const startIndex=rowNumbers.indexOf(s);
const endIndex=rowNumbers.indexOf(e);
if(startIndex<0||endIndex<0)return [e];
const from=Math.min(startIndex,endIndex);
const to=Math.max(startIndex,endIndex);
return rowNumbers.slice(from,to+1);
}
function updateQueueSelectionControls(c){
const rowNumbers=getQueueRowNumbers(c);
const selectable=rowNumbers.length;
const selectedCount=rowNumbers.filter(n=>state.selectedRows.has(n)).length;
const campaignStatus=String(c?.status||'').toLowerCase();
const canDelete=selectedCount>0&&campaignStatus!=='running'&&!state.bulkSend.active;
if(queueSelectedMeta)queueSelectedMeta.textContent=selectable<1?'':`${selectedCount}/${selectable} selected`;
if(queueSelectAllBtn){
queueSelectAllBtn.disabled=selectable<1||state.bulkSend.active;
queueSelectAllBtn.textContent=selectedCount>0&&selectedCount===selectable?'Clear Selection':'Select All';
}
if(queueDeleteSelectedBtn){
queueDeleteSelectedBtn.disabled=!canDelete;
queueDeleteSelectedBtn.textContent=selectedCount>0?`Delete Selected (${selectedCount})`:'Delete Selected';
}
}

function toggleSelectAllRows(){
const rowNumbers=getQueueRowNumbers(state.campaign);
const allSelected=rowNumbers.length>0&&rowNumbers.every(n=>state.selectedRows.has(n));
if(allSelected){state.selectedRows.clear();state.selectionAnchorRow=null;}else{rowNumbers.forEach(n=>state.selectedRows.add(n));state.selectionAnchorRow=rowNumbers[0]??null;}
renderCampaign();
}

async function deleteSelectedRows(){
if(!state.campaign?.id)return;
const rowNumbers=getSelectedRowNumbers();
if(rowNumbers.length<1)return;
const campaignStatus=String(state.campaign?.status||'').toLowerCase();
if(campaignStatus==='running'){setMainStatus('error','PAUSE RUN FIRST');rawOutput.textContent=j({error:'Pause or stop the run before deleting rows.'});return;}
if(queueDeleteSelectedBtn)queueDeleteSelectedBtn.disabled=true;
try{
const p=await api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}/rows/delete`,{rowNumbers});
if(p?.campaign){
rowNumbers.forEach(n=>{state.selectedRows.delete(n);pClear(n);});
setCampaign(p.campaign,{force:true});
renderCampaign();
setMainStatus('success',`ROWS DELETED ${rowNumbers.length}`);
}
}catch(e){
setMainStatus('error','DELETE FAILED');
rawOutput.textContent=j({error:e.message||'Row delete failed'});
}finally{
if(queueDeleteSelectedBtn)queueDeleteSelectedBtn.disabled=false;
}
}

function renderPreview(row,host){const rn=Number(row.rowNumber);let st=pGet(rn);const rs=String(row?.status||'').toLowerCase();if(!st&&(rs==='ready'||rs==='sent'||row?.emailSubject||row?.emailBody||row?.emailGeneratedBody||row?.sourceRow?.email_subject||row?.sourceRow?.email_body||row?.sourceRow?.email_generated_body)){const to=row.emailTo||row.sourceRow?.email_to||row.contactEmail||'';const subject=row.emailSubject||row.sourceRow?.email_subject||'';const generatedBody=row.emailGeneratedBody||row.sourceRow?.email_generated_body||'';const body=row.emailBody||row.sourceRow?.email_body||generatedBody||'';const preview={ok:true,mailerFields:row.mailerFields||{},to,subject,generatedBody,body};pSet(rn,{phase:rs==='sent'?'sent':'ready',message:rs==='sent'?'Email already sent.':'Preview ready',preview,editingBody:false,to,subject,body});st=pGet(rn);}if(!st)return;if(st.phase==='generating'||st.phase==='sending'){const p=document.createElement('p');p.className='inline-message';p.textContent=st.message||'Processing...';host.appendChild(p);return;}if(st.phase==='error'){const p=document.createElement('p');p.className='inline-message error';p.textContent=st.message||'Failed.';const acts=document.createElement('div');acts.className='expand-actions';const r=document.createElement('button');r.type='button';r.className='btn btn-ghost';r.textContent='Retry Row';r.addEventListener('click',()=>retryRow(rn));const c=document.createElement('button');c.type='button';c.className='btn btn-danger';c.textContent='Check Config';c.addEventListener('click',()=>setView('mailer'));acts.append(r,c);host.append(p,acts);return;}if(st.phase==='sent'){const p=document.createElement('p');p.className='inline-message success';p.textContent=st.message||'Email sent.';const b=document.createElement('button');b.type='button';b.className='btn btn-ghost';b.textContent='View Log';b.addEventListener('click',()=>{rawOutput.textContent=j(st.preview||{});setView('mailer');});host.append(p,b);return;}if(st.phase!=='ready')return;
const card=document.createElement('div');card.className='inline-preview';card.innerHTML='<div class="inline-preview-head"><strong class="mono">EMAIL PREVIEW</strong></div>';
const edit=document.createElement('button');edit.type='button';edit.className='btn btn-ghost';edit.textContent=st.editingBody?'Lock Body':'Edit Body';edit.addEventListener('click',()=>{pSet(rn,{editingBody:!st.editingBody});renderCampaign();});card.firstChild.appendChild(edit);
const to=document.createElement('div');to.className='inline-preview-field';to.innerHTML='<label>To</label>';const toIn=document.createElement('input');toIn.value=st.to||'';toIn.addEventListener('input',e=>pSet(rn,{to:e.target.value}));to.appendChild(toIn);
const sb=document.createElement('div');sb.className='inline-preview-field';sb.innerHTML='<label>Subject</label>';const sIn=document.createElement('input');sIn.value=st.subject||'';sIn.addEventListener('input',e=>pSet(rn,{subject:e.target.value}));sb.appendChild(sIn);
const bd=document.createElement('div');bd.className='inline-preview-field';bd.innerHTML='<label>Body</label>';if(st.editingBody){const ta=document.createElement('textarea');ta.rows=9;ta.value=st.body||'';ta.addEventListener('input',e=>pSet(rn,{body:e.target.value}));bd.appendChild(ta);}else{const pre=document.createElement('pre');pre.className='inline-preview-body';pre.textContent=st.body||'';bd.appendChild(pre);}const msg=document.createElement('p');msg.className='inline-message';msg.textContent=st.message||'Review and send.';
const acts=document.createElement('div');acts.className='inline-preview-actions';const d=document.createElement('button');d.type='button';d.className='btn btn-danger';d.textContent='Discard';d.addEventListener('click',()=>{pClear(rn);renderCampaign();});const send=document.createElement('button');send.type='button';send.className='btn btn-primary';send.textContent='Send Email';send.addEventListener('click',()=>rowSend(rn));acts.append(d,send);card.append(to,sb,bd,msg,acts);host.appendChild(card);}
function rowExpand(row,host){
const ex=document.createElement('div');ex.className='queue-row-expand';
const wb=document.createElement('section');wb.className='expand-block';const wh=document.createElement('div');wh.className='expand-block-head';const wt=document.createElement('h4');wt.textContent='Website Content';const websiteText=row.jinaContent||row.sourceRow?.jina_content||row.jinaError||row.sourceRow?.jina_error||'';wh.append(wt,btnCopy(websiteText));wb.append(wh,expandText(websiteText,'No website content.'));
const fb=document.createElement('section');fb.className='expand-block';const fh=document.createElement('div');fh.className='expand-block-head';const ft=document.createElement('h4');ft.textContent='Fetch Console';const fetchTraceText=row.jinaFetchTrace||row.sourceRow?.jina_fetch_trace||row.jinaError||row.sourceRow?.jina_error||'';fh.append(ft,btnCopy(fetchTraceText));const fp=document.createElement('pre');fp.className='expand-content';fp.textContent=fetchTraceText||'No fetch trace available yet.';fb.append(fh,fp);
const lb=document.createElement('section');lb.className='expand-block';const lh=document.createElement('div');lh.className='expand-block-head';const lt=document.createElement('h4');lt.textContent='LinkedIn Description';lh.append(lt,btnCopy(row.linkedInDescription||row.sourceRow?.linkedin_description||''));lb.append(lh,expandText(row.linkedInDescription||row.sourceRow?.linkedin_description||row.linkedInError,'No LinkedIn description.'));
const mb=document.createElement('section');mb.className='expand-block';const mh=document.createElement('div');mh.className='expand-block-head';const mt=document.createElement('h4');mt.textContent='Generated Mailer Fields';mh.append(mt,btnCopy(j(row.mailerFields||{})));const mp=document.createElement('pre');mp.className='expand-content';mp.textContent=j(row.mailerFields||{});mb.append(mh,mp);
const acts=document.createElement('div');acts.className='expand-actions';const rs=String(row?.status||'').toLowerCase();const campaignStatus=String(state.campaign?.status||'').toLowerCase();const protectedRow=isProtectedRow(row);const rf=document.createElement('button');rf.type='button';rf.className='btn btn-ghost';rf.textContent='Re-fetch Website';rf.disabled=campaignStatus==='stopped';rf.addEventListener('click',()=>retryRow(Number(row.rowNumber),'refetch_only'));const gp=document.createElement('button');gp.type='button';gp.className='btn btn-ghost';gp.textContent='Generate Preview';gp.disabled=campaignStatus==='stopped'||protectedRow;gp.addEventListener('click',()=>rowGenerate(row));acts.append(rf,gp);if(rs==='failed'){const r=document.createElement('button');r.type='button';r.className='btn btn-danger';r.textContent='Retry + Preview';r.disabled=campaignStatus==='stopped'||protectedRow;r.addEventListener('click',()=>retryRow(Number(row.rowNumber),'refetch_and_preview'));acts.appendChild(r);}const info=document.createElement('p');info.className='muted';info.style.margin='0';info.style.fontSize='0.82rem';info.textContent=protectedRow?'Protected website: mail generation disabled. Re-fetch only can retry website extraction.':'Re-fetch only refreshes website context. Generate Preview builds mail fields and email preview.';acts.appendChild(info);
const ph=document.createElement('div');renderPreview(row,ph);ex.append(wb,fb,lb,mb,acts,ph);host.appendChild(ex);}

function renderQueue(c){
queueRowsEl.innerHTML='';
const rows=Array.isArray(c?.rows)?c.rows:[];
updateQueueSelectionControls(c);
if(!rows.length){
queueRowsEl.innerHTML='<p class="muted">No queued rows.</p>';
return;
}
rows.forEach(row=>{
const rn=Number(row.rowNumber);
const exp=state.expanded===rn;
const ui=rowUi(row);
const a=document.createElement('article');
a.className='queue-row';

const hd=document.createElement('div');
hd.className='queue-row-head';
const main=document.createElement('div');
main.className='queue-row-main';

const sel=document.createElement('label');
sel.className='queue-row-select';
const selInput=document.createElement('input');
selInput.type='checkbox';
selInput.checked=state.selectedRows.has(rn);
selInput.disabled=state.bulkSend.active;
selInput.addEventListener('click',e=>{
e.stopPropagation();
const rowNumbers=getQueueRowNumbers(c);
const checked=Boolean(e.target.checked);
const shiftHeld=Boolean(e.shiftKey);
if(shiftHeld){
const anchor=Number(state.selectionAnchorRow);
const hasAnchor=rowNumbers.includes(anchor);
const rangeStart=hasAnchor?anchor:(rowNumbers[0]??rn);
const range=getRowSelectionRange(rowNumbers,rangeStart,rn);
range.forEach(n=>{if(checked)state.selectedRows.add(n);else state.selectedRows.delete(n);});
state.selectionAnchorRow=rn;
renderCampaign();
return;
}
if(checked)state.selectedRows.add(rn);else state.selectedRows.delete(rn);
state.selectionAnchorRow=rn;
updateQueueSelectionControls(c);
});
sel.appendChild(selInput);

const car=document.createElement('span');
car.className='mono';
car.textContent=exp?'v':'>';
const idx=document.createElement('span');
idx.className='queue-row-index';
idx.textContent=String(rn);
const co=document.createElement('span');
co.className='queue-company';
co.textContent=row.companyName||row.sourceRow?.companyName||row.sourceRow?.Company||'Unknown';
const url=document.createElement('span');
url.className='queue-url';
url.textContent=row.websiteUrl||'-';
main.append(sel,car,idx,co,url);

const sw=document.createElement('div');
sw.className='queue-status-wrap';
const dot=document.createElement('span');
dot.className=`status-dot ${ui.dot}`;
const tx=document.createElement('span');
tx.className='queue-status-text';
tx.textContent=`${ui.label}${Number(row.durationMs)>0?` ${fmtMs(row.durationMs)}`:''}`;
sw.append(dot,tx);
if(isRowSendReady(row)){
const s=document.createElement('button');
s.type='button';
s.className='btn btn-primary';
s.style.height='28px';
s.textContent='Send ->';
s.disabled=state.bulkSend.active;
s.addEventListener('click',e=>{e.stopPropagation();ensurePreviewStateForRow(rn);rowSend(rn);});
sw.appendChild(s);
}
hd.append(main,sw);
hd.addEventListener('click',()=>{state.expanded=exp?null:rn;renderCampaign();});
a.appendChild(hd);
if(exp)rowExpand(row,a);
queueRowsEl.appendChild(a);
});
}
function renderSummary(c,s){const st=statusNorm(c?.status);if(!['completed','stopped','failed'].includes(st)){runSummary.classList.add('hidden');runSummary.innerHTML='';return;}runSummary.classList.remove('hidden');runSummary.innerHTML='';const h=document.createElement('h3');h.className='mono';h.textContent=st==='completed'?'RUN COMPLETE':st==='stopped'?'RUN STOPPED':'RUN FAILED';const stAt=Date.parse(String(c?.startedAt||c?.savedAt||''));const enAt=Date.parse(String(c?.completedAt||c?.stoppedAt||''));const total=Number.isFinite(stAt)&&Number.isFinite(enAt)?Math.max(0,enAt-stAt):0;const p=document.createElement('p');p.textContent=`${s.total} target rows, ${s.done} enriched, ${s.failed} failed, ${total?fmtMs(total):'-'} total.`;
const acts=document.createElement('div');acts.className='run-summary-actions';const dl=document.createElement('a');dl.href=`/api/campaigns/${encodeURIComponent(c.id)}/download`;dl.className='btn btn-primary';dl.style.display='inline-flex';dl.style.alignItems='center';dl.style.textDecoration='none';dl.textContent='Download Enriched Excel';const nr=document.createElement('button');nr.type='button';nr.className='btn btn-ghost';nr.textContent='Start New Run';nr.disabled=state.bulkSend.active;nr.addEventListener('click',()=>{resetCampaignUi();setFile(null);uploadStateText.textContent='No file selected';});acts.append(dl,nr);runSummary.append(h,p,acts);}
function renderCampaign(){
const c=state.campaign;
if(!c){
state.selectedRows.clear();
state.selectionAnchorRow=null;
runConsole.classList.add('hidden');
runSummary.classList.add('hidden');
queueRowsEl.innerHTML='';
if(sendAllMeta)sendAllMeta.textContent='';
if(sendAllBtn)sendAllBtn.disabled=true;
if(sendBulk30Btn)sendBulk30Btn.disabled=true;
if(sendAllCountInput)sendAllCountInput.disabled=true;
if(senderSelect)senderSelect.disabled=true;
if(refreshSendersBtn)refreshSendersBtn.disabled=state.mailSenders.loading;
if(senderMeta)senderMeta.textContent='';
if(queueSelectAllBtn)queueSelectAllBtn.disabled=true;
if(queueDeleteSelectedBtn)queueDeleteSelectedBtn.disabled=true;
if(queueSelectedMeta)queueSelectedMeta.textContent='';
closeCampaignEvents();
return;
}
const rows=Array.isArray(c?.rows)?c.rows:[];
const validRowNumbers=new Set(rows.map(item=>Number(item?.rowNumber)).filter(n=>Number.isFinite(n)));
for(const selected of Array.from(state.selectedRows)){if(!validRowNumbers.has(Number(selected)))state.selectedRows.delete(Number(selected));}
if(!validRowNumbers.has(Number(state.selectionAnchorRow)))state.selectionAnchorRow=null;
for(const [rowNumber]of state.verification.entries()){
const row=rows.find(item=>Number(item?.rowNumber)===Number(rowNumber));
if(!row||String(row.status||'').toLowerCase()!=='awaiting_verification'){state.verification.delete(rowNumber);}
}
connectCampaignEvents(c.id);
runConsole.classList.remove('hidden');
const ui=runUi(c);
runIdLabel.textContent=`RUN ${c.id}`;
runStatusTitle.textContent=ui.title;
runStatusBadge.className=`status-badge ${ui.cls}`;
runStatusBadge.textContent=ui.label;
const s=runStats(c);
const pct=s.total?Math.round((s.processed/s.total)*100):0;
runProgressBar.style.width=`${pct}%`;
runProgressText.textContent=`${s.processed} / ${s.total} rows`;
runEtaText.textContent=s.eta>0?`ETA ~${fmtMs(s.eta)}`:'ETA -';
runMetaText.textContent=`Started ${ago(c.startedAt||c.savedAt)} | ${s.failed} failed`;
const st=statusNorm(c.status);
pauseResumeBtn.disabled=['completed','failed'].includes(st)||state.bulkSend.active;
pauseResumeBtn.textContent=st==='running'?'Pause':'Resume';
stopRunBtn.disabled=['completed','stopped','failed'].includes(st);
 if(resetRunBtn)resetRunBtn.disabled=state.bulkSend.active;
const readyRows=getSendReadyRows(c);
const sender=selectedSender();
const senderReady=Boolean(sender&&sender.email&&sender.active!==false);
const domainRemaining=senderReady?senderRemainingForBulk(sender):0;
const effectiveReady=Math.min(readyRows.length,domainRemaining);
const batchSize=getSendBatchSize(Math.max(readyRows.length,1),domainRemaining);
if(senderSelect){senderSelect.disabled=state.bulkSend.active||state.mailSenders.loading||state.mailSenders.list.length<1;}
if(refreshSendersBtn){refreshSendersBtn.disabled=state.bulkSend.active||state.mailSenders.loading;}
if(sendAllCountInput){sendAllCountInput.disabled=state.bulkSend.active||effectiveReady===0;sendAllCountInput.max=String(Math.max(effectiveReady,1));}
if(sendAllBtn){sendAllBtn.disabled=state.bulkSend.active||effectiveReady===0||!senderReady;sendAllBtn.textContent=state.bulkSend.active?'Sending...':`Send Next ${Math.min(batchSize,effectiveReady)}${effectiveReady?` of ${effectiveReady}`:''}`;}
if(sendBulk30Btn){const bulk30Count=Math.min(effectiveReady,BULK_DOMAIN_LIMIT);sendBulk30Btn.disabled=state.bulkSend.active||bulk30Count<1||!senderReady;sendBulk30Btn.textContent=state.bulkSend.active?'Sending...':`Bulk Send ${bulk30Count}/30`;}
if(sendAllMeta){if(state.bulkSend.active){const waitText=state.bulkSend.nextDelayMs>0?` | Next in ${Math.ceil(state.bulkSend.nextDelayMs/1000)}s`:'';sendAllMeta.textContent=`Sent ${state.bulkSend.sent}/${state.bulkSend.total}${waitText}`;}else if(state.bulkSend.message){sendAllMeta.textContent=state.bulkSend.message;}else if(!sender){sendAllMeta.textContent='Select a sender to send emails.';}else if(sender.active===false){sendAllMeta.textContent='Selected sender is inactive in Brevo. Choose an active sender.';}else if(domainRemaining<1){sendAllMeta.textContent=`Domain limit reached (${BULK_DOMAIN_LIMIT}/${BULK_DOMAIN_LIMIT}).`; }else{sendAllMeta.textContent=readyRows.length>0?`${effectiveReady} rows ready for ${sender.email} (${domainRemaining} domain remaining).`:'No ready rows';}}
renderSenderMeta();
renderQueue(c);
renderSummary(c,s);
startPolling();
}
async function loadCampaign(id){if(!id)return;const p=await api(`/api/campaigns/${encodeURIComponent(id)}`,null,'GET');if(p?.campaign){setCampaign(p.campaign,{force:true});setStoreId(p.campaign.id);renderCampaign();}}
async function loadLatest(){const persisted=getStoreId();if(persisted){try{await loadCampaign(persisted);return;}catch{clearStoreId();}}try{const p=await api('/api/campaigns/latest',null,'GET');if(p?.campaign?.id){setCampaign(p.campaign,{force:true});setStoreId(p.campaign.id);renderCampaign();}}catch{}}
async function loadHistory(){historyList.innerHTML='<p class="muted">Loading history...</p>';try{const p=await api('/api/campaigns/history?limit=5',null,'GET');const arr=Array.isArray(p?.campaigns)?p.campaigns:[];historyList.innerHTML='';if(!arr.length){historyList.innerHTML='<p class="muted">No previous runs.</p>';return;}arr.forEach(c=>{const d=document.createElement('div');d.className='history-item';const t=document.createElement('p');const ts=Date.parse(String(c?.savedAt||''));t.textContent=`${c.id} | ${c.count||c.rows?.length||0} rows | ${c.succeeded||0} ok | ${Number.isFinite(ts)?new Date(ts).toLocaleString():'-'}`;const b=document.createElement('button');b.type='button';b.className='btn btn-ghost';b.textContent='Load';b.addEventListener('click',async()=>{await loadCampaign(c.id);setView('campaign');});d.append(t,b);historyList.appendChild(d);});}catch(e){historyList.innerHTML=`<p class="muted">${e.message||'Failed to load history.'}</p>`;}}

async function startRun(){if(!state.file)return;const count=Number.parseInt(countInput.value,10);if(!Number.isFinite(count)||count<1){uploadStateText.textContent='Rows to process must be >= 1';return;}startRunBtn.disabled=true;startRunBtn.textContent='Initialising...';try{const base64=await fileToBase64(state.file);const p=await api('/api/campaigns',{campaignFile:{name:state.file.name,mimeType:state.file.type||'application/octet-stream',contentBase64:base64},count});if(!p?.campaign)throw new Error('Campaign creation failed');state.bulkSend={active:false,total:0,sent:0,failed:0,currentRow:null,nextDelayMs:0,message:'',stopRequested:false};setCampaign(p.campaign,{force:true});state.expanded=null;state.previews.clear();setStoreId(p.campaign.id);renderCampaign();await loadHistory();}catch(e){uploadStateText.textContent=e.message||'Run start failed';}finally{startRunBtn.textContent='Start Run';startRunBtn.disabled=!state.file;}}
async function togglePause(){if(!state.campaign?.id)return;const st=statusNorm(state.campaign.status);if(['completed','failed'].includes(st))return;const ep=st==='running'?'pause':'resume';pauseResumeBtn.disabled=true;try{const p=await api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}/${ep}`,{});if(p?.campaign){setCampaign(p.campaign,{force:true});renderCampaign();}}catch(e){rawOutput.textContent=j({error:e.message||'Pause/resume failed'});}finally{pauseResumeBtn.disabled=false;}}
async function stopRun(){if(!state.campaign?.id)return;state.bulkSend.stopRequested=true;stopRunBtn.disabled=true;setMainStatus('loading','STOPPING RUN');if(sendAllMeta&&state.bulkSend.active)sendAllMeta.textContent='Stopping bulk send and campaign pipeline...';try{const p=await api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}/stop`,{});if(p?.campaign){setCampaign(p.campaign,{force:true});renderCampaign();setMainStatus('success','RUN STOPPED');}}catch(e){rawOutput.textContent=j({error:e.message||'Stop failed'});setMainStatus('error','STOP FAILED');}finally{stopRunBtn.disabled=false;}}
async function resetRun(){if(!state.campaign?.id)return;if(resetRunBtn)resetRunBtn.disabled=true;setMainStatus('loading','RESETTING RUN');try{const p=await api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}/reset`,{});if(p?.campaign){state.bulkSend={active:false,total:0,sent:0,failed:0,currentRow:null,nextDelayMs:0,message:'',stopRequested:false};setCampaign(p.campaign,{force:true});state.expanded=null;state.previews.clear();renderCampaign();setMainStatus('success','RUN RESET');}}catch(e){rawOutput.textContent=j({error:e.message||'Reset failed'});setMainStatus('error','RESET FAILED');}finally{if(resetRunBtn)resetRunBtn.disabled=false;}}

function bindUpload(){uploadZone.addEventListener('click',()=>fileInput.click());uploadZone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fileInput.click();}});fileInput.addEventListener('change',()=>setFile(fileInput.files?.[0]||null));['dragenter','dragover'].forEach(n=>uploadZone.addEventListener(n,e=>{e.preventDefault();uploadZone.classList.add('drag-over');}));['dragleave','drop'].forEach(n=>uploadZone.addEventListener(n,e=>{e.preventDefault();if(n==='drop'){const f=e.dataTransfer?.files?.[0];if(f)setFile(f);}uploadZone.classList.remove('drag-over');}));}
function bindCopy(){document.querySelectorAll('.copy-btn[data-copy-target]').forEach(btn=>btn.addEventListener('click',async e=>{const id=e.currentTarget.dataset.copyTarget;const t=document.getElementById(id);const v=t?t.textContent||'':'';try{await navigator.clipboard.writeText(v);const p=btn.textContent;btn.textContent='Copied';setTimeout(()=>btn.textContent=p,900);}catch{btn.textContent='Failed';setTimeout(()=>btn.textContent='Copy',900);}}));}

$('#fillSample').addEventListener('click',()=>{fill(sampleLead);setMainStatus('idle','SAMPLE');});
$('#generateDraft').addEventListener('click',()=>mailerRun(doDraft));
$('#generateSubject').addEventListener('click',()=>mailerRun(async()=>{
const currentBody=String(bodyOutput.textContent||'').trim();
const draftBody=/^No body/i.test(currentBody)?undefined:currentBody;
renderMailer(await api('/api/content/subject',{lead:lead(),draftBody}));
}));
$('#generateVariants').addEventListener('click',()=>mailerRun(async()=>{renderMailer(await api('/api/content/variants',{lead:lead()}));}));
$('#generateFull').addEventListener('click',()=>mailerRun(async()=>{renderMailer(await api('/api/content/generate',{lead:lead()}));}));
$('#testHealth').addEventListener('click',()=>mailerRun(async()=>refreshHealth(true)));
$('#refreshHealth').addEventListener('click',()=>refreshHealth(false));
startRunBtn.addEventListener('click',()=>startRun());
pauseResumeBtn.addEventListener('click',()=>togglePause());
stopRunBtn.addEventListener('click',()=>stopRun());
if(sendAllBtn)sendAllBtn.addEventListener('click',()=>sendAllReadyRows());
if(sendBulk30Btn)sendBulk30Btn.addEventListener('click',()=>sendAllReadyRows({forceThirtyLimit:true}));
if(sendAllCountInput)sendAllCountInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sendAllReadyRows();}});
if(senderSelect)senderSelect.addEventListener('change',e=>{const email=compact(e.target?.value);const sender=(Array.isArray(state.mailSenders.list)?state.mailSenders.list:[]).find(item=>lower(item.email)===lower(email));state.mailSenders.selectedEmail=sender?.email||email;state.mailSenders.selectedName=sender?.name||'';renderSenderSelect();renderSenderMeta();renderCampaign();});
if(refreshSendersBtn)refreshSendersBtn.addEventListener('click',()=>loadMailSenders());
if(queueSelectAllBtn)queueSelectAllBtn.addEventListener('click',()=>toggleSelectAllRows());
if(queueDeleteSelectedBtn)queueDeleteSelectedBtn.addEventListener('click',()=>deleteSelectedRows());
if(resetRunBtn)resetRunBtn.addEventListener('click',()=>resetRun());
navBtns.forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));

bindUpload();bindCopy();setView('campaign');setMainStatus('idle','IDLE');setComplianceBadge(null);setDraftProgress(0,'Idle');refreshHealth(false);loadMailSenders({silent:true});loadHistory();loadLatest();
