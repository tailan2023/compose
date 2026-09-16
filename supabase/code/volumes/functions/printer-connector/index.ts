import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-connector-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, service, { auth: { persistSession: false } });

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function token(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const data = crypto.getRandomValues(new Uint8Array(8));
  return [...data].map(x => alphabet[x % alphabet.length]).join('');
}
async function requireCompanyUser(req: Request, tenantId: string) {
  const auth = req.headers.get('authorization') || '';
  const client = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user } } = await client.auth.getUser();
  if (!user) throw new Error('Sessão expirada. Entre novamente no painel.');
  const { data: profile } = await admin.from('users').select('tenant_id').eq('id', user.id).maybeSingle();
  if (!profile || profile.tenant_id !== tenantId) throw new Error('Você não tem acesso a esta empresa.');
  return user;
}
async function requireConnector(req: Request) {
  const raw = req.headers.get('x-connector-token') || '';
  if (!raw) throw new Error('Credencial do conector ausente.');
  const hash = await sha256(raw);
  const { data } = await admin.from('printer_connectors').select('*').eq('token_hash', hash).eq('is_active', true).maybeSingle();
  if (!data) throw new Error('Conector não autorizado ou revogado.');
  return data;
}

async function createMissingJobs(connector: any) {
  const { data: company } = await admin.from('companies').select('name,currency_code').eq('id', connector.tenant_id).single();
  const { data: orders, error } = await admin.from('orders')
    .select('id,order_number,created_at,table_name,fulfillment_type,guest_name,customer_notes,delivery_address,subtotal,delivery_fee,total,payment_method,status,customers(name,whatsapp),order_items(*)')
    .eq('tenant_id', connector.tenant_id)
    .gte('created_at', connector.created_at)
    .not('status', 'in', '(cancelled,payment_pending)')
    .order('created_at', { ascending: true }).limit(50);
  if (error) throw error;
  if (!orders?.length) return;
  const orderIds = orders.map((o: any) => o.id);
  const { data: existing } = await admin.from('printer_jobs').select('order_id').in('order_id', orderIds);
  const done = new Set((existing || []).map((x: any) => x.order_id));

  const productIds = [...new Set(orders.flatMap((o: any) => (o.order_items || []).map((i: any) => i.product_id)).filter(Boolean))];
  const categoryByProduct = new Map<string, string>();
  if (productIds.length) {
    const { data: products } = await admin.from('products').select('id,categories(name)').in('id', productIds);
    for (const product of products || []) categoryByProduct.set(product.id, (product as any).categories?.name || '');
  }

  const rows = orders.filter((o: any) => !done.has(o.id)).map((o: any) => ({
    tenant_id: connector.tenant_id, order_id: o.id,
    payload: {
      company_name: company?.name || '', currency_code: company?.currency_code || 'BRL', order_number: String(o.order_number), created_at: o.created_at,
      table_name: o.table_name, fulfillment_type: o.fulfillment_type, customer_name: o.customers?.name || o.guest_name || null,
      customer_whatsapp: o.customers?.whatsapp || null, customer_notes: o.customer_notes, delivery_address: o.delivery_address,
      subtotal: o.subtotal || 0, delivery_fee: o.delivery_fee || 0, total: o.total || 0, payment_method: o.payment_method,
      items: (o.order_items || []).map((i: any) => ({ ...i, category_name: categoryByProduct.get(i.product_id) || '' })),
    },
  }));
  if (rows.length) {
    const { error: insertError } = await admin.from('printer_jobs').upsert(rows, { onConflict: 'order_id', ignoreDuplicates: true });
    if (insertError) throw insertError;
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'create_pairing') {
      const tenantId = String(body.tenant_id || '');
      const user = await requireCompanyUser(req, tenantId);
      const code = pairingCode();
      await admin.from('printer_pairing_codes').delete().eq('tenant_id', tenantId).is('used_at', null);
      const { error } = await admin.from('printer_pairing_codes').insert({ tenant_id: tenantId, code_hash: await sha256(code), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), created_by: user.id });
      if (error) throw error;
      return json({ code, expires_in_seconds: 600 });
    }

    if (action === 'list_connectors') {
      const tenantId = String(body.tenant_id || ''); await requireCompanyUser(req, tenantId);
      const { data, error } = await admin.from('printer_connectors').select('id,name,is_active,version,last_seen_at,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false });
      if (error) throw error; return json({ connectors: data || [] });
    }

    if (action === 'revoke_connector') {
      const tenantId = String(body.tenant_id || ''); await requireCompanyUser(req, tenantId);
      const { error } = await admin.from('printer_connectors').update({ is_active: false }).eq('tenant_id', tenantId).eq('id', body.connector_id);
      if (error) throw error; return json({ ok: true });
    }

    if (action === 'pair') {
      const codeHash = await sha256(String(body.code || '').trim().toUpperCase());
      const { data: pair } = await admin.from('printer_pairing_codes').select('*').eq('code_hash', codeHash).is('used_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
      if (!pair) return json({ error: 'Código inválido ou expirado. Gere um novo código no painel.' }, 400);
      const rawToken = token();
      const { data: connector, error } = await admin.from('printer_connectors').insert({ tenant_id: pair.tenant_id, name: String(body.device_name || 'Computador'), token_hash: await sha256(rawToken) }).select('id').single();
      if (error) throw error;
      await admin.from('printer_pairing_codes').update({ used_at: new Date().toISOString() }).eq('id', pair.id);
      const { data: company } = await admin.from('companies').select('name').eq('id', pair.tenant_id).single();
      return json({ connector_id: connector.id, device_token: rawToken, company_name: company?.name || '' });
    }

    const connector = await requireConnector(req);
    if (action === 'heartbeat') {
      await admin.from('printer_connectors').update({ last_seen_at: new Date().toISOString(), version: String(body.version || '') }).eq('id', connector.id);
      return json({ ok: true });
    }
    if (action === 'claim') {
      await createMissingJobs(connector);
      const now = new Date().toISOString();
      await admin.from('printer_jobs').update({ status: 'pending', locked_by: null, locked_until: null }).eq('tenant_id', connector.tenant_id).eq('status', 'processing').lt('locked_until', now);
      const limit = Math.min(Math.max(Number(body.limit || 10), 1), 25);
      const { data: jobs, error } = await admin.rpc('claim_printer_jobs', { p_connector_id: connector.id, p_tenant_id: connector.tenant_id, p_limit: limit });
      if (error) throw error;
      return json({ jobs: jobs || [] });
    }
    if (action === 'complete') {
      const { error } = await admin.from('printer_jobs').update({ status: 'completed', printed_at: new Date().toISOString(), locked_until: null, updated_at: new Date().toISOString() }).eq('id', body.job_id).eq('tenant_id', connector.tenant_id).eq('locked_by', connector.id);
      if (error) throw error; return json({ ok: true });
    }
    if (action === 'fail') {
      const { data: current } = await admin.from('printer_jobs').select('attempts').eq('id', body.job_id).eq('tenant_id', connector.tenant_id).maybeSingle();
      const attempts = Number(current?.attempts || 0) + 1;
      const { error } = await admin.from('printer_jobs').update({ status: attempts >= 5 ? 'failed' : 'pending', attempts, last_error: String(body.error || '').slice(0, 1000), locked_by: null, locked_until: null, updated_at: new Date().toISOString() }).eq('id', body.job_id).eq('tenant_id', connector.tenant_id);
      if (error) throw error; return json({ ok: true, will_retry: attempts < 5 });
    }
    return json({ error: 'Ação inválida.' }, 400);
  } catch (error) {
    console.error(error); return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
