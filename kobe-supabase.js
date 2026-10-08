(function () {
  const client = window.supabase.createClient(
    'https://arnbsijvnxnoqybumkys.supabase.co',
    'sb_publishable_PDZh59CJskfn0O6_Rme8xw_MXoprn0v',
    { auth: { autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', persistSession: true } }
  );

  const appUrl = file => new URL(file, location.origin).toString();
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
    const { error } = await client.auth.signInWithPassword({ email: String(email || '').trim().toLowerCase(), password: pass });
    fail(error);
    return enterApp(role);
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
    return {
      id: session.id,
      status: session.status,
      sellerVerified: session.seller_profiles.verification_status === 'verified',
      sellerName: session.seller_profiles.shop_name,
      sellerKid: session.seller_profiles.kobe_id,
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
      .select('id,seller_id,title,description,platform,external_url,status,starts_at,ends_at,seller_profiles!inner(shop_name,kobe_id,verification_status),live_session_products(sort_order,pinned,products(id,name,description,price_tzs,stock_quantity,image_path,status))')
      .eq('status', 'live').order('starts_at', { ascending: true });
    fail(error);
    return (data || []).map(mapLiveSession);
  }

  async function listOwnLiveSessions() {
    const { data: auth, error: authError } = await client.auth.getUser();
    fail(authError);
    if (!auth.user) throw new Error('Sign in as a seller to load your live listings.');
    const { data, error } = await client.from('live_sessions')
      .select('id,seller_id,title,description,platform,external_url,status,starts_at,ends_at,seller_profiles!inner(shop_name,kobe_id,verification_status),live_session_products(sort_order,pinned,products(id,name,description,price_tzs,stock_quantity,image_path,status))')
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
    resetPassword: async ({ email }) => {
      const { error } = await client.auth.resetPasswordForEmail(String(email || '').trim().toLowerCase(), { redirectTo: appUrl('reset-password.html') });
      fail(error);
    },
    updatePassword: async password => {
      const { error } = await client.auth.updateUser({ password });
      fail(error);
    }
  };

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
    getMyKycStatus
  };
  window.KobeApi = Object.assign(window.KobeApi || {}, api);
  window.kobeLogout = signOut;
  if (typeof KobeApi !== 'undefined') Object.assign(KobeApi, api);

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
    }).catch(() => location.replace(appUrl('Kobe_Mweusi_homepage_v7_static.html#signin')));
  } else if (page === 'Kobe_Mweusi_homepage_v7_static.html' || page === '' || page === 'index.html') {
    getSessionProfile().then(state => {
      if (state) location.replace(appUrl(state.profile.account_type === 'seller' ? 'seller.html' : 'buyer.html'));
    }).catch(() => {});
  }
})();