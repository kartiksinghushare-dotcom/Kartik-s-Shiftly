/* ============================================================================
   Bridge — 29-data.js   (v172)  DATA
   Folders → tables. A folder in Data is one Postgres table (schema `data`).
   Excel / CSV files uploaded into a folder are parsed in the browser (Web
   Worker, streamed) and appended to that folder's table in batches; every
   row remembers its source file + sheet, so deleting a file removes exactly
   its rows. PDFs, images and anything else stay as plain files in Storage.
   Large files go up with resumable (TUS) uploads, 6 MB chunks, auto-retry.
   Classic script: shares top-level scope with the other /js files.
   ============================================================================ */

const DT_BUCKET='data-files';
const DT_TABULAR_EXT={xlsx:1,xlsm:1,xls:1,csv:1,tsv:1};
const DT_CDN={
  papa:'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  xlsx:'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  tus:'https://cdn.jsdelivr.net/npm/tus-js-client@4.1.0/dist/tus.min.js'
};
const DT_CHUNK=6*1024*1024;           // Supabase resumable uploads require exactly 6 MB chunks
const DT_DIRECT_MAX=6*1024*1024;      // ≤ 6 MB → one plain PUT; above → resumable

const DT={folders:[],files:[],cols:{},loaded:false,loading:false,error:null,rt:null,jobs:{}};

/* ───────────────────────── permissions ───────────────────────── */
function _dtCan(action){try{if(isAdmin())return true;return can('data',action);}catch(e){return false;}}

/* ───────────────────────── helpers ───────────────────────── */
const _dtN=n=>Number(n||0).toLocaleString('en-US');
const _dtExt=name=>String(name||'').split('.').pop().toLowerCase();
const _dtIsTabular=name=>!!DT_TABULAR_EXT[_dtExt(name)];
function _dtIcon(name){const e=_dtExt(name);if(DT_TABULAR_EXT[e])return'📊';if(e==='pdf')return'📄';if(/^(png|jpe?g|gif|webp|heic|svg)$/.test(e))return'🖼';if(/^docx?$/.test(e))return'📝';if(/^pptx?$/.test(e))return'📑';if(/^(zip|rar|7z)$/.test(e))return'🗜';return'📎';}
function _dtSize(b){b=Number(b)||0;if(b<1024)return b+' B';if(b<1048576)return Math.round(b/1024)+' KB';if(b<1073741824)return(b/1048576).toFixed(b<10485760?1:0)+' MB';return(b/1073741824).toFixed(2)+' GB';}
function _dtWhen(iso){if(!iso)return'';try{const d=new Date(iso);return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}catch(e){return'';}}
function _dtTypeLabel(t){return({numeric:'number',timestamptz:'date & time',date:'date',boolean:'yes/no',text:'text'})[t]||t;}
function _mDF(r){return{id:r.id,name:r.name,parentId:r.parent_id||null,tableName:r.table_name,createdBy:r.created_by||null,createdAt:r.created_at||null};}
function _mDFi(r){return{id:r.id,folderId:r.folder_id,name:r.name,storagePath:r.storage_path||null,fileType:r.file_type||null,fileSize:Number(r.file_size||0),kind:r.kind||'file',status:r.status||'ready',rows:Number(r.rows||0),error:r.error||null,sheets:Array.isArray(r.sheets)?r.sheets:[],uploadedBy:r.uploaded_by||null,uploaderName:r.uploader_name||'',uploadedAt:r.uploaded_at||null,updatedAt:r.updated_at||null};}
function _dtFolder(id){return DT.folders.find(f=>f.id===id)||null;}
function _dtChildren(pid){return DT.folders.filter(f=>(f.parentId||null)===(pid||null)).sort((a,b)=>a.name.localeCompare(b.name));}
function _dtFiles(fid){return DT.files.filter(f=>f.folderId===fid);}
function _dtDescendants(id){const out=[];(function walk(p){_dtChildren(p).forEach(c=>{out.push(c);walk(c.id);});})(id);return out;}
function _dtPath(id){const out=[];let cur=_dtFolder(id);let guard=0;while(cur&&guard++<50){out.unshift(cur);cur=cur.parentId?_dtFolder(cur.parentId):null;}return out;}
function _dtFolderStats(id){const subs=_dtDescendants(id);const ids=[id,...subs.map(s=>s.id)];const files=DT.files.filter(f=>ids.includes(f.folderId));const own=_dtFiles(id);return{subs:subs.length,files:files.length,rows:own.reduce((a,f)=>a+(f.kind==='table'?f.rows:0),0),tables:own.filter(f=>f.kind==='table').length};}
function _dtFilesMerge(rows){const by=new Map(DT.files.map(f=>[f.id,f]));(rows||[]).forEach(r=>by.set(r.id,_mDFi(r)));DT.files=[...by.values()].sort((a,b)=>String(b.uploadedAt).localeCompare(String(a.uploadedAt)));}
function _dtFoldersMerge(rows){const by=new Map(DT.folders.map(f=>[f.id,f]));(rows||[]).forEach(r=>by.set(r.id,_mDF(r)));DT.folders=[...by.values()];}
function _dtLive(){if(S.route==='data')rr();}
function _dtLoadScript(src,globalName){return new Promise((res,rej)=>{try{if(globalName&&window[globalName])return res();}catch(e){}const prev=document.querySelector('script[data-dt-src="'+src+'"]');if(prev){prev.addEventListener('load',()=>res());prev.addEventListener('error',()=>rej(new Error('Could not load '+src)));return;}const s=document.createElement('script');s.src=src;s.async=true;s.dataset.dtSrc=src;s.onload=()=>res();s.onerror=()=>rej(new Error('Could not load '+src));document.head.appendChild(s);});}

/* ───────────────────────── data loading + live ───────────────────────── */
async function _dtLoad(force){
  if(DT.loading)return;if(DT.loaded&&!force)return;
  DT.loading=true;DT.error=null;
  try{
    const[f,fi,c]=await Promise.all([
      sb.from('data_folders').select('*').order('name'),
      sb.from('data_files').select('*').order('uploaded_at',{ascending:false}),
      sb.from('data_columns').select('*').order('ordinal')]);
    if(f.error)throw f.error;if(fi.error)throw fi.error;if(c.error)throw c.error;
    DT.folders=(f.data||[]).map(_mDF);
    DT.files=(fi.data||[]).map(_mDFi);
    DT.cols={};(c.data||[]).forEach(r=>{(DT.cols[r.folder_id]=DT.cols[r.folder_id]||[]).push({name:r.col_name,label:r.label,type:r.col_type,ordinal:r.ordinal});});
    DT.loaded=true;
  }catch(e){
    DT.error=String(e&&e.message||e);
    if(/data_folders|does not exist|relation/i.test(DT.error))DT.error='The Data tables are not in the database yet. Run migration supabase/migrations/2026-10-12_v172_data.sql, then reload.';
  }finally{DT.loading=false;_dtLive();}
}
async function _dtLoadCols(folderId){
  const{data,error}=await sb.from('data_columns').select('*').eq('folder_id',folderId).order('ordinal');
  if(!error)DT.cols[folderId]=(data||[]).map(r=>({name:r.col_name,label:r.label,type:r.col_type,ordinal:r.ordinal}));
}
function _dtLiveStart(){
  if(DT.rt)return;
  try{
    DT.rt=sb.channel('dt-live-'+Math.random().toString(36).slice(2,7))
      .on('postgres_changes',{event:'*',schema:'public',table:'data_files'},p=>{try{
        if(p.eventType==='DELETE'){DT.files=DT.files.filter(f=>f.id!==(p.old&&p.old.id));}
        else if(p.new&&p.new.id){if(DT.jobs[p.new.id]&&DT.jobs[p.new.id].active)return;/* our own job paints itself */_dtFilesMerge([p.new]);}
        _dtLive();}catch(e){}})
      .on('postgres_changes',{event:'*',schema:'public',table:'data_folders'},p=>{try{
        if(p.eventType==='DELETE'){const id=p.old&&p.old.id;DT.folders=DT.folders.filter(f=>f.id!==id);}
        else if(p.new&&p.new.id)_dtFoldersMerge([p.new]);
        _dtLive();}catch(e){}})
      .subscribe();
  }catch(e){DT.rt=null;}
}
function _dtBoot(){if(!DT.loaded&&!DT.loading&&!DT.error)_dtLoad();_dtLiveStart();}

