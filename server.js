// SurePath AI Connector — the always-on bridge between Zoho CRM, Vapi and Twilio.
//
//   POST /zoho-lead     Zoho workflow webhook: a new lead was imported -> queue calls
//   POST /vapi-webhook  Vapi end-of-call report -> log to Zoho, schedule retries
//   GET  /healthz       liveness check
//
// Call cadence (client punch list): attempts at 9am / 1pm / 5pm Central,
// Mon-Fri, max 4 attempts, lead-local 8am-9pm respected by area code.
// All state lives in Zoho custom fields (AI_Call_Status, AI_Call_Attempts,
// AI_Next_Attempt, AI_Last_Outcome) so the server itself is stateless.
//
// No npm dependencies. Node 18+.

const http = require('node:http');

const ENV = (k, req = true) => {
  const v = process.env[k];
  if (!v && req) { console.error(`Missing env var ${k}`); process.exit(1); }
  return v;
};

const ZOHO_CLIENT_ID = ENV('ZOHO_CLIENT_ID');
const ZOHO_CLIENT_SECRET = ENV('ZOHO_CLIENT_SECRET');
const ZOHO_REFRESH_TOKEN = ENV('ZOHO_REFRESH_TOKEN');
const VAPI_KEY = ENV('VAPI_KEY');
const VAPI_PHONE_NUMBER_ID = ENV('VAPI_PHONE_NUMBER_ID');
const TWILIO_SID = ENV('TWILIO_SID');
const TWILIO_TOKEN = ENV('TWILIO_TOKEN');
const TWILIO_MSG_SID = ENV('TWILIO_MSG_SID');
const PORT = process.env.PORT || 10000;

const ASSISTANTS = {
  'Past Property Sale': ENV('ASSISTANT_COLD'),
  'Pre-Foreclosure': ENV('ASSISTANT_PRE'),
  'Heir': ENV('ASSISTANT_HEIR'),
  'Estate': ENV('ASSISTANT_HEIR'),
};

const MAX_ATTEMPTS = 4;
const SLOTS_CT = [9, 13, 17]; // attempt hours, America/Chicago

const VOICEMAILS = {
  1: "Hello, this is Emma from Sure Path Asset Recovery. I've been trying to reach {firstName}. I can't legally provide details on this message, but we've identified surplus funds from a property sale that belong to you. Call us the minute you hear this message. My number is (855) 968-4599. Thank you!",
  2: "Hi {firstName}, this is Emma from Sure Path Asset Recovery following up. I can't legally say what this is about on the answering machine, but it's all good news financially for you. Call me the minute you hear this message at (855) 968-4599. Thank you!",
  3: "Hi {firstName}, Emma again from Sure Path Asset Recovery. The surplus funds tied to your property have a state deadline and I'd hate for you to miss out. There's no cost to you. Please call me back at (855) 968-4599. Thank you!",
  4: "Hello, this message is from Sure Path Asset Recovery for {fullName}. Surplus funds associated with the property at {propertyAddress} have been identified as due to you. These funds are subject to a state deadline, after which they are no longer recoverable. Please contact us at (855) 968-4599 or visit www.surepathassetrecovery.com. Thank you.",
};

const SMS_MISSED_CALL = "Hi {firstName}, I just tried calling you regarding surplus funds from your property that belong to you. These funds have a state deadline and I'd hate for you to miss out. No cost to you to learn more. Call us back at (855) 968-4599 or visit https://www.surepathassetrecovery.com. Reply STOP to opt out.";

