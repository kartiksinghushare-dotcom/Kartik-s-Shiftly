import re, sys, pathlib
root = pathlib.Path(sys.argv[1])

def rep(s, old, new, n=1, label=''):
    assert s.count(old) == n, f"{label}: expected {n}, found {s.count(old)} for: {old[:90]}"
    return s.replace(old, new)

# ═══════════════════ 19b-okr-v4.js ═══════════════════
p = root/'public/js/19b-okr-v4.js'; s = p.read_text(encoding='utf-8')

# 1) period filter helpers + range-aware kids, inserted before _sbKids
s = rep(s, "function _sbKids(o,showDrafts){return okrChildren(o.id).filter(k=>k.kind!=='kr'&&!k.quarterLabel&&(okrIsKPI(o)||k.kind!=='kpi')&&okrCanSee(k)&&(showDrafts||k.state!=='draft'));}",
r'''/* ── v4.6 · Period filter (one control): all time · this month · this quarter · this year · a year · a month ·
   a single date · a custom range. Drives BOTH the list (an item shows when its period overlaps the range —
   items with no dates stay) and every hero graph's window. Persisted with the other scoreboard filters. */
function _sbPer(){const v=S.filters.okrSbPer;return(v&&typeof v==='object')?v:{mode:'all'};}
function _sbPeriodRange(){
  const v=_sbPer(),t=todayISO(),y=Number(t.slice(0,4)),m=Number(t.slice(5,7));
  const last=(yy,mm)=>_okrMkISO(yy,mm,_okrMonthLen(yy,mm));
  switch(v.mode){
    case 'month':return{from:_okrMkISO(y,m,1),to:last(y,m),label:'This month'};
    case 'quarter':{const q=Math.floor((m-1)/3);const m0=q*3+1;return{from:_okrMkISO(y,m0,1),to:last(y,m0+2),label:'This quarter'};}
    case 'year':return{from:y+'-01-01',to:y+'-12-31',label:'This year'};
    case 'y':{const yy=Number(v.y)||y;return{from:yy+'-01-01',to:yy+'-12-31',label:String(yy)};}
    case 'm':{if(!v.m||!/^\d{4}-\d{2}$/.test(v.m))return null;const yy=Number(v.m.slice(0,4)),mm=Number(v.m.slice(5,7));return{from:v.m+'-01',to:last(yy,mm),label:new Date(v.m+'-01T00:00:00').toLocaleDateString('en-GB',{month:'short',year:'numeric'})};}
    case 'd':{if(!v.d)return null;return{from:v.d,to:v.d,label:fmtD(v.d)};}
    case 'range':{if(!v.from&&!v.to)return null;const f=v.from||'0000-01-01',e=v.to||'9999-12-31';return{from:f,to:e,label:(v.from?fmtS(v.from):'…')+' – '+(v.to?fmtS(v.to):'…')};}
    default:return null;
  }
}
/* does this item belong to the range? (period overlap; no dates → always shown) */
function _sbInRange(o,R){
  if(!R)return true;
  const eff=_okrEffPeriod(o);const ps=eff.ps||eff.pe,pe=eff.pe||eff.ps;
  if(!ps||!pe)return true;
  return ps<=R.to&&pe>=R.from;
}
App._okrSbPer=(patch)=>{S.filters.okrSbPer=Object.assign({},_sbPer(),patch||{});if(patch&&patch.mode&&patch.mode!=='range'&&patch.mode!=='y'&&patch.mode!=='m'&&patch.mode!=='d')S.filters.okrSbPerOpen=false;rr();};
App._okrSbPerTog=()=>{S.filters.okrSbPerOpen=!S.filters.okrSbPerOpen;rr();};
function _sbPeriodCtl(){
  const v=_sbPer(),R=_sbPeriodRange(),open=!!S.filters.okrSbPerOpen,on=!!R;
  const yNow=new Date().getFullYear();
  const years=[...new Set((DB.okrs||[]).flatMap(o=>[o.periodStart,o.periodEnd]).filter(Boolean).map(d=>Number(String(d).slice(0,4))).concat([yNow-1,yNow,yNow+1]))].filter(n=>n>2000&&n<2100).sort();
  const quick=(k,l)=>`<button type="button" onclick="App._okrSbPer({mode:'${k}'})" class="sb-per-q${v.mode===k?' on':''}">${l}</button>`;
  const row=(l,ctl)=>`<div class="sb-per-row"><span>${l}</span>${ctl}</div>`;
  const inp='class="ui-input" style="min-height:32px;padding:4px 8px;font-size:12px"';
  return`<div style="position:relative">
    <button type="button" onclick="App._okrSbPerTog()" class="sb-per-btn${on?' on':''}">${ic('calendar','w-3.5 h-3.5')}${esc(R?R.label:'All time')}${ic('chevD','w-3 h-3')}</button>
    ${open?`<div class="sb-per-pop" onclick="event.stopPropagation()">
      <div class="sb-per-quick">${quick('all','All time')}${quick('month','This month')}${quick('quarter','This quarter')}${quick('year','This year')}</div>
      ${row('Year',`<select ${inp} onchange="App._okrSbPer({mode:'y',y:this.value})"><option value="" ${v.mode!=='y'?'selected':''}>—</option>${years.map(yy=>`<option value="${yy}" ${v.mode==='y'&&Number(v.y)===yy?'selected':''}>${yy}</option>`).join('')}</select>`)}
      ${row('Month',`<input type="month" ${inp} value="${v.mode==='m'?esc(v.m||''):''}" onchange="App._okrSbPer({mode:'m',m:this.value})"/>`)}
      ${row('Date',`<input type="date" ${inp} value="${v.mode==='d'?esc(v.d||''):''}" onchange="App._okrSbPer({mode:'d',d:this.value})"/>`)}
      ${row('Range',`<span style="display:flex;gap:6px;align-items:center;min-width:0"><input type="date" ${inp} value="${v.mode==='range'?esc(v.from||''):''}" onchange="App._okrSbPer({mode:'range',from:this.value})"/><span style="color:var(--c-text-3)">–</span><input type="date" ${inp} value="${v.mode==='range'?esc(v.to||''):''}" onchange="App._okrSbPer({mode:'range',to:this.value})"/></span>`)}
      <div style="display:flex;gap:6px;margin-top:10px">${on?`<button type="button" onclick="App._okrSbPer({mode:'all',from:'',to:''})" class="ui-btn ui-btn-ghost ui-btn-sm" style="flex:1">Clear</button>`:''}<button type="button" onclick="S.filters.okrSbPerOpen=false;rr()" class="ui-btn ui-btn-primary ui-btn-sm" style="flex:1">Done</button></div>
      <div style="font-size:10.5px;color:var(--c-text-3);margin-top:8px;line-height:1.5">Shows every objective whose period overlaps the range and zooms the graphs to it. Items without dates always stay.</div>
    </div>`:''}
  </div>`;
}
function _sbKids(o,showDrafts){const R=_sbPeriodRange();return okrChildren(o.id).filter(k=>k.kind!=='kr'&&!k.quarterLabel&&(okrIsKPI(o)||k.kind!=='kpi')&&okrCanSee(k)&&(showDrafts||k.state!=='draft')&&_sbInRange(k,R));}''', label='_sbKids')