/* ───────────────────────── page ───────────────────────── */
function dataPage(){
  _dtBoot();
  const folderId=S.filters.dtFolder||null;
  if(folderId&&DT.loaded&&!_dtFolder(folderId))S.filters.dtFolder=null;
  const fid=S.filters.dtFolder||null;
  const f=fid?_dtFolder(fid):null;
  const canCreate=_dtCan('create'),canUpload=_dtCan('upload');
  let actions='';
  if(canCreate)actions+='<button onclick="App._dtNewFolder()" class="ui-btn ui-btn-ghost ui-btn-md">'+ic('folder','w-4 h-4')+'New folder</button>';
  if(f&&canUpload)actions+='<button onclick="App._dtUploadOpen()" class="ui-btn ui-btn-primary ui-btn-md">'+ic('upload','w-4 h-4')+'Upload files</button>';
  let html='<div class="fade">'+_dtCSS();
  html+=hdr('Data',f?'Everything uploaded into this folder lands in one table — Excel & CSV become rows, other files are kept as files.':'Upload Excel and CSV files into folders. Each folder is one table you can download and analyse.',actions);
  if(DT.error)return html+'<div class="ui-card" style="padding:22px;border-color:var(--c-danger-soft)"><div style="display:flex;gap:12px;align-items:flex-start"><div style="width:38px;height:38px;border-radius:11px;background:var(--c-danger-soft);color:var(--c-danger);display:grid;place-items:center;flex-shrink:0">'+ic('alert','w-4 h-4')+'</div><div><div style="font-weight:800;margin-bottom:4px">Data isn’t ready</div><div style="font-size:13px;color:var(--c-text-2);line-height:1.6">'+esc(DT.error)+'</div><button onclick="DT.error=null;DT.loaded=false;App.rr();" class="ui-btn ui-btn-ghost ui-btn-sm" style="margin-top:10px">'+ic('refresh','w-4 h-4')+'Try again</button></div></div></div></div>';
  if(!DT.loaded)return html+loadingState('Loading your data folders…')+'</div>';
  html+=_dtCrumbs(fid);
  if(!f){
    const roots=_dtChildren(null);
    if(!roots.length)return html+_dtEmptyRoot(canCreate)+'</div>';
    html+=_dtFolderGrid(roots);
    return html+'</div>';
  }
  const subs=_dtChildren(fid);
  const stats=_dtFolderStats(fid);
  // folder summary strip
  html+='<div class="dt-sum">'
    +_dtSumCard('Rows in table',_dtN(stats.rows),'chart')
    +_dtSumCard('Files',_dtN(_dtFiles(fid).length),'paperclip')
    +_dtSumCard('Columns',_dtN((DT.cols[fid]||[]).length),'list')
    +'<div class="dt-sumcard dt-sumcard-wide"><div class="dt-sumlbl">Table</div><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><code class="dt-code">data.'+esc(f.tableName)+'</code><button onclick="App._dtTableInfo(\''+f.id+'\')" class="ui-btn ui-btn-ghost ui-btn-sm">'+ic('info','w-4 h-4')+'Details</button></div></div>'
    +'</div>';
  if(subs.length)html+=_dtFolderGrid(subs);
  html+=_dtFileList(f);
  return html+'</div>';
}
function _dtSumCard(lbl,val,icon){return'<div class="dt-sumcard"><div class="dt-sumlbl">'+esc(lbl)+'</div><div class="dt-sumval">'+val+'</div></div>';}
function _dtCrumbs(fid){
  const path=fid?_dtPath(fid):[];
  let h='<div class="dt-crumbs">';
  h+='<button onclick="App._dtGo(null)" class="dt-crumb'+(fid?'':' on')+'">'+ic('grid','w-3.5 h-3.5')+'Data</button>';
  path.forEach((p,i)=>{h+='<span class="dt-crumb-sep">›</span><button onclick="App._dtGo(\''+p.id+'\')" class="dt-crumb'+(i===path.length-1?' on':'')+'">'+esc(p.name)+'</button>';});
  return h+'</div>';
}
function _dtEmptyRoot(canCreate){
  return'<div class="ui-card" style="padding:40px 24px;text-align:center"><div style="font-size:40px;margin-bottom:10px">🗂️</div><div class="fd" style="font-size:18px;font-weight:800;margin-bottom:6px">Create your first data folder</div><div style="font-size:13.5px;color:var(--c-text-2);max-width:460px;margin:0 auto 18px;line-height:1.6">Each folder becomes one table. Name it after the data it will hold — <b>Sales Orders</b>, <b>Inventory</b>, <b>Payroll</b> — then upload Excel or CSV files into it. Every file you add is appended to that folder’s table.</div>'
    +(canCreate?'<button onclick="App._dtNewFolder()" class="ui-btn ui-btn-primary ui-btn-md">'+ic('folder','w-4 h-4')+'New folder</button>':'<div style="font-size:12px;color:var(--c-text-3)">You don’t have permission to create folders.</div>')+'</div>';
}
function _dtFolderGrid(folders){
  const canDel=_dtCan('delete'),canEdit=_dtCan('create');
  return'<div class="dt-grid">'+folders.map(f=>{const s=_dtFolderStats(f.id);
    return'<div class="dt-card" onclick="App._dtGo(\''+f.id+'\')">'
      +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px"><div style="font-size:30px;line-height:1">📁</div>'
      +'<div class="dt-card-menu" onclick="event.stopPropagation()">'
      +(canEdit?'<button title="Rename" onclick="App._dtRename(\''+f.id+'\')">'+ic('edit','w-3.5 h-3.5')+'</button>':'')
      +(canDel?'<button title="Delete folder" class="danger" onclick="App._dtDelFolder(\''+f.id+'\')">'+ic('trash','w-3.5 h-3.5')+'</button>':'')
      +'</div></div>'
      +'<div class="dt-card-name">'+esc(f.name)+'</div>'
      +'<div class="dt-card-meta">'+_dtN(s.rows)+' rows · '+s.files+' file'+(s.files===1?'':'s')+(s.subs?' · '+s.subs+' sub-folder'+(s.subs===1?'':'s'):'')+'</div>'
      +'<code class="dt-code dt-code-sm">data.'+esc(f.tableName)+'</code>'
      +'</div>';}).join('')+'</div>';
}
function _dtStatusPill(file){
  const job=DT.jobs[file.id];
  if(job&&job.active){
    const pct=job.phase==='upload'?job.pct:null;
    const txt=job.phase==='upload'?('Uploading '+(pct||0)+'%'):job.phase==='import'?('Importing · '+_dtN(job.rowsDone)+' rows'):job.phase==='convert'?'Converting Excel…':job.phase==='finish'?'Finishing…':'Queued';
    return'<span class="dt-pill dt-pill-busy" id="dtp-'+file.id+'"><span class="dt-spin"></span>'+txt+'</span>';
  }
  if(file.status==='error')return'<span class="dt-pill dt-pill-err" title="'+esc(file.error||'')+'">'+ic('alert','w-3 h-3')+'Failed</span>';
  if(file.status==='uploading'||file.status==='importing')return'<span class="dt-pill dt-pill-warn" title="Started on another device or interrupted">'+(file.status==='uploading'?'Uploading…':'Importing…')+'</span>';
  if(file.kind==='table')return'<span class="dt-pill dt-pill-ok">'+ic('check','w-3 h-3')+_dtN(file.rows)+' rows</span>';
  return'<span class="dt-pill">File</span>';
}
function _dtFileList(f){
  const files=_dtFiles(f.id);
  const canDl=_dtCan('download'),canDel=_dtCan('delete'),canUp=_dtCan('upload');
  if(!files.length)return'<div class="ui-card dt-drop" id="dt-inline-drop" ondragover="App._dtDragOver(event)" ondragleave="App._dtDragLeave(event)" ondrop="App._dtDrop(event)" style="padding:36px 20px;text-align:center;border-style:dashed">'
    +'<div style="font-size:34px;margin-bottom:8px">⬆️</div><div style="font-weight:800;margin-bottom:4px">No files yet</div>'
    +'<div style="font-size:13px;color:var(--c-text-2);line-height:1.6;max-width:420px;margin:0 auto">'+(canUp?'Drop Excel or CSV files here (or any other file). Spreadsheets are added to the <b>data.'+esc(f.tableName)+'</b> table; everything else is stored as a file.':'Nothing has been uploaded into this folder yet.')+'</div>'
    +(canUp?'<button onclick="App._dtUploadOpen()" class="ui-btn ui-btn-primary ui-btn-md" style="margin-top:14px">'+ic('upload','w-4 h-4')+'Upload files</button>':'')+'</div>';
  return'<div class="ui-card" style="overflow:hidden" ondragover="App._dtDragOver(event)" ondragleave="App._dtDragLeave(event)" ondrop="App._dtDrop(event)" id="dt-inline-drop">'
    +files.map((d,i)=>{const job=DT.jobs[d.id];const busy=job&&job.active;
      return'<div class="dt-row" id="dtr-'+d.id+'">'
        +'<span class="dt-row-ic">'+_dtIcon(d.name)+'</span>'
        +'<div style="flex:1;min-width:0"><div class="dt-row-name">'+esc(d.name)+'</div>'
        +'<div class="dt-row-meta">'+_dtSize(d.fileSize)+(d.uploaderName?' · '+esc(d.uploaderName):'')+(d.uploadedAt?' · '+_dtWhen(d.uploadedAt):'')+(d.kind==='table'&&d.sheets&&d.sheets.length>1?' · '+d.sheets.length+' sheets':'')+(d.status==='error'&&d.error?' · <span style="color:var(--c-danger)">'+esc(d.error)+'</span>':'')+'</div>'
        +(busy?'<div class="dt-bar" id="dtb-'+d.id+'"><div style="width:'+(job.phase==='finish'?100:Math.min(99,job.pct||0))+'%"></div></div>':'')
        +'</div>'
        +'<div class="dt-row-actions">'+_dtStatusPill(d)
        +(!busy&&d.kind==='table'&&d.storagePath&&(d.status==='error'||d.status==='importing'||d.status==='uploading')&&canUp?'<button onclick="App._dtReimport(\''+d.id+'\')" class="ui-btn ui-btn-ghost ui-btn-sm" title="Parse the stored file again">'+ic('refresh','w-3.5 h-3.5')+'Re-import</button>':'')
        +(!busy&&!d.storagePath&&d.status==='error'&&canUp?'<span class="dt-row-meta" style="white-space:normal">Upload didn’t finish — delete and upload again</span>':'')
        +(busy?'<button onclick="App._dtCancel(\''+d.id+'\')" class="ui-btn ui-btn-ghost ui-btn-sm">Cancel</button>':'')
        +(!busy&&canDl&&d.storagePath?'<button onclick="App._dtDownload(\''+d.id+'\')" class="ui-btn ui-btn-ghost ui-btn-sm" title="Download original">'+ic('download','w-3.5 h-3.5')+'</button>':'')
        +(!busy&&canDel?'<button onclick="App._dtDelFile(\''+d.id+'\')" class="ui-btn ui-btn-ghost ui-btn-sm dt-danger" title="Delete file'+(d.kind==='table'?' and its rows':'')+'">'+ic('trash','w-3.5 h-3.5')+'</button>':'')
        +'</div></div>';}).join('')+'</div>';
}