// ---------- Zoho ----------
let zohoToken = null, zohoTokenAt = 0;
async function zohoAuth() {
  if (zohoToken && Date.now() - zohoTokenAt < 45 * 60 * 1000) return zohoToken;
  const p = new URLSearchParams({ grant_type: 'refresh_token', client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, refresh_token: ZOHO_REFRESH_TOKEN });
  const d = await (await fetch('https://accounts.zoho.com/oauth/v2/token', { method: 'POST', body: p })).json();
  if (!d.access_token) throw new Error('zoho token refresh failed: ' + JSON.stringify(d).slice(0, 200));
  zohoToken = d.access_token; zohoTokenAt = Date.now();
  return zohoToken;
}
async function zoho(method, path, body) {
  const r = await fetch('https://www.zohoapis.com/crm/v8' + path, {
    method,
    headers: { Authorization: 'Zoho-oauthtoken ' + (await zohoAuth()), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`zoho ${method} ${path} -> ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}

// ---------- Vapi / Twilio ----------
async function vapi(method, path, body) {
  const r = await fetch('https://api.vapi.ai' + path, {
    method,
    headers: { Authorization: 'Bearer ' + VAPI_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`vapi ${method} ${path} -> ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}
async function sendSms(to, body) {
  const auth = 'Basic ' + Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessagingServiceSid: TWILIO_MSG_SID, To: to, Body: body }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) console.error('sms failed:', JSON.stringify(d).slice(0, 200));
  return r.ok;
}

// ---------- time helpers ----------
function ctParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return { weekday: o.weekday, hour: +o.hour % 24, minute: +o.minute, y: +o.year, m: +o.month, d: +o.day };
}
const isWeekdayCT = (d) => !['Sat', 'Sun'].includes(ctParts(d).weekday);
function withinCompanyWindow(d = new Date()) {
  const p = ctParts(d);
  const mins = p.hour * 60 + p.minute;
  return isWeekdayCT(d) && mins >= 8 * 60 + 30 && mins <= 17 * 60 + 30;
}
// next 9am/1pm/5pm CT slot strictly after `from`, on a weekday
function nextSlot(from = new Date()) {
  for (let add = 0; add < 7 * 24; add++) {
    const t = new Date(from.getTime() + add * 3600 * 1000);
    const p = ctParts(t);
    if (!isWeekdayCT(t)) continue;
    for (const h of SLOTS_CT) {
      if (p.hour < h || (add > 0 && p.hour === h)) {
        // build a Date at h:00 CT on t's CT date by scanning minute-precision
        const target = new Date(t);
        target.setUTCMinutes(0, 0, 0);
        for (let i = 0; i < 48; i++) {
          const cand = new Date(target.getTime() + i * 30 * 60 * 1000);
          const cp = ctParts(cand);
          if (cp.y === p.y && cp.m === p.m && cp.d === p.d && cp.hour === h && cp.minute === 0 && cand > from) return cand;
        }
      }
    }
  }
  return new Date(from.getTime() + 24 * 3600 * 1000);
}

const PACIFIC = ['206','209','213','253','279','310','323','341','360','408','415','424','425','442','458','503','509','510','530','541','559','562','619','626','628','650','657','661','669','707','714','747','760','805','818','820','831','858','909','916','925','949','951','971'];
const MOUNTAIN = ['208','303','307','385','406','435','480','505','520','602','623','629','719','720','928','970','982','983','986'];
const CENTRAL = ['205','210','214','217','218','224','225','228','251','254','256','262','281','308','309','312','314','316','318','319','320','331','334','337','346','361','402','405','409','414','417','430','432','469','479','501','502','504','507','512','515','531','563','573','580','601','605','608','612','615','618','620','630','636','641','651','660','662','682','701','708','713','715','731','763','769','773','779','785','806','812','815','816','817','830','832','847','850','870','872','901','903','913','915','918','920','931','936','938','940','952','956','972','979','985'];
function leadHourOk(phone) {
  const area = String(phone).replace(/\D/g, '').replace(/^1/, '').slice(0, 3);
  let offset = -5;
  if (PACIFIC.includes(area)) offset = -8;
  else if (MOUNTAIN.includes(area)) offset = -7;
  else if (CENTRAL.includes(area)) offset = -6;
  const localHour = (new Date().getUTCHours() + 24 + offset) % 24;
  return localHour >= 8 && localHour < 21;
}

const e164 = (p) => {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return String(p).startsWith('+') ? String(p) : null;
};
const zDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');