# 2) hero: only the North Star badge (no governance chips), markers on the canvas, kids bar
s = rep(s, """      <div class="sb-hero-tags">${okrBadgesHTML(ns)}${okrStatusChip(st)}${f?okrFlagChip(f.flag,false,f):''}${okrUpdateCtl(ns,false)}<span class="sb-hero-owner">${_sbOwnerCell(ns)}</span></div>""",
"""      <div class="sb-hero-tags">${ns.isNorthStar?_okrBadge(ic('star','w-3 h-3')+'NORTH STAR','#13171B','#F3E7C9','#13171B','The one number the company runs on'):_okrLvlChip(0)}${ns.state==='draft'?_okrBadge('DRAFT','#F3F0EA','#6B5F55','#E2DBD1','Proposed — not live, not counted'):''}${okrStatusChip(st)}${f?okrFlagChip(f.flag,false,f):''}${okrUpdateCtl(ns,false)}<span class="sb-hero-owner">${_sbOwnerCell(ns)}</span></div>""", label='hero tags')
s = rep(s, """    <div class="sb-hero-chart" onclick="event.stopPropagation()"><canvas data-okr-chart="${ns.id}"></canvas></div>""",
"""    <div class="sb-hero-chart" onclick="event.stopPropagation()"><canvas data-okr-chart="${ns.id}" data-okr-marks="1"></canvas></div>
    ${_sbHeroMarksLegend(ns)}""", label='hero canvas')