App._dtGo=(id)=>{S.filters.dtFolder=id||null;rr();window.scrollTo(0,0);};

/* ───────────────────────── table info ───────────────────────── */
App._dtTableInfo=async(fid)=>{
  const f=_dtFolder(fid);if(!f)return;
  await _dtLoadCols(fid);
  const cols=(DT.cols[fid]||[]).slice().sort((a,b)=>a.ordinal-b.ordinal);
  const sql='select * from data.'+f.tableName+' limit 100;';
  modalShell({title:f.name,sub:'Table details — use these names in SQL or when asking Claude for analysis',size:'max-w-lg',
    body:'<div style="display:flex;flex-direction:column;gap:14px">'
      +'<div><div class="ui-label">Table</div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><code class="dt-code">data.'+esc(f.tableName)+'</code><button class="ui-btn ui-btn-ghost ui-btn-sm" onclick="App._dtCopy(\'data.'+esc(f.tableName)+'\')">'+ic('copy','w-3.5 h-3.5')+'Copy</button></div></div>'
      +'<div><div class="ui-label">Example query</div><div style="display:flex;gap:8px;align-items:flex-start"><code class="dt-code" style="flex:1;white-space:pre-wrap">'+esc(sql)+'</code><button class="ui-btn ui-btn-ghost ui-btn-sm" onclick="App._dtCopy('+JSON.stringify(sql).replace(/"/g,'&quot;')+')">'+ic('copy','w-3.5 h-3.5')+'Copy</button></div></div>'
      +'<div><div class="ui-label">Columns ('+cols.length+')</div>'
      +(cols.length?'<div style="border:1px solid var(--c-border);border-radius:12px;overflow:hidden"><table class="ui-table" style="font-size:12.5px"><thead><tr><th>Column</th><th>From header</th><th>Type</th></tr></thead><tbody>'+cols.map(c=>'<tr><td><code class="dt-code dt-code-sm">'+esc(c.name)+'</code></td><td>'+esc(c.label)+'</td><td style="color:var(--c-text-2)">'+_dtTypeLabel(c.type)+'</td></tr>').join('')+'</tbody></table></div>':'<div style="font-size:13px;color:var(--c-text-3)">No columns yet — upload a spreadsheet.</div>')
      +'</div>'
      +'<div style="font-size:12px;color:var(--c-text-3);line-height:1.6">Every row also carries <code>_file_id</code>, <code>_sheet</code>, <code>_row_no</code> and <code>_imported_at</code>. Column names come from the first header row of each sheet; new headers in later files are added as new columns automatically.</div>'
      +'</div>',
    footer:(_dtCan('download')&&cols.length?'<button onclick="App._dtExportCSV(\''+fid+'\')" class="ui-btn ui-btn-ghost ui-btn-md">'+ic('download','w-4 h-4')+'Download whole table (CSV)</button>':'')+'<button onclick="App.closeModal()" class="ui-btn ui-btn-primary ui-btn-md">Done</button>'});
};
App._dtCopy=async(txt)=>{try{await navigator.clipboard.writeText(txt);toast('Copied');}catch(e){toast('Could not copy','err');}};

/* ───────────────────────── folders: create / rename / delete ───────────────────────── */
App._dtNewFolder=()=>{
  if(!_dtCan('create'))return toast('You don’t have permission to create folders','err');
  const parent=S.filters.dtFolder?_dtFolder(S.filters.dtFolder):null;
  modalShell({title:'New folder',sub:parent?'Inside '+parent.name+' — it gets its own table':'Each folder is one table',size:'max-w-sm',
    body:'<label for="dt-nf" class="ui-label">Folder name</label><input id="dt-nf" class="ui-input" placeholder="e.g. Sales Orders, Inventory, Payroll" autocomplete="off" maxlength="80"><div style="font-size:12px;color:var(--c-text-3);margin-top:8px;line-height:1.6">Table name preview: <code id="dt-nf-prev" class="dt-code dt-code-sm">data.'+esc(parent?parent.tableName+'__':'')+'…</code></div>',
    footer:'<button onclick="App.closeModal()" class="ui-btn ui-btn-ghost ui-btn-md">Cancel</button><button id="dt-nf-btn" onclick="App._dtCreateFolder()" class="ui-btn ui-btn-primary ui-btn-md">Create folder</button>'});
  setTimeout(()=>{const i=document.getElementById('dt-nf');if(!i)return;i.focus();
    const prev=document.getElementById('dt-nf-prev');const base=parent?parent.tableName+'__':'';
    i.addEventListener('input',()=>{if(prev)prev.textContent='data.'+base+_dtSlug(i.value);});
    i.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();App._dtCreateFolder();}});},60);
};
function _dtSlug(s){s=String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');return s||'x';}
let _dtCreating=false;
App._dtCreateFolder=async()=>{
  if(_dtCreating)return;
  const inp=document.getElementById('dt-nf');const name=(inp?inp.value:'').trim();
  if(!name){if(inp){inp.style.borderColor='var(--c-danger)';inp.focus();}return toast('Enter a folder name','err');}
  const parentId=S.filters.dtFolder||null;
  if(_dtChildren(parentId).some(f=>f.name.toLowerCase()===name.toLowerCase()))return toast('A folder with this name already exists here','err');
  _dtCreating=true;const btn=document.getElementById('dt-nf-btn');if(btn){btn.disabled=true;btn.textContent='Creating…';}
  const id=uid('dtf');
  try{
    const{data,error}=await sb.rpc('data_create_folder',{p_id:id,p_name:name,p_parent_id:parentId,p_created_by:S.uid});
    if(error)throw error;
    _dtFoldersMerge([{id,name,parent_id:parentId,table_name:data,created_by:S.uid,created_at:new Date().toISOString()}]);
    closeModal();toast('📁 “'+name+'” created');
    try{log(fullName(me()),'Created data folder',name);}catch(e){}
    rr();
  }catch(e){toast('Could not create folder: '+(e.message||e),'err');if(btn){btn.disabled=false;btn.textContent='Create folder';}}
  finally{_dtCreating=false;}
};
App._dtRename=(fid)=>{
  const f=_dtFolder(fid);if(!f)return;if(!_dtCan('create'))return toast('No permission','err');
  modalShell({title:'Rename folder',sub:'The table name (data.'+f.tableName+') stays the same',size:'max-w-sm',
    body:'<label for="dt-rn" class="ui-label">Folder name</label><input id="dt-rn" class="ui-input" value="'+esc(f.name)+'" maxlength="80">',
    footer:'<button onclick="App.closeModal()" class="ui-btn ui-btn-ghost ui-btn-md">Cancel</button><button onclick="App._dtRenameSave(\''+fid+'\')" class="ui-btn ui-btn-primary ui-btn-md">Save</button>'});
  setTimeout(()=>{const i=document.getElementById('dt-rn');if(i){i.focus();i.select();i.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();App._dtRenameSave(fid);}});}},60);
};
App._dtRenameSave=async(fid)=>{
  const f=_dtFolder(fid);const inp=document.getElementById('dt-rn');const name=(inp?inp.value:'').trim();
  if(!f||!name)return toast('Enter a name','err');
  const{error}=await sb.from('data_folders').update({name}).eq('id',fid);
  if(error)return toast('Rename failed: '+error.message,'err');
  f.name=name;closeModal();toast('Renamed');rr();
};
App._dtDelFolder=async(fid)=>{
  const f=_dtFolder(fid);if(!f)return;if(!_dtCan('delete'))return toast('No permission','err');
  const s=_dtFolderStats(fid);const subs=_dtDescendants(fid);
  const allRows=[f,...subs].reduce((a,x)=>a+_dtFiles(x.id).reduce((b,y)=>b+(y.kind==='table'?y.rows:0),0),0);
  const ok=await confirmP({title:'Delete “'+f.name+'”?',body:'This removes the folder, its table and every file inside it.',
    items:[s.subs?s.subs+' sub-folder'+(s.subs===1?'':'s')+' (and their tables)':'',s.files+' file'+(s.files===1?'':'s'),_dtN(allRows)+' table rows'].filter(Boolean),
    note:'The table data.'+esc(f.tableName)+' is dropped. This cannot be undone.',confirmLabel:'Delete folder'});
  if(!ok)return;
  try{
    const{data,error}=await sb.rpc('data_folder_delete',{p_folder_id:fid});
    if(error)throw error;
    const ids0=new Set([fid,...subs.map(x=>x.id)]);
    const extra=DT.files.filter(x=>ids0.has(x.folderId)).flatMap(x=>(x.sheets||[]).map(y=>y&&y.path).filter(Boolean));
    const paths=(Array.isArray(data)?data:[]).concat(extra);
    for(let i=0;i<paths.length;i+=100){try{await sb.storage.from(DT_BUCKET).remove(paths.slice(i,i+100));}catch(e){}}
    const ids=new Set([fid,...subs.map(x=>x.id)]);
    DT.folders=DT.folders.filter(x=>!ids.has(x.id));DT.files=DT.files.filter(x=>!ids.has(x.folderId));ids.forEach(id=>delete DT.cols[id]);
    if(S.filters.dtFolder&&ids.has(S.filters.dtFolder))S.filters.dtFolder=f.parentId||null;
    toast('Folder deleted','warn');try{log(fullName(me()),'Deleted data folder',f.name);}catch(e){}rr();
  }catch(e){toast('Delete failed: '+(e.message||e),'err');}
};

