'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let project = null, policies = [], selectedTemplate = null, preview = null, activeView = 'compare', comparing = false;
  let choices = {}, selection = null, mockLoading = false;
  const partyLoads = new Map(), partyErrors = new Map();
  const templates = {
    mock: {label:'Mock data', note:'นโยบายสมมติ 10 รายการจากสองพรรคสมมติ พรรคละ 5 รายการในหมวดเดียวกัน เพื่อทดลองเปรียบเทียบ'},
    thai_election: {label:'นโยบายเลือกตั้งไทย', note:'ดึงนโยบายจากเว็บทางการของเพื่อไทย ประชาชน ภูมิใจไทย และประชาธิปัตย์ พร้อมเก็บลิงก์ต้นทาง'},
    bma_tracker: {label:'ตัวติดตามนโยบาย กทม.', note:'ข้อมูล tracker ของ กทม. เป็นรายการกลยุทธ์/action plan ไม่ใช่บัญชีนโยบายหาเสียงผู้สมัคร'},
    bangkok_candidate: {label:'นโยบายผู้สมัคร กทม.', note:'นโยบาย กทม. จากเว็บไซต์ทางการของประชาชนและประชาธิปัตย์ หรือระบุ URL แคมเปญอื่นได้'}
  };

  async function api(path, options={}) {
    const response = await fetch(path, {headers:{'Content-Type':'application/json'}, ...options});
    let data;
    try { data = await response.json(); } catch { throw Error('เซิร์ฟเวอร์ตอบกลับไม่สำเร็จ'); }
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
    return data;
  }
  function error(id, message) { const node=$(id);node.textContent=message;node.hidden=!message; }
  function setButton(button, busy, busyText, idleText) {button.disabled=busy;button.querySelector('span').textContent=busy?busyText:idleText;}

  async function loadProjects() {
    const data=await api('/api/projects');
    $('project-count').textContent=`${data.projects.length} โปรเจกต์`;
    const list=$('project-list');list.replaceChildren();
    if(!data.projects.length){const p=document.createElement('p');p.className='muted';p.textContent='ยังไม่มีโปรเจกต์ เริ่มจากสร้างโปรเจกต์การเลือกตั้งก่อน';list.append(p);return;}
    for(const item of data.projects){
      const button=document.createElement('button');button.type='button';button.className='project-card';
      const title=document.createElement('strong');title.textContent=item.name;
      const meta=document.createElement('span');meta.textContent=[item.election,item.year,item.location].filter(Boolean).join(' · ');
      const count=document.createElement('small');count.textContent=`${item.policy_count} นโยบาย · สร้าง ${new Date(item.created_at).toLocaleDateString('th-TH')}`;
      button.append(title,meta,count);button.onclick=()=>openProject(item.id);list.append(button);
    }
  }
  async function openProject(id) {
    try {
      const data=await api(`/api/projects/${id}`);project=data.project;
      choices={};$('compare-search-a').value='';$('compare-search-b').value='';$('compare-result').hidden=true;
      error('compare-error','');
      $('project-home').hidden=true;$('project-workspace').hidden=false;
      document.body.classList.toggle('workspace-open',true);
      $('current-project-name').textContent=project.name;
      $('current-project-meta').textContent=[project.election,project.year,project.location].filter(Boolean).join(' · ');
      await refreshPolicies();showWorkspace('compare');
    } catch(e) { window.alert(e.message); }
  }
  function showWorkspace(view) {
    activeView=view;$('workspace-compare').hidden=view!=='compare';$('workspace-data').hidden=view!=='data';$('workspace-summary').hidden=view!=='summary';
    for(const [id,tabView] of [['workspace-compare-tab','compare'],['workspace-data-tab','data'],['workspace-summary-tab','summary']]){
      const active=view===tabView;$(id).classList.toggle('active',active);$(id).setAttribute('aria-selected',String(active));
    }
  }
  function sourceUrl() {
    const select=$('source-preset');
    if(select.hidden)return '';
    if(select.value==='custom')return $('source-url').value.trim();
    return select.value;
  }
  function chooseTemplate(template) {
    selectedTemplate=template;preview=null;
    document.querySelectorAll('.template-card').forEach(button=>button.classList.toggle('active',button.dataset.template===template));
    $('preview-area').hidden=true;$('source-controls').hidden=false;
    const select=$('source-preset'),url=$('source-url'),label=$('source-label');
    select.replaceChildren();
    const catalog=template==='thai_election'?PartyComparison.sources({election:'เลือกตั้งไทย',year:'2569'},[]):template==='bangkok_candidate'?PartyComparison.sources({election:'เลือกตั้ง กทม.',year:'2569'},[]):[];
    const presets=catalog.length?[...catalog.map(item=>[item.url,`${item.label} · ${template==='bangkok_candidate'?'นโยบาย กทม.':'นโยบายระดับประเทศ'}`]),['custom','ระบุ URL เอง']]:[];
    for(const [value,text] of presets){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
    select.hidden=!presets.length;url.hidden=true;url.value='';label.hidden=!presets.length;label.htmlFor=presets.length?'source-preset':'source-url';
    label.textContent=template==='bma_tracker'?'URL ตัวติดตามนโยบาย กทม.':template==='mock'?'ชุดข้อมูล':'แหล่งข้อมูล';
    $('source-note').textContent=templates[template].note;
    if(template==='mock')previewSource();
    else if(template==='bma_tracker'){$('preview-source').querySelector('span').textContent='ดึงข้อมูล กทม. และตรวจตัวอย่าง';}
    else $('preview-source').querySelector('span').textContent='ดึงข้อมูลและตรวจตัวอย่าง';
    $('source-party').value='';
    select.onchange=()=>{const custom=select.value==='custom';url.hidden=!custom;$('source-party-field').hidden=!custom;label.htmlFor=custom?'source-url':'source-preset';url.placeholder=template==='bangkok_candidate'?'https://เว็บไซต์นโยบายผู้สมัคร/':'https://เว็บไซต์นโยบายพรรค/';if(custom)url.focus();};
    select.onchange();
  }
  function renderPreview(data) {
    preview=data;$('preview-area').hidden=false;$('preview-title').textContent='ตรวจข้อมูลก่อนบันทึก';
    $('preview-count').textContent=`${data.count.toLocaleString('th-TH')} รายการ`;
    $('preview-source-name').textContent=`${data.source_label} · ${data.source_url}`;
    const list=$('preview-list');list.replaceChildren();
    const max=80;
    data.policies.slice(0,max).forEach((item,index)=>{
      const details=document.createElement('details');details.className='preview-item';details.open=false;
      const summary=document.createElement('summary');const check=document.createElement('input');check.type='checkbox';check.checked=true;check.dataset.index=index;check.setAttribute('aria-label','นำเข้านโยบาย '+(index+1));
      check.onclick=e=>e.stopPropagation();
      const info=document.createElement('span');const title=document.createElement('span');title.className='preview-item-title';title.textContent=item.title;
      const meta=document.createElement('span');meta.className='preview-item-meta';meta.textContent=[item.party,item.category,item.source_label].filter(Boolean).join(' · ');
      info.append(title,meta);summary.append(check,info);details.append(summary);
      const edit=document.createElement('textarea');edit.rows=3;edit.maxLength=50000;edit.value=item.content||'';edit.setAttribute('aria-label','ข้อความนโยบาย '+item.title);edit.dataset.contentIndex=index;
      details.append(edit);list.append(details);
    });
    if(data.count>max){const more=document.createElement('div');more.className='preview-more';more.textContent=`กำลังแสดงตัวอย่าง ${max} รายการแรก; บันทึกได้ครบทั้ง ${data.count.toLocaleString('th-TH')} รายการ`;list.append(more);}
    $('save-import').querySelector('span').textContent=`บันทึก ${data.count.toLocaleString('th-TH')} รายการในโปรเจกต์`;
  }
  async function previewSource() {
    error('import-error','');
    const button=$('preview-source');setButton(button,true,'กำลังดึงข้อมูล…','ดึงข้อมูลและตรวจตัวอย่าง');
    try{
      const data=await api('/api/data/preview',{method:'POST',body:JSON.stringify({template:selectedTemplate,url:sourceUrl()})});
      if(!data.policies?.length)throw Error('ไม่พบรายการนโยบายจากแหล่งนี้');
      const unidentified=data.policies.filter(item=>!PartyComparison.partyKey(item.party)&&item.source_kind!=='bma_tracker');
      if(unidentified.length){
        const party=$('source-party').value.trim();
        if(!party)throw Error('แหล่งนี้ยังไม่ระบุพรรค กรุณากรอกชื่อพรรคแล้วดึงข้อมูลอีกครั้ง');
        unidentified.forEach(item=>{item.party=party;item.source_meta={...item.source_meta,party_label_origin:'user'};});
      }
      renderPreview(data);
    }catch(e){error('import-error',e.message);}
    finally{setButton(button,false,'กำลังดึงข้อมูล…',selectedTemplate==='bma_tracker'?'ดึงข้อมูล กทม. และตรวจตัวอย่าง':'ดึงข้อมูลและตรวจตัวอย่าง');}
  }
  function updateCompareOptions() {
    selection=PartyComparison.options(policies,choices,PartyComparison.sources(project,policies));
    choices={partyA:selection.partyA,partyB:selection.partyB,policyA:selection.policyA,policyB:selection.policyB};
    function fill(id,items,value,label,empty){
      const select=$(id);select.replaceChildren();
      if(!value){const option=document.createElement('option');option.value='';option.textContent=empty;option.disabled=items.length>0;select.append(option);}
      for(const item of items){const option=document.createElement('option');option.value=item.key??item.id;option.textContent=label(item);select.append(option);}
      select.value=value;select.disabled=comparing||mockLoading||!items.length;
    }
    fill('compare-party-a',selection.parties,selection.partyA,item=>item.label,'เลือกพรรคฝั่ง A');
    fill('compare-party-b',selection.partiesB,selection.partyB,item=>item.label,'เลือกพรรคฝั่ง B');
    let pending=false;
    for(const side of ['a','b']){
      const upper=side.toUpperCase(),key=choices['party'+upper],loadKey=`${project?.id}:${key}`;
      const group=selection.parties.find(item=>item.key===key);
      const loading=partyLoads.has(loadKey);pending ||= loading;
      const loadError=partyErrors.get(loadKey)||'';
      const items=selection['policies'+upper],query=$('compare-search-'+side).value.trim().toLocaleLowerCase('th');
      const filtered=items.filter(item=>[item.title,item.category,item.content].join(' ').toLocaleLowerCase('th').includes(query));
      const chosen=filtered.find(item=>String(item.id)===choices['policy'+upper])||filtered[0];
      choices['policy'+upper]=chosen?String(chosen.id):'';
      fill('compare-'+side,filtered,choices['policy'+upper],item=>item.title,loading?'กำลังโหลดนโยบาย…':query?'ไม่พบนโยบายที่ค้นหา':'เลือกพรรคก่อน');
      $('compare-search-'+side).disabled=comparing||!items.length;
      $('compare-count-'+side).textContent=items.length?`${items.length} นโยบาย`:'';
      $('compare-load-'+side).hidden=!loading;$('compare-load-'+side).textContent=`กำลังดึงนโยบายจริงของ${group?.label||''}…`;
      error('compare-load-error-'+side,loadError);
      $('compare-retry-'+side).hidden=!loadError;$('compare-retry-'+side).disabled=comparing||loading;
      renderSelectedPolicy(side,chosen,loading);
    }
    const ready=Boolean(choices.policyA&&choices.policyB);
    $('run-project-compare').disabled=comparing||mockLoading||pending||!ready;
    $('compare-status').textContent=comparing?'On-Fly-Jev กำลังเปรียบเทียบ…':mockLoading||pending?'กำลังโหลดนโยบายให้เลือก…':ready?'พร้อมเปรียบเทียบสองนโยบายที่เลือก':selection.parties.length<2?'เพิ่มพรรคหรือผู้สมัครอีกฝั่งจาก URL ด้านบน':!choices.partyA||!choices.partyB?'เลือกพรรคทั้งสองฝั่ง แล้วเลือกนโยบายที่อยากเทียบ':'เลือกนโยบายให้ครบทั้งสองฝั่ง';
    $('quick-mock').hidden=policies.length>0;$('quick-mock').disabled=comparing||pending||mockLoading;
    $('comparison-custom').disabled=comparing||mockLoading;
    $('compare-criterion').disabled=comparing;$('compare-situation').disabled=comparing;
    const sources=PartyComparison.sources(project,policies);
    $('comparison-source-note').textContent=sources.length?`ชุดเปรียบเทียบ: ${sources[0].template==='bangkok_candidate'?'เลือกตั้ง กทม.':'เลือกตั้งไทย'} 2569 · เลือกพรรคเพื่อโหลดข้อมูลทางการเข้าโปรเจกต์`:'ใช้นโยบายที่บันทึกในโปรเจกต์ เลือกพรรคและอ่านเนื้อหาของแต่ละฝั่งได้เลย';
  }
  function renderSelectedPolicy(side,item,loading) {
    const node=$('compare-preview-'+side);node.replaceChildren();
    if(!item){const empty=document.createElement('p');empty.className='selected-policy-empty';empty.textContent=loading?'เมื่อโหลดเสร็จ นโยบายจะแสดงที่นี่':$('compare-search-'+side).value?'ลองค้นหาด้วยคำอื่น':'เลือกพรรคและนโยบาย แล้วอ่านเนื้อหาของฝั่งนี้ได้ที่นี่';node.append(empty);return;}
    const category=document.createElement('span');category.className='policy-category';category.textContent=item.category||'นโยบาย';
    const title=document.createElement('h3');title.textContent=item.title;
    const content=document.createElement('p');content.textContent=item.content.length>320?item.content.slice(0,320)+'…':item.content;
    node.append(category,title,content);
    if(item.content.length>320){const details=document.createElement('details'),summary=document.createElement('summary'),full=document.createElement('p');summary.textContent='อ่านเนื้อหาทั้งหมด';full.textContent=item.content;details.append(summary,full);node.append(details);}
    if(/^https?:\/\//.test(item.source_url)){const link=document.createElement('a');link.href=item.source_url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=(item.source_label||'แหล่งข้อมูล')+' ↗';node.append(link);}
    else if(item.source_kind==='mock'){const note=document.createElement('small');note.textContent='ข้อมูลสมมติสำหรับทดลอง';node.append(note);}
  }
  async function loadSelectedSources() {
    const projectId=project?.id;if(!projectId)return;
    const wanted=[choices.partyA,choices.partyB];
    const tasks=[];
    for(const key of wanted){
      const group=selection.parties.find(item=>item.key===key),loadKey=`${projectId}:${key}`;
      if(!group?.source||group.policies.length||partyLoads.has(loadKey))continue;
      partyErrors.delete(loadKey);
      const task=(async()=>{
        try{
          const data=await api('/api/data/preview',{method:'POST',body:JSON.stringify({template:group.source.template,url:group.source.url})});
          const items=data.policies.filter(item=>PartyComparison.partyKey(item.party)===key);
          if(!items.length)throw Error('ไม่พบนโยบายของพรรคนี้จากแหล่งทางการ ลองใหม่หรือเพิ่ม URL อื่น');
          await api(`/api/projects/${projectId}/policies`,{method:'POST',body:JSON.stringify({policies:items})});
          if(project?.id===projectId)await refreshPolicies();
        }catch(e){partyErrors.set(loadKey,e.message);}
        finally{partyLoads.delete(loadKey);if(project?.id===projectId)updateCompareOptions();}
      })();
      partyLoads.set(loadKey,task);tasks.push(task);
    }
    updateCompareOptions();await Promise.allSettled(tasks);
  }
  function renderPolicyTable() {
    const target=$('policy-table'),query=$('policy-search').value.trim().toLocaleLowerCase('th');target.replaceChildren();
    const filtered=policies.filter(item=>[item.title,item.party,item.category,item.source_label].join(' ').toLocaleLowerCase('th').includes(query));
    const max=100;
    filtered.slice(0,max).forEach(item=>{
      const row=document.createElement('div');row.className='policy-row';const first=document.createElement('div'),second=document.createElement('div');
      const title=document.createElement('strong');title.textContent=item.title;first.append(title);
      if(item.party){const party=document.createElement('small');party.textContent=item.party;first.append(party);}
      const category=document.createElement('small');category.textContent=item.category||'ไม่ระบุหมวดหมู่';
      const link=document.createElement('a');link.href=item.source_url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=item.source_label||'เปิดแหล่งข้อมูล';link.title=item.source_url;second.append(category,link);row.append(first,second);target.append(row);
    });
    if(filtered.length>max){const more=document.createElement('p');more.className='muted';more.textContent=`แสดง ${max} จาก ${filtered.length} รายการที่ตรงกัน`;target.append(more);}
    if(!filtered.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='ไม่พบรายการที่ค้นหา';target.append(empty);}
  }
  async function refreshPolicies() {
    const data=await api(`/api/projects/${project.id}/policies`);policies=data.policies;
    $('policy-total').textContent=`${policies.length.toLocaleString('th-TH')} รายการ`;
    $('policy-empty').hidden=policies.length>0;$('policy-browser').hidden=!policies.length;
    updateCompareOptions();renderPolicyTable();await loadSummary();
  }
  function renderCounts(nodeId,counts) {
    const node=$(nodeId);node.replaceChildren();const entries=Object.entries(counts||{}).sort((a,b)=>b[1]-a[1]);
    if(!entries.length){const empty=document.createElement('p');empty.className='empty-summary';empty.textContent='ยังไม่มีข้อมูล';node.append(empty);return;}
    const max=Math.max(...entries.map(x=>x[1]),1);
    for(const [label,count] of entries){const row=document.createElement('div');row.className='summary-bar';const text=document.createElement('span');text.className='summary-bar-label';text.textContent=label;const track=document.createElement('div');track.className='summary-bar-track';const fill=document.createElement('div');fill.className='summary-bar-fill';fill.style.width=(count/max*100)+'%';track.append(fill);const number=document.createElement('span');number.className='summary-bar-count';number.textContent=count;row.append(text,track,number);node.append(row);}
  }
  function renderDecisions(items) {
    const node=$('summary-decisions');node.replaceChildren();
    if(!items.length){const empty=document.createElement('p');empty.className='empty-summary';empty.textContent='ยังไม่มีผลเปรียบเทียบ เลือกคู่จากหน้า “เปรียบเทียบ” เพื่อบันทึกผลแรก';node.append(empty);return;}
    for(const item of items){const card=document.createElement('article');card.className='decision-card';const title=document.createElement('strong');title.textContent=`${item.policy_a_party} · ${item.policy_a_title}  ↔  ${item.policy_b_party} · ${item.policy_b_title}`;const winner=document.createElement('p');winner.textContent=item.winner_id===item.policy_a_id?`โมเดลเลือก A: ${item.policy_a_title}`:item.winner_id===item.policy_b_id?`โมเดลเลือก B: ${item.policy_b_title}`:'โมเดลไม่ส่งตัวเลือกที่รู้จัก';const criterion=document.createElement('p');criterion.textContent=`เกณฑ์: ${item.criterion}`;const date=document.createElement('small');date.textContent=new Date(item.created_at).toLocaleString('th-TH');card.append(title,winner,criterion,date);node.append(card);}
  }
  async function loadSummary() {
    if(!project)return;
    const data=await api(`/api/projects/${project.id}/summary`);
    $('summary-policy-count').textContent=data.policy_count.toLocaleString('th-TH');$('summary-category-count').textContent=Object.keys(data.categories).length.toLocaleString('th-TH');$('summary-decision-count').textContent=data.decisions.length.toLocaleString('th-TH');
    renderCounts('summary-categories',data.categories);renderCounts('summary-sources',data.sources);renderDecisions(data.decisions);
  }
  function displayCompareResult(data,pair) {
    const node=$('compare-result');node.replaceChildren();node.hidden=false;
    const winner=pair[data.choice];
    const label=document.createElement('span');label.className='eyebrow';label.textContent='ON-FLY-JEV / ผลเปรียบเทียบ';
    const title=document.createElement('h3');title.textContent=winner?`โมเดลเลือก ${data.choice} · ${winner.party}`:'โมเดลไม่ส่งตัวเลือกที่รู้จัก';
    const policy=document.createElement('p');policy.className='result-policy-title';policy.textContent=winner?.title||'';
    const bars=document.createElement('div');bars.className='comparison-probabilities';
    for(const side of ['A','B']){
      const row=document.createElement('div');row.className='probability-row';
      const name=document.createElement('span');name.textContent=`${side} · ${pair[side].party}`;
      const track=document.createElement('div');track.className='probability-track';const fill=document.createElement('div');fill.className='probability-fill '+(side==='B'?'side-b':'');
      const probability=Number(data.probabilities?.[side]||0);fill.style.width=`${probability*100}%`;track.append(fill);
      const number=document.createElement('strong');number.textContent=`${(probability*100).toFixed(1)}%`;row.append(name,track,number);bars.append(row);
    }
    const scope=document.createElement('p');scope.textContent='ผลของนโยบายคู่นี้ตามเกณฑ์ที่กำหนด';
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='รายละเอียดการรัน';
    const runtime=document.createElement('p');runtime.textContent=`On-Fly-Jev · ${data.runtime?.inference_ms??'—'} ms · ${data.runtime?.device??''}`;
    const note=document.createElement('p');note.textContent=`ส่งตัวอย่างข้อความต้นนโยบาย ${data.excerpted?.A?'A ถูกย่อ ': 'A ครบ '}${data.excerpted?.B?'· B ถูกย่อ':'· B ครบ'}; เนื้อหาฉบับเต็มยังอยู่ในข้อมูลที่นำเข้า`;
    details.append(summary,runtime,note);node.append(label,title,policy,bars,scope,details);loadSummary().catch(()=>{});
    node.scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  $('project-form').addEventListener('submit',async event=>{
    event.preventDefault();error('project-error','');
    try{
      const data=await api('/api/projects',{method:'POST',body:JSON.stringify({name:$('project-name').value.trim(),election:$('election-name').value.trim(),year:$('election-year').value.trim(),location:$('election-location').value.trim()})});
      $('project-form').reset();await loadProjects();await openProject(data.project.id);
    }catch(e){error('project-error',e.message);}
  });
  document.querySelectorAll('.template-card').forEach(button=>button.addEventListener('click',()=>chooseTemplate(button.dataset.template)));
  $('preview-source').addEventListener('click',previewSource);
  $('source-url').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();previewSource();}});
  $('discard-preview').onclick=()=>{$('preview-area').hidden=true;preview=null;};
  $('save-import').onclick=async()=>{
    if(!preview||!project)return;error('import-error','');setButton($('save-import'),true,'กำลังบันทึก…','บันทึกนโยบายในโปรเจกต์');
    const items=preview.policies.filter((_,index)=>index>=80||$('preview-list').querySelector(`input[data-index="${index}"]`)?.checked).map((item,index)=>({...item,content:$('preview-list').querySelector(`textarea[data-content-index="${preview.policies.indexOf(item)}"]`)?.value??item.content}));
    try{
      const result=await api(`/api/projects/${project.id}/policies`,{method:'POST',body:JSON.stringify({policies:items})});
      $('preview-area').hidden=true;preview=null;await refreshPolicies();
      $('policy-total').textContent=`${policies.length.toLocaleString('th-TH')} รายการ · เพิ่ม ${result.saved.toLocaleString('th-TH')}`;
      if(items.some(item=>PartyComparison.partyKey(item.party)&&item.source_kind!=='bma_tracker'))showWorkspace('compare');
    }catch(e){error('import-error',e.message);}
    finally{setButton($('save-import'),false,'กำลังบันทึก…','บันทึกนโยบายในโปรเจกต์');}
  };
  $('policy-search').addEventListener('input',renderPolicyTable);
  for(const side of ['a','b']){
    const upper=side.toUpperCase();
    $('compare-party-'+side).addEventListener('change',async()=>{
      choices['party'+upper]=$('compare-party-'+side).value;choices['policy'+upper]='';$('compare-search-'+side).value='';
      error('compare-error','');$('compare-result').hidden=true;updateCompareOptions();await loadSelectedSources();
    });
    $('compare-'+side).addEventListener('change',()=>{choices['policy'+upper]=$('compare-'+side).value;error('compare-error','');$('compare-result').hidden=true;updateCompareOptions();});
    $('compare-search-'+side).addEventListener('input',()=>{$('compare-result').hidden=true;updateCompareOptions();});
    $('compare-retry-'+side).onclick=loadSelectedSources;
  }
  for(const id of ['compare-criterion','compare-situation'])$(id).addEventListener('input',()=>{$('compare-result').hidden=true;});
  $('comparison-custom').onclick=()=>{
    const sources=PartyComparison.sources(project,policies);
    chooseTemplate(sources.some(item=>item.template==='bangkok_candidate')?'bangkok_candidate':'thai_election');
    $('source-preset').value='custom';$('source-preset').onchange();showWorkspace('data');$('source-url').focus();
  };
  $('quick-mock').onclick=async()=>{
    if(!project||mockLoading)return;
    const projectId=project.id;mockLoading=true;error('compare-error','');updateCompareOptions();
    try{
      const data=await api('/api/data/preview',{method:'POST',body:JSON.stringify({template:'mock'})});
      await api(`/api/projects/${projectId}/policies`,{method:'POST',body:JSON.stringify({policies:data.policies})});
      if(project?.id===projectId)await refreshPolicies();
    }catch(e){if(project?.id===projectId)error('compare-error',e.message);}
    finally{mockLoading=false;if(project)updateCompareOptions();}
  };
  $('run-project-compare').onclick=async()=>{
    error('compare-error','');$('compare-result').hidden=true;
    const idA=Number($('compare-a').value),idB=Number($('compare-b').value);
    if(!idA||!idB||!$('compare-party-b').value||$('compare-party-a').value===$('compare-party-b').value){error('compare-error','เลือกนโยบายจากสองพรรคที่แตกต่างกันก่อน');return;}
    comparing=true;updateCompareOptions();
    const projectId=project.id,pair={A:policies.find(item=>item.id===idA),B:policies.find(item=>item.id===idB)};
    const button=$('run-project-compare');setButton(button,true,'กำลังเปรียบเทียบ…','เปรียบเทียบคู่นี้');
    try{const result=await api(`/api/projects/${projectId}/compare`,{method:'POST',body:JSON.stringify({policy_a_id:idA,policy_b_id:idB,criterion:$('compare-criterion').value.trim(),situation:$('compare-situation').value.trim()})});if(project?.id===projectId)displayCompareResult(result,pair);}
    catch(e){if(project?.id===projectId)error('compare-error',e.message);}
    finally{comparing=false;setButton(button,false,'กำลังเปรียบเทียบ…','เปรียบเทียบคู่นี้');if(project)updateCompareOptions();}
  };
  $('back-projects').onclick=async()=>{$('project-workspace').hidden=true;$('project-home').hidden=false;document.body.classList.toggle('workspace-open',false);project=null;await loadProjects();};
  $('workspace-data-tab').onclick=()=>showWorkspace('data');
  $('workspace-compare-tab').onclick=()=>showWorkspace('compare');
  $('workspace-summary-tab').onclick=()=>{showWorkspace('summary');loadSummary().catch(e=>window.alert(e.message));};
  $('summary-to-data').onclick=()=>showWorkspace('compare');
  $('legacy-toggle').onclick=()=>{
    const show=$('legacy-lab').hidden;$('project-app').hidden=show;$('legacy-lab').hidden=!show;
    $('legacy-toggle').querySelector('span')?.remove();$('legacy-toggle').textContent=show?'กลับไปโปรเจกต์':'เปิดโหมดทดลองเดิม';
    window.scrollTo({top:0,behavior:'smooth'});
  };
  loadProjects().catch(e=>error('project-error',e.message));
})();