# legend helper + hero section wrapper (hero + collapsible tree) — insert before okrScoreboardHTML
s = rep(s, "function okrScoreboardHTML(){",
r'''/* The dates marked on the hero graph: every milestone in the subtree (amber, green once done) and every
   sub-objective at its period end (plum). Listed under the graph as a compact key, newest first. */
function _sbHeroMarks(o){
  const sd=!!S.filters.okrSbDrafts;
  const ms=_sbMilestonesOf(o,sd).map(x=>({kind:'ms',id:x.id,date:x.date,title:x.title,done:x.done}));
  const subs=okrChildren(o.id).filter(k=>okrIsObjective(k)&&!k.quarterLabel&&!k.closed&&(sd||k.state!=='draft')&&okrCanSee(k)&&k.periodEnd).map(k=>({kind:'sub',id:k.id,date:String(k.periodEnd).slice(0,10),title:k.title||'',done:okrStatusOf(k)==='Achieved',pct:okrNoPct(k)?null:okrProgress(k)}));
  return ms.concat(subs).sort((a,b)=>a.date.localeCompare(b.date));
}
function _sbHeroMarksLegend(o){
  const all=_sbHeroMarks(o);if(!all.length)return'';
  const R=_sbPeriodRange();const marks=R?all.filter(x=>x.date>=R.from&&x.date<=R.to):all;
  if(!marks.length)return'';
  const t=todayISO();
  return`<div class="sb-marks" onclick="event.stopPropagation()">
    ${marks.slice(0,12).map(x=>`<button type="button" class="sb-mark sb-mark-${x.kind}${x.done?' done':x.date<t?' late':''}" onclick="App._okrProgressModal('${x.id}')" title="${esc((x.kind==='ms'?'Milestone · ':'Sub-objective · ')+x.title)}"><i></i><span class="sb-mark-d">${esc(fmtS(x.date))}</span><span class="sb-mark-t">${esc(x.title)}</span>${x.kind==='sub'&&x.pct!==null?`<span class="sb-mark-p">${x.pct}%</span>`:''}</button>`).join('')}
    ${marks.length>12?`<span class="sb-dim" style="align-self:center">+${marks.length-12} more on the graph</span>`:''}
  </div>`;
}
/* One L0 = hero + its sub-objective tree (collapsed by default; every level expands with its own arrow). */
function _sbHeroSection(r,showDrafts){
  const kids=_sbKids(r,showDrafts),exp=_sbExp(r.id);
  const rows=[];if(exp)_sbWalk(r,1,rows,showDrafts);
  const bar=kids.length?`<button type="button" class="sb-kidsbar${exp?' on':''}" onclick="event.stopPropagation();App._okrSbTog('${r.id}')" aria-expanded="${exp?'true':'false'}">${ic('chevR','w-3.5 h-3.5')}<span>${kids.length} sub-objective${kids.length===1?'':'s'}</span><span class="sb-dim">${exp?'hide':'show'}</span></button>`:'';
  return`<section class="sb-sec sb-sec-hero${r.state==='draft'?' sb-draft':''}">
    ${_sbHero(r)}
    ${bar}
    ${exp&&rows.length?`<div class="sb-table"><div class="sb-thead2"><span></span><span>Objective</span><span>Owner</span><span>Status</span></div>${rows.join('')}</div>`:''}
  </section>`;
}
function okrScoreboardHTML(){''', label='scoreboard head')