/* ───────────────────────── files: download / delete / re-import ───────────────────────── */
App._dtDownload=async(id)=>{
  const d=DT.files.find(x=>x.id===id);if(!d||!d.storagePath)return;
  if(!_dtCan('download'))return toast('No permission','err');
  const{data,error}=await sb.storage.from(DT_BUCKET).createSignedUrl(d.storagePath,600,{download:d.name});
  if(error||!data)return toast('Could not create download link: '+(error&&error.message||''),'err');
  const a=document.createElement('a');a.href=data.signedUrl;a.download=d.name;a.rel='noopener';document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),2000);
};
App._dtDelFile=async(id)=>{
  const d=DT.files.find(x=>x.id===id);if(!d)return;if(!_dtCan('delete'))return toast('No permission','err');
  const ok=await confirmP({title:'Delete “'+d.name+'”?',body:d.kind==='table'?'The file and the '+_dtN(d.rows)+' rows it added to the table are removed.':'The file is removed from storage.',confirmLabel:'Delete'});
  if(!ok)return;
  await _dtRemoveFile(d);
  toast('Deleted','warn');rr();
};
async function _dtRemoveFile(d){
  const{data:sp,error}=await sb.rpc('data_file_delete',{p_file_id:d.id});
  if(error)throw error;
  const paths=[sp||d.storagePath].concat((d.sheets||[]).map(x=>x&&x.path).filter(Boolean)).filter(Boolean);
  if(paths.length){try{await sb.storage.from(DT_BUCKET).remove(paths);}catch(e){}}
  DT.files=DT.files.filter(x=>x.id!==d.id);
}
App._dtReimport=async(id)=>{
  const d=DT.files.find(x=>x.id===id);if(!d||!d.storagePath)return;if(!_dtCan('upload'))return toast('No permission','err');
  if(DT.jobs[id]&&DT.jobs[id].active)return;
  const job=_dtJob({id:d.id,folderId:d.folderId,name:d.name,path:d.storagePath,size:d.fileSize,kind:'table',file:null,type:d.fileType});
  job.phase='import';job.active=true;_dtPaint(job);rr();
  try{
    await sb.rpc('data_file_clear_rows',{p_file_id:d.id});
    await sb.from('data_files').update({status:'importing',error:null,rows:0,updated_at:new Date().toISOString()}).eq('id',d.id);
    const ext=_dtExt(d.name);
    const conv=(d.sheets||[]).filter(x=>x&&x.path);          // Excel: the per-sheet CSVs made at upload time
    if(ext==='csv'||ext==='tsv'){await _dtImportCSV(job,d.storagePath,'Sheet1',d.fileSize);job.sheets=[{name:'Sheet1'}];}
    else if(conv.length){for(const sh of conv){await _dtImportCSV(job,sh.path,sh.name,sh.size||0);job.sheets.push(sh);}}
    else{ // old Excel upload without converted sheets: fetch, convert, import
      const{data:blob,error}=await sb.storage.from(DT_BUCKET).download(d.storagePath);
      if(error||!blob)throw new Error('Could not read the stored file: '+(error&&error.message||''));
      job.file=new File([blob],d.name,{type:d.fileType||blob.type||''});
      await _dtImportPhase(job);
    }
    await _dtFinishJob(job);
  }catch(e){await _dtFailJob(job,e);}
};

