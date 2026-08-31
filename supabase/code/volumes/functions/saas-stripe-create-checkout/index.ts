import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { admin, cors, json, secret, stripeForm } from '../_shared/common.ts';

const zeroDecimal = new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const auth = req.headers.get('authorization') || '';
    const client = createClient(secret('SUPABASE_URL')!, secret('SUPABASE_ANON_KEY')!, {
      global:{headers:{Authorization:auth}}, auth:{persistSession:false}
    });
    const {data:{user}} = await client.auth.getUser();
    if (!user) return json({error:'Sessão inválida.'},401);

    const {tenant_id} = await req.json();
    const db = admin();
    const {data:profile} = await db.from('users').select('tenant_id,role').eq('id',user.id).maybeSingle();
    if (!profile || profile.tenant_id !== tenant_id || !['admin','owner'].includes(profile.role)) return json({error:'Acesso negado.'},403);

    const [{data:company},{data:subscription}] = await Promise.all([
      db.from('companies').select('id,name,email,billing_currency').eq('id',tenant_id).maybeSingle(),
      db.from('subscriptions').select('id,plan_id,status,trial_ends_at,stripe_customer_id,stripe_subscription_id').eq('tenant_id',tenant_id).maybeSingle()
    ]);
    if (!company || !subscription) return json({error:'Assinatura não encontrada.'},404);
    if (subscription.stripe_subscription_id) return json({error:'Esta assinatura já está vinculada à Stripe.'},409);

    const currency = String(company.billing_currency || 'USD').toUpperCase();
    if (currency === 'BRL') return json({error:'Assinaturas em BRL continuam no Mercado Pago.'},409);
    const {data:price} = await db.from('plan_prices').select('monthly_price,stripe_price_id').eq('plan_id',subscription.plan_id).eq('currency_code',currency).eq('is_active',true).maybeSingle();
    if (!price) return json({error:`Preço do plano não configurado em ${currency}.`},409);

    const factor = zeroDecimal.has(currency) ? 1 : 100;
    const amount = Math.round(Number(price.monthly_price) * factor);
    if (!Number.isFinite(amount) || amount < 1) return json({error:'Valor da assinatura inválido.'},400);

    const dashboard = (secret('DASHBOARD_URL') || 'https://dashboard.cardapioplus.com').replace(/\/$/,'');
    const body = new URLSearchParams();
    body.set('mode','subscription');
    body.set('success_url',`${dashboard}/?view=assinatura&billing=success&session_id={CHECKOUT_SESSION_ID}`);
    body.set('cancel_url',`${dashboard}/?view=assinatura&billing=cancelled`);
    body.set('client_reference_id',tenant_id);
    body.set('metadata[tenant_id]',tenant_id);
    body.set('metadata[subscription_id]',subscription.id);
    body.set('subscription_data[metadata][tenant_id]',tenant_id);
    body.set('subscription_data[metadata][subscription_id]',subscription.id);
    body.set('line_items[0][quantity]','1');
    if (price.stripe_price_id) {
      body.set('line_items[0][price]',price.stripe_price_id);
    } else {
      body.set('line_items[0][price_data][currency]',currency.toLowerCase());
      body.set('line_items[0][price_data][unit_amount]',String(amount));
      body.set('line_items[0][price_data][recurring][interval]','month');
      body.set('line_items[0][price_data][product_data][name]',`Assinatura Cardápio+`);
    }
    if (subscription.stripe_customer_id) body.set('customer',subscription.stripe_customer_id);
    else if (company.email) body.set('customer_email',company.email);

    const trialEnd = subscription.trial_ends_at ? Math.floor(new Date(subscription.trial_ends_at).getTime()/1000) : 0;
    if (trialEnd > Math.floor(Date.now()/1000) + 60) body.set('subscription_data[trial_end]',String(trialEnd));

    const session = await stripeForm('checkout/sessions',body,undefined,`saas-checkout-${subscription.id}-${currency}`);
    await db.from('subscriptions').update({
      payment_provider:'stripe', billing_currency:currency, stripe_checkout_session_id:session.id
    }).eq('id',subscription.id);
    return json({url:session.url});
  } catch (e) {
    console.error(e);
    return json({error:e instanceof Error ? e.message : 'Não foi possível abrir a cobrança internacional.'},500);
  }
});

