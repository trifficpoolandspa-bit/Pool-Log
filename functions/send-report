// send-report
//
// Sends a service report, or an "on my way" note, from the office rather than
// from a phone. A phone that is off, out of signal or closed no longer holds up
// somebody's report: the phone hands it over and the server does the sending.
//
// It runs in Supabase (Edge Functions) and sends through Resend, using the key
// stored as RESEND_API_KEY. The key never goes near the apps, which are public
// files anyone can read.
//
// Who may use it: anyone signed in, for a customer in their own company. The
// company name on the email and the address replies go to are read from the
// server, not taken from the caller, so nobody can send as another company.

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SENDING_ADDRESS = 'reports@getweir.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function reply(status: number, body: Record<string, unknown>){
  return new Response(JSON.stringify(body), {
    status,
    headers: {...CORS, 'Content-Type': 'application/json'}
  });
}

// Everything the caller is allowed to send as, read from the server
async function whoIsAsking(token: string){
  const ask = async (path: string) => {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: {apikey: ANON_KEY, Authorization: 'Bearer ' + token}
    });
    return res.ok ? await res.json() : null;
  };
  const membership = await ask('rpc/my_membership');
  if(!membership || !membership.company_id) return null;

  // The company's own details, as the office set them
  const rows = await ask("company_records?select=data&kind=eq.company&id=eq.details");
  const details = Array.isArray(rows) && rows[0] ? rows[0].data || {} : {};
  return {
    companyId: membership.company_id,
    companyName: details.companyName || membership.company_name || 'Your pool service',
    replyTo: details.accountEmail || null,
    technicianId: membership.technician_id || null
  };
}

Deno.serve(async (req: Request)=>{
  if(req.method === 'OPTIONS') return new Response('ok', {headers: CORS});
  if(req.method !== 'POST') return reply(405, {error: 'Send it as a POST'});
  if(!RESEND_API_KEY) return reply(500, {error: 'This server has no sending key set up'});

  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if(!token) return reply(401, {error: 'Sign in first'});

  const who = await whoIsAsking(token);
  if(!who) return reply(403, {error: 'That account is not attached to a company'});

  let body: Record<string, any>;
  try{ body = await req.json(); }catch(e){ return reply(400, {error: 'That was not readable'}); }

  const to = String(body.to || '').trim();
  const subject = String(body.subject || '').trim();
  const html = String(body.html || '');
  if(!to || to.indexOf('@') === -1) return reply(400, {error: 'No email address to send to'});
  if(!subject || !html) return reply(400, {error: 'A report needs a subject and a body'});

  // Photos come as data the phone already has. They go inside the report
  // rather than hanging off the bottom of it: each one is referenced from the
  // page by an id, which is what "cid:" means in an email. Anything past what
  // the email service accepts is left out rather than failing the whole send.
  const attachments: Array<Record<string, string>> = [];
  const shown: string[] = [];
  let carried = 0;
  (Array.isArray(body.photos) ? body.photos : []).forEach((p: any, i: number)=>{
    if(!p || !p.content) return;
    const size = String(p.content).length * 0.75;
    if(carried + size > 20 * 1024 * 1024) return;
    carried += size;
    const id = 'photo-' + (i + 1);
    attachments.push({
      filename: String(p.filename || ('photo-' + (i + 1) + '.jpg')),
      content: String(p.content),
      content_type: 'image/jpeg',
      content_id: id
    });
    shown.push(id + '\u0001' + String(p.caption || p.filename || ''));
  });

  // The report's own page, with the photos added to the end of it
  function photoSection(){
    if(!shown.length) return '';
    const cards = shown.map(entry=>{
      const [id, caption] = entry.split('\u0001');
      const label = caption.replace(/[<>&]/g, '').replace(/\.(jpe?g|png|webp)$/i, '');
      return '<tr><td style="padding:0 0 16px;">'
        + '<img src="cid:' + id + '" alt="' + label + '" width="520" '
        + 'style="display:block;width:100%;max-width:520px;height:auto;border-radius:10px;border:1px solid #E6E9E8;">'
        + (label ? '<div style="font-size:12.5px;color:#6B7B79;margin-top:6px;">' + label + '</div>' : '')
        + '</td></tr>';
    }).join('');
    return '<tr><td style="padding:0 26px 26px;">'
      + '<div style="font-size:13.5px;font-weight:600;color:#16302E;margin:0 0 12px;">'
      + (shown.length === 1 ? 'Photo from this visit' : 'Photos from this visit') + '</div>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
      + cards + '</table></td></tr>';
  }

  // Slotted in before the report's closing table, so it sits inside the page
  function withPhotos(page: string){
    const section = photoSection();
    if(!section) return page;
    const at = page.lastIndexOf('</table></td></tr></table>');
    if(at === -1) return page + section;
    return page.slice(0, at) + section + page.slice(at);
  }

  const from = who.companyName.replace(/["<>]/g, '') + ' via Weir <' + SENDING_ADDRESS + '>';
  const payload: Record<string, unknown> = {
    from,
    to: [to],
    subject,
    html: withPhotos(html),
    ...(who.replyTo ? {reply_to: who.replyTo} : {}),
    ...(attachments.length ? {attachments} : {})
  };

  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  const result = await sent.json().catch(()=> ({}));
  if(!sent.ok){
    return reply(sent.status, {error: result.message || 'The email service refused it', detail: result});
  }
  return reply(200, {sent: true, id: result.id, from: from, replyTo: who.replyTo});
});