/* ───────────────────────── upload modal ───────────────────────── */
App._dtPending=null;
App._dtUploadOpen=()=>{
  const fid=S.filters.dtFolder;const f=fid?_dtFolder(fid):null;
  if(!f)return toast('Open a folder first — files are uploaded into a folder','warn');
  if(!_dtCan('upload'))return toast('You don’t have permission to upload here','err');
  App._dtPending=[];
  modalShell({title:'Upload into “'+f.name+'”',sub:'Excel & CSV → rows in data.'+f.tableName+' · other files are stored as files',size:'max-w-md',key:'dt-upload',
    body:'<div id="dt-dz" class="dt-dz" onclick="document.getElementById(\'dt-fi\').click()" ondragover="App._dtDragOver(event)" ondragleave="App._dtDragLeave(event)" ondrop="App._dtDrop(event,true)">'
      +'<div style="font-size:34px;margin-bottom:6px">⬆️</div><div style="font-weight:800">Click to choose or drag & drop</div>'
      +'<div style="font-size:12px;color:var(--c-text-3);margin-top:4px;line-height:1.6">Any size — large files upload in resumable 6 MB chunks.<br>.xlsx .xls .csv .tsv become table rows · PDF, images, Word, etc. stay as files</div>'
      +'<input type="file" id="dt-fi" multiple style="display:none" onchange="App._dtPick(this.files)"></div>'
      +'<div id="dt-pick" style="margin-top:12px"></div>',
    footer:'<button onclick="App.closeModal()" class="ui-btn ui-btn-ghost ui-btn-md">Cancel</button><button id="dt-up-btn" onclick="App._dtUploadStart()" class="ui-btn ui-btn-primary ui-btn-md" disabled>Upload</button>'});
};
App._dtDragOver=(e)=>{e.preventDefault();e.stopPropagation();const el=e.currentTarget;if(el)el.classList.add('over');};
App._dtDragLeave=(e)=>{const el=e.currentTarget;if(el)el.classList.remove('over');};
App._dtDrop=(e,inModal)=>{
  e.preventDefault();e.stopPropagation();const el=e.currentTarget;if(el)el.classList.remove('over');
  const files=Array.from((e.dataTransfer&&e.dataTransfer.files)||[]);if(!files.length)return;
  if(inModal)return App._dtPick(files);
  // dropped straight on the folder: open the modal pre-filled
  if(!S.filters.dtFolder)return toast('Open a folder first','warn');
  if(!_dtCan('upload'))return toast('You don’t have permission to upload here','err');
  App._dtUploadOpen();setTimeout(()=>App._dtPick(files),30);
};
App._dtPick=(list)=>{
  const files=Array.from(list||[]).filter(f=>f&&f.size>=0);if(!files.length)return;
  const cur=App._dtPending||[];
  files.forEach(f=>{if(!cur.some(x=>x.name===f.name&&x.size===f.size))cur.push(f);});
  App._dtPending=cur;_dtPaintPick();
};
App._dtUnpick=(i)=>{(App._dtPending||[]).splice(i,1);_dtPaintPick();};
function _dtPaintPick(){
  const box=document.getElementById('dt-pick');const btn=document.getElementById('dt-up-btn');const files=App._dtPending||[];
  if(!box)return;
  if(!files.length){box.innerHTML='';if(btn){btn.disabled=true;btn.textContent='Upload';}return;}
  const fid=S.filters.dtFolder;const existing=fid?_dtFiles(fid):[];
  const total=files.reduce((a,f)=>a+f.size,0);
  box.innerHTML='<div style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto">'+files.map((f,i)=>{
    const tab=_dtIsTabular(f.name);const dup=existing.some(x=>x.name===f.name);
    return'<div class="dt-pick"><span style="font-size:20px">'+_dtIcon(f.name)+'</span><div style="flex:1;min-width:0"><div class="dt-row-name">'+esc(f.name)+'</div><div class="dt-row-meta">'+_dtSize(f.size)+' · '+(tab?'<span style="color:var(--c-success-ink);font-weight:700">→ table rows</span>':'file only')+(dup?' · <span style="color:var(--c-gold-ink);font-weight:700">replaces existing file</span>':'')+(f.size>500*1048576?' · <span style="color:var(--c-text-3)">large — keep this tab open</span>':'')+'</div></div><button onclick="App._dtUnpick('+i+')" class="ui-btn ui-btn-ghost ui-btn-sm" title="Remove">'+ic('x','w-3.5 h-3.5')+'</button></div>';}).join('')+'</div>'
    +'<div style="font-size:12px;color:var(--c-text-3);margin-top:8px">'+files.length+' file'+(files.length===1?'':'s')+' · '+_dtSize(total)+'</div>';
  if(btn){btn.disabled=false;btn.textContent='Upload '+files.length+' file'+(files.length===1?'':'s');}
}
App._dtUploadStart=async()=>{
  const files=(App._dtPending||[]).slice();const fid=S.filters.dtFolder;const f=fid?_dtFolder(fid):null;
  if(!files.length||!f)return;
  if(!_dtCan('upload'))return toast('No permission','err');
  const existing=_dtFiles(fid);
  const dups=files.map(x=>existing.find(e=>e.name===x.name)).filter(Boolean);
  closeModal();
  if(dups.length){
    const ok=await confirmP({title:'Replace '+dups.length+' existing file'+(dups.length===1?'':'s')+'?',body:'A file with the same name is already in this folder. The old file and the rows it added will be replaced by the new upload.',items:dups.map(d=>esc(d.name)),confirmLabel:'Replace & upload',danger:false,icon:'upload'});
    if(!ok)return;
    for(const d of dups){if(DT.jobs[d.id]&&DT.jobs[d.id].active){toast('“'+d.name+'” is still being processed — wait for it to finish','warn');return;}try{await _dtRemoveFile(d);}catch(e){return toast('Could not replace “'+d.name+'”: '+(e.message||e),'err');}}
  }
  App._dtPending=null;
  files.forEach(file=>_dtQueue(file,f));
  rr();
};

/* ───────────────────────── jobs: queue → upload → import → finish ───────────────────────── */
function _dtJob(o){const j=Object.assign({id:null,folderId:null,name:'',path:'',size:0,kind:'file',file:null,type:'',phase:'queued',pct:0,rowsDone:0,sheets:[],active:true,cancelled:false,_tus:null,_w:null,startedAt:Date.now()},o);DT.jobs[j.id]=j;_dtGuard();return j;}
let _dtRunning=0;const _dtQ=[];const DT_PARALLEL=1;   // one file at a time: the database, not the browser, is the bottleneck
function _dtQueue(file,folder){
  const id=uid('dtx');const safe=file.name.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(-120);
  const path=folder.id+'/'+id+'/'+safe;
  const kind=_dtIsTabular(file.name)?'table':'file';
  const job=_dtJob({id,folderId:folder.id,name:file.name,path,size:file.size,kind,file,type:file.type||''});
  const now=new Date().toISOString();
  _dtFilesMerge([{id,folder_id:folder.id,name:file.name,storage_path:path,file_type:file.type||null,file_size:file.size,kind,status:'uploading',rows:0,sheets:[],uploaded_by:S.uid,uploader_name:fullName(me()),uploaded_at:now,updated_at:now}]);
  _dtQ.push(job);_dtPump();
}
function _dtPump(){
  while(_dtRunning<DT_PARALLEL&&_dtQ.length){const job=_dtQ.shift();if(job.cancelled)continue;_dtRunning++;_dtRunJob(job).finally(()=>{_dtRunning--;_dtPump();});}
}
async function _dtRunJob(job){
  try{
    const now=new Date().toISOString();
    const{error}=await sb.from('data_files').insert({id:job.id,folder_id:job.folderId,name:job.name,storage_path:job.path,file_type:job.type||null,file_size:job.size,kind:job.kind,status:'uploading',rows:0,sheets:[],uploaded_by:S.uid,uploader_name:fullName(me()),uploaded_at:now,updated_at:now});
    if(error)throw new Error('Could not register the file: '+error.message);
    job.phase='upload';_dtPaint(job);
    await _dtUploadBlob(job);
    if(job.cancelled)throw new Error('Cancelled');
    if(job.kind==='table'){
      await sb.from('data_files').update({status:'importing',updated_at:new Date().toISOString()}).eq('id',job.id);
      await _dtImportPhase(job);
    }
    await _dtFinishJob(job);
  }catch(e){await _dtFailJob(job,e);}
}
async function _dtImportPhase(job){
  if(job.cancelled)throw new Error('Cancelled');
  job.phase='import';job.pct=0;job.rowsDone=0;job.sheets=[];_dtPaint(job);
  const ext=_dtExt(job.name);
  if(ext==='csv'||ext==='tsv'){await _dtImportCSV(job,job.path,'Sheet1',job.size);job.sheets=[{name:'Sheet1'}];return;}
  // Excel: every sheet becomes a CSV (dates → ISO, numbers → plain) in a Web Worker, goes to Storage next to
  // the original, and is imported server-side exactly like a CSV upload.
  job.phase='convert';_dtPaint(job);
  const sheets=await _dtXlsxToCsv(job);
  if(!sheets.length)throw new Error('No sheet with a header row and data was found');
  for(let i=0;i<sheets.length;i++){
    if(job.cancelled)throw new Error('Cancelled');
    const sh=sheets[i];const p=job.folderId+'/'+job.id+'/sheets/'+i+'.csv';
    job.phase='upload';job.pct=0;_dtPaint(job);
    await _dtUploadFile(job,sh.blob,p,'text/csv');
    job.phase='import';job.pct=0;_dtPaint(job);
    await _dtImportCSV(job,p,sh.name,sh.blob.size);
    job.sheets.push({name:sh.name,path:p,size:sh.blob.size});
  }
}
/* Server-side import loop: each call moves one ~6 MB chunk of the CSV from Storage into the table. A failed
   call is retried from the same offset (the function deletes anything it had already written for that
   chunk, so retries can't duplicate rows). */
