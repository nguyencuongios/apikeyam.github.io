const cfg = window.AMBER_CONFIG || {};
const API = String(cfg.API_BASE_URL || "").replace(/\/$/, "");
const $ = (s) => document.querySelector(s);
const state = { page: "overview", token: sessionStorage.getItem("amber_admin_token") || "", offset: 0, limit: 25, rows: [], editing: null };
const labels = {
  overview:"Overview",api_keys:"API Key Manager",tweaks:"Tweak Manager",packages:"Package Manager",
  licenses:"License Manager",devices:"Device Manager",expiration:"Expiration Manager",
  blacklist:"Blacklist",api_logs:"Request Logs",reports:"Reports & Statistics",settings:"API Configuration"
};
const fields = {
  api_keys:["name","licenseKey","packageId","tweakId","status","deviceLimit","expiresAt","customMessage","notes"],
  tweaks:["name","bundleIdentifier","version","author","description","apiEndpoint","status"],
  packages:["name","bundleIdentifier","tweakId","description","status"],
  licenses:["name","keyId","packageId","tweakId","status","expiresAt","deviceLimit"],
  devices:["deviceName","keyId","packageId","tweakId","status","lastHeartbeat"],
  blacklist:["type","value","reason","status"],
  api_logs:["method","path","status","responseTimeMs","requestId","timestamp"],
  activations:["keyId","deviceId","packageId","tweakId","action","timestamp"]
};
const human = (s) => s.replace(/([A-Z])/g," $1").replace(/_/g," ").replace(/^./,c=>c.toUpperCase());
function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2400)}
async function api(path, options={}) {
  if (!API || API.includes("REPLACE_WITH")) throw new Error("Set API_BASE_URL in public/config.js after deploying the backend.");
  const headers={"Content-Type":"application/json",...(options.headers||{})};
  if(state.token) headers.Authorization=`Bearer ${state.token}`;
  const r=await fetch(`${API}${path}`,{...options,headers});
  const body=await r.json().catch(()=>({message:"Invalid server response"}));
  if(!r.ok || body.success===false) throw new Error(body.message || body.code || `HTTP ${r.status}`);
  return body.data;
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function nav(page){state.page=page;state.offset=0;document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));$("#pageTitle").textContent=labels[page]||human(page);$("#crumb").textContent=(labels[page]||page).toUpperCase();$("#sidebar").classList.remove("open");renderPage()}
async function renderPage(){
  if(state.page==="overview") return renderOverview();
  if(state.page==="reports") return renderReports();
  if(state.page==="settings") return renderSettings();
  if(state.page==="expiration") return renderExpiration();
  return renderCollection(state.page);
}
async function renderOverview(){
  $("#content").innerHTML=`<div class="welcome"><div><div class="eyebrow">SYSTEM OVERVIEW</div><h2>Command your ecosystem.</h2><p>Live operational data from your Firebase database.</p></div><button class="gold-button" id="refreshButton">↻ Refresh data</button></div><div id="stats" class="stats-grid"><div class="empty-state">Loading live database metrics…</div></div><div class="panel"><div class="panel-head"><div><h3>Recent API activity</h3><p>Latest requests recorded by the server</p></div><button class="text-button" data-goto="api_logs">View logs →</button></div><div id="recentLogs" class="table-wrap">Loading…</div></div>`;
  $("#refreshButton").onclick=renderOverview;
  try{
    const d=await api("/api/v1/admin/overview");
    const cards=[
      ["Total API Keys",d.api_keys],["Active Keys",d.activeKeys],["Expired Keys",d.expiredKeys],["Revoked Keys",d.revokedKeys],
      ["Packages",d.packages],["Tweaks",d.tweaks],["Total Devices",d.devices],["Active Devices",d.activeDevices],
      ["Online Devices",d.onlineDevices],["License Activations",d.activations],["API Requests",d.api_logs],["Failed Requests",d.failedRequests]
    ];
    $("#stats").innerHTML=cards.map(([k,v])=>`<div class="stat-card"><div class="stat-label">${k}</div><div class="stat-value">${Number(v||0).toLocaleString()}</div><div class="stat-note">LIVE DATABASE VALUE</div></div>`).join("");
    const logs=await api("/api/v1/admin/api_logs?limit=8");
    $("#recentLogs").innerHTML=table(["Method","Endpoint","HTTP","Latency","Timestamp"],logs.items.map(x=>[x.method,x.path,x.status,`${x.responseTimeMs||0} ms`,date(x.timestamp)]));
  }catch(e){$("#stats").innerHTML=`<div class="empty-state">${escapeHtml(e.message)}<br><br>Set the API URL and provide an administrator token.</div>`;$("#recentLogs").textContent="No live data available."}
}
function date(v){if(!v)return "—";const n=Number(v);return new Date(n).toLocaleString()}
function table(headers,rows){if(!rows.length)return `<div class="empty-state">No records found in the database.</div>`;return `<table><thead><tr>${headers.map(x=>`<th>${escapeHtml(x)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${x??"—"}</td>`).join("")}</tr>`).join("")}</tbody></table>`}
async function renderCollection(collection){
  const cols=fields[collection]||["name","status","createdAt"];
  $("#content").innerHTML=`<div class="panel"><div class="panel-head"><div><div class="eyebrow">DATA MANAGEMENT</div><h3>${labels[collection]||human(collection)}</h3><p>Records are read from the connected Firebase database.</p></div><button class="gold-button" id="createButton">＋ Create</button></div><div class="toolbar"><input id="searchInput" placeholder="Search records…"><select id="statusFilter"><option value="">All statuses</option>${["ACTIVE","UNUSED","EXPIRED","SUSPENDED","REVOKED","BLACKLISTED","DISABLED"].map(x=>`<option>${x}</option>`).join("")}</select><button class="outline-button" id="searchButton">Search</button><button class="outline-button" id="exportButton">Export JSON</button></div><div id="recordsTable" class="table-wrap">Loading records…</div><div id="pagination" class="pagination"></div></div>`;
  $("#createButton").onclick=()=>openRecord(collection,cols);
  $("#searchButton").onclick=()=>{state.offset=0;loadRows(collection,cols)};
  $("#searchInput").onkeydown=e=>{if(e.key==="Enter")$("#searchButton").click()};
  $("#exportButton").onclick=()=>exportCollection(collection);
  await loadRows(collection,cols);
}
async function loadRows(collection,cols){
  try{
    const q=encodeURIComponent($("#searchInput")?.value||"");
    const status=encodeURIComponent($("#statusFilter")?.value||"");
    const d=await api(`/api/v1/admin/${collection}?limit=${state.limit}&offset=${state.offset}&q=${q}&status=${status}`);
    state.rows=d.items||[];
    const headers=["ID",...cols.map(human),"Actions"];
    const rows=state.rows.map(r=>[
      `<code>${escapeHtml(r.id)}</code>`,
      ...cols.map(c=>escapeHtml(c==="expiresAt"||c==="lastHeartbeat"||c==="createdAt"||c==="timestamp"?date(r[c]):r[c])),
      `<div class="row-actions"><button class="small-action" data-edit="${escapeHtml(r.id)}">Edit</button><button class="small-action" data-delete="${escapeHtml(r.id)}">Delete</button></div>`
    ]);
    $("#recordsTable").innerHTML=table(headers,rows);
    $("#pagination").innerHTML=`<span>${d.total} records · ${state.offset+1}–${Math.min(state.offset+state.limit,d.total)}</span><span><button class="small-action" id="prevPage" ${state.offset===0?"disabled":""}>Previous</button> <button class="small-action" id="nextPage" ${state.offset+state.limit>=d.total?"disabled":""}>Next</button></span>`;
    $("#prevPage").onclick=()=>{state.offset=Math.max(0,state.offset-state.limit);loadRows(collection,cols)};
    $("#nextPage").onclick=()=>{state.offset+=state.limit;loadRows(collection,cols)};
    document.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openRecord(collection,cols,state.rows.find(x=>x.id===b.dataset.edit)));
    document.querySelectorAll("[data-delete]").forEach(b=>b.onclick=()=>deleteRecord(collection,b.dataset.delete,cols));
  }catch(e){$("#recordsTable").innerHTML=`<div class="empty-state">${escapeHtml(e.message)}</div>`}
}
function openRecord(collection,cols,record=null){
  state.editing=record;
  $("#dialogTitle").textContent=record?"Edit record":"Create record";
  $("#formFields").innerHTML=cols.map((c,i)=>`<div class="field"><label>${human(c)}</label>${["description","notes","customMessage","reason"].includes(c)?`<textarea name="${c}">${escapeHtml(record?.[c]||"")}</textarea>`:`<input name="${c}" ${c==="expiresAt"||c==="lastHeartbeat"?"type=number":""} value="${escapeHtml(record?.[c]??(c==="status"?"ACTIVE":""))}" placeholder="${human(c)}">`}</div>`).join("");
  $("#recordDialog").showModal();
  $("#recordForm").onsubmit=async e=>{
    e.preventDefault();
    const payload={};new FormData(e.target).forEach((v,k)=>payload[k]=v);
    ["expiresAt","lastHeartbeat","deviceLimit"].forEach(k=>{if(payload[k]!=="")payload[k]=Number(payload[k])});
    try{
      if(record) await api(`/api/v1/admin/${collection}/${encodeURIComponent(record.id)}`,{method:"PATCH",body:JSON.stringify(payload)});
      else await api(`/api/v1/admin/${collection}`,{method:"POST",body:JSON.stringify(payload)});
      $("#recordDialog").close();toast("Record saved");renderCollection(collection);
    }catch(err){toast(err.message)}
  };
}
async function deleteRecord(collection,id,cols){
  if(!confirm(`Delete ${id}? This action cannot be automatically undone.`))return;
  try{await api(`/api/v1/admin/${collection}/${encodeURIComponent(id)}`,{method:"DELETE"});toast("Record deleted");loadRows(collection,cols)}catch(e){toast(e.message)}
}
async function exportCollection(collection){
  try{const d=await api(`/api/v1/admin/export/${collection}`);download(`${collection}.json`,JSON.stringify(d,null,2),"application/json")}catch(e){toast(e.message)}
}
function download(name,content,type){const a=document.createElement("a");const url=URL.createObjectURL(new Blob([content],{type}));a.href=url;a.download=name;a.click();URL.revokeObjectURL(url)}
async function renderReports(){
  $("#content").innerHTML=`<div class="welcome"><div><div class="eyebrow">ANALYTICS & REPORTING</div><h2>Reports & Statistics</h2><p>Counts and records queried from the live database.</p></div><button class="outline-button" id="exportReport">Export report JSON</button></div><div id="reportStats" class="stats-grid"><div class="empty-state">Loading report data…</div></div><div class="panel"><h3>Reporting integrity</h3><p class="stat-label">This initial build reports current collection counts. Time-series charts, PDF generation and custom date-range aggregation are not enabled until a verified event-retention and reporting pipeline is configured.</p></div>`;
  try{const d=await api("/api/v1/admin/overview");const cards=[["Keys",d.api_keys],["Active Keys",d.activeKeys],["Expired Keys",d.expiredKeys],["Packages",d.packages],["Tweaks",d.tweaks],["Devices",d.devices],["Active Devices",d.activeDevices],["Online Devices",d.onlineDevices],["Activations",d.activations],["API Requests",d.api_logs],["Failed Requests",d.failedRequests]];$("#reportStats").innerHTML=cards.map(([k,v])=>`<div class="stat-card"><div class="stat-label">${k}</div><div class="stat-value">${Number(v||0).toLocaleString()}</div><div class="stat-note">CURRENT TOTAL</div></div>`).join("");$("#exportReport").onclick=()=>download("amber-gold-report.json",JSON.stringify({generatedAt:new Date().toISOString(),metrics:d},null,2),"application/json")}catch(e){$("#reportStats").innerHTML=`<div class="empty-state">${escapeHtml(e.message)}</div>`}
}
function renderExpiration(){nav("api_keys");$("#statusFilter")?.value && ($("#statusFilter").value="EXPIRED");}
function renderSettings(){
 $("#content").innerHTML=`<div class="panel"><div class="eyebrow">CONNECTION SETTINGS</div><h3>API Configuration</h3><p class="stat-label">The API URL is configured in public/config.js. The administrator token is kept only in this browser tab's session storage.</p><div class="toolbar" style="margin-top:18px"><button class="outline-button" id="testConnection">Test API health</button><button class="outline-button" id="clearToken">Clear admin token</button></div><div id="healthResult" class="stat-label">No health check performed.</div></div>`;
 $("#testConnection").onclick=async()=>{try{const d=await fetch(`${API}/api/v1/server/health`).then(r=>r.json());$("#healthResult").textContent=JSON.stringify(d);$("#apiState").textContent=d.success?"Online":"Error"}catch(e){$("#healthResult").textContent=e.message}};
 $("#clearToken").onclick=()=>{state.token="";sessionStorage.removeItem("amber_admin_token");toast("Token cleared")};
}
function setToken(){const t=prompt("Enter administrator token. It is stored only for this browser tab.");if(t!==null){state.token=t.trim();sessionStorage.setItem("amber_admin_token",state.token);toast("Token set for this tab");renderPage()}}
$("#adminButton").onclick=setToken;
$("#navigation").addEventListener("click",e=>{const b=e.target.closest("[data-page]");if(b)nav(b.dataset.page)});
$("#content").addEventListener("click",e=>{const b=e.target.closest("[data-goto]");if(b)nav(b.dataset.goto)});
$("#menuButton").onclick=()=>$("#sidebar").classList.toggle("open");
if(!state.token)setTimeout(()=>toast("Set the administrator token to manage records"),700);
renderPage();