// ---------- Zoho record helpers ----------
const CONTACT_FIELDS = 'id,First_Name,Last_Name,Full_Name,Email,Phone,Mobile,Home_Phone,Alternate_Phone,Lead_Type,Mailing_Street,Mailing_City,Mailing_State,Owner,AI_Call_Status,AI_Call_Attempts,AI_Next_Attempt,AI_Last_Outcome';
async function getContact(id) {
  const d = await zoho('GET', `/Contacts/${id}?fields=${CONTACT_FIELDS}`);
  return d && d.data && d.data[0];
}
async function updateContact(id, fields) {
  return zoho('PUT', '/Contacts/' + id, { data: [{ id, ...fields }] });
}
async function addNote(contactId, title, content) {
  return zoho('POST', '/Notes', { data: [{ Note_Title: title.slice(0, 120), Note_Content: content.slice(0, 32000), Parent_Id: { module: { api_name: 'Contacts' }, id: contactId }, se_module: 'Contacts' }] });
}
async function addTask(contactId, ownerId, subject, description) {
  const due = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const task = { Subject: subject.slice(0, 120), Description: description.slice(0, 2000), Due_Date: due, Status: 'Not Started', Priority: 'High', What_Id: null, Who_Id: { id: contactId }, se_module: 'Contacts' };
  if (ownerId) task.Owner = { id: ownerId };
  return zoho('POST', '/Tasks', { data: [task] });
}

function pickPhone(c, attempt) {
  // all numbers in priority order: Primary Contact, Alt Phone 1-3; rotate across attempts
  const labels = [['Phone','primary'],['Mobile','alt1'],['Home_Phone','alt2'],['Alternate_Phone','alt3']];
  const list = [];
  for (const [f, label] of labels) {
    const n = e164(c[f]);
    if (n && !list.some(x => x.number === n)) list.push({ number: n, label });
  }
  if (!list.length) return null;
  return list[(Math.max(attempt, 1) - 1) % list.length];
}

// ---------- core actions ----------
async function queueLead(contactId) {
  const c = await getContact(contactId);
  if (!c) throw new Error('contact not found: ' + contactId);
  if (['Do Not Call', 'Completed'].includes(c.AI_Call_Status)) return { skipped: c.AI_Call_Status };
  const now = new Date();
  const next = withinCompanyWindow(now) ? now : nextSlot(now);
  await updateContact(contactId, { AI_Call_Status: 'Pending', AI_Call_Attempts: 0, AI_Next_Attempt: zDate(next), AI_Last_Outcome: 'Queued by lead import' });
  console.log(`queued ${c.Full_Name} (${contactId}), first attempt ${next.toISOString()}`);
  return { queued: true, next: next.toISOString() };
}

async function placeCall(c) {
  const attempt = (c.AI_Call_Attempts || 0) + 1;
  const phone = pickPhone(c, attempt);
  if (!phone) {
    await updateContact(c.id, { AI_Call_Status: 'No Valid Phone', AI_Last_Outcome: 'No usable phone number' });
    return;
  }
  if (!leadHourOk(phone.number)) { console.log(`lead-local hours block ${c.Full_Name}, retry next slot`); await updateContact(c.id, { AI_Next_Attempt: zDate(nextSlot(new Date())) }); return; }
  const assistantId = ASSISTANTS[c.Lead_Type] || ASSISTANTS['Past Property Sale'];
  const first = c.First_Name || 'there';
  const vm = VOICEMAILS[Math.min(attempt, 4)]
    .replaceAll('{firstName}', first)
    .replaceAll('{fullName}', c.Full_Name || first)
    .replaceAll('{propertyAddress}', c.Mailing_Street || 'your property');
  const call = await vapi('POST', '/call', {
    assistantId,
    phoneNumberId: VAPI_PHONE_NUMBER_ID,
    customer: { number: phone.number, name: c.Full_Name || first },
    assistantOverrides: {
      voicemailMessage: vm,
      variableValues: {
        customerName: first,
        propertyAddress: c.Mailing_Street || 'your property',
        propertyCityState: [c.Mailing_City, c.Mailing_State].filter(Boolean).join(', '),
        zohoContactId: c.id,
      },
      metadata: { zohoContactId: c.id, attempt },
    },
  });
  await updateContact(c.id, { AI_Call_Status: 'Calling', AI_Call_Attempts: attempt, AI_Last_Outcome: `Attempt ${attempt} dialing (${phone.label})` });
  console.log(`call placed: ${c.Full_Name} attempt ${attempt} (${phone.label}) call ${call.id}`);
}