async function _dtImportCSV(job,path,sheet,size){
  let offset=0,state=null,attempt=0;
  for(;;){
    if(job.cancelled)throw new Error('Cancelled');
    let data=null,msg='';
    try{
      const r=await sb.functions.invoke('data-import',{body:{file_id:job.id,path,sheet,offset,state}});
      data=r.data;
      if(r.error){msg=r.error.message||'import failed';try{if(r.error.context&&r.error.context.json){const j=await r.error.context.json();if(j&&j.error)msg=j.error;}}catch(e){}}
      else if(!data)msg='empty response';
      else if(data.error){msg=data.error;data=null;}
    }catch(e){msg=String(e&&e.message||e);}
    if(!data){
      attempt++;
      if(attempt>=5||/not authenticated|not found|larger than 6 MB|required/i.test(msg))throw new Error('Import failed: '+msg);
      await new Promise(r=>setTimeout(r,1200*attempt));continue;
    }
    attempt=0;offset=Number(data.offset||0);state=data.state||state;
    job.rowsDone+=Number(data.rows||0);
    const total=Number(data.size||size||0);job.pct=total?Math.min(99,Math.round(offset/total*100)):50;_dtPaint(job);
    if(data.done)return;
  }
}
async function _dtFinishJob(job){
  if(!job.active||job.cancelled)return;   // cancelled while the last step was in flight
  job.phase='finish';_dtPaint(job);
  const patch={status:'ready',error:null,updated_at:new Date().toISOString()};
  if(job.kind==='table'){patch.rows=job.rowsDone;patch.sheets=job.sheets;}
  const{error}=await sb.from('data_files').update(patch).eq('id',job.id);
  if(error)console.warn('[data] finish update:',error.message);
  const f=DT.files.find(x=>x.id===job.id);if(f){f.status='ready';f.error=null;if(job.kind==='table'){f.rows=job.rowsDone;f.sheets=job.sheets;}}
  job.active=false;job.phase='done';job.endedAt=Date.now();
  if(job.kind==='table')await _dtLoadCols(job.folderId);
  toast((job.kind==='table'?'✓ '+_dtN(job.rowsDone)+' rows added from ':'✓ Uploaded ')+'“'+job.name+'”');
  try{log(fullName(me()),job.kind==='table'?'Imported data file':'Uploaded data file',job.name);}catch(e){}
  _dtPaintJobs();_dtGuard();if(S.route==='data')rr();
}
async function _dtFailJob(job,e){
  if(!job.active)return;   // already settled (double cancel / late error)
  const msg=String(e&&e.message||e||'Failed');
  const failedPhase=job.phase;
  job.active=false;job.phase='error';job.error=msg;job.endedAt=Date.now();
  setTimeout(_dtPaintJobs,8600);   // the panel only repaints on events — make sure the failed entry actually leaves
  try{if(job._w)job._w.terminate();}catch(x){}
  try{if(job._tus)job._tus.abort();}catch(x){}
  if(job.cancelled||/^Cancelled$/.test(msg)){
    // user cancelled: remove the half-done record, its rows, and anything already stored
    try{await sb.rpc('data_file_delete',{p_file_id:job.id});}catch(x){}
    try{await sb.storage.from(DT_BUCKET).remove([job.path].concat((job.sheets||[]).map(x=>x&&x.path).filter(Boolean)));}catch(x){}
    DT.files=DT.files.filter(x=>x.id!==job.id);
    toast('Upload cancelled','warn');
  }else{
    if(job.kind==='table'){try{await sb.rpc('data_file_clear_rows',{p_file_id:job.id});}catch(x){}}
    const noObject=(failedPhase==='upload'||failedPhase==='queued');   // nothing reached storage → no Re-import / Download
    const patch={status:'error',error:msg.slice(0,500),rows:0,updated_at:new Date().toISOString()};if(noObject)patch.storage_path=null;
    try{await sb.from('data_files').update(patch).eq('id',job.id);}catch(x){}
    const f=DT.files.find(x=>x.id===job.id);if(f){f.status='error';f.error=msg;f.rows=0;if(noObject)f.storagePath=null;}
    console.error('[data] job failed:',job.name,msg);
    toast('“'+job.name+'” failed: '+msg,'err');
  }
  _dtPaintJobs();_dtGuard();if(S.route==='data')rr();
}
App._dtCancel=(id)=>{const j=DT.jobs[id];if(!j||!j.active)return;j.cancelled=true;
  const qi=_dtQ.indexOf(j);if(qi>=0)_dtQ.splice(qi,1);
  try{if(typeof j._abort==='function')j._abort();}catch(e){}   // rejects an in-flight upload / conversion
  try{if(j._tus)j._tus.abort(true);}catch(e){}try{if(j._w)j._w.terminate();}catch(e){}
  // Whatever it was awaiting (an API call, the server importer, a storage read), settle NOW; the run loop's
  // own catch finds the job already settled and does nothing more.
  _dtFailJob(j,new Error('Cancelled'));
};

/* ───────────────────────── storage upload (direct or resumable) ───────────────────────── */
async function _dtUploadBlob(job){return _dtUploadFile(job,job.file,job.path,job.file&&job.file.type||'application/octet-stream');}
async function _dtUploadFile(job,f,path,ct){
  ct=ct||'application/octet-stream';
  if(f.size<=DT_DIRECT_MAX){
    const{error}=await sb.storage.from(DT_BUCKET).upload(path,f,{cacheControl:'3600',upsert:true,contentType:ct});
    if(error)throw new Error('Upload failed: '+error.message);
    if(job.cancelled)throw new Error('Cancelled');
    job.pct=100;_dtPaint(job);return;
  }
  await _dtLoadScript(DT_CDN.tus,'tus');
  const sess=await sb.auth.getSession();const token=sess&&sess.data&&sess.data.session&&sess.data.session.access_token;
  if(!token)throw new Error('You are signed out — sign in again to upload');
  await new Promise((res,rej)=>{
    const up=new tus.Upload(f,{
      endpoint:SB_URL+'/storage/v1/upload/resumable',
      retryDelays:[0,1000,3000,5000,10000,20000,30000],
      headers:{'x-upsert':'true',apikey:SB_ANON},
      uploadDataDuringCreation:true,removeFingerprintOnSuccess:true,
      metadata:{bucketName:DT_BUCKET,objectName:path,contentType:ct,cacheControl:'3600'},
      chunkSize:DT_CHUNK,
      // The bearer token is set ONLY here (never also in `headers`): XHR joins a repeated header with a
      // comma, and Storage then rejects the token as "Invalid Compact JWS". Re-read per request so a
      // session refresh during a long upload is picked up.
      onBeforeRequest:async(req)=>{let t=token;try{const s=await sb.auth.getSession();t=(s&&s.data&&s.data.session&&s.data.session.access_token)||t;}catch(e){}req.setHeader('authorization','Bearer '+t);},
      onError:(err)=>{if(job.cancelled)return rej(new Error('Cancelled'));let m='';try{const body=err&&err.originalResponse&&err.originalResponse.getBody&&err.originalResponse.getBody();if(body){try{const j=JSON.parse(body);m=j.message||j.error||'';}catch(x){m=String(body).slice(0,160);}}}catch(x){}
        if(!m){const raw=String(err&&err.message||err||'');const mm=raw.match(/"message":"([^"]+)"/);m=mm?mm[1]:raw.replace(/, originated from request[\s\S]*$/,'').slice(0,200);}
        rej(new Error('Upload failed: '+(m||'unknown error')));},
      onProgress:(sent,total)=>{job.pct=total?Math.round(sent/total*100):0;_dtPaint(job);},
      onSuccess:()=>res()
    });
    job._tus=up;job._abort=()=>{try{up.abort(true);}catch(e){}rej(new Error('Cancelled'));};
    up.start();
  });
  job._abort=null;
  if(job.cancelled)throw new Error('Cancelled');
}

