'use strict';
// Share the selection rules with the UI and the local regression tests.
const PartyComparison = (() => {
  const partyKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const nationalSources = [
    {key:'พรรคเพื่อไทย', label:'พรรคเพื่อไทย', template:'thai_election', url:'https://election.ptp.or.th/policy'},
    {key:'พรรคประชาชน', label:'พรรคประชาชน', template:'thai_election', url:'https://election69.peoplesparty.or.th/policy/'},
    {key:'พรรคภูมิใจไทย', label:'พรรคภูมิใจไทย', template:'thai_election', url:'https://www.bhumjaithai.com/policy'},
    {key:'พรรคประชาธิปัตย์', label:'พรรคประชาธิปัตย์', template:'thai_election', url:'https://www.democrat.or.th/policies/'}
  ];
  function sources(project, policies) {
    const year = String(project?.year || '').match(/\d{4}/)?.[0];
    if (year && !['2569', '2026'].includes(year)) return [];
    if (policies.some(p => p.source_kind === 'mock')) return [];
    const national = policies.some(p => p.source_meta?.scope === 'national' || /election69\.peoplesparty|election\.ptp|bhumjaithai/.test(p.source_url || ''));
    const bangkok = /กทม|ผู้ว่า|ส\.ก\.|bangkok/i.test(project?.election || '') || (!national && policies.some(p => p.source_url?.includes('bkk2569') || p.source_meta?.scope === 'bangkok' || p.source_kind === 'bma_tracker'));
    return bangkok ? [
      {key:'พรรคประชาชน', label:'พรรคประชาชน', template:'bangkok_candidate', url:'https://bkk2569.peoplesparty.or.th/policy/'},
      {key:'พรรคประชาธิปัตย์', label:'พรรคประชาธิปัตย์', template:'bangkok_candidate', url:'https://www.democrat.or.th/category/policy/bangkok-policy/'}
    ] : nationalSources;
  }
  function options(policies, previous = {}, catalog = []) {
    const groups = new Map();
    const bangkok = catalog.some(source => source.template === 'bangkok_candidate');
    for (const policy of policies) {
      const key = partyKey(policy.party);
      if (!key || policy.source_kind === 'bma_tracker') continue;
      if (catalog.length && (bangkok ? policy.source_meta?.scope==='national' || /election69\.peoplesparty|election\.ptp|bhumjaithai/.test(policy.source_url || '') : policy.source_meta?.scope==='bangkok' || policy.source_url?.includes('bkk2569'))) continue;
      if (!groups.has(key)) groups.set(key, {key, label:policy.party.trim(), policies:[]});
      groups.get(key).policies.push(policy);
    }
    for (const source of catalog) {
      if (!groups.has(source.key)) groups.set(source.key, {key:source.key, label:source.label, policies:[]});
      groups.get(source.key).source = source;
    }
    const parties = [...groups.values()];
    const partyA = groups.has(previous.partyA) ? previous.partyA : parties.find(p => p.policies.length && p.key !== previous.partyB)?.key || '';
    const partiesB = parties.filter(party => party.key !== partyA);
    const partyB = partiesB.some(party => party.key === previous.partyB) ? previous.partyB : partiesB.find(p => p.policies.length)?.key || '';
    const policiesA = groups.get(partyA)?.policies || [];
    const policiesB = groups.get(partyB)?.policies || [];
    const choose = (items, id) => String(items.find(item => String(item.id) === String(id))?.id || items[0]?.id || '');
    return {parties, partiesB, partyA, partyB, policiesA, policiesB,
      policyA:choose(policiesA, previous.policyA), policyB:choose(policiesB, previous.policyB),
      ready:policiesA.length > 0 && policiesB.length > 0};
  }
  return {partyKey, options, sources};
})();
if (typeof module !== 'undefined') module.exports = PartyComparison;
