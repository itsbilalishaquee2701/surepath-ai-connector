// Live performance dashboard: GET /dashboard?key=... (aggregates only, no personal data)
const LOGO = 'https://horizons-cdn.hostinger.com/3678aaf2-993e-4ce7-bdd8-2d0a14676582/4aede1b63b3df287cf97383bb9536256.png';
const DEFAULT_FEE = Number(process.env.DEFAULT_FEE_PCT || 20);

async function fetchAll(zoho, module, fields) {
  const out = []; let token = null;
  do {
    const d = await zoho('GET', `/${module}?fields=${fields}&per_page=200` + (token ? `&page_token=${token}` : ''));
    if (!d) break;
    out.push(...(d.data || []));
    token = d.info && d.info.more_records ? d.info.next_page_token : null;
  } while (token);
  return out;
}

let cache = null, cacheAt = 0;
const WON = ['Claim Complete', 'Ask for Review', 'Closed Won'];
async function compute(zoho) {
  if (cache && Date.now() - cacheAt < 5 * 60 * 1000) return cache;
  const contacts = await fetchAll(zoho, 'Contacts', 'Lead_Type,AI_Call_Status,AI_Last_Outcome,Surplus_Amount');
  const deals = await fetchAll(zoho, 'Deals', 'Stage,Amount,Fee_Percent,Closing_Date');
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x) || 'Not set'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const won = deals.filter(d => WON.includes(d.Stage));
  const lost = deals.filter(d => /Closed Lost/.test(d.Stage || ''));
  const open = deals.filter(d => !WON.includes(d.Stage) && !/^Closed/.test(d.Stage || ''));
  const fee = (d) => (Number(d.Amount) || 0) * ((d.Fee_Percent != null ? Number(d.Fee_Percent) : DEFAULT_FEE) / 100);
  const months = {};
  for (const d of won) { const m = (d.Closing_Date || '').slice(0, 7) || 'Undated'; months[m] = (months[m] || 0) + fee(d); }
  cache = {
    contacts: contacts.length,
    leadTypes: count(contacts, c => c.Lead_Type),
    callStatus: count(contacts, c => c.AI_Call_Status),
    engaged: contacts.filter(c => /callback|agreement|interested/i.test(c.AI_Last_Outcome || '')).length,
    pool: contacts.reduce((s, c) => s + (Number(c.Surplus_Amount) || 0), 0),
    stages: count(deals, d => d.Stage),
    deals: deals.length, open: open.length, won: won.length, lost: lost.length,
    pipeline: open.reduce((s, d) => s + (Number(d.Amount) || 0), 0),
    recovered: won.reduce((s, d) => s + (Number(d.Amount) || 0), 0),
    revenue: won.reduce((s, d) => s + fee(d), 0),
    months: Object.entries(months).sort().slice(-6),
    at: new Date(),
  };
  cacheAt = Date.now();
  return cache;
}

const $ = (n) => '$' + Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function bars(obj, color) {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(e => e[1]));
  if (!entries.length) return '<p class="muted">No data yet</p>';
  return entries.map(([k, v]) => `<div class="row"><span class="lbl">${esc(k)}</span><div class="track"><div class="fill" style="width:${(v / max) * 100}%;background:${color}"></div></div><b>${v.toLocaleString()}</b></div>`).join('');
}

function render(d) {
  const winRate = d.won + d.lost ? Math.round((d.won / (d.won + d.lost)) * 100) : 0;
  const monthMax = Math.max(1, ...d.months.map(m => m[1]));
  const monthBars = d.months.length ? d.months.map(([m, v]) => `<div class="col"><div class="colbar" style="height:${Math.max(4, (v / monthMax) * 120)}px"></div><b>${$(v)}</b><span>${esc(m)}</span></div>`).join('') : '<p class="muted">No closed deals yet</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="300"><title>Sure Path Dashboard</title>
<style>
:root{--b:#1165b6;--n:#1d3d52;--bg:#f4f7fa;--c:#fff;--m:#6b7c8a;--g:#1f9d6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:var(--n)}
header{background:var(--c);border-bottom:1px solid #e3e8ee;padding:14px 28px;display:flex;align-items:center;gap:14px}
header img{height:46px}header h1{font-size:18px;margin:0}header small{color:var(--m);margin-left:auto}
main{max-width:1180px;margin:0 auto;padding:24px 20px 40px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:18px}
.kpi{background:var(--c);border-radius:12px;padding:18px 20px;box-shadow:0 1px 3px rgba(20,40,60,.08)}
.kpi span{display:block;color:var(--m);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.kpi b{font-size:28px;display:block;margin-top:4px}.kpi.hero{background:var(--b);color:#fff}.kpi.hero span{color:#cfe3f6}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px}
.card{background:var(--c);border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(20,40,60,.08)}
.card h2{font-size:14px;margin:0 0 14px;text-transform:uppercase;letter-spacing:.05em;color:var(--m)}
.row{display:grid;grid-template-columns:150px 1fr 48px;align-items:center;gap:10px;margin:8px 0;font-size:13px}
.track{background:#edf1f5;border-radius:6px;height:12px;overflow:hidden}.fill{height:100%;border-radius:6px}.row b{text-align:right}
.cols{display:flex;gap:14px;align-items:flex-end;height:190px}.col{flex:1;text-align:center;display:flex;flex-direction:column;justify-content:flex-end;gap:4px;font-size:12px}
.colbar{background:var(--g);border-radius:6px 6px 0 0}.muted{color:var(--m)}
footer{text-align:center;color:var(--m);font-size:12px;margin-top:22px}
</style></head><body>
<header><img src="${LOGO}" alt="Sure Path"><h1>Performance Dashboard</h1><small>Updated ${d.at.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</small></header>
<main>
<section class="kpis">
<div class="kpi hero"><span>Revenue earned</span><b>${$(d.revenue)}</b></div>
<div class="kpi"><span>Funds recovered for clients</span><b>${$(d.recovered)}</b></div>
<div class="kpi"><span>Open pipeline value</span><b>${$(d.pipeline)}</b></div>
<div class="kpi"><span>Deals won / lost</span><b>${d.won} / ${d.lost}</b></div>
<div class="kpi"><span>Win rate</span><b>${winRate}%</b></div>
<div class="kpi"><span>Total contacts</span><b>${d.contacts.toLocaleString()}</b></div>
<div class="kpi"><span>Interested or callback</span><b>${d.engaged}</b></div>
<div class="kpi"><span>Surplus pool tracked</span><b>${$(d.pool)}</b></div>
</section>
<section class="grid">
<div class="card"><h2>Revenue by month (closed won)</h2><div class="cols">${monthBars}</div></div>
<div class="card"><h2>Deal pipeline</h2>${bars(d.stages, '#1165b6')}</div>
<div class="card"><h2>Contacts by lead type</h2>${bars(d.leadTypes, '#2a9fd6')}</div>
<div class="card"><h2>AI calling status</h2>${bars(d.callStatus, '#1d3d52')}</div>
</section>
<footer>Revenue = Deal Amount x Fee Percent (default ${DEFAULT_FEE}% when a deal has none). Refreshes every 5 minutes.</footer>
</main></body></html>`;
}

module.exports = { compute, render };
