/* ============================================================
   19c-okr-import.js — Bridge v4.3 · OKR / KPI template download + bulk upload
   ------------------------------------------------------------
   Two buttons on the OKR and KPIs tabs (anyone with OKR → Create):

     · Template   one Excel file — sheet "OKRs" (objectives + key results), sheet "KPIs",
                  sheet "How to fill". Blank with two example rows, or pre-filled with everything
                  you can see (for bulk updating). Column A is the item ID: hidden, so a renamed
                  title still updates the same item. Blank ID = create.
     · Upload     drop the filled file → every row is previewed as Will create / Will update /
                  Error (with the reason) → nothing is written until "Import" is pressed.

   Saving goes through the same path as the editor (_okrPush + okrLog + saveDB), so RLS,
   permissions and the activity trail apply. The upload never deletes, closes or moves an
   existing item; a blank cell on an existing item keeps the current value.

   Loaded after 19b-okr-v4.js (classic script, shared scope). Nothing runs at load time.
   ============================================================ */

/* ───────────────────────── columns ───────────────────────── */
const OKR_IMP_COLS=[
  ['id','ID (leave blank for new)'],
  ['type','Type *'],
  ['title','Title *'],
  ['parent','Parent (title)'],
  ['krKind','Key result type'],
  ['metric','Metric'],
  ['direction','Direction'],
  ['start','Start value'],
  ['target','Target value'],
  ['unit','Unit'],
  ['floor','Floor / ceiling'],
  ['items','Items to count'],
  ['owners','Owners (emails) *'],
  ['dept','Department'],
  ['subDept','Sub-department'],
  ['periodStart','Period start (YYYY-MM-DD)'],
  ['periodEnd','Period end (YYYY-MM-DD)'],
  ['dueDate','Due date (YYYY-MM-DD)'],
  ['checkin','Check-in'],
  ['description','Description']
];
const OKR_IMP_TYPES={objective:'Objective',kr:'Key result',kpi:'KPI'};
const OKR_IMP_KRKIND={metric:'Number',milestone:'Milestone',count:'Count',range:'Floor + target'};
const OKR_IMP_METRIC={number:'Number',percent:'Percentage',currency:'Currency',yesno:'Yes / No'};
const OKR_IMP_DIR={up:'Higher is better',down:'Lower is better',gte:'Greater than',lte:'Less than'};
const _okrImpInv=(m)=>{const o={};Object.keys(m).forEach(k=>o[String(m[k]).toLowerCase()]=k);return o;};
const _okrImpNorm=(s)=>String(s===null||s===undefined?'':s).trim();
const _okrImpKey=(s)=>_okrImpNorm(s).toLowerCase().replace(/\s+/g,' ');

/* Lookup of a label → key, tolerant of case, blanks and a few synonyms */
function _okrImpPick(map,val,syn){
  const v=_okrImpKey(val);if(!v)return null;
  const inv=_okrImpInv(map);if(inv[v])return inv[v];
  if(map[v]!==undefined)return v;                    // the key itself was typed
  if(syn&&syn[v])return syn[v];
  return undefined;                                   // typed but unknown
}
function _okrImpFreq(s){
  const v=_okrImpKey(s);
  if(!v||v==='none'||v==='no')return{};
  let m=v.match(/^weekly\s*\(?\s*([a-z]{3})/);if(m){const d=m[1].charAt(0).toUpperCase()+m[1].slice(1,3);return WKDAYS.includes(d)?{type:'weekly',day:d}:undefined;}
  if(v==='weekly')return{type:'weekly',day:'Mon'};
  m=v.match(/^monthly\s*\(?\s*(\d{1,2})/);if(m){const d=Number(m[1]);return(d>=1&&d<=31)?{type:'monthly',day:d}:undefined;}
  if(v==='monthly')return{type:'monthly',day:1};
  return undefined;
}
function _okrImpFreqLabel(f){f=f||{};if(f.type==='weekly')return'Weekly ('+(f.day||'Mon')+')';if(f.type==='monthly')return'Monthly ('+(f.day||1)+')';if(f.type==='custom')return'Custom';return'None';}
function _okrImpDate(s){
  const v=_okrImpNorm(s);if(!v)return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(v))return isNaN(new Date(v+'T00:00:00'))?undefined:v;
  /* Excel may hand back a serial or a locale date even with raw:false — accept the common shapes */
  let m=v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  m=v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);if(m)return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
  if(/^\d{5}$/.test(v)){const d=new Date(Date.UTC(1899,11,30)+Number(v)*86400000);return d.toISOString().slice(0,10);}
  return undefined;
}
function _okrImpNum(s){const v=_okrImpNorm(s).replace(/,/g,'');if(v==='')return null;const n=Number(v);return isFinite(n)?n:undefined;}
function _okrImpItems(s){
  const v=_okrImpNorm(s);if(!v)return[];
  return v.split(/\s*;\s*|\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const p=line.split('|').map(x=>x.trim());const d=_okrImpDate(p[1]||'');return{id:uid('it'),name:p[0],due:(d&&d!==undefined)?d:null,doneAt:null,doneBy:null};});
}
function _okrImpItemsText(o){return okrItems(o).map(x=>x.name+(x.due?' | '+x.due:'')).join('; ');}
function _okrImpUserByText(s){
  const v=_okrImpKey(s);if(!v)return null;
  return (DB.users||[]).find(u=>u&&String(u.email||'').toLowerCase()===v)||(DB.users||[]).find(u=>u&&fullName(u).toLowerCase()===v)||null;
}
function _okrImpOwnersText(o){return okrOwners(o).map(id=>{const u=uById(id);return u?(u.email||fullName(u)):'';}).filter(Boolean).join(', ');}
function _okrImpDeptName(id){const d=(DB.departments||[]).find(x=>x.id===id);return d?d.name:'';}

