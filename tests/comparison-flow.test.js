'use strict';
// Exercise the controller without a browser, with isolated API fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

class Element {
  constructor(tag='div') { this.tagName=tag;this.children=[];this.value='';this.hidden=false;this.disabled=false;this.dataset={};this.style={};this.listeners={};this.classList={toggle(){}}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=items; }
  setAttribute() {}
  addEventListener(type,handler) { this.listeners[type]=handler; }
  querySelector(selector) { if(selector==='span')return this.children[0] || (this.children[0]=new Element('span'));return null; }
  focus() {}
  scrollIntoView() {}
  remove() {}
}
async function workspace(initial, {deferPreview=false, previewFailures=0}={}) {
  const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,'HTML ids must be unique');
  const nodes=new Map(ids.map(id=>[id,new Element()]));
  const $=id=>{assert.ok(nodes.has(id),`missing UI element ${id}`);return nodes.get(id);};
  $('compare-criterion').value='การเดินทาง';
  let rows=initial.map(p=>({...p})),releasePreview;
  const calls=[];
  const fetch=async(url,options={})=>{
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
    calls.push({url,method,body});
    let data;
    if(url==='/api/projects')data={projects:[{id:3,name:'ทดสอบ',election:'เลือกตั้งไทย',policy_count:rows.length}]};
    else if(url==='/api/projects/3')data={project:{id:3,name:'ทดสอบ',election:'เลือกตั้งไทย'}};
    else if(url==='/api/projects/3/policies'&&method==='GET')data={policies:rows};
    else if(url==='/api/projects/3/policies'){
      rows.push(...body.policies.map((p,index)=>({...p,id:rows.length+index+1})));data={saved:body.policies.length};
    }else if(url==='/api/projects/3/summary')data={policy_count:rows.length,categories:{},sources:{},decisions:[]};
    else if(url==='/api/data/preview'){
      if(previewFailures-- > 0)return {ok:false,json:async()=>({detail:'เว็บต้นทางไม่พร้อม'})};
      if(deferPreview)await new Promise(resolve=>{releasePreview=resolve;});
      data={policies:[{title:'รถเมล์เพิ่มเที่ยว',party:'พรรคเพื่อไทย',category:'เดินทาง',content:'เพิ่มเที่ยวรถเมล์ช่วงเร่งด่วน',source_kind:'party_campaign',source_url:'https://election.ptp.or.th/policy',source_label:'แหล่งทางการ'}]};
      if(body.template==='mock')data={policies:[{...pp,id:undefined,party:'พรรคสมมติ A',source_kind:'mock'}, {...pp,id:undefined,party:'พรรคสมมติ B',source_kind:'mock'}]};
    }else if(url==='/api/projects/3/compare')data={choice:'B',probabilities:{A:0.3,B:0.7},runtime:{inference_ms:10},excerpted:{A:false,B:false}};
    else throw Error(`Unexpected API request: ${method} ${url}`);
    return {ok:true,json:async()=>data};
  };
  const context=vm.createContext({document:{body:new Element(),getElementById:$,createElement:tag=>new Element(tag),querySelectorAll:()=>[]},window:{alert:message=>{throw Error(message);},scrollTo(){}},fetch});
  vm.runInContext(fs.readFileSync(path.join(root,'web/comparison-options.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'web/projects.js'),'utf8'),context);
  await new Promise(setImmediate);
  await $('project-list').children[0].onclick();
  return {$,calls,release:()=>releasePreview(),change:(id,value)=>{$(id).value=value;return $(id).listeners.change();}};
}
const pp={id:1,title:'รถเมล์ราคาคงที่',party:'พรรคประชาชน',category:'เดินทาง',content:'กำหนดราคาเดียว',source_kind:'party_campaign',source_url:'https://election69.peoplesparty.or.th/policy/',source_label:'แหล่งทางการ'};

test('direct B selection loads its official policies inline, saves them, and enables comparison',async()=>{
  const ui=await workspace([pp],{deferPreview:true});
  assert.equal(ui.$('workspace-compare').hidden,false);
  assert.equal(ui.$('workspace-data').hidden,true);
  assert.equal(ui.$('compare-party-a').value,'พรรคประชาชน');
  assert.ok(ui.$('compare-party-b').children.some(option=>option.value==='พรรคเพื่อไทย'));
  const pending=ui.change('compare-party-b','พรรคเพื่อไทย');
  assert.equal(ui.$('compare-load-b').hidden,false);
  assert.equal(ui.$('run-project-compare').disabled,true);
  ui.release();await pending;
  assert.equal(ui.$('compare-party-b').value,'พรรคเพื่อไทย');
  assert.equal(ui.$('compare-b').value,'2');
  assert.equal(ui.$('run-project-compare').disabled,false);
  assert.equal(ui.$('workspace-data').hidden,true);
  assert.equal(ui.calls.filter(c=>c.url==='/api/data/preview').length,1);
  await ui.$('run-project-compare').onclick();
  const request=ui.calls.find(c=>c.url==='/api/projects/3/compare');
  assert.equal(request.body.policy_a_id,1);
  assert.equal(request.body.policy_b_id,2);
  assert.equal(ui.$('compare-result').hidden,false);
  assert.match(ui.$('compare-result').children.find(n=>n.tagName==='h3').textContent,/พรรคเพื่อไทย/);
});
test('search with no match disables comparison and clearing it restores the selection',async()=>{
  const ui=await workspace([pp,{...pp,id:2,party:'พรรคเพื่อไทย'}]);
  assert.equal(ui.$('run-project-compare').disabled,false);
  ui.$('compare-search-b').value='คำที่ไม่มี';ui.$('compare-search-b').listeners.input();
  assert.equal(ui.$('compare-b').value,'');
  assert.equal(ui.$('run-project-compare').disabled,true);
  ui.$('compare-search-b').value='';ui.$('compare-search-b').listeners.input();
  assert.equal(ui.$('compare-b').value,'2');
  assert.equal(ui.$('run-project-compare').disabled,false);
});
test('failed party loading keeps the choice, shows an inline retry, and recovers',async()=>{
  const ui=await workspace([pp],{previewFailures:1});
  await ui.change('compare-party-b','พรรคเพื่อไทย');
  assert.equal(ui.$('compare-party-b').value,'พรรคเพื่อไทย');
  assert.equal(ui.$('compare-load-error-b').hidden,false);
  assert.equal(ui.$('compare-retry-b').hidden,false);
  assert.equal(ui.$('run-project-compare').disabled,true);
  await ui.$('compare-retry-b').onclick();
  assert.equal(ui.$('compare-load-error-b').hidden,true);
  assert.equal(ui.$('run-project-compare').disabled,false);
});
test('empty project can load two mock parties directly from the compare page',async()=>{
  const ui=await workspace([]);
  assert.equal(ui.$('quick-mock').hidden,false);
  await ui.$('quick-mock').onclick();
  assert.equal(ui.$('compare-party-a').value,'พรรคสมมติ a');
  assert.equal(ui.$('compare-party-b').value,'พรรคสมมติ b');
  assert.equal(ui.$('run-project-compare').disabled,false);
  assert.equal(ui.$('quick-mock').hidden,true);
  assert.equal(ui.$('workspace-data').hidden,true);
});