# 3) okrScoreboardHTML body: all L0s → hero sections; period filter in the control bar; range filtering
s = rep(s, """  const rootsAll=okrVisibleRoots().filter(o=>!o.quarterLabel&&o.kind!=='kr'&&(showDrafts||o.state!=='draft'));
  const roots=rootsAll.filter(okrIsObjective);
  const nss=roots.filter(o=>o.isNorthStar),others=roots.filter(o=>!o.isNorthStar);""",
"""  const PR=_sbPeriodRange();
  const rootsAll=okrVisibleRoots().filter(o=>!o.quarterLabel&&o.kind!=='kr'&&(showDrafts||o.state!=='draft')&&_sbInRange(o,PR));
  /* v4.6 — every top-level objective gets the hero treatment; the flagged North Star keeps its badge and engines */
  const roots=rootsAll.filter(okrIsObjective).sort((a,b)=>(b.isNorthStar?1:0)-(a.isNorthStar?1:0));""", label='roots')
s = rep(s, """      <span class="sb-asof">${ic('calendar','w-3.5 h-3.5')}As of ${esc(fmtD(todayISO()))}</span>
      <span class="sb-expctl">""",
"""      <span class="sb-asof">As of ${esc(fmtD(todayISO()))}</span>
      ${_sbPeriodCtl()}
      <span class="sb-expctl">""", label='ctl')
s = rep(s, """  const sections=others.map(r=>{
    const kids=_sbKids(r,showDrafts),exp=_sbExp(r.id);
    const rows=[];if(exp)_sbWalk(r,1,rows,showDrafts);
    return`<section class="sb-sec${r.state==='draft'?' sb-draft':''}">
      <div class="sb-table">
        <div class="sb-thead2"><span></span><span>Objective</span><span>Owner</span><span>Status</span></div>
        ${_sbRow(r,0,true,kids.length,exp)}
        ${rows.join('')}
      </div>
    </section>`;}).join('');""",
"""  const sections=roots.map(r=>_sbHeroSection(r,showDrafts)).join('');""", label='sections')
s = rep(s, """  return`<div class="sb">${pending}${strip}${ctl}${nss.map(_sbHero).join('')}${sections}</div>`;""",
"""  return`<div class="sb">${pending}${strip}${ctl}${PR&&!roots.length?`<div class="sb-empty">${ic('calendar','w-5 h-5')}<div><b>Nothing in ${esc(PR.label)}.</b> No objective's period overlaps this range — clear the period filter to see everything.</div></div>`:''}${sections}</div>`;""", label='return')
p.write_text(s, encoding='utf-8'); print('19b ok')

# ═══════════════════ 19-okr-roles-acl.js — markers + window on hero charts ═══════════════════
p = root/'public/js/19-okr-roles-acl.js'; s = p.read_text(encoding='utf-8')
s = rep(s, """      const _tnow=todayISO();
      const _eff=_okrEffPeriod(o);""",
"""      const _tnow=todayISO();
      const _eff=_okrEffPeriod(o);
      /* v4.6 — hero graphs (data-okr-marks) mark milestones + sub-objectives on their dates: the axis stretches to the
         furthest marker; the scoreboard's period filter then windows the whole thing. */
      const _marksOn=cv.getAttribute('data-okr-marks')==='1'&&typeof _sbHeroMarks==='function';
      const _marks=_marksOn?_sbHeroMarks(o):[];
      if(_marksOn&&_marks.length){const mx=_marks[_marks.length-1].date,mn=_marks[0].date;if(!_eff.pe||mx>_eff.pe)_eff.pe=mx;if(!_eff.ps||mn<_eff.ps)_eff.ps=mn;}
      const _win=(_marksOn&&typeof _sbPeriodRange==='function')?_sbPeriodRange():null;
      if(_win&&_eff.ps&&_eff.pe&&_win.from<=_eff.pe&&_win.to>=_eff.ps){if(_win.from>_eff.ps)_eff.ps=_win.from;if(_win.to<_eff.pe)_eff.pe=_win.to;}
      const _marksIn=_marks.filter(x=>(!_eff.ps||x.date>=_eff.ps)&&(!_eff.pe||x.date<=_eff.pe));""", label='eff')