/* ───────────────────────── Excel → CSV (Web Worker) ───────────────────────── */
let _dtWorkerURLCache=null;
function _dtWorkerURL(){if(_dtWorkerURLCache)return _dtWorkerURLCache;const src='('+_dtXlsxWorkerBody.toString()+')();';_dtWorkerURLCache=URL.createObjectURL(new Blob([src],{type:'application/javascript'}));return _dtWorkerURLCache;}
function _dtXlsxToCsv(job){
  return new Promise((resolve,reject)=>{
    let w;try{w=new Worker(_dtWorkerURL());}catch(e){return reject(new Error('This browser cannot run the background converter: '+e.message));}
    job._w=w;const out=[];let settled=false;
    const fail=(err)=>{if(settled)return;settled=true;try{w.terminate();}catch(e){}job._abort=null;reject(err);};
    job._abort=()=>fail(new Error('Cancelled'));
    w.onmessage=(e)=>{const m=e.data||{};
      if(m.t==='sheet')out.push({name:m.name,blob:m.blob,rows:m.rows});
      else if(m.t==='progress'){job.pct=Math.min(99,Math.round(m.pct||0));_dtPaint(job);}
      else if(m.t==='done'){if(settled)return;settled=true;try{w.terminate();}catch(x){}job._abort=null;resolve(out);}
      else if(m.t==='error')fail(new Error(m.msg||'Could not read the Excel file'));
    };
    w.onerror=(e)=>fail(new Error('Converter error: '+(e&&e.message||'unknown')));
    w.postMessage({t:'init',libs:[DT_CDN.xlsx]});
    w.postMessage({t:'start',file:job.file});
  });
}
/* Runs INSIDE the worker — must not touch anything outside this function. */
function _dtXlsxWorkerBody(){
  function post(x){self.postMessage(x);}
  function pad(n){n=String(n);return n.length<2?'0'+n:n;}
  function cell(v){
    if(v===null||v===undefined)return'';
    if(v instanceof Date){if(isNaN(v.getTime()))return'';var s=v.getFullYear()+'-'+pad(v.getMonth()+1)+'-'+pad(v.getDate());if(v.getHours()||v.getMinutes()||v.getSeconds())s+='T'+pad(v.getHours())+':'+pad(v.getMinutes())+':'+pad(v.getSeconds());return s;}
    if(typeof v==='number')return isFinite(v)?String(v):'';
    if(typeof v==='boolean')return v?'true':'false';
    var t=String(v);
    return /[",\r\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;
  }
  self.onmessage=function(e){var m=e.data||{};
    if(m.t==='init'){try{importScripts.apply(null,m.libs||[]);}catch(err){post({t:'error',msg:'Could not load the Excel library (check internet access): '+(err&&err.message||err)});}return;}
    if(m.t!=='start')return;
    try{
      if(typeof XLSX==='undefined')throw new Error('Excel library not loaded');
      m.file.arrayBuffer().then(function(buf){
        post({t:'progress',pct:5});
        var wb=XLSX.read(new Uint8Array(buf),{type:'array',cellDates:true,dense:true,cellNF:false,cellText:false,cellHTML:false,cellStyles:false});
        buf=null;
        var names=wb.SheetNames||[];var total=0;var done=0;var sheets=[];
        names.forEach(function(nm){var ws=wb.Sheets[nm];if(!ws)return;var hidden=false;try{var si=(wb.Workbook&&wb.Workbook.Sheets||[]).find(function(x){return x&&x.name===nm;});hidden=!!(si&&si.Hidden);}catch(x){}
          if(hidden)return;var rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null,blankrows:false});if(!rows||rows.length<2)return;sheets.push({name:nm,rows:rows});total+=rows.length;});
        wb=null;
        sheets.forEach(function(sh){
          var parts=[];var buf2=[];var n=0;
          for(var i=0;i<sh.rows.length;i++){var r=sh.rows[i]||[];var line=[];var any=false;for(var c=0;c<r.length;c++){var s=cell(r[c]);if(s!=='')any=true;line.push(s);}
            if(!any)continue;buf2.push(line.join(','));n++;
            if(buf2.length>=5000){parts.push(buf2.join('\n')+'\n');buf2=[];done+=5000;post({t:'progress',pct:5+done/total*90});}}
          if(buf2.length)parts.push(buf2.join('\n')+'\n');
          sh.rows=null;
          post({t:'sheet',name:sh.name,rows:n-1,blob:new Blob(parts,{type:'text/csv'})});
        });
        post({t:'done'});
      }).catch(function(err){post({t:'error',msg:String(err&&err.message||err)});});
    }catch(err){post({t:'error',msg:String(err&&err.message||err)});}
  };
}

/* ───────────────────────── progress painting (no full re-render) ───────────────────────── */
function _dtPaint(job){
  try{
    const pill=document.getElementById('dtp-'+job.id);
    if(pill){const txt=job.phase==='upload'?('Uploading '+(job.pct||0)+'%'):job.phase==='import'?('Importing · '+_dtN(job.rowsDone)+' rows'):job.phase==='convert'?'Converting Excel…':job.phase==='finish'?'Finishing…':'Queued';pill.innerHTML='<span class="dt-spin"></span>'+txt;}
    const bar=document.getElementById('dtb-'+job.id);
    if(bar&&bar.firstElementChild){const pct=job.phase==='finish'?100:Math.min(99,job.pct||0);bar.firstElementChild.style.width=pct+'%';}
  }catch(e){}
  _dtPaintJobs();
}
/* Floating "Uploads" panel — visible on every page while something is running */
let _dtJobsT=0;
function _dtPaintJobs(){
  const now=Date.now();if(now-_dtJobsT<120){if(!_dtJobsPending){_dtJobsPending=true;setTimeout(()=>{_dtJobsPending=false;_dtPaintJobs();},130);}return;}_dtJobsT=now;
  const jobs=Object.values(DT.jobs).filter(j=>j.active||(j.phase==='error'&&!j.cancelled&&!j.dismissed&&now-(j.endedAt||0)<8000));
  let el=document.getElementById('dt-jobs');
  if(!jobs.length){if(el)el.remove();return;}
  if(!el){el=document.createElement('div');el.id='dt-jobs';el.className='dt-jobs';document.body.appendChild(el);}
  const active=jobs.filter(j=>j.active).length;
  el.innerHTML='<div class="dt-jobs-h"><span>'+(active?active+' upload'+(active===1?'':'s')+' in progress':'Uploads')+'</span><div style="display:flex;gap:4px"><button onclick="App._dtGoFolder()" class="ui-btn ui-btn-ghost ui-btn-sm">Open Data</button><button onclick="App._dtJobsDismiss()" class="ui-btn ui-btn-ghost ui-btn-sm" title="Hide finished">'+ic('x','w-3.5 h-3.5')+'</button></div></div>'
    +jobs.map(j=>{const pct=j.phase==='upload'?j.pct:j.phase==='import'?Math.min(99,j.pct||0):j.phase==='convert'?Math.min(99,j.pct||0):j.phase==='finish'?100:0;
      const txt=j.phase==='upload'?'Uploading · '+(j.pct||0)+'%':j.phase==='import'?'Importing rows · '+_dtN(j.rowsDone)+' ('+(j.pct||0)+'%)':j.phase==='convert'?'Converting Excel…':j.phase==='finish'?'Finishing…':j.phase==='error'?('Failed — '+(j.error||'')):'Waiting…';
      return'<div class="dt-job"><div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px">'+_dtIcon(j.name)+'</span><div style="flex:1;min-width:0"><div class="dt-row-name" style="font-size:12.5px">'+esc(j.name)+'</div><div class="dt-row-meta">'+esc(txt)+'</div></div>'+(j.active?'<button onclick="App._dtCancel(\''+j.id+'\')" class="ui-btn ui-btn-ghost ui-btn-sm" title="Cancel">'+ic('x','w-3.5 h-3.5')+'</button>':'<button onclick="App._dtJobsDismiss(\''+j.id+'\')" class="ui-btn ui-btn-ghost ui-btn-sm" title="Dismiss">'+ic('x','w-3.5 h-3.5')+'</button>')+'</div><div class="dt-bar" style="margin-top:6px"><div style="width:'+pct+'%'+(j.phase==='import'?';background:var(--c-success)':'')+'"></div></div></div>';}).join('');
}
let _dtJobsPending=false;
App._dtJobsDismiss=async(id)=>{
  const active=Object.values(DT.jobs).filter(j=>j.active&&(!id||j.id===id));
  if(active.length){const ok=await confirmP({title:'Cancel '+(active.length===1?'this upload':active.length+' uploads')+'?',body:'Files still being uploaded or imported will be stopped and removed.',confirmLabel:'Cancel uploads'});if(!ok)return;active.forEach(j=>App._dtCancel(j.id));}
  Object.values(DT.jobs).forEach(j=>{if(!j.active&&(!id||j.id===id))j.dismissed=true;});_dtJobsT=0;_dtPaintJobs();};
App._dtGoFolder=()=>{const j=Object.values(DT.jobs).find(x=>x.active)||Object.values(DT.jobs)[0];
  // App.go swaps S.filters per route (filter memory), so pick the folder AFTER navigating.
  if(S.route!=='data'){if(typeof App.go==='function')App.go('data');else{S.route='data';S.filters={};}}
  if(j)S.filters.dtFolder=j.folderId;rr();};
/* Warn before leaving the page while uploads are running */
let _dtGuardOn=false;
function _dtGuard(){const busy=Object.values(DT.jobs).some(j=>j.active);if(busy&&!_dtGuardOn){_dtGuardOn=true;window.addEventListener('beforeunload',_dtBeforeUnload);}else if(!busy&&_dtGuardOn){_dtGuardOn=false;window.removeEventListener('beforeunload',_dtBeforeUnload);}}
function _dtBeforeUnload(e){e.preventDefault();e.returnValue='Uploads are still running. Leave anyway?';return e.returnValue;}

