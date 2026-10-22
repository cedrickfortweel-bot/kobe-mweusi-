(function () {
  const client = window.supabase.createClient(
    'https://arnbsijvnxnoqybumkys.supabase.co',
    'sb_publishable_PDZh59CJskfn0O6_Rme8xw_MXoprn0v',
    { auth: { autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', persistSession: true } }
  );

  const appUrl = file => new URL(file, location.origin).toString();

  /* Handoff codes the server issued, keyed by order reference. */
  const handoffTokens = {};
  const cleanPhone = value => {
    const digits = String(value || '').replace(/[^0-9+]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    if (digits.startsWith('0')) return '+255' + digits.slice(1);
    if (digits.startsWith('255')) return '+' + digits;
    return '+255' + digits;
  };
  const fail = error => {
    if (!error) return;
    if (error.code === 'P0001' && error.message === 'RATE_LIMITED') {
      const seconds = Math.max(1, Number(error.details) || 60);
      throw new Error(`Too many changes. Please wait ${seconds} seconds and try again.`);
    }
    if (error.code === '23505' && String(error.message).includes('seller_kyc_one_open_submission_idx')) {
      throw new Error('You already have a verification submission under review. Wait for the review or contact support.');
    }
    if (error.code === '42501') throw new Error('This action is not allowed for your account.');
    throw new Error(error.message || 'Supabase request failed.');
  };

  async function profileFor(userId) {
    const { data, error } = await client.from('profiles').select('*').eq('id', userId).single();
    fail(error);
    return data;
  }

  async function enterApp(expectedRole) {
    const { data, error } = await client.auth.getSession();
    fail(error);
    if (!data.session) throw new Error('Your email is not confirmed yet. Check your inbox for the verification link.');
    const user = data.session.user;
    if (!user.email_confirmed_at) {
      await client.auth.signOut();
      throw new Error('Your email is not confirmed yet. Check your inbox for the verification link, or request a new one.');
    }
    const profile = await profileFor(data.session.user.id);
    if (expectedRole && profile.account_type !== expectedRole) {
      await client.auth.signOut();
      throw new Error('This account is registered as a ' + profile.account_type + '. Choose the matching sign-in role.');
    }
    location.assign(appUrl(profile.account_type === 'seller' ? 'seller.html' : 'buyer.html'));
    return { redirecting: true };
  }

  async function signUp(accountType, form) {
    const email = String(form.email || '').trim().toLowerCase();
    if (!email) throw new Error('Email is required until SMS sign-in is configured.');
    const { data, error } = await client.auth.signUp({
      email,
      password: form.pass,
      options: {
        emailRedirectTo: appUrl(accountType === 'seller' ? 'seller.html' : 'buyer.html'),
        data: {
          account_type: accountType,
          display_name: String(form.name || '').trim(),
          phone_e164: cleanPhone(form.phone)
        }
      }
    });
    fail(error);
    if (data.session) return enterApp(accountType);
    return { confirmationRequired: true };
  }

  async function signIn({ email, pass, role }) {
    const { data, error } = await client.auth.signInWithPassword({ email: String(email || '').trim().toLowerCase(), password: pass });
    if (error) throw error;
    const user = data.user;
    if (!user.email_confirmed_at) {
      await client.auth.signOut();
      throw new Error('Your email is not confirmed yet. Check your inbox for the verification link, or request a new one.');
    }
    return enterApp(role);
  }

  async function resendConfirmationEmail({ email }) {
    const { error } = await client.auth.resend({ type: 'signup', email: String(email || '').trim().toLowerCase() });
    fail(error);
    return { ok: true };
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    fail(error);
    location.replace(appUrl('Kobe_Mweusi_homepage_v7_static.html#signin'));
  }

  async function getSessionProfile() {
    const { data, error } = await client.auth.getSession();
    fail(error);
    if (!data.session) return null;
    return { session: data.session, profile: await profileFor(data.session.user.id) };
  }

  async function ensureSellerProfile() {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as a seller to manage your shop.');
    const { data: existing, error: readError } = await client.from('seller_profiles').select('*').eq('user_id', auth.user.id).maybeSingle();
    fail(readError);
    if (existing) return existing;
    const shopName = String(auth.user.user_metadata.display_name || 'My Kobe shop').trim();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await client.from('seller_profiles')
        .insert({ user_id: auth.user.id, shop_name: shopName })
        .select('*').single();
      if (!error) return data;
      if (error.code === '23505') {
        const { data: concurrent, error: concurrentError } = await client.from('seller_profiles').select('*').eq('user_id', auth.user.id).maybeSingle();
        fail(concurrentError);
        if (concurrent) return concurrent;
        if (String(error.message).includes('seller_profiles_kobe_id_unique')) continue;
      }
      fail(error);
    }
    throw new Error('Could not assign a unique Kobe seller ID. Please retry.');
  }

  async function saveSellerProfile(values) {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in to update your shop.');
    const { data, error } = await client.from('seller_profiles').upsert({
      user_id: auth.user.id,
      shop_slug: values.shop_slug || null,
      shop_name: String(values.shop_name || '').trim(),
      bio: String(values.bio || '').trim(),
      region: values.region || null,
      public_contact: values.public_contact || null
    }, { onConflict: 'user_id' }).select('*').single();
    fail(error);
    return data;
  }

  async function listPublicProducts(sellerId) {
    let query = client.from('products').select('id,seller_id,name,description,price_tzs,stock_quantity,status,image_path,created_at').eq('status', 'active').order('created_at', { ascending: false });
    if (sellerId) query = query.eq('seller_id', sellerId);
    const { data, error } = await query;
    fail(error);
    return data || [];
  }

  async function saveProduct(values) {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as a seller to save products.');
    const product = {
      seller_id: auth.user.id,
      name: String(values.name || '').trim(),
      description: String(values.description || '').trim(),
      price_tzs: Number(values.price_tzs),
      stock_quantity: Number(values.stock_quantity),
      status: values.status === 'active' ? 'active' : 'draft',
      image_path: values.image_path || null
    };
    const request = values.id
      ? client.from('products').update(product).eq('id', values.id)
      : client.from('products').insert(product);
    const { data, error } = await request.select('*').single();
    fail(error);
    return data;
  }

  async function listOwnProducts() {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as a seller to load your products.');
    const { data, error } = await client.from('products').select('*')
      .eq('seller_id', auth.user.id).order('created_at', { ascending: false });
    fail(error);
    return data || [];
  }

  async function saveLiveSession(values) {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as a seller to publish a live listing.');
    const session = {
      seller_id: auth.user.id,
      title: String(values.title || '').trim(),
      description: String(values.description || '').trim(),
      platform: values.platform,
      external_url: String(values.external_url || '').trim(),
      status: values.status || 'scheduled',
      starts_at: values.starts_at || null,
      ends_at: values.ends_at || null
    };
    const request = values.id
      ? client.from('live_sessions').update(session).eq('id', values.id)
      : client.from('live_sessions').insert(session);
    const { data, error } = await request.select('*').single();
    fail(error);
    const productIds = Array.from(new Set((values.product_ids || []).filter(Boolean)));
    const { error: clearError } = await client.from('live_session_products').delete().eq('session_id', data.id);
    fail(clearError);
    if (productIds.length) {
      const links = productIds.map((productId, index) => ({ session_id: data.id, product_id: productId, sort_order: index }));
      const { error: linkError } = await client.from('live_session_products').insert(links);
      fail(linkError);
    }
    return data;
  }

  function mapLiveSession(session) {
   const seller = session.seller_profiles || {};
   /* The canonical Seller Kobe ID (KOBE12XL) is the one a customer reads
      and searches for. The app-facing id is kept as a fallback for
      sellers whose registry row has not been created yet. */
   const registry = Array.isArray(seller.kobe_id_registry) ? seller.kobe_id_registry[0] : seller.kobe_id_registry;
   return {
   id: session.id,
   status: session.status,
   sellerVerified: seller.verification_status === 'verified',
   sellerName: seller.shop_name,
   sellerKid: (registry && registry.kobe_id) || seller.kobe_id || '',
   sellerKidApp: seller.kobe_id || '',
   title: session.title,
      description: session.description,
      platform: session.platform,
      externalUrl: session.external_url,
      endAt: session.ends_at ? new Date(session.ends_at).getTime() : null,
      products: (session.live_session_products || [])
        .filter(link => link.products && link.products.status === 'active')
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((link, index) => ({
          id: link.products.id,
          idx: index,
          name: link.products.name,
          description: link.products.description,
          price: link.products.price_tzs,
          stock: link.products.stock_quantity,
          image: '',
          soldOut: link.products.stock_quantity <= 0,
          pinned: link.pinned
        }))
    };
  }

  async function listPublicLiveSessions() {
    const { data, error } = await client.from('live_sessions')
      .select('id,seller_id,title,description,platform,external_url,status,starts_at,ends_at,seller_profiles!inner(shop_name,kobe_id,verification_status,kobe_id_registry(kobe_id)),live_session_products(sort_order,pinned,products(id,name,description,price_tzs,stock_quantity,image_path,status))')
      .eq('status', 'live').order('starts_at', { ascending: true });
    fail(error);
    return (data || []).map(mapLiveSession);
  }

  async function listOwnLiveSessions() {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as a seller to load your live listings.');
    const { data, error } = await client.from('live_sessions')
      .select('id,seller_id,title,description,platform,external_url,status,starts_at,ends_at,seller_profiles!inner(shop_name,kobe_id,verification_status,kobe_id_registry(kobe_id)),live_session_products(sort_order,pinned,products(id,name,description,price_tzs,stock_quantity,image_path,status))')
      .eq('seller_id', auth.user.id).in('status', ['scheduled', 'live']).order('starts_at', { ascending: true });
    fail(error);
    return (data || []).map(mapLiveSession);
  }

  async function endLiveSession(id) {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as the seller to end this listing.');
    const { data, error } = await client.from('live_sessions')
      .update({ status: 'ended', ends_at: new Date().toISOString() })
      .eq('id', id).eq('seller_id', auth.user.id).select('*').single();
    fail(error);
    return data;
  }

  async function submitKyc(values) {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as a seller to submit verification.');
    const seller = await ensureSellerProfile();
    const personal = values.entity_type === 'personal';
    const submissionId = crypto.randomUUID();
    const requiredFields = personal ? ['a', 'ph', 'b', 'd', 'e', 'c'] : ['a', 'b', 'c', 'd', 'rn', 'rid', 'e'];
    for (const key of requiredFields) {
      if (!String(values.fields[key] || '').trim()) throw new Error('Complete all required verification fields.');
    }
    if (!values.fields.ok) throw new Error('Confirm that your information and documents are accurate.');

    const docs = personal
      ? [['d', 'nida'], ['e', 'selfie'], ['f', 'tin']]
      : [['d', 'registration'], ['f', 'tin'], ['e', 'representative']];
    const files = docs.map(([key, kind]) => ({ key, kind, file: values.files[key] })).filter(entry => entry.file instanceof File);
    const requiredDocuments = personal ? ['d', 'e'] : ['d', 'e'];
    if (requiredDocuments.some(key => !files.some(entry => entry.key === key))) throw new Error('Attach the required identity and business documents.');
    if (files.length < 1 || files.length > 6) throw new Error('Attach between 1 and 6 documents.');

    const uploaded = [];
    try {
      for (const entry of files) {
        if (entry.file.size > 10485760) throw new Error('Each document must be 10 MB or smaller.');
        if (!['image/jpeg', 'image/png', 'application/pdf'].includes(entry.file.type)) throw new Error('Use a JPEG, PNG, or PDF document.');
        const safeName = entry.file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100) || 'document';
        const path = `${auth.user.id}/${submissionId}/${entry.kind}/${safeName}`;
        const { error } = await client.storage.from('kyc-documents').upload(path, entry.file, {
          contentType: entry.file.type,
          upsert: false
        });
        fail(error);
        uploaded.push(path);
      }

      const socialLinks = {};
      for (const [code] of [['tt'], ['ig'], ['fb'], ['wa'], ['ot']]) {
        const enabled = values.fields['s_' + code];
        const url = String(values.fields['l_' + code] || '').trim();
        if (enabled && url) socialLinks[code] = url;
      }

      const payload = {
        id: submissionId,
        seller_id: auth.user.id,
        entity_type: personal ? 'personal' : 'corporate',
        legal_name: String(personal ? values.fields.a : values.fields.rn).trim(),
        business_name: personal ? null : String(values.fields.a).trim(),
        business_type: personal ? null : String(values.fields.bt || '').trim(),
        registration_number: personal ? null : String(values.fields.b || '').trim(),
        region: personal ? null : String(values.fields.rg || '').trim(),
        id_type: personal ? String(values.fields.it || 'NIDA National ID') : 'Representative ID',
        id_last4: String(personal ? values.fields.b : values.fields.rid).replace(/\s/g, '').slice(-4),
        tax_id_last4: String(personal ? values.fields.c : values.fields.c).replace(/\s/g, '').slice(-4),
        representative_role: personal ? null : String(values.fields.rp || '').trim(),
        social_links: socialLinks,
        document_paths: uploaded,
        attested_at: new Date().toISOString()
      };
      const { data, error } = await client.from('seller_kyc_submissions').insert(payload)
        .select('id,status,submitted_at').single();
      fail(error);
      return { ...data, seller };
    } catch (error) {
      if (uploaded.length) await client.storage.from('kyc-documents').remove(uploaded).catch(() => {});
      throw error;
    }
  }

  async function getMyKycStatus() {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) return null;
    const { data: seller, error: sellerError } = await client.from('seller_profiles')
      .select('kobe_id,verification_status').eq('user_id', auth.user.id).maybeSingle();
    fail(sellerError);
    if (!seller) return null;
    const { data: submission, error: submissionError } = await client.from('seller_kyc_submissions')
      .select('entity_type,id_last4,status,review_note,submitted_at,reviewed_at')
      .eq('seller_id', auth.user.id).order('submitted_at', { ascending: false }).limit(1).maybeSingle();
    fail(submissionError);
    return { seller, submission };
  }

  const api = {
    signUpBuyer: form => signUp('buyer', form),
    signUpSeller: form => signUp('seller', form),
    signIn,
    signOut,
    signInWithGoogle: async () => {
      const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl('Kobe_Mweusi_homepage_v7_static.html#signin') } });
      fail(error);
    },
    resendConfirmationEmail,
    resetPassword: async ({ email }) => {
      const { error } = await client.auth.resetPasswordForEmail(String(email || '').trim().toLowerCase(), { redirectTo: appUrl('reset-password.html') });
      fail(error);
    },
     updatePassword: async password => {
       const { error } = await client.auth.updateUser({ password });
       fail(error);
     },
    changePassword: async ({ current, password }) => {
      const { error: verifyError } = await client.auth.signInWithPassword({
        email: (await client.auth.getUser()).data.user?.email || '',
        password: current
      });
      if (verifyError) throw new Error('Current password is incorrect.');
      const { error } = await client.auth.updateUser({ password });
      fail(error);
    },
    /* Set or change the transaction PIN. The server decides which it is:
       a current PIN is required only when one is already set, and a
       wrong one counts towards the lockout. */
    setTransactionPin: async ({ current, pin } = {}) => {
      return invoke('security', { action: 'set-pin', current: current || '', new: pin || '' });
    },
    /* Reset a forgotten PIN. Needs the password, and a phone code the
       server can see was confirmed. */
    resetTransactionPin: async ({ password, pin } = {}) => {
      return invoke('security', { action: 'pin-reset', password: password || '', new_pin: pin || '' });
    },
    signOutAll: async () => {
      const { error } = await client.auth.signOut({ scope: 'global' });
      fail(error);
    },
    exportData: async () => {
      return invoke('user', { action: 'export' });
    },
  };

  /* ================================================================
     Edge Function adapters. Every money-moving operation (top-up,
     escrow funding, release, withdrawal) stays an honest refusal
     until the payment provider is connected. Everything else talks
     to the real backend. These methods speak the same contract as
     the app stubs: reads resolve with safe defaults and surface
     errors through window.kobeError; writes return {ok, reason}.
     ================================================================ */

  async function invoke(name, body) {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      let message = error.message || 'Request failed';
      /* A non-2xx response still carries a body. Keeping it lets the app
         react to a specific reason, for example a wallet that is short
         for the purchase, instead of only showing a generic message.

         The client hands back the Response itself, so the body has to be
         read from it. Without this the server's own wording is lost and
         every refusal looks like an outage. */
      let payload = null;
      const context = error.context;
      if (context && typeof context.json === 'function') {
        try {
          const parsed = await context.json();
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
        } catch (e) { /* the body was not json */ }
      } else if (typeof context === 'string') {
        try {
          const parsed = JSON.parse(context);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
        } catch (e) { /* not JSON */ }
      }
      if (!payload) {
        try {
          const parsed = JSON.parse(message);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
        } catch (e) { /* not JSON */ }
      }
      if (payload && payload.error) message = payload.error;
      if (/fetch|network|offline|failed to fetch/i.test(message)) {
        message = 'Backend service is not available. Please try again later.';
      }
      if (/edge function/i.test(message)) {
        message = 'Backend service is not available. Please try again later.';
      }
      if (payload) {
        return Object.assign({ ok: false, error: message }, payload, { error: message });
      }
      throw new Error(message);
    }
    return data;
  }

  async function guardedRead(name, body, fallback) {
    try {
      return await invoke(name, body);
    } catch (error) {
      return fallback;
    }
  }

  /* Writes: resolve with {ok:false, reason} like the app stubs did.
     All errors return a user-friendly reason; no technical errors leak. */
  async function guardedWrite(name, body) {
    try {
      return await invoke(name, body);
    } catch (error) {
      return { ok: false, reason: 'Backend service is not available right now. Please try again later.' };
    }
  }

  function dataUrlToBlob(dataUrl) {
    const [meta, b64] = String(dataUrl).split(',');
    const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  Object.assign(api, {
    /* -------- orders -------- */
    async listOrders() {
      const res = await guardedRead('orders', { action: 'list', role: 'buyer' }, null);
      return (res && res.orders) || [];
    },
    /* Create an order and fund it from the wallet.

       The amount is never sent. The server reads the price from the
       product row, applies the fee and checks the wallet balance, so a
       tampered client cannot change what is charged. */
    async createOrder({ product_id, quantity = 1, note, source, live_session_id, idempotencyKey } = {}) {
      return guardedWrite('orders', {
        action: 'create',
        product_id,
        quantity: Number(quantity) || 1,
        note: note || null,
        source: source || 'store',
        live_session_id: live_session_id || null,
        idempotencyKey: idempotencyKey || ('ord:' + String(product_id || '') + ':' + Date.now()),
      });
    },
    async lookupOrder(ref) {
      const res = await guardedWrite('orders', { action: 'lookup', ref });
      return res && res.ok ? res.order : null;
    },
    async cancelOrder(ref) {
      return guardedWrite('orders', { action: 'cancel', ref });
    },

    /* -------- wallet top-up -------- */
    /* The buyer tops up through the payment provider. The money then
       sits in the wallet and pays for later purchases. */
    async topUp({ amount, phone, operator } = {}) {
      return guardedWrite('payments', {
        action: 'topup',
        amount_tzs: Math.round(Number(amount) || 0),
        phone: phone || null,
        operator: operator || null,
      });
    },

    /* -------- disputes -------- */
    async listDisputes() {
      const res = await guardedRead('disputes', { action: 'list' }, null);
      return (res && res.disputes) || [];
    },
    async getDispute(ref) {
      const res = await guardedWrite('disputes', { action: 'get', dispute_ref: ref });
      return res && res.ok ? res.dispute : null;
    },
    async fileDispute({ orderId, reason, description, evidence }) {
      const created = await guardedWrite('disputes', {
        action: 'open',
        order_ref: orderId,
        reason,
        description,
      });
      if (!created || !created.ok) return created || { ok: false, reason: 'Could not open the dispute.' };
      const disputeId = created.dispute && created.dispute.disputeId;
      const disputeRef = created.dispute && created.dispute.id;
      if (evidence && evidence.length && disputeId) {
        const paths = [];
        for (const file of evidence) {
          try {
            const safe = String((file && file.name) || 'evidence')
              .replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80);
            const path = `${disputeId}/${stateUserId()}/${crypto.randomUUID()}-${safe}`;
            const blob = file instanceof File ? file : dataUrlToBlob(file);
            const { error } = await client.storage.from('dispute-evidence').upload(path, blob, {
              cacheControl: '3600',
              upsert: false,
            });
            if (error) throw new Error(error.message);
            paths.push(path);
          } catch (e) { /* one bad file must not block the dispute */ }
        }
        if (paths.length) {
          await invoke('disputes', { action: 'evidence', dispute_ref: disputeRef, paths });
        }
      }
      return { ok: true, dispute: created.dispute };
    },
    async addDisputeMessage({ disputeId, text }) {
      return guardedWrite('disputes', { action: 'reply', dispute_ref: disputeId, text });
    },
    async uploadDisputeEvidence(disputeId, files) {
      const paths = [];
      for (const file of files || []) {
        const dataUrl = typeof file === 'string' ? file : (file && file.dataUrl) || null;
        const blob = file instanceof File ? file : dataUrlToBlob(dataUrl);
        const safe = String((file && file.name) || 'evidence')
          .replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80);
        const path = `${disputeId}/${stateUserId()}/${crypto.randomUUID()}-${safe}`;
        const { error } = await client.storage.from('dispute-evidence').upload(path, blob, {
          cacheControl: '3600',
          upsert: false,
        });
        if (error) throw new Error(error.message);
        paths.push(path);
      }
      return paths;
    },

    /* -------- handoff -------- */
    /* The codes the server issued for an order, keyed by order reference.
       Only a server-issued code is ever rendered into a QR, so a QR can
       never carry a raw transaction id. */
    async handoffIssue(orderRef) {
      const res = await guardedWrite('handoff', { action: 'issue', order_ref: orderRef });
      if (res && res.ok !== false && orderRef) handoffTokens[orderRef] = res;
      return res;
    },
    async verifyHandoffCode({ code }) {
      return guardedWrite('handoff', { action: 'verify', code });
    },
    handoffCodeSvg(txId) {
      const issued = handoffTokens[txId];
      const seed = issued && issued.buyer_code ? issued.buyer_code : txId;
      if (typeof window.generateQrSvg === 'function') return window.generateQrSvg(seed);
      return '';
    },

    /* -------- escrow -------- */
    /* The release decision belongs to the server. The app never computes
       the countdown itself and never assumes a release happened. */
    async escrowTimers() {
      const res = await guardedRead('escrow', { action: 'status' }, null);
      return (res && res.timers) || [];
    },
    async escrowDecision(orderId) {
      const res = await guardedRead('escrow', { action: 'evaluate', order_id: orderId }, null);
      return (res && res.decision) || null;
    },
    /* The buyer confirms the goods arrived. The server decides whether
       that releases the escrow. */
    async confirmReceipt(orderId) {
      return guardedWrite('escrow', { action: 'confirm', order_id: orderId });
    },
    async requestEscrowRelease(orderId) {
      return guardedWrite('escrow', { action: 'release', order_id: orderId });
    },

    /* -------- payments -------- */
    async paymentIntent(orderRef) {
      return guardedWrite('payments', { action: 'intent', order_ref: orderRef });
    },
    async paymentStatus(orderRef) {
      const res = await guardedRead('payments', { action: 'status', order_ref: orderRef }, null);
      return res && res.ok ? res : null;
    },

    /* -------- identifiers -------- */
    /* The buyer's own Wallet ID. The server decides whether it may be
       revealed at all. */
    async myWalletId() {
      const res = await guardedRead('escrow', { action: 'wallet' }, null);
      return (res && res.wallet_id) || null;
    },

    /* -------- chat -------- */
    async chatThreads() {
      const res = await guardedRead('chat', { action: 'threads' }, null);
      return (res && res.threads) || [];
    },
    async chatThread(withUserId) {
      const res = await guardedRead('chat', { action: 'thread', with: withUserId }, null);
      return res && res.ok ? res : null;
    },
    async sendChatMessage({ with: withUserId, text }) {
      return guardedWrite('chat', { action: 'send', with: withUserId, text });
    },
    async markChatRead(withUserId) {
      return guardedWrite('chat', { action: 'read', with: withUserId });
    },

    /* -------- reviews -------- */
    async submitReview({ txId, stars, tags, comment }) {
      return guardedWrite('reviews', { action: 'submit', order_ref: txId, stars, tags, comment });
    },
    async sellerReviews(kobeId) {
      const res = await guardedRead('reviews', { action: 'seller', kobe_id: kobeId }, null);
      return res && res.ok ? res : { reviews: [], average: 0, count: 0 };
    },

    /* -------- wallet / seller -------- */
    async walletSummary() {
      const res = await guardedRead('wallet', { action: 'summary' }, null);
      return res && res.ok ? res : null;
    },

    /* Request a withdrawal of money that has already been released from
       escrow. The server decides what is available; the client only
       states the amount it wants. */
    async requestPayout({ amount, phone, operator } = {}) {
      return guardedWrite('wallet', {
        action: 'withdraw',
        amount_tzs: Math.round(Number(amount) || 0),
        method: 'mobile_money',
        destination: phone ? String(phone) : null,
        operator: operator || null,
        idempotency_key: `payout:${Date.now()}`,
      });
    },
    async myPayouts() {
      const res = await guardedRead('wallet', { action: 'payouts' }, null);
      return (res && res.payouts) || [];
    },
    async payoutCapacity() {
      const res = await guardedRead('wallet', { action: 'payouts' }, null);
      return (res && res.capacity) || null;
    },
    /* Staff only. */
    async pendingPayouts() {
      const res = await guardedRead('seller', { action: 'payouts' }, null);
      return (res && res.payouts) || [];
    },
    async approvePayout(payoutId, providerReference) {
      return guardedWrite('seller', {
        action: 'approve-payout',
        payout_id: payoutId,
        provider_reference: providerReference || null,
      });
    },
    async sellerOverview() {
      const res = await guardedRead('seller', { action: 'overview' }, null);
      return res && res.ok ? res.overview : null;
    },
    async sellerDirectory(q) {
      const res = await guardedRead('seller', { action: 'directory', q: q || '' }, null);
      return (res && res.sellers) || [];
    },
    async sellerActivity(before) {
      const res = await guardedRead('seller', { action: 'activity', before: before || undefined }, null);
      return (res && res.activity) || [];
    },

    /* Confirm the account's phone number. Supabase Auth owns the code;
       the server records the confirmation only after Auth confirms it. */
    async verifyPhone() {
      return guardedWrite('security', { action: 'verify-phone' });
    },
    async phoneStatus() {
      return guardedRead('security', { action: 'phone-status' }, null);
    },

    /* Sandbox top-up. Only works while the payment provider is
       configured for the sandbox, so it cannot run in production. */
    async sandboxTopUp({ amount, note } = {}) {
      return guardedWrite('payments', {
        action: 'sandbox-topup',
        amount_tzs: Math.round(Number(amount) || 0),
        note: note || null,
      });
    },

    /* -------- seller catalogue, live sessions, verification -------- */

    /* The verification status and the live session controls are
       standalone functions, so they are exposed here as well. Without
       this the apps would call KobeApi.getMyKycStatus() and get a
       TypeError, because the name is not on the api object. */
    getMyKycStatus: () => getMyKycStatus(),
    endLiveSession: id => endLiveSession(id),
    listPublicProducts: sellerId => listPublicProducts(sellerId),
    listOwnProducts: () => listOwnProducts(),
    saveProduct: values => saveProduct(values),
    listPublicLiveSessions: () => listPublicLiveSessions(),
    listOwnLiveSessions: () => listOwnLiveSessions(),
    saveLiveSession: values => saveLiveSession(values),
    submitKyc: values => submitKyc(values),
    saveSellerProfile: values => saveSellerProfile(values),
    ensureSellerProfile: () => ensureSellerProfile(),

    /* The seller's orders, in the shape the seller app renders:
       { id, who, ph, item, q, u, amt, fee, total, dt, s, d, disputeId }. */
    async listSellerOrders() {
      const res = await guardedRead('orders', { action: 'list', role: 'seller' }, null);
      return (res && res.orders) || [];
    },

    /* The seller's catalogue, in the shape the seller app renders:
       { id, n, d, p, s, v, img }. */
    async sellerProducts() {
      let rows = [];
      try {
        rows = await listOwnProducts();
      } catch (error) {
        console.error('Could not load the catalogue:', error);
        return [];
      }
      return rows.map(row => ({
        id: row.id,
        n: row.name,
        d: row.description || '',
        p: Number(row.price_tzs || 0),
        s: Number(row.stock_quantity || 0),
        v: row.status === 'active' ? 1 : 0,
        img: row.image_path || '',
      }));
    },

    /* Save a catalogue item. The photo may be a data URL, in which case it
       is uploaded to the shop media bucket first and only the path is
       stored. The seller id and the price are never taken from the page. */
    async saveSellerProduct({ id, n, d, p, s, v, img } = {}) {
      let imagePath = null;
      if (typeof img === 'string' && img.startsWith('data:')) {
        imagePath = await api.uploadShopMedia({ dataUrl: img, name: 'product.jpg' });
      } else if (typeof img === 'string' && img) {
        imagePath = img;
      }
      const row = await api.saveProduct({
        id: id || null,
        name: n,
        description: d || '',
        price_tzs: Number(p || 0),
        stock_quantity: Number(s || 0),
        status: v ? 'active' : 'draft',
        image_path: imagePath,
      });
      return {
        id: row.id,
        n: row.name,
        d: row.description || '',
        p: Number(row.price_tzs || 0),
        s: Number(row.stock_quantity || 0),
        v: row.status === 'active' ? 1 : 0,
        img: row.image_path || '',
      };
    },

    /* The seller's live sessions, in the shape the seller app renders:
       { id, t, d, plat, url, status, start, endAt, pin, products }. */
    async sellerLiveSessions() {
      let rows = [];
      try {
        rows = await listOwnLiveSessions();
      } catch (error) {
        console.error('Could not load the live sessions:', error);
        return [];
      }
      return rows.map(row => ({
        id: row.id,
        t: row.title,
        d: row.description || '',
        plat: row.platform,
        url: row.externalUrl || '',
        status: row.status,
        start: row.endAt ? new Date(row.endAt).getTime() - 3600000 : Date.now(),
        endAt: row.endAt,
        pin: row.products.findIndex(p => p.pinned),
        products: row.products.map(p => ({
          id: p.id,
          n: p.name,
          p: Number(p.price || 0),
          s: Number(p.stock || 0),
          sold: 0,
          shown: 1,
          img: '',
        })),
      }));
    },

    /* Start or update a live session. */
    async saveSellerLiveSession({ id, t, d, plat, url, status, starts_at, ends_at, product_ids } = {}) {
      const row = await api.saveLiveSession({
        id: id || null,
        title: t,
        description: d || '',
        platform: plat || 'tiktok',
        external_url: url || '',
        status: status || 'scheduled',
        starts_at: starts_at || null,
        ends_at: ends_at || null,
        product_ids: product_ids || [],
      });
      return row;
    },

    /* The seller's verification state, in the shape the app renders:
       kyc 0 = not started, 1 = in review, 2 = verified. */
    async sellerVerification() {
      const status = await getMyKycStatus();
      if (!status) return { kyc: 0, ver: { type: '', idLast: '', sub: 0, rev: 0, app: 0, seen: false }, note: '' };
      const seller = status.seller || {};
      const submission = status.submission || null;
      const verified = seller.verification_status === 'verified';
      const inReview = !!submission && (submission.status === 'pending' || submission.status === 'under_review');
      const rejected = !!submission && submission.status === 'rejected';
      return {
        kyc: verified ? 2 : inReview || rejected ? 1 : 0,
        ver: {
          type: submission ? (submission.entity_type === 'personal' ? 'Personal' : 'Corporate') : '',
          idLast: submission && submission.id_last4 ? submission.id_last4 : '',
          sub: submission && submission.submitted_at ? new Date(submission.submitted_at).getTime() : 0,
          rev: submission && submission.reviewed_at ? new Date(submission.reviewed_at).getTime() : 0,
          app: verified ? 1 : 0,
          seen: !!submission,
          rejected,
        },
        note: rejected && submission.review_note ? submission.review_note : '',
        kobeId: seller.kobe_id || '',
        verificationStatus: seller.verification_status || 'unverified',
      };
    },

    /* -------- security -------- */
    async pinSet(pin) {
      return guardedWrite('security', { action: 'pin-set', new_pin: pin });
    },
    async pinChange(oldPin, newPin) {
      return guardedWrite('security', { action: 'pin-change', old_pin: oldPin, new_pin: newPin });
    },
    /* The PIN check goes through the locked path, so five wrong attempts
       lock it. The response says whether it is locked and for how
       long, so the page can say so rather than "wrong PIN". */
    async pinVerify(pin) {
      return guardedWrite('security', { action: 'pin-verify', pin });
    },
    async pinStatus() {
      const res = await guardedWrite('security', { action: 'pin-status' });
      return res && res.ok ? res : { ok: true, hasPin: false, locked_until: null };
    },
    async passwordChange(oldPassword, newPassword) {
      return guardedWrite('security', { action: 'password-change', old_password: oldPassword, new_password: newPassword });
    },

    /* -------- seller profile (full row) -------- */
    async sellerProfile() {
      const { data: auth, error: authError } = await client.auth.getUser();
      fail(authError);
      if (!auth.user) throw new Error('Sign in as a seller.');
      const { data, error } = await client
        .from('seller_profiles')
        .select('*, kobe_id_registry(kobe_id)')
        .eq('user_id', auth.user.id)
        .maybeSingle();
      fail(error);
      if (!data) return data;

      /* The canonical Seller Kobe ID is what a customer reads. The
         app-facing id stays as a fallback so nothing breaks for a seller
         whose registry row has not been created yet. */
      const registry = Array.isArray(data.kobe_id_registry)
        ? data.kobe_id_registry[0]
        : data.kobe_id_registry;
      return Object.assign({}, data, {
        kobe_id: (registry && registry.kobe_id) || data.kobe_id,
        app_kobe_id: data.kobe_id,
      });
    },

    /* Resolve a seller ID in either format to the canonical one. The
       customer may have the KOBE12XL code, the older app-facing id, or
       a public live link that contains either. */
    async resolveSellerId(code) {
      const raw = String(code || '').trim();
      if (!raw) return null;
      const { data, error } = await client.rpc('public_seller_identity_by_kid', {
        p_kid: raw,
      });
      if (error) {
        /* The function may not be deployed yet; fall back to what the
           caller already has rather than failing the lookup. */
        return null;
      }
      return Array.isArray(data) ? data[0] ?? null : data ?? null;
    },
    async saveShopDetails({ shopName, bio, region, publicContact, hours, delivery, socials, avatarPath, coverPath }) {
      const { data: auth, error: authError } = await client.auth.getUser();
      fail(authError);
      if (!auth.user) throw new Error('Sign in as a seller.');

      /* A verified seller's public details are locked: they were part of
         what the review checked. The update below only matches a pending
         seller, so a verified seller would otherwise be told nothing and
         believe the change had been saved. Say so plainly instead. */
      const { data: seller, error: sellerError } = await client
        .from('seller_profiles')
        .select('verification_status')
        .eq('user_id', auth.user.id)
        .maybeSingle();
      fail(sellerError);
      if (!seller) throw new Error('Your shop is not set up yet.');
      if (seller.verification_status === 'verified') {
        throw new Error('Your shop details are locked because your seller account is verified. Send a change request and support will update them for you.');
      }

      const payload = {};
      if (shopName !== undefined) payload.shop_name = String(shopName).slice(0, 120);
      if (bio !== undefined) payload.bio = String(bio).slice(0, 2000);
      if (region !== undefined) payload.region = String(region).slice(0, 100);
      if (publicContact !== undefined) payload.public_contact = publicContact;
      if (hours !== undefined || delivery !== undefined) {
        payload.details = { hours: hours || null, delivery: delivery || null };
      }
      if (socials !== undefined) payload.socials = socials;
      if (avatarPath !== undefined) payload.avatar_path = avatarPath;
      if (coverPath !== undefined) payload.cover_path = coverPath;
      const { data, error } = await client
        .from('seller_profiles')
        .update(payload)
        .eq('user_id', auth.user.id)
        .eq('verification_status', 'pending')
        .select('shop_slug')
        .maybeSingle();
      fail(error);
      return data;
    },
    async shopMediaUrl(path) {
      if (!path) return '';
      return client.storage.from('shop-media').getPublicUrl(path).data.publicUrl;
    },

     /* -------- own profile --------
        The profiles RLS policy grants update on (display_name, phone_e164)
        only, so those two are the only columns sent. account_type, id and
        created_at are untouched and stay server owned. email is read-only
        from auth.users and included for display only. */
     async getMyProfile() {
       const { data: auth, error: authError } = await client.auth.getUser();
       fail(authError);
       if (!auth.user) throw new Error('Sign in to view your profile.');
       const { data, error } = await client
         .from('profiles')
    .select('id, account_type, display_name, phone_e164, phone_verified_at, created_at')
         .eq('id', auth.user.id)
         .maybeSingle();
       fail(error);
       if (data) return { ...data, email: auth.user.email || auth.user.primary_factors || null };
       /* A row is created by the signup trigger; a missing one means the
          account predates it, so build it from the auth user instead of
          inventing data. */
       return {
         id: auth.user.id,
         account_type: auth.user.user_metadata && auth.user.user_metadata.account_type,
         display_name: null,
         phone_e164: null,
         email: auth.user.email || null,
         created_at: auth.user.created_at,
       };
    },
    async saveMyProfile({ displayName, phoneE164, avatarPath } = {}) {
      const { data: auth, error: authError } = await client.auth.getUser();
      fail(authError);
      if (!auth.user) throw new Error('Sign in to edit your profile.');

      const name = String(displayName == null ? '' : displayName).trim();
      if (name.length < 2 || name.length > 100) throw new Error('Name must be 2 to 100 characters.');
      if (/[\r\n\t]/.test(name)) throw new Error('Name cannot contain tabs or line breaks.');

      const phone = String(phoneE164 == null ? '' : phoneE164).trim();
      if (phone && !/^\+[1-9][0-9]{7,14}$/.test(phone)) {
        throw new Error('Phone must be in international format, for example +255712345678.');
      }

      /* Only the columns the RLS grants are sent. account_type, id and
         created_at stay server owned. */
      const payload = { display_name: name, phone_e164: phone || null };
      if (avatarPath !== undefined && avatarPath !== null && avatarPath !== '') {
        payload.avatar_path = String(avatarPath).slice(0, 400);
      }

      const { data, error } = await client
        .from('profiles')
        .update(payload)
        .eq('id', auth.user.id)
        .select('id, account_type, display_name, phone_e164, phone_verified_at, avatar_path, created_at')
        .maybeSingle();
      fail(error);
      /* Empty result with no error means RLS hid the row, which for a
         profile row means the session changed. Never report success. */
      if (!data) throw new Error('Could not save your profile. Please sign in again.');
      return data;
    },

    /* -------- support requests -------- */
    async supportRequest({ topic, current, proposed, reason }) {
      const { data: auth, error: authError } = await client.auth.getUser();
      fail(authError);
      if (!auth.user) throw new Error('Sign in to send a request.');
      const { error } = await client.from('support_requests').insert({
        user_id: auth.user.id,
        topic: String(topic).slice(0, 100),
        current_info: current ? String(current).slice(0, 2000) : null,
        proposed: String(proposed).slice(1, 2000),
        reason: reason ? String(reason).slice(0, 2000) : null,
      });
      fail(error);
      return { ok: true };
    },

    /* -------- delivery agent hub --------
       The agent workspace used to keep its own password in localStorage
       and record scans in an array, so a scan never reached the server
       and the seller was never told. The agent now signs in like every
       other account, and the server decides whether the account is an
       agent at all. */
    async agentSignIn({ email, password } = {}) {
      const address = String(email || '').trim().toLowerCase();
      if (!address) throw new Error('Enter the email Kobe Mweusi operations gave you.');
      if (!password) throw new Error('Enter your password.');
      const { data, error } = await client.auth.signInWithPassword({ email: address, password });
      if (error) throw new Error('That email and password do not match an agent account.');
      const user = data.user;
      if (!user.email_confirmed_at) {
        await client.auth.signOut();
        throw new Error('Your email is not confirmed yet. Check your inbox for the verification link.');
      }
      /* The hub only opens for an account the server calls an agent. A
         backend that is merely unavailable is not the same thing as a
         refusal, so the session is only dropped on a real refusal. */
      const snapshot = await api.agentSnapshot();
      if (!snapshot || snapshot.ok === false) {
        const message = (snapshot && (snapshot.error || snapshot.reason)) || 'This account is not a delivery agent.';
        if (!/not a delivery agent/i.test(message)) return { ok: false, error: message };
        await client.auth.signOut();
        throw new Error(message);
      }
      return snapshot;
    },
    async agentSignOut() {
      const { error } = await client.auth.signOut();
      fail(error);
    },
    async agentSnapshot() {
      return guardedWrite('agent', { action: 'snapshot' });
    },
    /* A scan is recorded by the server. The page never decides whether
       a code is good or whether the money moved. */
    async agentScan(code) {
      return guardedWrite('agent', { action: 'scan', code: String(code || '').trim() });
    },

    /* -------- notifications -------- */
    /* The durable inbox, read through the view that only ever shows the
       signed-in user's own rows. */
    async listNotifications(limit = 60) {
      const { data, error } = await client
        .from('my_notifications')
        .select('id,title,body,link,category,kind,priority,read_at,created_at')
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 60, 200)));
      fail(error);
      return data || [];
    },

    /* -------- push -------- */
    async pushConfig() {
      return invoke('push', { action: 'config' });
    },
    async pushSubscribe(subscription) {
      return guardedWrite('push', { action: 'subscribe', subscription });
    },
    async pushUnsubscribe(endpoint) {
      return guardedWrite('push', { action: 'unsubscribe', endpoint });
    },

    /* -------- shop media -------- */
    async uploadShopMedia(file) {
      const { data: auth, error: authError } = await client.auth.getUser();
      fail(authError);
      if (!auth.user) throw new Error('Sign in to upload images.');
      const safe = String((file && file.name) || 'image')
        .replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80);
      const path = `${auth.user.id}/${crypto.randomUUID()}-${safe}`;
      const dataUrl = typeof file === 'string' ? file : (file && file.dataUrl) || null;
      const blob = file instanceof File ? file : dataUrlToBlob(dataUrl);
      const { error } = await client.storage.from('shop-media').upload(path, blob, {
        cacheControl: '3600',
        upsert: false,
      });
      fail(error);
      return path;
    },

    /* The profile photo. It lives in the profile-avatars bucket so it
       follows the account to another device, rather than living in this
       browser's local storage. */
    async uploadAvatar(dataUrl) {
      const { data: auth, error: authError } = await client.auth.getUser();
      fail(authError);
      if (!auth.user) throw new Error('Sign in to upload a photo.');
      const path = `${auth.user.id}/${crypto.randomUUID()}.jpg`;
      const blob = dataUrlToBlob(dataUrl);
      const { error } = await client.storage.from('profile-avatars').upload(path, blob, {
        cacheControl: '3600',
        upsert: false,
      });
      fail(error);
      return path;
    },
    async avatarUrl(path) {
      if (!path) return '';
      return client.storage.from('profile-avatars').getPublicUrl(path).data.publicUrl;
    },
  });

  function stateUserId() {
    let id = null;
    try {
      const session = client.auth.getSession();
      id = session && session.data && session.data.session ? session.data.session.user.id : null;
    } catch (e) { /* session not loaded yet */ }
    return id || 'unknown';
  }

  /* Push plumbing: the apps expose window.kobePushConfig and expect
     the backend to call it with the VAPID key and save/remove hooks. */
  async function setupPush() {
    try {
      const config = await api.pushConfig();
      if (config && config.ok && typeof window.kobePushConfig === 'function') {
        window.kobePushConfig({
          vapidPublicKey: config.vapidPublicKey || '',
          onSubscribe: subscription => api.pushSubscribe(subscription),
          onUnsubscribe: subscription => api.pushUnsubscribe(subscription && subscription.endpoint),
        });
      }
    } catch (e) { /* push is optional until VAPID keys are set */ }
  }

  /* Realtime is best-effort: it only delivers events once the tables
     are added to the Supabase Realtime publication. */
  function setupRealtime(state) {
    try {
      const userId = state.profile.id;
      const notify = (() => {
        let timer = 0;
        return () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            window.dispatchEvent(new CustomEvent('kobe:refresh', { detail: { reason: 'realtime' } }));
            if (typeof window.kobeRefresh === 'function') window.kobeRefresh('realtime');
          }, 700);
        };
      })();
      const channel = client.channel('kobe-private-' + userId);
      channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders',
          filter: `or(buyer_id=eq.${userId},seller_id=eq.${userId})` }, notify)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages',
          filter: `thread_buyer=eq.${userId}` }, notify)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages',
          filter: `thread_seller=eq.${userId}` }, notify)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'disputes',
          filter: `opened_by=eq.${userId}` }, notify)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'wallet_ledger_entries',
          filter: `user_id=eq.${userId}` }, notify)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_events',
          filter: `user_id=eq.${userId}` }, notify)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications',
          filter: `user_id=eq.${userId}` }, notify)
        .subscribe();
    } catch (e) { /* realtime is optional */ }
  }

  window.KobeSupabase = {
    client,
    api,
    getSessionProfile,
    ensureSellerProfile,
    saveSellerProfile,
    listPublicProducts,
    saveProduct,
    listOwnProducts,
    saveLiveSession,
    listPublicLiveSessions,
    listOwnLiveSessions,
    endLiveSession,
    submitKyc,
    getMyKycStatus,
    invoke,
    dataUrlToBlob,
  };
  window.KobeBackend = api;
  window.KobeApi = api;

  /* The buyer page ships a preview API as a fallback for when the
     backend has not loaded. The real boundary REPLACES it rather than
     being merged into it: a merge would let a preview method and a
     real method collide, and which one answered would depend on load
     order. A method that exists only in the preview must never be
     reachable by accident. */
  try {
    if (typeof KobeApi !== 'undefined' && KobeApi && typeof KobeApi === 'object') {
      KobeApi = api;
    }
  } catch (e) {
    /* No preview API on this page, or the binding is not assignable. */
  }

  /* Let the page install its request guards on the real boundary, so the
     double-tap and timeout protection applies to the real methods and
     not only to the preview. */
  try {
    if (typeof window.kobeWrapApi === 'function') window.kobeWrapApi(api);
  } catch (e) {
    /* The guard is optional. */
  }

  window.kobeLogout = signOut;

  const page = location.pathname.split('/').pop();
  const expectedRole = page === 'seller.html' ? 'seller' : page === 'buyer.html' ? 'buyer' : null;
  if (expectedRole) {
    getSessionProfile().then(async state => {
      if (!state) {
        location.replace(appUrl('Kobe_Mweusi_homepage_v7_static.html#signin'));
        return;
      }
      if (state.profile.account_type !== expectedRole) {
        location.replace(appUrl(state.profile.account_type === 'seller' ? 'seller.html' : 'buyer.html'));
        return;
      }
      if (expectedRole === 'seller') await ensureSellerProfile();
      window.dispatchEvent(new CustomEvent('kobe:auth-ready', { detail: state }));
      setupPush();
      setupRealtime(state);
    }).catch(() => location.replace(appUrl('Kobe_Mweusi_homepage_v7_static.html#signin')));
  } else if (page === 'Kobe_Mweusi_homepage_v7_static.html' || page === '' || page === 'index.html') {
    getSessionProfile().then(state => {
      if (state) location.replace(appUrl(state.profile.account_type === 'seller' ? 'seller.html' : 'buyer.html'));
    }).catch(() => {});
  }
})();