s = rep(s, """        if(_tnow>=_eff.ps&&_tnow<=_eff.pe)s.add(_tnow);
        dates=[...s].sort();""",
"""        if(_tnow>=_eff.ps&&_tnow<=_eff.pe)s.add(_tnow);
        _marksIn.forEach(x=>s.add(x.date));
        dates=[...s].sort();""", label='dates')
s = rep(s, """      ds.push({label:'Actual',data:actual,spanGaps:true,order:-1,borderColor:'#54433C',backgroundColor:'rgba(84,67,60,.12)',fill:true,tension:.3,pointRadius:_th?4:3,pointBackgroundColor:_ptCol,pointBorderColor:_ptCol,borderWidth:2});""",
"""      ds.push({label:'Actual',data:actual,spanGaps:true,order:-1,borderColor:'#54433C',backgroundColor:'rgba(84,67,60,.12)',fill:true,tension:.3,pointRadius:_th?4:3,pointBackgroundColor:_ptCol,pointBorderColor:_ptCol,borderWidth:2});
      /* v4.6 — marker datasets: a point per milestone (amber · green when done) and per sub-objective (plum) sitting on
         the planned line at its date, plus a thin vertical guide drawn by the plugin below. */
      const _mkTip={};
      if(_marksIn.length){
        const yAt=d=>{const i=dates.indexOf(d);const v=ideal?ideal[i]:null;if(v!==null&&v!==undefined)return v;const a=actual.slice(0,i+1).filter(x=>x!==null);return a.length?a[a.length-1]:Number(o.startValue||0);};
        const mk=(kind,label,color,style)=>{const pts=_marksIn.filter(x=>x.kind===kind);if(!pts.length)return;
          const data=dates.map(()=>null),bg=dates.map(()=>color),rad=dates.map(()=>0);
          pts.forEach(x=>{const i=dates.indexOf(x.date);if(i<0)return;data[i]=yAt(x.date);rad[i]=kind==='ms'?6:7;if(x.done)bg[i]='#58996E';(_mkTip[x.date]=_mkTip[x.date]||[]).push((kind==='ms'?'◆ ':'▣ ')+(x.done?'✓ ':'')+x.title+(x.pct!==null&&x.pct!==undefined?' · '+x.pct+'%':''));});
          ds.push({label:label,data:data,showLine:false,pointStyle:style,pointRadius:rad,pointHoverRadius:rad.map(r=>r?r+2:0),pointBackgroundColor:bg,pointBorderColor:'#FFFFFF',pointBorderWidth:1.5,borderColor:color,backgroundColor:color,order:-2,_okrMark:true});};
        mk('ms','Milestones','#D9A62B','rectRot');
        mk('sub','Sub-objectives','#7A5A9A','rect');
      }""", label='marker datasets')
s = rep(s, """      _aCharts.push(new Chart(cv.getContext('2d'),{type:'line',data:{labels:labels,datasets:ds},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,labels:{color:T.tick,font:{size:10.5},boxWidth:14,padding:8}}},""",
"""      const _mkPlugin={id:'okrMarks',afterDatasetsDraw(chart){if(!_marksIn.length)return;const x=chart.scales.x,area=chart.chartArea,ctx=chart.ctx;if(!x||!area)return;ctx.save();ctx.setLineDash([3,4]);ctx.lineWidth=1;
        const seen=new Set();_marksIn.forEach(m=>{if(seen.has(m.date))return;seen.add(m.date);const i=dates.indexOf(m.date);if(i<0)return;const px=x.getPixelForValue(i);const anySub=_marksIn.some(z=>z.date===m.date&&z.kind==='sub');ctx.strokeStyle=anySub?'rgba(122,90,154,.55)':'rgba(217,166,43,.6)';ctx.beginPath();ctx.moveTo(px,area.top);ctx.lineTo(px,area.bottom);ctx.stroke();});ctx.restore();}};
      _aCharts.push(new Chart(cv.getContext('2d'),{type:'line',data:{labels:labels,datasets:ds},plugins:[_mkPlugin],options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,labels:{color:T.tick,font:{size:10.5},boxWidth:14,padding:8,usePointStyle:false}},tooltip:{callbacks:{label:function(c){const d=c.dataset;if(d&&d._okrMark){return(_mkTip[dates[c.dataIndex]]||[]).filter(t2=>(d.label==='Milestones')===(t2.charAt(0)==='◆'));}return(d.label||'')+': '+(c.parsed&&c.parsed.y!==null&&c.parsed.y!==undefined?_okrFmtVal(o,c.parsed.y):'—');}}}},""", label='chart ctor')