/* ───────────────────────── CSV export of a folder's table ───────────────────────── */
App._dtExportCSV=async(fid)=>{
  const f=_dtFolder(fid);if(!f)return;if(!_dtCan('download'))return toast('No permission','err');
  await _dtLoadCols(fid);
  const cols=(DT.cols[fid]||[]).slice().sort((a,b)=>a.ordinal-b.ordinal);
  if(!cols.length)return toast('The table is empty','warn');
  const{data:cnt}=await sb.rpc('data_folder_count',{p_folder_id:fid,p_search:null});
  const total=Number(cnt||0);if(!total)return toast('Nothing to export','warn');
  if(total>300000){const ok=await confirmP({title:'Export '+_dtN(total)+' rows?',body:'This is a large table — the download is built in your browser and can take a few minutes.',confirmLabel:'Export',danger:false,icon:'download'});if(!ok)return;}
  toast('Preparing CSV… '+_dtN(total)+' rows');
  const q=s=>{if(s===null||s===undefined)return'';s=String(s);return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const parts=['﻿'+cols.map(c=>q(c.label)).join(',')+',Source file,Sheet,Row\n'];
  const files=_dtFiles(fid);const fname=id=>{const x=files.find(y=>y.id===id);return x?x.name:'';};
  const PAGE=5000;let off=0;
  try{
    while(off<total){
      const{data,error}=await sb.rpc('data_folder_rows',{p_folder_id:fid,p_limit:PAGE,p_offset:off,p_order:'_id',p_desc:false,p_search:null});
      if(error)throw error;const rows=Array.isArray(data)?data:[];if(!rows.length)break;
      parts.push(rows.map(r=>cols.map(c=>q(r[c.name])).join(',')+','+q(fname(r._file_id))+','+q(r._sheet)+','+q(r._row_no)).join('\n')+'\n');
      off+=rows.length;
    }
    const blob=new Blob(parts,{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=_dtSlug(f.name)+'.csv';document.body.appendChild(a);a.click();setTimeout(()=>{a.remove();URL.revokeObjectURL(url);},4000);
    toast('✓ CSV ready — '+_dtN(off)+' rows');
  }catch(e){toast('Export failed: '+(e.message||e),'err');}
};

/* ───────────────────────── styles ───────────────────────── */
function _dtCSS(){
  if(document.getElementById('dt-css'))return'';
  const css=`
.dt-crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:-6px 0 16px}
.dt-crumb{display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border-radius:8px;border:none;background:transparent;color:var(--c-text-2);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.dt-crumb:hover{background:var(--c-surface-2);color:var(--c-text)}
.dt-crumb.on{color:var(--c-text);font-weight:800;cursor:default}
.dt-crumb-sep{color:var(--c-text-3);font-size:14px}
.dt-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.dt-sumcard{background:var(--c-surface);border:1px solid var(--c-border);border-radius:14px;padding:12px 14px;min-width:0}
.dt-sumcard-wide{grid-column:span 2}
.dt-sumlbl{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c-text-3);margin-bottom:4px}
.dt-sumval{font-size:20px;font-weight:800;letter-spacing:-.3px;color:var(--c-text)}
.dt-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;background:var(--c-surface-2);border:1px solid var(--c-border);border-radius:8px;padding:4px 8px;color:var(--c-text);word-break:break-all}
.dt-code-sm{font-size:11px;padding:2px 6px}
.dt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-bottom:16px}
.dt-card{position:relative;background:var(--c-surface);border:1.5px solid var(--c-border);border-radius:16px;padding:14px;cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s;min-width:0}
.dt-card:hover{border-color:var(--c-text-3);transform:translateY(-1px);box-shadow:var(--sh-sm)}
.dt-card-name{font-size:14px;font-weight:800;margin-top:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--c-text)}
.dt-card-meta{font-size:11.5px;color:var(--c-text-3);margin:3px 0 8px}
.dt-card-menu{display:flex;gap:2px;opacity:0;transition:opacity .15s}
.dt-card:hover .dt-card-menu,.dt-card:focus-within .dt-card-menu{opacity:1}
@media(hover:none){.dt-card-menu{opacity:1}}
.dt-card-menu button{width:28px;height:28px;border-radius:8px;border:none;background:var(--c-surface-2);color:var(--c-text-2);cursor:pointer;display:grid;place-items:center}
.dt-card-menu button:hover{color:var(--c-text)}
.dt-card-menu button.danger:hover{background:var(--c-danger-soft);color:var(--c-danger)}
.dt-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--c-border)}
.dt-row:last-child{border-bottom:none}
.dt-row-ic{font-size:22px;flex-shrink:0;width:28px;text-align:center}
.dt-row-name{font-size:13.5px;font-weight:700;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--c-text)}
.dt-row-meta{font-size:11.5px;color:var(--c-text-3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dt-row-actions{display:flex;gap:6px;align-items:center;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.dt-danger:hover{color:var(--c-danger)!important;background:var(--c-danger-soft)!important}
.dt-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--c-surface-2);color:var(--c-text-2);white-space:nowrap}
.dt-pill-ok{background:var(--c-success-soft);color:var(--c-success-ink)}
.dt-pill-err{background:var(--c-danger-soft);color:var(--c-danger-ink)}
.dt-pill-warn{background:var(--c-gold-soft);color:var(--c-gold-ink)}
.dt-pill-busy{background:var(--c-info-soft);color:var(--c-info-ink)}
.dt-spin{width:10px;height:10px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:dtspin .8s linear infinite;display:inline-block}
@keyframes dtspin{to{transform:rotate(360deg)}}
.dt-bar{height:5px;background:var(--c-surface-2);border-radius:3px;overflow:hidden;margin-top:6px;max-width:420px}
.dt-bar>div{height:100%;background:var(--c-brand);border-radius:3px;transition:width .25s}
.dt-drop.over,#dt-inline-drop.over{outline:2px dashed var(--c-brand);outline-offset:-4px;background:var(--c-brand-soft)}
.dt-dz{border:2px dashed var(--c-border-2);border-radius:16px;padding:28px 18px;text-align:center;cursor:pointer;transition:all .15s;background:var(--c-surface-2)}
.dt-dz:hover,.dt-dz.over{border-color:var(--c-brand);background:var(--c-brand-soft)}
.dt-pick{display:flex;align-items:center;gap:10px;background:var(--c-surface-2);border-radius:10px;padding:8px 10px}
.dt-tbar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--c-border);flex-wrap:wrap}
.dt-search{display:flex;align-items:center;gap:6px;flex:1 1 220px;min-width:180px;max-width:360px;color:var(--c-text-3);background:var(--c-surface-2);border-radius:10px;padding:0 10px}
.dt-search .ui-input{box-shadow:none;min-height:34px}
.dt-scroll{overflow:auto;max-height:70vh;-webkit-overflow-scrolling:touch}
.dt-table{min-width:100%;white-space:nowrap}
.dt-table thead th{position:sticky;top:0;background:var(--c-surface);z-index:1}
.dt-th{cursor:pointer;user-select:none}
.dt-th:hover{color:var(--c-text)}
.dt-th.on{color:var(--c-text)}
.dt-th-type{font-size:9.5px;font-weight:600;letter-spacing:.02em;text-transform:none;color:var(--c-text-3);margin-top:1px}
.dt-table th.num,.dt-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.dt-th-n,.dt-td-n{color:var(--c-text-3);font-size:11px;text-align:right;width:1%}
.dt-th-src,.dt-td-src{color:var(--c-text-3);font-size:11.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.dt-td-src span{opacity:.75}
.dt-table td{max-width:360px;overflow:hidden;text-overflow:ellipsis;padding:9px 12px;font-size:13px}
.dt-null{color:var(--c-text-3)}
.dt-pager{display:flex;align-items:center;gap:6px;padding:10px 14px;border-top:1px solid var(--c-border);flex-wrap:wrap}
.dt-pager button[disabled]{opacity:.4;cursor:default}
.dt-jobs{position:fixed;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));z-index:60;background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;box-shadow:var(--sh-lg,0 12px 40px -12px rgba(0,0,0,.28));padding:10px 12px 12px;max-height:50vh;overflow:auto}
@media(max-width:767px){.dt-jobs{bottom:84px}}
.dt-jobs-h{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;font-weight:800;margin-bottom:6px;color:var(--c-text)}
.dt-job{padding:8px 0;border-top:1px solid var(--c-border)}
`;
  try{const st=document.createElement('style');st.id='dt-css';st.textContent=css;document.head.appendChild(st);}catch(e){}
  return'';
}
