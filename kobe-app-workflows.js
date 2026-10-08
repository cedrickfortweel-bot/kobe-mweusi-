(function () {
  const page = location.pathname.split('/').pop();
  const toast = message => {
    if (typeof window.toast === 'function') window.toast(message);
    else if (typeof window.kobeToast === 'function') window.kobeToast(message);
  };
  const productFromRow = row => ({
    id: row.id,
    n: row.name,
    d: row.description || '',
    e: '📦',
    img: '',
    p: String(row.price_tzs),
    s: String(row.stock_quantity),
    v: row.status === 'active' ? 1 : 0
  });

  if (page === 'seller.html') {
    let sellerBoot = null;

    async function loadSellerData() {
      if (sellerBoot) return sellerBoot;
      sellerBoot = (async () => {
        const state = await window.KobeSupabase.getSessionProfile();
        if (!state || state.profile.account_type !== 'seller') return;
        const profile = await window.KobeSupabase.ensureSellerProfile();
        store.name = profile.shop_name;
        store.kid = profile.kobe_id;
        store.cat = profile.region || '';
        user.name = state.profile.display_name;
        user.first = state.profile.display_name.split(/\s+/)[0] || '';
        user.phone = state.profile.phone_e164 || '';
        const kycState = await window.KobeSupabase.getMyKycStatus();
        if (kycState) {
          const submission = kycState.submission;
          kyc = kycState.seller.verification_status === 'verified' ? 2
            : submission && ['pending', 'under_review'].includes(submission.status) ? 1 : 0;
          if (submission) {
            ver = {
              type: submission.entity_type === 'personal' ? 'Personal' : 'Corporate',
              idLast: submission.id_last4 || '',
              sub: submission.submitted_at ? new Date(submission.submitted_at).getTime() : 0,
              rev: submission.reviewed_at ? new Date(submission.reviewed_at).getTime() : 0,
              app: kycState.seller.verification_status === 'verified' && submission.reviewed_at
                ? new Date(submission.reviewed_at).getTime() : 0,
              seen: true,
              reviewNote: submission.review_note || ''
            };
          }
        }
        const products = await window.KobeSupabase.listOwnProducts();
        prods.splice(0, prods.length, ...products.map(productFromRow));
        const sessions = await window.KobeSupabase.listOwnLiveSessions();
        const active = sessions.find(session => session.status === 'live');
        if (active) {
          live = {
            id: active.id,
            t: active.title,
            tt: active.externalUrl,
            platform: active.platform,
            n: active.products.length,
            products: active.products.map(product => ({
              id: product.id,
              i: prods.findIndex(item => item.id === product.id),
              n: product.name,
              p: product.price,
              e: '📦',
              img: '',
              s: product.stock,
              sold: 0,
              shown: 1
            })),
            start: active.starts_at ? new Date(active.starts_at).getTime() : Date.now(),
            endAt: active.endAt || Date.now() + 3600000,
            pin: -1,
            feed: [],
            orders: 0,
            rev: 0,
            resv: []
          };
        }
        render();
        updateStreamButton();
      })().catch(error => {
        sellerBoot = null;
        toast(error.message || 'Could not load your shop data.');
      });
      return sellerBoot;
    }

    function updateStreamButton() {
      const button = document.querySelector('[onclick="lTT()"]');
      if (button && live) button.textContent = live.platform === 'youtube' ? 'Open YouTube live' : 'Open TikTok live';
    }

    window.addEventListener('kobe:auth-ready', loadSellerData);
    loadSellerData();

    window.pedit = function (index) {
      const current = index < 0 ? { id: null, n: '', d: '', p: '', s: '', v: 1 } : prods[index];
      if (!current) return;
      gform(index < 0 ? 'Add product' : 'Edit product', [
        { k: 'n', l: 'Product name', v: current.n },
        { k: 'd', l: 'Description', ta: 1, v: current.d || '' },
        { k: 'p', l: 'Price (TSh)', t: 'number', v: current.p },
        { k: 's', l: 'Stock available', t: 'number', v: current.s },
        { k: 'v', l: 'Show to buyers', tg: 1, v: current.v }
      ], async values => {
        if (!values.n) return 'Enter a product name.';
        if (num(values.p) < 1) return 'Enter a price.';
        if (num(values.s) < 0) return 'Stock cannot be negative.';
        const saved = await window.KobeSupabase.saveProduct({
          id: current.id,
          name: values.n,
          description: values.d,
          price_tzs: num(values.p),
          stock_quantity: num(values.s),
          status: values.v ? 'active' : 'draft'
        });
        const product = productFromRow(saved);
        if (index < 0) prods.push(product);
        else prods[index] = product;
        return '';
      }, index < 0 ? 'Add product' : 'Save changes', 'Product saved to your shop');
    };

    window.startLive = function () {
      const candidates = prods.map((product, index) => ({ product, index })).filter(row => row.product.id);
      if (!candidates.length) return toast('Save at least one product before publishing a live listing.');
      const durations = { '1 hour': 1, '3 hours': 3, '6 hours': 6, '12 hours': 12, '24 hours': 24 };
      gform('Publish a TikTok or YouTube live listing', [
        { k: 't', l: 'Session title', p: 'e.g. Today’s new arrivals' },
        { k: 'platform', l: 'Platform', o: ['TikTok', 'YouTube'] },
        { k: 'url', l: 'Public live link', p: 'https://www.tiktok.com/@you/live' },
        { k: 'len', l: 'Listing length', o: Object.keys(durations) }
      ].concat(candidates.map(({ product, index }) => ({ k: 'p' + index, l: product.n, tg: 1, v: product.v }))), async values => {
        if (!values.t) return 'Give the listing a title.';
        const platform = values.platform.toLowerCase();
        let url;
        try { url = new URL(values.url); } catch (error) { return 'Enter a valid HTTPS live link.'; }
        const host = url.hostname.toLowerCase();
        const validHost = platform === 'tiktok'
          ? host === 'tiktok.com' || host.endsWith('.tiktok.com')
          : host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
        if (url.protocol !== 'https:' || !validHost) return 'Use a public HTTPS link from the selected platform.';
        const selected = candidates.filter(({ index }) => values['p' + index]);
        if (!selected.length) return 'Feature at least one product.';
        const hours = durations[values.len] || 1;
        const startAt = new Date();
        const endAt = new Date(startAt.getTime() + hours * 3600000);
        const saved = await window.KobeSupabase.saveLiveSession({
          title: values.t,
          platform,
          external_url: url.toString(),
          status: 'live',
          starts_at: startAt.toISOString(),
          ends_at: endAt.toISOString(),
          product_ids: selected.map(({ product }) => product.id)
        });
        live = {
          id: saved.id,
          t: saved.title,
          tt: saved.external_url,
          platform: saved.platform,
          n: selected.length,
          products: selected.map(({ product, index }) => ({
            id: product.id, i: index, n: product.n, p: num(product.p), e: product.e,
            img: '', s: num(product.s), sold: 0, shown: 1
          })),
          start: startAt.getTime(),
          endAt: endAt.getTime(),
          pin: -1,
          feed: [],
          orders: 0,
          rev: 0,
          resv: []
        };
        liveNotes = [];
        render();
        updateStreamButton();
        return '';
      }, 'Publish listing', 'Live listing published');
    };

    window.lTT = function () {
      if (live && live.tt) window.open(live.tt, '_blank', 'noopener,noreferrer');
    };

    window.endLive = async function () {
      if (!live || live.status === 'ended') return;
      try {
        await window.KobeSupabase.endLiveSession(live.id);
        live.status = 'ended';
        live.endedAt = Date.now();
        render();
        toast('Live listing ended.');
      } catch (error) {
        toast(error.message || 'Could not end the live listing.');
      }
    };

    window.bvBuy = window.bvPay = function () {
      toast('In-app checkout and reservations are disabled until AzamPay is connected.');
    };
    window.lSale = function () {
      toast('Sales and stock changes require verified payment callbacks.');
    };
  }

  if (page === 'buyer.html') {
    window.kobeBuyerLiveBackend = true;
    let buyerBoot = null;

    async function loadBuyerLiveListings() {
      if (buyerBoot) return buyerBoot;
      buyerBoot = window.KobeSupabase.listPublicLiveSessions()
        .then(rows => setBuyerLiveSessions(rows))
        .catch(error => toast(error.message || 'Could not load live listings.'))
        .finally(() => { buyerBoot = null; });
      return buyerBoot;
    }

    window.addEventListener('kobe:auth-ready', loadBuyerLiveListings);
    loadBuyerLiveListings();

    const renderSession = window.renderBuyerLiveSession;
    window.renderBuyerLiveSession = function () {
      renderSession();
      if (!activeBuyerLiveSession || !activeBuyerLiveSession.externalUrl) return;
      let url;
      try { url = new URL(activeBuyerLiveSession.externalUrl); } catch (error) { return; }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !(host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be')) return;
      const root = document.getElementById('buyer-live-session-content');
      if (!root || root.querySelector('[data-external-live-link]')) return;
      const link = document.createElement('a');
      link.dataset.externalLiveLink = 'true';
      link.className = 'km-live-action';
      link.href = url.toString();
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open ' + (activeBuyerLiveSession.platform === 'youtube' ? 'YouTube' : 'TikTok') + ' live';
      root.prepend(link);
    };

    window.startLiveEscrowPurchase = function () {
      toast('In-app checkout is unavailable until AzamPay is connected. No reservation or payment was made.');
    };
  }
})();