p.write_text(s, encoding='utf-8'); print('19 ok')

# ═══════════════════ main.css ═══════════════════
p = root/'src/styles/main.css'; s = p.read_text(encoding='utf-8')
anchor = ".sb2-meta .sb-sep{color:var(--c-border-2);font-weight:700}"
assert s.count(anchor) == 1
s = s.replace(anchor, anchor + '''
/* v4.6 — hero sections, kids bar, period filter, graph marker key */
.sb-sec-hero{display:flex;flex-direction:column}
.sb-sec-hero .sb-hero{border:none;border-radius:0;box-shadow:none;grid-template-areas:"main tiles" "chart chart" "marks marks" "eng eng"}
.sb-kidsbar{display:flex;align-items:center;gap:8px;width:100%;padding:9px 18px;border:none;border-top:1px solid var(--c-border);background:var(--c-surface-2);color:var(--c-text);font:inherit;font-size:12px;font-weight:800;cursor:pointer;text-align:left}
.sb-kidsbar svg{transition:transform .12s;color:var(--c-text-3)}
.sb-kidsbar.on svg{transform:rotate(90deg)}
.sb-kidsbar .sb-dim{margin-left:auto;font-weight:600}
.sb-kidsbar:hover{background:var(--c-bg)}
.sb-sec-hero .sb-table{border-top:1px solid var(--c-border)}
.sb-marks{grid-area:marks;display:flex;flex-wrap:wrap;gap:6px;cursor:default;margin-top:-4px}
.sb-mark{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 9px 3px 7px;border-radius:20px;border:1px solid var(--c-border);background:var(--c-surface);font:inherit;font-size:11px;color:var(--c-text-2);cursor:pointer;min-width:0}
.sb-mark:hover{border-color:var(--c-text-3)}
.sb-mark i{width:9px;height:9px;flex-shrink:0;display:inline-block}
.sb-mark-ms i{background:#D9A62B;transform:rotate(45deg);border-radius:1px}
.sb-mark-sub i{background:#7A5A9A;border-radius:2px}
.sb-mark.done i{background:#58996E}
.sb-mark.late{border-color:#F0CFC8}
.sb-mark.late .sb-mark-d{color:#A63528}
.sb-mark-d{font-weight:800;color:var(--c-text);white-space:nowrap;font-variant-numeric:tabular-nums}
.sb-mark-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.sb-mark-p{font-weight:800;color:var(--c-text);font-variant-numeric:tabular-nums}
.sb-per-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:9px;border:1.5px solid var(--c-border-2);background:var(--c-surface);color:var(--c-text-2);font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
.sb-per-btn.on{border-color:var(--c-text);background:var(--c-ink);color:#fff}
.sb-per-pop{position:absolute;top:36px;left:0;z-index:60;background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;box-shadow:var(--sh-md);padding:10px;width:300px;max-width:calc(100vw - 32px);cursor:default}
.sb-per-quick{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px}
.sb-per-q{padding:6px 8px;border-radius:8px;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text-2);font:inherit;font-size:11.5px;font-weight:700;cursor:pointer}
.sb-per-q.on{background:var(--c-ink);color:#fff;border-color:var(--c-ink)}
.sb-per-row{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;align-items:center;padding:4px 0;font-size:11.5px;font-weight:700;color:var(--c-text-2)}
.sb-per-row .ui-input{width:100%;min-width:0}
@media (max-width:760px){.sb-marks{margin-top:0}.sb-mark-t{max-width:150px}}''')
p.write_text(s, encoding='utf-8'); print('css ok')

p = root/'index.html'; s = p.read_text(encoding='utf-8'); n = s.count('?v=181'); assert n > 30
p.write_text(s.replace('?v=181','?v=182'), encoding='utf-8'); print('bumped', n, 'to v=182')