/* ───────────────────────── toolbar buttons (called from okrPage) ───────────────────────── */
function _okrImpBtns(){
  if(!_okrCanCreate()||!_okrV4Ready())return'';
  return btn('Template','App._okrTemplateDialog()',{variant:'ghost',icon:'doc'})+btn('Upload','App._okrImport()',{variant:'ghost',icon:'folder'});
}

/* ───────────────────────── 1. TEMPLATE ───────────────────────── */
App._okrTemplateDialog=()=>{
  if(!_okrCanCreate())return toast('You need OKR → Create to upload','err');
  const vis=okrVisible().filter(o=>!o.quarterLabel);
  const nO=vis.filter(o=>!okrIsKPI(o)).length,nK=vis.filter(okrIsKPI).length;
  modalShell({title:'Download template',sub:'One Excel file · sheets “OKRs”, “KPIs” and “How to fill”',size:'max-w-md',key:'okr-tpl',
    body:`<div style="display:grid;gap:12px">
      ${selF('What to include','okr-tpl-mode',[['blank','Blank — two example rows to copy from'],['current','Pre-filled with what I can see ('+nO+' OKRs · '+nK+' KPIs) — for bulk updating']],'blank')}
      <div style="font-size:11.5px;color:var(--c-text-3);line-height:1.55">Column A holds the item ID and is hidden. Keep it: a row with an ID <b>updates</b> that item even if you rename the title; a row with a blank ID <b>creates</b> a new one. Parents are referenced by title, so there is nothing to look up.</div>
    </div>`,
    footer:btnG('Cancel','App.closeModal()')+btnP('Download',"App._okrTemplate((document.getElementById('okr-tpl-mode')||{}).value);App.closeModal()",'doc')});
};
function _okrImpRowOf(o){
  const p=o.parentId?okrById(o.parentId):null;
  const isKR=o.kind==='kr';
  return[
    o.id,
    OKR_IMP_TYPES[o.kind]||'KPI',
    o.title||'',
    p?(p.title||''):'',
    isKR?(OKR_IMP_KRKIND[okrKRKind(o)]||'Number'):'',
    o.metricType==='krs'?'':(OKR_IMP_METRIC[o.metricType]||'Number'),
    o.metricType==='krs'||o.metricType==='yesno'?'':(OKR_IMP_DIR[okrDirOf(o)]||''),
    o.metricType==='krs'||o.metricType==='yesno'||(isKR&&(okrKRKind(o)==='milestone'||okrKRKind(o)==='count'))?'':(o.startValue===null||o.startValue===undefined?'':o.startValue),
    o.metricType==='krs'||o.metricType==='yesno'||(isKR&&(okrKRKind(o)==='milestone'||okrKRKind(o)==='count'))?'':(o.targetValue===null||o.targetValue===undefined?'':o.targetValue),
    o.metricType==='krs'?'':(o.unit||''),
    (isKR&&okrKRKind(o)==='range'&&o.floorValue!==null&&o.floorValue!==undefined)?o.floorValue:'',
    (isKR&&okrKRKind(o)==='count')?_okrImpItemsText(o):'',
    _okrImpOwnersText(o),
    _okrImpDeptName(o.departmentId),
    _okrImpDeptName(o.subDepartmentId),
    o.periodStart||'',
    o.periodEnd||'',
    (isKR&&okrKRKind(o)==='milestone')?(o.dueDate||''):'',
    _okrImpFreqLabel(o.frequency),
    o.description||''
  ];
}
function _okrImpSheet(X,rows){
  const ws=X.utils.aoa_to_sheet(rows);
  ws['!cols']=OKR_IMP_COLS.map(([k,h],i)=>{let w=h.length;for(let r=1;r<Math.min(rows.length,300);r++){const v=rows[r][i];if(v!==null&&v!==undefined)w=Math.max(w,String(v).length);}const c={wch:Math.min(Math.max(w+2,10),48)};if(i===0)c.hidden=true;return c;});
  ws['!freeze']={xSplit:0,ySplit:1};
  ws['!autofilter']={ref:X.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(rows.length-1,1),c:OKR_IMP_COLS.length-1}})};
  return ws;
}
App._okrTemplate=async(mode)=>{
  if(!_okrCanCreate())return toast('You need OKR → Create to upload','err');
  let X;try{X=await _loadXLSX();}catch(e){return toast(e.message||'Couldn’t load the spreadsheet library','err');}
  try{
    const head=OKR_IMP_COLS.map(c=>c[1]);
    const dept=(topDepts()[0]||{}).name||'Operations';
    const mail=(me()||{}).email||'owner@company.com';
    let okrRows=[head],kpiRows=[head];
    if(mode==='current'){
      const list=_okrExportSet('all').filter(o=>!o.quarterLabel);
      list.filter(o=>!okrIsKPI(o)).forEach(o=>okrRows.push(_okrImpRowOf(o)));
      list.filter(okrIsKPI).forEach(o=>kpiRows.push(_okrImpRowOf(o)));
    }else{
      okrRows.push(['','Objective','Bolt: 0 → 150 orders/day','','','Number','Higher is better',0,150,'orders/day','','',mail,dept,'','2026-10-01','2026-12-31','','Weekly (Mon)','Launch the 15-minute gifting engine in Dubai']);
      okrRows.push(['','Key result','Bolt live in the first Dubai area','Bolt: 0 → 150 orders/day','Milestone','','','','','','','',mail,'','','2026-10-01','2026-10-31','2026-10-31','Weekly (Mon)','']);
      okrRows.push(['','Key result','Certified partner areas live','Bolt: 0 → 150 orders/day','Number','Number','Higher is better',0,6,'areas','','',mail,'','','2026-10-01','2026-12-31','','Weekly (Mon)','']);
      kpiRows.push(['','KPI','Partner areas certified (Ops)','Certified partner areas live','','Number','Higher is better',0,6,'areas','','',mail,dept,'','2026-10-01','2026-12-31','','Weekly (Mon)','Linked under the key result — the KR reads this KPI']);
      kpiRows.push(['','KPI','Flower wastage','','','Currency','Less than','',120000,'AED','','',mail,dept,'','2026-10-01','2026-12-31','','Monthly (1)','Top-level KPI, not linked to any objective']);
    }
    const help=[['How to fill this template'],[''],
      ['SHEETS'],
      ['• “OKRs” — objectives and their key results. “KPIs” — the numbers Bridge tracks (link one under an objective or a number key result by naming it in Parent).'],
      ['• Column A (ID) is hidden on purpose. Leave it blank to CREATE; keep it to UPDATE that item (safe to rename the title).'],
      ['• Rows are matched by ID first, then by exact Title. A blank cell on an existing item keeps its current value. The upload never deletes or closes anything.'],
      [''],
      ['COLUMNS'],
      ['• Type *: Objective · Key result · KPI'],
      ['• Parent (title): for an Objective — the objective above it (blank = top level, needs a Department). For a Key result — its objective (required). For a KPI — the objective / number key result to link under, or a parent KPI (blank = top-level KPI, needs a Department). A parent can be another row earlier in the same file.'],
      ['• Key result type: Number (start → target) · Milestone (just a Due date) · Count (list the Items) · Floor + target (Floor + Target). Blank = Number.'],
      ['• Metric: Number · Percentage · Currency · Yes / No. Blank = Number. An Objective with no Target value reads the average of its key results and linked KPIs.'],
      ['• Direction: Higher is better · Lower is better · Greater than (threshold) · Less than (threshold). Blank = Higher is better.'],
      ['• Items to count: “Item A | 2026-10-31; Item B | 2026-11-30” — separate items with ; and put an optional date after |.'],
      ['• Owners (emails) *: one or more user emails, comma-separated. Full names also work.'],
      ['• Department / Sub-department must match an existing department exactly:'],
      ...topDepts().flatMap(d=>[['     - '+d.name],...subDepts(d.id).map(s=>['           · '+s.name])]),
      ['• Dates as YYYY-MM-DD. Check-in: Weekly (Mon…Sun) · Monthly (1–31) · None. Blank = Weekly (Mon).'],
      [''],
      ['WHAT YOU NEED'],
      ['• OKR → Create to add items; OKR → Manage to add a top-level objective; you can only update items you are allowed to edit.'],
      ['• Rows with errors are shown in the preview and skipped — the rest import fine.']];
    const wb=X.utils.book_new();
    X.utils.book_append_sheet(wb,_okrImpSheet(X,okrRows),'OKRs');
    X.utils.book_append_sheet(wb,_okrImpSheet(X,kpiRows),'KPIs');
    const hw=X.utils.aoa_to_sheet(help);hw['!cols']=[{wch:120}];
    X.utils.book_append_sheet(wb,hw,'How to fill');
    X.writeFile(wb,mode==='current'?('bridge_okrs_kpis_'+todayISO()+'.xlsx'):'bridge_okr_kpi_template.xlsx');
    toast(mode==='current'?'Downloaded — edit, then Upload':'Template downloaded');
  }catch(e){toast(e.message||'Couldn’t build the template','err');}
};