const NO_CONTACT_REASONS = ['voicemail', 'customer-did-not-answer', 'no-answer', 'customer-busy', 'twilio-failed-to-connect-call', 'silence-timed-out'];

async function handleEndOfCall(msg) {
  const call = msg.call || {};
  const meta = (call.assistantOverrides && call.assistantOverrides.metadata) || call.metadata || {};
  const vv = (call.assistantOverrides && call.assistantOverrides.variableValues) || {};
  const contactId = meta.zohoContactId || vv.zohoContactId;
  const summary = (msg.analysis && msg.analysis.summary) || msg.summary || '';
  const sd = (msg.analysis && msg.analysis.structuredData) || {};
  const reason = msg.endedReason || call.endedReason || '';
  const customerNo = (call.customer && call.customer.number) || '';
  if (!contactId) { console.log('end-of-call without contactId (inbound or manual):', reason); return logInboundByPhone(customerNo, msg, summary, sd); }

  const c = await getContact(contactId);
  if (!c) return;
  const attempt = c.AI_Call_Attempts || 1;
  const dnc = sd.do_not_call === true || /do not call/i.test(sd.outcome || '');
  const noContact = NO_CONTACT_REASONS.some(r => reason.includes(r)) || /voicemail|no answer/i.test(sd.outcome || '');

  const noteBody = [
    `Attempt ${attempt} of ${MAX_ATTEMPTS} — ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
    `Ended: ${reason || 'unknown'}`,
    sd.outcome ? `Outcome: ${sd.outcome}` : '',
    summary ? `\nSummary:\n${summary}` : '',
  ].filter(Boolean).join('\n');
  await addNote(contactId, `AI Call — Attempt ${attempt} (${sd.outcome || reason || 'result'})`, noteBody);

  if (dnc) {
    await updateContact(contactId, { AI_Call_Status: 'Do Not Call', AI_Last_Outcome: 'Do not call requested', AI_Next_Attempt: null });
    console.log(`DNC: ${c.Full_Name}`);
    return;
  }
  if (noContact) {
    if (attempt === 1) {
      const phone = pickPhone(c, 1);
      if (phone) await sendSms(phone.number, SMS_MISSED_CALL.replaceAll('{firstName}', c.First_Name || 'there'));
    }
    if (attempt >= MAX_ATTEMPTS) {
      await updateContact(contactId, { AI_Call_Status: 'Completed', AI_Last_Outcome: `All ${MAX_ATTEMPTS} attempts made, no contact`, AI_Next_Attempt: null });
      await addTask(contactId, c.Owner && c.Owner.id, `Review: ${c.Full_Name} unreachable after ${MAX_ATTEMPTS} AI attempts`, 'The AI agent could not reach this lead. Voicemails were left and a missed-call text was sent. Consider manual outreach or skip-tracing an alternate number.');
    } else {
      const next = nextSlot(new Date());
      await updateContact(contactId, { AI_Call_Status: 'Retry Scheduled', AI_Last_Outcome: `Attempt ${attempt}: ${sd.outcome || reason}`, AI_Next_Attempt: zDate(next) });
      console.log(`retry ${c.Full_Name} at ${next.toISOString()}`);
    }
    return;
  }
  // real conversation happened
  await updateContact(contactId, { AI_Call_Status: 'Completed', AI_Last_Outcome: (sd.outcome || 'Conversation completed').slice(0, 95), AI_Next_Attempt: null });
  const needsFollowUp = sd.agreement_email_requested === true || sd.callback_time || /agreement|callback|interested/i.test(sd.outcome || '');
  if (needsFollowUp) {
    await addTask(contactId, c.Owner && c.Owner.id, `Follow up: ${c.Full_Name} — ${sd.outcome || 'interested'}`, [sd.callback_time ? `Requested callback: ${sd.callback_time}` : '', sd.email ? `Email given on call: ${sd.email}` : '', summary].filter(Boolean).join('\n'));
  }
}

// inbound calls (no contactId): log against the matching contact by phone, if any
async function logInboundByPhone(number, msg, summary, sd) {
  if (!number) return;
  try {
    const d = await zoho('GET', `/Contacts/search?criteria=((Mobile:equals:${encodeURIComponent(number)})or(Alternate_Phone:equals:${encodeURIComponent(number)}))&fields=id,Full_Name,Owner`);
    const c = d && d.data && d.data[0];
    if (!c) return;
    await addNote(c.id, `AI Call — Inbound (${sd.outcome || 'answered'})`, `Inbound call from ${number} at ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT\n\n${summary || ''}`);
  } catch (e) { console.error('inbound log failed:', e.message); }
}

// ---------- scheduler ----------
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    if (!withinCompanyWindow()) return;
    const crit = encodeURIComponent('((AI_Call_Status:equals:Pending)or(AI_Call_Status:equals:Retry Scheduled))');
    const d = await zoho('GET', `/Contacts/search?criteria=${crit}&fields=${CONTACT_FIELDS}&per_page=50`).catch(e => { if (!/204/.test(e.message)) console.error('search:', e.message); return null; });
    const due = (d && d.data || []).filter(c => !c.AI_Next_Attempt || new Date(c.AI_Next_Attempt) <= new Date());
    for (const c of due.slice(0, 5)) { // max 5 calls per tick to stay gentle
      try { await placeCall(c); } catch (e) { console.error(`call failed ${c.id}:`, e.message); await updateContact(c.id, { AI_Call_Status: 'Retry Scheduled', AI_Last_Outcome: ('Error: ' + e.message).slice(0, 95), AI_Next_Attempt: zDate(nextSlot(new Date())) }).catch(() => {}); }
    }
  } catch (e) { console.error('tick error:', e.message); }
  finally { ticking = false; }
}
setInterval(tick, 3 * 60 * 1000);

// watchdog: a contact stuck in 'Calling' for over an hour goes back to retry
setInterval(async () => {
  try {
    const crit = encodeURIComponent('(AI_Call_Status:equals:Calling)');
    const d = await zoho('GET', `/Contacts/search?criteria=${crit}&fields=${CONTACT_FIELDS}&per_page=50`).catch(() => null);
    for (const c of (d && d.data || [])) {
      if (c.Modified_Time && Date.now() - new Date(c.Modified_Time) < 60 * 60 * 1000) continue;
      await updateContact(c.id, { AI_Call_Status: 'Retry Scheduled', AI_Next_Attempt: zDate(nextSlot(new Date())) });
    }
  } catch {}
}, 30 * 60 * 1000);

// ---------- http ----------
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => res(b)); });

http.createServer(async (req, res) => {
  const ok = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj || { ok: true })); };
  try {
    if (req.method === 'GET' && req.url.startsWith('/healthz')) return ok({ ok: true, window: withinCompanyWindow() });
    if (req.method === 'POST' && req.url.startsWith('/zoho-lead')) {
      const body = JSON.parse(await readBody(req) || '{}');
      const contactId = body.contactId || body.id;
      if (!contactId) return ok({ error: 'no contactId' });
      const r = await queueLead(String(contactId));
      return ok(r);
    }
    if (req.method === 'POST' && req.url.startsWith('/vapi-webhook')) {
      const body = JSON.parse(await readBody(req) || '{}');
      const msg = body.message || body;
      ok({ received: true }); // ack fast, work after
      if (msg.type === 'end-of-call-report') await handleEndOfCall(msg).catch(e => console.error('eoc:', e.message));
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error('http error:', e.message);
    try { res.writeHead(500); res.end('error'); } catch {}
  }
}).listen(PORT, () => console.log('SurePath AI Connector listening on', PORT));
