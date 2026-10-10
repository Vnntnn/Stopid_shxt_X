'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {options, sources} = require('../web/comparison-options.js');
const policies = [
  {id:1, party:'พรรค A', title:'รถเมล์', source_kind:'party_campaign'},
  {id:2, party:'พรรค A', title:'โรงเรียน', source_kind:'party_campaign'},
  {id:3, party:'พรรค B', title:'รถไฟ', source_kind:'party_campaign'},
  {id:4, party:'พรรค C', title:'ทางเท้า', source_kind:'candidate_campaign'}
];
test('single-party imports require another party instead of comparing two policies from the same party', () => {
  const result = options(policies.slice(0,2));
  assert.equal(result.ready, false);
  assert.equal(result.partyB, '');
  assert.deepEqual(result.policiesB, []);
  assert.equal(result.policiesA.length, 2);
});
test('defaults and dropdown policies belong to different parties', () => {
  const result = options(policies);
  assert.equal(result.ready, true);
  assert.notEqual(result.partyA, result.partyB);
  assert.deepEqual(result.policiesA.map(p=>p.id), [1,2]);
  assert.deepEqual(result.policiesB.map(p=>p.id), [3]);
  assert.ok(result.partiesB.every(p=>p.key!==result.partyA));
});
test('switching A to the previous B picks a different B and clears incompatible policies', () => {
  const result = options(policies, {partyA:'พรรค b', partyB:'พรรค b', policyA:'1', policyB:'3'});
  assert.equal(result.partyA, 'พรรค b');
  assert.equal(result.partyB, 'พรรค a');
  assert.equal(result.policyA, '3');
  assert.equal(result.policyB, '1');
});
test('refresh preserves valid party and policy selections', () => {
  const previous = {partyA:'พรรค a', partyB:'พรรค c', policyA:'2', policyB:'4'};
  const result = options(policies, previous);
  for (const key of Object.keys(previous)) assert.equal(result[key], previous[key]);
});
test('unidentified records and BMA tracking rows cannot act as a second party', () => {
  const result = options([policies[0], {...policies[2], party:''}, {...policies[3], source_kind:'bma_tracker'}]);
  assert.equal(result.ready, false);
  assert.equal(result.parties.length, 1);
});
test('normalizes party whitespace and case to prevent duplicate party choices', () => {
  const result = options([policies[0], {...policies[2], party:'  พรรค   a  '}]);
  assert.equal(result.parties.length, 1);
  assert.equal(result.ready, false);
});
test('offers official parties directly even before their policies are imported', () => {
  const catalog = sources({election:'เลือกตั้งไทย'}, []);
  const result = options([], {}, catalog);
  assert.equal(result.parties.length, 4);
  assert.ok(result.parties.every(p=>p.source.url.startsWith('https://')));
  assert.equal(result.partyA, '');
  assert.equal(result.partyB, '');
  assert.equal(result.ready, false);
});
test('single-party project can select the other official party without an import screen', () => {
  const imported = [{id:12,party:'พรรคประชาชน',source_kind:'party_campaign'}];
  const catalog = sources({election:'เลือกตั้งไทย'}, imported);
  const pending = options(imported, {partyA:'พรรคประชาชน',partyB:'พรรคเพื่อไทย'}, catalog);
  assert.equal(pending.partyB, 'พรรคเพื่อไทย');
  assert.equal(pending.ready, false);
  assert.equal(pending.partiesB[0].source.template, 'thai_election');
  const loaded = options([...imported,{id:13,party:'พรรคเพื่อไทย',source_kind:'party_campaign'}], pending, catalog);
  assert.equal(loaded.partyA, 'พรรคประชาชน');
  assert.equal(loaded.partyB, 'พรรคเพื่อไทย');
  assert.equal(loaded.ready, true);
});
test('selecting B first retains B when its import completes', () => {
  const catalog = sources({election:'เลือกตั้งไทย'}, []);
  const result = options([{id:1,party:'พรรคประชาชน',source_kind:'party_campaign'}], {partyA:'',partyB:'พรรคประชาชน'}, catalog);
  assert.equal(result.partyA, '');
  assert.equal(result.partyB, 'พรรคประชาชน');
  assert.equal(result.policyB, '1');
});
test('Bangkok and mock projects do not offer national-election party sources', () => {
  const catalog = sources({election:'เลือกตั้งผู้ว่า กทม.'}, []);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].template, 'bangkok_candidate');
  assert.deepEqual(sources({},[{source_kind:'mock'}]), []);
  assert.deepEqual(sources({year:'2566'}, []), []);
});
test('new official parties are offered and their Bangkok policies stay in the right cohort', () => {
  const catalog=sources({election:'เลือกตั้งไทย'},[]);
  assert.ok(catalog.some(p=>p.key==='พรรคภูมิใจไทย'));
  assert.ok(catalog.some(p=>p.key==='พรรคประชาธิปัตย์'));
  const rows=[{id:1,party:'พรรคประชาธิปัตย์',source_meta:{scope:'national'}},{id:2,party:'พรรคประชาธิปัตย์',source_meta:{scope:'bangkok'}}];
  assert.deepEqual(options(rows,{},catalog).policiesA.map(p=>p.id),[1]);
  assert.deepEqual(options(rows,{},sources({election:'เลือกตั้ง กทม.'},rows)).policiesA.map(p=>p.id),[2]);
});
test('mixed older imports keep national and Bangkok official policy records in separate comparison cohorts', () => {
  const rows=[{id:1,party:'พรรคประชาชน',source_url:'https://election69.peoplesparty.or.th/policy/1'}, {id:2,party:'พรรคประชาชน',source_url:'https://bkk2569.peoplesparty.or.th/policy/2'}];
  const national=options(rows,{},sources({election:'เลือกตั้งไทย'},rows));
  assert.deepEqual(national.policiesA.map(p=>p.id),[1]);
  const bangkok=options(rows,{},sources({election:'เลือกตั้ง กทม.'},rows));
  assert.deepEqual(bangkok.policiesA.map(p=>p.id),[2]);
});