/* ───────────────────────── 2. UPLOAD ───────────────────────── */
let _OKRIMP=null;   // {file, rows:[{n,sheet,raw,o,action,errs,warns,isNew}], ready}
App._okrImport=()=>{
  if(!_okrCanCreate())return toast('You need OKR → Create to upload','err');
  if(!_okrV4Ready())return toast('Database update pending — upload needs the v4 migration','err');
  _OKRIMP=null;
  modalShell({title:'Upload OKRs & KPIs',sub:'Fill the template, drop it here, check the preview, then import',size:'max-w-3xl',key:'okr-imp',
    body:`<div id="okrimp-body">${_okrImpPickHTML()}</div>`});
};
function _okrImpPickHTML(){
  return`<div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
      ${btn('Download template','App._okrTemplateDialog()',{variant:'ghost',icon:'doc'})}
      <span style="font-size:11.5px;color:var(--c-text-3)">Same columns as the template · sheets “OKRs” and “KPIs” (.xlsx or .csv)</span>
    </div>
    <div onclick="document.getElementById('okrimp-file').click()" ondragover="event.preventDefault();this.style.borderColor='var(--c-text)'" ondragleave="this.style.borderColor='var(--c-border-2)'" ondrop="event.preventDefault();this.style.borderColor='var(--c-border-2)';App._okrImpFile({files:event.dataTransfer.files})" style="border:2px dashed var(--c-border-2);border-radius:16px;padding:34px;text-align:center;cursor:pointer;transition:border-color .15s">
      <div style="display:inline-grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--c-surface-2);color:var(--c-text-2);margin-bottom:8px">${ic('folder','w-5 h-5')}</div>
      <div style="font-size:14px;font-weight:700;color:var(--c-text)">Click to browse or drag &amp; drop</div>
      <div style="font-size:12px;color:var(--c-text-3);margin-top:4px">Nothing is saved until you press Import on the next screen</div>
      <input type="file" id="okrimp-file" accept=".xlsx,.xls,.csv" hidden onchange="App._okrImpFile(this)"/>
    </div>
  </div>`;
}
App._okrImpFile=async(input)=>{
  const f=(input.files||[])[0];if(!f)return;
  const body=document.getElementById('okrimp-body');
  if(body)body.innerHTML='<div style="padding:30px;text-align:center;color:var(--c-text-3);font-size:13px">Reading '+esc(f.name)+'…</div>';
  try{
    const X=await _loadXLSX();
    const buf=await f.arrayBuffer();
    const wb=X.read(buf,{type:'array'});
    const sheets=[];
    const named=wb.SheetNames.filter(n=>/^okr|^kpi/i.test(n.trim()));
    (named.length?named:[wb.SheetNames[0]]).forEach(n=>{sheets.push({name:n,aoa:X.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:false,defval:''})});});
    _okrImpParse(f.name,sheets);
  }catch(e){
    toast('Couldn’t read the file: '+(e.message||e),'err');
    if(body)body.innerHTML=_okrImpPickHTML();
  }
};
/* Header row → column index map (matched on the label before any “(” or “*”) */
const _okrImpHKey=(h)=>_okrImpKey(String(h).replace(/\s*\(.*$/,'').replace(/\*/g,'').replace(/[-_\/]/g,' '));
function _okrImpHeaderMap(head){
  const want={};OKR_IMP_COLS.forEach(([k,h])=>{want[_okrImpHKey(h)]=k;});
  const syn={'parent':'parent','parent title':'parent','owner':'owners','owners':'owners','owner emails':'owners','owners emails':'owners','kr type':'krKind','key result kind':'krKind','start':'start','target':'target','floor':'floor','due':'dueDate','due date':'dueDate','period start':'periodStart','period end':'periodEnd','sub department':'subDept','subdepartment':'subDept','check in':'checkin','frequency':'checkin','items':'items','goal':'description'};
  const map={};
  (head||[]).forEach((h,i)=>{const k=_okrImpHKey(h);const key=want[k]||syn[k];if(key&&map[key]===undefined)map[key]=i;});
  return map;
}
function _okrImpParse(fname,sheets){
  const rows=[];
  sheets.forEach(sh=>{
    const aoa=sh.aoa||[];if(!aoa.length)return;
    const map=_okrImpHeaderMap(aoa[0]);
    if(map.title===undefined){rows.push({n:1,sheet:sh.name,raw:{},errs:['No “Title” column found on this sheet — download the template and keep its header row'],fatal:true});return;}
    const defType=/^kpi/i.test(sh.name.trim())?'KPI':'';
    for(let r=1;r<aoa.length;r++){
      const line=aoa[r]||[];
      if(!line.some(c=>_okrImpNorm(c)))continue;      // blank line
      const raw={};OKR_IMP_COLS.forEach(([k])=>{raw[k]=map[k]===undefined?'':_okrImpNorm(line[map[k]]);});
      if(!raw.type)raw.type=defType;
      rows.push({n:r+1,sheet:sh.name,raw:raw,errs:[],warns:[]});
    }
  });
  if(!rows.length){toast('The file has no rows to import','err');const b=document.getElementById('okrimp-body');if(b)b.innerHTML=_okrImpPickHTML();return;}
  _OKRIMP={file:fname,rows:rows};
  _okrImpResolve();
  _okrImpRenderPreview();
}
/* ── Resolve every row into a ready-to-save object + action, without touching DB ── */
function _okrImpResolve(){
  const R=_OKRIMP.rows.filter(r=>!r.fatal);
  const byTitleExisting={};(DB.okrs||[]).forEach(o=>{if(o&&!o.deletedAt&&!o.quarterLabel){const k=_okrImpKey(o.title);if(k&&!byTitleExisting[k])byTitleExisting[k]=o;}});
  /* pass 1 — identity: existing (by ID, then exact title) or new (fresh id) */
  const byTitleFile={};
  R.forEach(r=>{
    const raw=r.raw;r.errs=[];r.warns=[];
    const type=_okrImpPick(OKR_IMP_TYPES,raw.type,{'o':'objective','obj':'objective','key result':'kr','kr':'kr','keyresult':'kr','kpi':'kpi'});
    r.kind=type||null;
    if(!raw.title)r.errs.push('Title is empty');
    if(type===undefined)r.errs.push('Type “'+raw.type+'” is not Objective, Key result or KPI');
    if(type===null)r.errs.push('Type is empty');
    let ex=null;
    if(raw.id){ex=okrById(raw.id);if(!ex||ex.deletedAt)r.warns.push('ID not found — matched by title instead');}
    if(!ex&&raw.title)ex=byTitleExisting[_okrImpKey(raw.title)]||null;
    r.existing=ex;r.isNew=!ex;
    r.id=ex?ex.id:uid('okr');
    if(ex&&r.kind&&ex.kind!==r.kind)r.errs.push('This item exists as a '+okrKindLabel(ex)+' — the type can’t be changed by upload');
    const tk=_okrImpKey(raw.title);
    if(tk){if(byTitleFile[tk])r.errs.push('Duplicate title in the file (row '+byTitleFile[tk].n+')');else byTitleFile[tk]=r;}
  });
  /* pass 2 — fields */
  const findParent=(txt)=>{
    const k=_okrImpKey(txt);if(!k)return null;
    const ex=okrById(txt)||byTitleExisting[k];if(ex)return{id:ex.id,kind:ex.kind,obj:ex,title:ex.title};
    const fr=byTitleFile[k];if(fr&&!fr.errs.length)return{id:fr.id,kind:fr.kind,row:fr,title:fr.raw.title};
    if(fr)return{bad:true};
    return undefined;
  };
  R.forEach(r=>{
    if(!r.kind)return;
    const raw=r.raw,ex=r.existing,isKR=r.kind==='kr';
    const o=ex?JSON.parse(JSON.stringify(ex)):{id:r.id,parentId:null,title:'',description:'',departmentId:null,subDepartmentId:null,ownerId:null,owners:[],metricType:'number',startValue:0,targetValue:null,unit:'',direction:'up',frequency:{type:'weekly',day:'Mon'},periodStart:null,periodEnd:null,statusMode:'auto',statusManual:null,isAnnual:false,rollup:false,quarterLabel:null,sort:0,createdBy:S.uid,createdAt:new Date().toISOString(),kind:r.kind,krKind:isKR?'metric':null,isNorthStar:false,dueDate:null,doneAt:null,doneBy:null,floorValue:null,items:[],pacing:[],paceTolerance:null,contributesTo:null,targetConfirmed:true,targetBasis:'',leadLag:null,ownerTbd:false,needsDecision:false,decisionNote:'',state:'active',baselineAsOf:null};
    if(!Array.isArray(o.items))o.items=[];if(!Array.isArray(o.pacing))o.pacing=[];
    o.title=raw.title||o.title;
    if(raw.description)o.description=raw.description;
    /* parent */
    if(raw.parent){
      const p=findParent(raw.parent);
      if(p===undefined)r.errs.push('Parent “'+raw.parent+'” not found (check the exact title)');
      else if(p&&p.bad)r.errs.push('Parent row “'+raw.parent+'” has errors');
      else if(p){
        if(p.id===o.id)r.errs.push('An item can’t be its own parent');
        else if(ex&&okrDescendants(ex.id).some(x=>x.id===p.id))r.errs.push('That parent sits underneath this item — it would create a loop');
        else if(r.kind==='objective'&&p.kind!=='objective')r.errs.push('An objective can only sit under another objective');
        else if(isKR&&p.kind!=='objective')r.errs.push('A key result has to sit under an objective');
        else if(r.kind==='kpi'&&p.kind==='kr'){const pk=p.obj;const pkk=pk?okrKRKind(pk):_okrImpPick(OKR_IMP_KRKIND,p.row.raw.krKind)||'metric';if(pkk!=='metric'&&pkk!=='range')r.errs.push('A KPI can only link under a Number or Floor + target key result');}
        else if(p.obj&&(p.obj.isAnnual||p.obj.rollup)&&r.kind!=='kpi'&&p.kind==='objective')r.errs.push('That objective auto-updates (annual / roll-up) — it can’t hold key results');
        if(!r.errs.length)o.parentId=p.id;
      }
    }else if(!ex){o.parentId=null;}
    else if(isKR&&!o.parentId)r.errs.push('A key result needs its objective in Parent');
    if(isKR&&!o.parentId&&!r.errs.length)r.errs.push('A key result needs its objective in Parent');
    /* kinds & numbers */
    if(isKR){
      const kk=raw.krKind?_okrImpPick(OKR_IMP_KRKIND,raw.krKind,{'number':'metric','metric':'metric','milestone':'milestone','date':'milestone','count':'count','items':'count','range':'range','floor':'range','floor + target':'range','floor+target':'range'}):(ex?okrKRKind(ex):'metric');
      if(kk===undefined)r.errs.push('Key result type “'+raw.krKind+'” is not Number, Milestone, Count or Floor + target');
      o.krKind=kk||'metric';
    }else o.krKind=null;
    const met=raw.metric?_okrImpPick(OKR_IMP_METRIC,raw.metric,{'percentage':'percent','%':'percent','percent':'percent','money':'currency','yes/no':'yesno','yes / no':'yesno','yesno':'yesno','done':'yesno'}):null;
    if(met===undefined)r.errs.push('Metric “'+raw.metric+'” is not Number, Percentage, Currency or Yes / No');
    const dir=raw.direction?_okrImpPick(OKR_IMP_DIR,raw.direction,{'higher':'up','up':'up','lower':'down','down':'down','greater':'gte','gte':'gte','>=':'gte','less':'lte','lte':'lte','<=':'lte','less than':'lte','greater than':'gte'}):null;
    if(dir===undefined)r.errs.push('Direction “'+raw.direction+'” is not recognised');
    const sv=_okrImpNum(raw.start),tv=_okrImpNum(raw.target),fv=_okrImpNum(raw.floor);
    if(sv===undefined)r.errs.push('Start value “'+raw.start+'” is not a number');
    if(tv===undefined)r.errs.push('Target value “'+raw.target+'” is not a number');
    if(fv===undefined)r.errs.push('Floor “'+raw.floor+'” is not a number');
    if(met)o.metricType=met;if(dir)o.direction=dir;
    if(sv!==null&&sv!==undefined)o.startValue=sv;
    if(tv!==null&&tv!==undefined){o.targetValue=tv;if(o.metricType==='krs')o.metricType=met||'number';}
    if(raw.unit)o.unit=raw.unit;
    if(isKR){
      const kk=o.krKind;
      if(kk==='milestone'){o.metricType='yesno';o.startValue=0;o.targetValue=1;o.floorValue=null;o.items=[];const d=_okrImpDate(raw.dueDate);if(d===undefined)r.errs.push('Due date “'+raw.dueDate+'” — use YYYY-MM-DD');if(d)o.dueDate=d;if(!o.dueDate)r.errs.push('A milestone needs a Due date');}
      else if(kk==='count'){o.metricType='number';o.startValue=0;o.floorValue=null;if(raw.items){const its=_okrImpItems(raw.items);if(!its.length)r.errs.push('Items to count is empty');else{const keep=okrItems(o);o.items=its.map(x=>{const prev=keep.find(y=>_okrImpKey(y.name)===_okrImpKey(x.name));return prev?Object.assign({},prev,{due:x.due||prev.due}):x;});}}if(!okrItems(o).length)r.errs.push('A Count key result needs Items to count');o.targetValue=okrItems(o).length;o.direction='up';}
      else if(kk==='range'){if(o.metricType==='yesno')o.metricType='number';if(fv!==null&&fv!==undefined)o.floorValue=fv;if(o.floorValue===null||o.floorValue===undefined)r.errs.push('Floor + target needs a Floor');if(o.targetValue===null||o.targetValue===undefined)r.errs.push('Floor + target needs a Target value');else if(o.floorValue!==null&&(okrDirDown(o)?Number(o.floorValue)<Number(o.targetValue):Number(o.floorValue)>Number(o.targetValue)))r.errs.push(okrDirDown(o)?'For “Lower is better” the ceiling must sit above the target':'The floor must sit below the target');o.items=[];}
      else{o.floorValue=null;o.items=[];if(o.metricType==='yesno')o.metricType='number';if(o.targetValue===null||o.targetValue===undefined)o.metricType='krs';}
      o.isAnnual=false;o.rollup=false;o.isNorthStar=false;
    }else{
      o.floorValue=null;o.items=[];o.leadLag=null;o.dueDate=null;
      if(r.kind==='kpi'){if(o.metricType==='krs')o.metricType='number';if(o.metricType!=='yesno'&&(o.targetValue===null||o.targetValue===undefined))r.errs.push('A KPI needs a Target value');}
      else{o.isAnnual=false;o.rollup=false;if(o.metricType!=='yesno'&&(o.targetValue===null||o.targetValue===undefined))o.metricType='krs';if(o.parentId)o.isNorthStar=false;}
    }
    if(o.metricType==='krs'){o.startValue=0;o.targetValue=null;o.revisedTarget=null;o.direction='up';o.unit='';o.pacing=[];o.paceTolerance=null;}
    if(o.metricType==='percent')o.unit='%';
    if(o.metricType==='yesno'){o.startValue=0;o.targetValue=1;}
    if(okrIsThresh(o))o.startValue=0;
    /* owners */
    if(raw.owners){
      const ids=[],bad=[];raw.owners.split(/[,;]/).map(s=>s.trim()).filter(Boolean).forEach(s=>{const u=_okrImpUserByText(s);if(u)ids.push(u.id);else bad.push(s);});
      if(bad.length)r.errs.push('Owner not found: '+bad.join(', '));
      if(ids.length){o.owners=[...new Set(ids)];o.ownerId=o.owners[0];o.ownerTbd=false;}
      else if(!bad.length&&!okrOwners(o).length&&!o.ownerTbd)r.errs.push('Owners (emails) is empty');
    }else if(!okrOwners(o).length&&!o.ownerTbd)r.errs.push('Owners (emails) is empty');
    /* department */
    if(raw.dept){const d=topDepts().find(x=>_okrImpKey(x.name)===_okrImpKey(raw.dept));if(!d)r.errs.push('Department “'+raw.dept+'” not found');else{if(o.departmentId!==d.id)o.subDepartmentId=null;o.departmentId=d.id;}}
    if(raw.subDept){const d=o.departmentId?subDepts(o.departmentId).find(x=>_okrImpKey(x.name)===_okrImpKey(raw.subDept)):null;if(!d)r.errs.push('Sub-department “'+raw.subDept+'” not found under '+(_okrImpDeptName(o.departmentId)||'the department'));else o.subDepartmentId=d.id;}
    if(!isKR&&!o.parentId&&!o.departmentId)r.errs.push('A top-level item needs a Department');
    /* dates & schedule */
    const ps=_okrImpDate(raw.periodStart),pe=_okrImpDate(raw.periodEnd);
    if(ps===undefined)r.errs.push('Period start “'+raw.periodStart+'” — use YYYY-MM-DD');
    if(pe===undefined)r.errs.push('Period end “'+raw.periodEnd+'” — use YYYY-MM-DD');
    if(ps)o.periodStart=ps;if(pe)o.periodEnd=pe;
    if(o.periodStart&&o.periodEnd&&o.periodEnd<o.periodStart)r.errs.push('Period end is before its start');
    if(raw.checkin){const f=_okrImpFreq(raw.checkin);if(f===undefined)r.errs.push('Check-in “'+raw.checkin+'” — use Weekly (Mon), Monthly (1) or None');else o.frequency=f;}
    if(!raw.checkin&&!ex&&isKR&&o.parentId){const pk=okrById(o.parentId);if(pk&&pk.frequency&&pk.frequency.type)o.frequency=JSON.parse(JSON.stringify(pk.frequency));}
    /* permissions */
    if(ex){if(!okrCanSee(ex)||!_okrCanEditNode(ex))r.errs.push('You can’t edit this '+okrKindLabel(ex));}
    else{
      if(!_okrCanCreate())r.errs.push('You can’t create items');
      if(r.kind==='objective'&&!o.parentId&&!_okrCanManage())r.errs.push('Top-level objectives need OKR → Manage');
    }
    r.o=o;
    /* what changes, for the log and the preview */
    if(ex){
      const F=[['title','Title'],['description','Goal'],['parentId','Parent'],['departmentId','Department'],['subDepartmentId','Sub-department'],['owners','Owners'],['metricType','Metric'],['startValue','Start value'],['targetValue','Target'],['unit','Unit'],['direction','Which way is good?'],['periodStart','Period start'],['periodEnd','Period end'],['krKind','Key-result type'],['dueDate','Due date'],['floorValue','Floor'],['items','Counted items'],['frequency','Frequency']];
      r.changes=[];
      const norm=v=>{if(v===null||v===undefined||v==='')return'';if(Array.isArray(v))return v.length?JSON.stringify(v):'';if(typeof v==='object')return Object.keys(v).length?JSON.stringify(v):'';return String(v);};
      F.forEach(([k,label])=>{const a=k==='owners'?okrOwners(ex):ex[k],b=k==='owners'?okrOwners(o):o[k];if(norm(a)!==norm(b))r.changes.push({field:label,from:_okrImpShow(k,a),to:_okrImpShow(k,b)});});
      r.action=r.errs.length?'error':(r.changes.length?'update':'same');
    }else r.action=r.errs.length?'error':'create';
  });
  /* a row whose parent row errored can't be saved either */
  let moved=true,guard=0;
  while(moved&&guard++<20){moved=false;R.forEach(r=>{if(r.action==='error'||!r.o||!r.o.parentId)return;const pr=R.find(x=>x.id===r.o.parentId);if(pr&&pr.action==='error'){r.errs.push('Its parent row ('+pr.n+') has errors');r.action='error';moved=true;}});}
}
function _okrImpShow(k,v){
  if(v===null||v===undefined||v==='')return'—';
  if(k==='owners')return Array.isArray(v)&&v.length?v.map(x=>{const u=uById(x);return u?fullName(u):x;}).join(', '):'—';
  if(k==='parentId'){const p=okrById(v);return p?p.title:(_OKRIMP&&(_OKRIMP.rows.find(r=>r.id===v)||{}).raw||{}).title||v;}
  if(k==='departmentId'||k==='subDepartmentId')return _okrImpDeptName(v)||v;
  if(k==='items')return Array.isArray(v)?v.length+' item(s)':'—';
  if(k==='frequency')return _okrImpFreqLabel(v);
  if(k==='metricType')return OKR_IMP_METRIC[v]||(v==='krs'?'By key results / KPIs':v);
  if(k==='direction')return OKR_IMP_DIR[v]||v;
  if(k==='krKind')return OKR_IMP_KRKIND[v]||v;
  return String(v);
}
/* ── Preview ── */
const _OKR_IMP_ACT={create:{label:'Will create',bg:'#E9F2EC',fg:'#2B5638'},update:{label:'Will update',bg:'#FBF1DC',fg:'#7A5A12'},same:{label:'No change',bg:'var(--c-surface-2)',fg:'var(--c-text-3)'},error:{label:'Error',bg:'#F9E7E3',fg:'#8E2A1E'}};
function _okrImpRenderPreview(){
  const body=document.getElementById('okrimp-body');if(!body||!_OKRIMP)return;
  const R=_OKRIMP.rows;
  const n=k=>R.filter(r=>r.action===k).length;
  const nC=n('create'),nU=n('update'),nS=n('same'),nE=R.filter(r=>r.action==='error'||r.fatal).length;
  const order={objective:0,kr:1,kpi:2};
  const sorted=R.slice().sort((a,b)=>(a.fatal?-1:0)-(b.fatal?-1:0)||((order[a.kind]||9)-(order[b.kind]||9))||a.n-b.n);
  const tile=(l,v,fg)=>`<div style="flex:1;min-width:96px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:11px;padding:8px 11px"><div style="font-size:18px;font-weight:800;line-height:1;color:${fg||'var(--c-text)'}">${v}</div><div style="font-size:10.5px;color:var(--c-text-2);margin-top:3px">${l}</div></div>`;
  const row=r=>{
    const a=_OKR_IMP_ACT[r.fatal?'error':r.action]||_OKR_IMP_ACT.error;
    const raw=r.raw||{};
    const kindChip=r.kind==='kr'?'<span class="okr-imp-k">KR</span>':r.kind==='kpi'?okrKPIChip():'<span class="okr-imp-k">OBJ</span>';
    const sub=[raw.parent?'under '+esc(raw.parent):(r.kind==='kr'?'':'top level'),raw.owners?esc(raw.owners):''].filter(Boolean).join(' · ');
    const detail=r.errs&&r.errs.length?`<div class="okr-imp-err">${r.errs.map(e=>'• '+esc(e)).join('<br>')}</div>`
      :(r.action==='update'&&r.changes&&r.changes.length?`<div class="okr-imp-chg">${r.changes.slice(0,6).map(c=>'<b>'+esc(c.field)+'</b>: '+esc(c.from)+' → '+esc(c.to)).join(' · ')}${r.changes.length>6?' · +'+(r.changes.length-6)+' more':''}</div>`:'');
    const warn=r.warns&&r.warns.length?`<div class="okr-imp-warn">${r.warns.map(e=>'• '+esc(e)).join('<br>')}</div>`:'';
    return`<div class="okr-imp-row">
      <span class="okr-imp-n">${esc(r.sheet||'')}&nbsp;·&nbsp;row ${r.n}</span>
      <span style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:6px;min-width:0">${kindChip}<span style="font-weight:700;color:var(--c-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(raw.title||'(no title)')}</span></div>
        ${sub?`<div style="font-size:11px;color:var(--c-text-3);margin-top:1px">${sub}</div>`:''}
        ${detail}${warn}
      </span>
      <span style="flex-shrink:0;display:inline-flex;align-items:center;padding:2px 9px;border-radius:20px;font-size:10.5px;font-weight:800;background:${a.bg};color:${a.fg};white-space:nowrap">${a.label}</span>
    </div>`;
  };
  const canGo=(nC+nU)>0;
  body.innerHTML=`<div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">${tile('Will create',nC,nC?'#2B5638':'')}${tile('Will update',nU,nU?'#7A5A12':'')}${tile('No change',nS)}${tile('Errors (skipped)',nE,nE?'#8E2A1E':'')}</div>
    <div style="font-size:11.5px;color:var(--c-text-2);margin-bottom:8px;line-height:1.5">${esc(_OKRIMP.file)} — ${R.length} row${R.length===1?'':'s'}. Rows with errors are skipped; fix them in the file and upload again if you want them in. Nothing is deleted, closed or moved by an upload.</div>
    <div class="okr-imp-list">${sorted.map(row).join('')}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap">
      ${btnG('Choose another file',"document.getElementById('okrimp-body').innerHTML=_okrImpPickHTML();_OKRIMP=null")}
      ${canGo?btnP('Import '+(nC+nU)+' row'+((nC+nU)===1?'':'s'),'App._okrImpGo()','check'):btn('Nothing to import','',{variant:'ghost',disabled:true})}
    </div>
  </div>`;
}
/* ── Commit: objectives → key results → KPIs, parents before children ── */
App._okrImpGo=()=>{
  if(!_OKRIMP)return;
  if(!_okrCanCreate())return toast('You need OKR → Create to upload','err');
  const R=_OKRIMP.rows.filter(r=>!r.fatal&&(r.action==='create'||r.action==='update')&&r.o);
  if(!R.length)return toast('Nothing to import','warn');
  /* parents first: sort by depth within the file */
  const idSet=new Set(R.map(r=>r.id));
  const depth=r=>{let d=0,pid=r.o.parentId,g=0;while(pid&&g++<20){const pr=R.find(x=>x.id===pid);if(!pr)break;d++;pid=pr.o.parentId;}return d;};
  const order={objective:0,kr:1,kpi:2};
  R.sort((a,b)=>(depth(a)-depth(b))||((order[a.kind]||9)-(order[b.kind]||9))||a.n-b.n);
  let nC=0,nU=0,fail=0;
  DB.okrs=DB.okrs||[];
  R.forEach(r=>{
    try{
      const o=r.o;
      const idx=DB.okrs.findIndex(x=>x.id===o.id);
      if(idx>-1){
        const prev=DB.okrs[idx];
        const parentChanged=(prev.parentId||null)!==(o.parentId||null);
        const addedOwn=okrOwners(o).filter(x=>!okrOwners(prev).includes(x));
        Object.assign(prev,o);                       // keep the live reference everything else holds
        prev.updatedAt=new Date().toISOString();
        if(parentChanged){prev.sort=okrChildren(prev.parentId).filter(x=>x.id!==prev.id).length;try{_okrRelevel(prev.id);}catch(e){}}
        okrLog(prev.id,'Edited objective',{via:'upload',file:_OKRIMP.file,changes:r.changes||[]});
        if(addedOwn.length)try{_okrNotifyAssigned(prev,addedOwn);}catch(e){}
        _okrPush(prev);nU++;
      }else{
        o.sort=okrChildren(o.parentId||null).length;
        DB.okrs.push(o);
        try{_okrRelevel(o.id);}catch(e){}
        okrLog(o.id,'Created objective',{via:'upload',file:_OKRIMP.file,level:'L'+okrLevel(o)});
        try{_okrNotifyAssigned(o,okrOwners(o));}catch(e){}
        _okrPush(o);nC++;
      }
      if(o.parentId)_OKR_EXP[o.parentId]=true;
    }catch(e){fail++;console.warn('[okr import] row',r.n,e&&e.message);}
  });
  _okrFlagCache={t:0,map:{}};
  try{saveOkrExpanded(_OKR_EXP);}catch(e){}
  saveDB();
  try{log(fullName(me()),'Uploaded OKRs & KPIs',nC+' created · '+nU+' updated'+(fail?' · '+fail+' failed':''));}catch(e){}
  _OKRIMP=null;closeModal();
  toast((nC?nC+' created':'')+(nC&&nU?' · ':'')+(nU?nU+' updated':'')+(fail?' · '+fail+' failed':''),fail?'warn':'ok');
  rr();
};
