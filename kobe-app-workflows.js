/* kobe-app-workflows.js - Merged candidate */
(function () {
  'use strict';

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

  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var api = function () {
    return (window.KobeSupabase && window.KobeSupabase.api) || window.KobeBackend || {};
  };
  var invoke = function (name, body) { return api().invoke(name, body); };
  var fmtTZS = function (n) { return 'TSh ' + Number(n || 0).toLocaleString('en-US'); };
  var timeString = function (iso) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  var agoText = function (ms) {
    var m = Math.floor(Math.max(0, Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.floor(m / 60) + ' h ago';
    return Math.floor(m / 1440) + ' d ago';
  };
  var SOCIAL_LABELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };

var page = location.pathname.split('/').pop();

  window.addEventListener('kobe:auth-ready', function (e) {
    var state = e.detail || {};
    var page = location.pathname.split('/').pop();
    if (page === 'seller.html') bootSeller(state);
    else if (page === 'buyer.html') bootBuyer(state);
  });

  /* ==================================================================
     SELLER
     ================================================================== */

  var sellerState = null;
  var sellerButtonsWired = false;
  var shopPaths = { avatar: '', cover: '' };
  var sellerStats = {};
  var sellerOverviewCache = null;

  async function bootSeller(state) {
    if (typeof enterSeller === 'function') enterSeller({ name: (state.profile && state.profile.display_name) || '' });
    /* Load core profile first so the sidebar name/avatar appear instantly.
       Defer non-critical data (wallet, activity, live) until after first render. */
    await loadSellerData(state);
    var pin = await api().pinStatus();
    if (pin && pin.hasPin && typeof secSt !== 'undefined') secSt.pin = true;
    if (typeof render === 'function') render();
    window.dispatchEvent(new CustomEvent('kobe:seller-ready'));
  }

  async function loadSellerData(state) {
    sellerState = state;
    if (!state || !state.profile) return;
    /* Core profile + sidebar: load FIRST and render immediately. */
    try { await loadSellerProfile(); } catch (e) { console.warn('profile', e); }
    if (typeof render === 'function') render();
    /* Secondary data: load in parallel, each guarded independently. */
    var secondary = [
      loadSellerProducts(),
      loadSellerOrders(),
      loadSellerDisputes(),
      loadSellerWallet(),
      loadSellerChats(),
    ];
    var results = await Promise.allSettled(secondary);
    results.forEach(function(r, i) {
      if (r.status === 'rejected') console.warn('seller-load', ['products','orders','disputes','wallet','chats'][i], r.reason);
    });
    try { await loadSellerActivity(); } catch (e) { console.warn('activity', e); }
    try { await loadSellerLive(); } catch (e) { console.warn('live', e); }
    wireSellerButtons();
    if (typeof render === 'function') render();
  }

  async function loadSellerProfile() {
    var profile = sellerState.profile;
    var authUser = null;
    var metaDisplayName = '';
    if (window.KobeSupabase && window.KobeSupabase.client) {
      try {
        var authRes = await window.KobeSupabase.client.auth.getUser();
        if (authRes && authRes.data && authRes.data.user) {
          authUser = authRes.data.user;
          metaDisplayName = (authUser.user_metadata && (authUser.user_metadata.full_name || authUser.user_metadata.name || authUser.user_metadata.display_name)) || '';
        }
      } catch (e) { /* auth metadata is optional */ }
    }
    user.name = profile.display_name || metaDisplayName || '';
    user.first = user.name.trim().split(/\s+/)[0] || '';
    user.phone = profile.phone_e164 || '';
    user.email = profile.email || (authUser && authUser.email) || '';

    /* Run sellerProfile and sellerOverview in parallel — independent calls. */
    var profileP = api().sellerProfile().catch(function (e) { console.warn('sellerProfile', e); return null; });
    var overviewP = sellerOverviewCache ? Promise.resolve(sellerOverviewCache) : api().sellerOverview().catch(function (e) { console.warn('sellerOverview', e); return null; });
    var row = await profileP;
    var overview = await overviewP;

    if (row) {
      shopPaths.avatar = row.avatar_path || '';
      shopPaths.cover = row.cover_path || '';
      store.name = row.shop_name || '';
      store.first = store.name.split(/\s+/)[0] || '';
      store.kid = row.kobe_id || '';
      store.desc = row.bio || '';
      store.loc = row.region || '';
      store.hours = (row.details && row.details.hours) || '';
      store.delivery = (row.details && row.details.delivery) || '';
      store.soc = Object.keys(row.socials || {}).map(function (k) { return SOCIAL_LABELS[k] || k; });
      /* Lazy-load media URLs — don't await them now, resolve later. */
      if (row.avatar_path) api().shopMediaUrl(row.avatar_path).then(function (u) { store.avatar = u; if (typeof pfUpdate === 'function') pfUpdate(); }).catch(function () {});
      if (row.cover_path) api().shopMediaUrl(row.cover_path).then(function (u) { store.cover = u; }).catch(function () {});
    }
    if (overview) {
      sellerOverviewCache = overview;
      sellerStats = overview.stats || {};
      store.rate = sellerStats.rating ? String(sellerStats.rating) : '—';
      bal = Number(overview.wallet.balance);
    }
    if (typeof pfUpdate === 'function') pfUpdate();
  }

  async function loadSellerProducts() {
    var rows = await window.KobeSupabase.listOwnProducts();
    prods.splice(0, prods.length);
    (rows || []).forEach(function (p) {
      prods.push({
        n: p.name, e: '📦', img: p.image_url || '', p: Number(p.price_tzs),
        s: Number(p.stock_quantity), v: p.status === 'active' ? 1 : 0, id: p.id,
      });
    });
  }

  async function loadSellerOrders() {
    var rows = await api().listOrders('seller');
    orders.splice(0, orders.length);
    (rows || []).forEach(function (o) { orders.push(o); });
    if (typeof SL !== 'undefined') {
      SL['Awaiting payment'] = ['Awaiting payment', 'proc', '🔒'];
      SL['Cancelled'] = ['Cancelled', 'proc', '↩'];
    }
  }

  async function loadSellerDisputes() {
    var myUserId = sellerState.profile.id;
    var res = await invoke('disputes', { action: 'list' });
    var list = (res && res.disputes) || [];
    disputes.splice(0, disputes.length);
    list.forEach(function (d) {
      disputes.push({
        id: d.id,
        uuid: d.disputeId,
        oid: d.orderId,
        reason: d.reason,
        desc: d.description,
        dl: d.sellerDeadline,
        replied: !!d.sellerRepliedAt,
        msgs: (d.messages || []).map(function (m) {
          return [m.senderId === myUserId ? 's' : 'b', m.text, timeString(m.at)];
        }),
        imgs: (d.evidence || []).map(function (e2) { return e2.url; }),
      });
    });
  }

  async function loadSellerWallet() {
    var wallet = await api().walletSummary();
    if (!wallet) return;
    bal = Number(wallet.wallet.balance);
  }

  async function loadSellerChats() {
    var threads = await api().chatThreads();
    chats.splice(0, chats.length);
    (threads || []).forEach(function (t) {
      chats.push({ w: t.withName, uid: t.withUserId, u: t.unread, m: [] });
    });
    chatFilter = '';
  }

  async function loadSellerActivity() {
    var activity = await api().sellerActivity();
    var wallet = await api().walletSummary();
    var ledger = (wallet && wallet.ledger) || [];
    var rows = [];

    var kindMap = {
      order_created: { title: 'Order received', kind: 'Escrow', amount: function (p) { return Number(p.total || 0); }, status: 'Processing' },
      order_cancelled: { title: 'Order cancelled', kind: 'Escrow', amount: function () { return 0; }, status: 'Cancelled' },
      order_completed: { title: 'Escrow released', kind: 'Credit', amount: function (p) { return Number(p.net || p.total || 0); }, status: 'Completed' },
      escrow_funded: { title: 'Escrow funded', kind: 'Escrow', amount: function (p) { return Number(p.total || 0); }, status: 'In escrow' },
      dispute_opened: { title: 'Dispute opened', kind: 'Dispute', amount: function () { return 0; }, status: 'Disputed' },
      dispute_reply: { title: 'Dispute reply', kind: 'Dispute', amount: function () { return 0; }, status: 'Disputed' },
      handoff_verified: { title: 'Handoff verified', kind: 'Escrow', amount: function () { return 0; }, status: 'In escrow' },
      review_received: { title: 'New review', kind: 'Review', amount: function () { return 0; }, status: 'Completed' },
      message_received: { title: 'New message', kind: 'Message', amount: function () { return 0; }, status: 'Completed' },
      payout_requested: { title: 'Withdrawal requested', kind: 'Withdrawal', amount: function (p) { return -Number(p.amount || 0); }, status: 'Processing' },
    };
    (activity || []).forEach(function (a) {
      var p = a.payload || {};
      var m = kindMap[a.kind];
      if (!m) return;
      rows.push({
        id: a.id, ref: p.ref || '', t: m.title + (p.ref ? ' ' + p.ref : ''),
        w: agoText(new Date(a.created_at).getTime()),
        a: m.amount(p), k: m.kind, s: m.status, at: new Date(a.created_at).getTime(),
      });
    });

    var ledgerMap = {
      top_up: { title: 'Wallet top-up', kind: 'Credit', status: 'Completed' },
      order_funding: { title: 'Escrow hold', kind: 'Escrow', status: 'In escrow' },
      escrow_release: { title: 'Escrow released', kind: 'Credit', status: 'Completed' },
      fee: { title: 'Kobe fee (1%)', kind: 'Fee', status: 'Completed' },
      refund: { title: 'Refund issued', kind: 'Refund', status: 'Completed' },
      withdrawal: { title: 'Withdrawal', kind: 'Withdrawal', status: 'Processing' },
      adjustment: { title: 'Wallet adjustment', kind: 'Adjustment', status: 'Completed' },
    };
    ledger.forEach(function (e2) {
      var m = ledgerMap[e2.type];
      if (!m) return;
      rows.push({
        id: e2.id, ref: '', t: m.title, w: agoText(new Date(e2.at).getTime()),
        a: Number(e2.amount), k: m.kind, s: m.status, at: new Date(e2.at).getTime(),
      });
    });

    rows.sort(function (x, y) { return y.at - x.at; });
    acts.splice(0, acts.length);
    rows.slice(0, 50).forEach(function (r) { acts.push(r); });

    notifs.splice(0, notifs.length);
    rows.slice(0, 12).forEach(function (r) {
      notifs.push({
        id: r.id,
        title: r.t,
        body: r.a ? fmtTZS(Math.abs(r.a)) : '',
        type: r.k === 'Dispute' ? 'dispute' : (r.k === 'Withdrawal' ? 'payout' : (r.k === 'Escrow' || r.k === 'Credit' ? 'order' : 'info')),
        link: r.ref ? 'order/' + r.ref : '',
        t: r.at, r: 0,
      });
    });
  }

  async function loadSellerLive() {
    if (!window.KobeSupabase) return;
    try {
      var sessions = await window.KobeSupabase.listOwnLiveSessions();
      live = sessions && sessions.length ? sessions[0] : null;
    } catch (e) {
      live = null;
    }
  }

  function wireSellerButtons() {
    if (sellerButtonsWired) return;
    sellerButtonsWired = true;

    var originalPedit = window.pedit;
    window.pedit = function (i) {
      var p = i < 0 ? { n: '', e: '📦', p: '', s: '', v: 1 } : prods[i];
      pics.p = p.img || '';
      gform(i < 0 ? 'Add product' : 'Edit product', [
        { k: 'n', l: 'Product name', v: p.n },
        { k: 'p', l: 'Price (TSh)', t: 'number', v: p.p },
        { k: 's', l: 'Stock available', t: 'number', v: p.s },
        { k: 'v', l: 'Show to buyers', tg: 1, v: p.v },
      ], async function (o) {
        if (!o.n) return 'Enter a product name.';
        if (Number(o.p) < 1) return 'Enter a price.';
        var payload = {
          name: String(o.n).slice(1, 120),
          price_tzs: Math.round(Number(o.p)),
          stock_quantity: Math.max(0, Math.round(Number(o.s) || 0)),
          status: o.v ? 'active' : 'draft',
          image_url: pics.p || null,
        };
        try {
          if (i < 0) await window.KobeSupabase.saveProduct(payload);
          else await window.KobeSupabase.saveProduct(payload, p.id);
        } catch (e) {
          return (e && e.message) || 'Could not save the product.';
        }
        return '';
      }, i < 0 ? 'Add product' : 'Save changes', i < 0 ? 'Product added' : 'Product updated', [['p', 'Product photo']]);
    };

    var originalGsave = window.gsave;
    window.gsave = function (btn) {
      return originalGsave.call(window, btn);
    };

    window.chk = async function () {
      var input = document.getElementById('ref');
      var ref = String((input && input.value) || '').trim().toUpperCase();
      if (!ref) { toast('Enter an order reference like KM-123456.'); return; }
      var res = await invoke('orders', { action: 'lookup', ref: ref });
      if (!res || !res.ok) { toast((res && res.error) || 'Could not find that order.'); return; }
      var o = res.order;
      var idx = orders.findIndex(function (x) { return x.id === o.id; });
      if (idx >= 0) orders[idx] = o; else orders.unshift(o);
      render();
      openOrd(o.id);
      toast('Order ' + o.id + ' verified.');
    };

    window.KobeSellerScanner = {
      onScreenChange: function (screen) {
        if (!window.KobeCamera) return;
        if (screen === 'scan') this.start();
        else window.KobeCamera.stop();
      },
      start: function () {
        window.KobeCamera.start({
          frameId: 'seller-scan-frame',
          statusId: 'seller-scan-status',
          buttonId: 'seller-scan-btn',
          onCode: function (code) { window.KobeSellerScanner.handleCode(code); },
        });
      },
      handleCode: async function (code) {
        var result = document.getElementById('seller-scan-result');
        var status = document.getElementById('seller-scan-status');
        if (result) { result.style.display = 'block'; result.textContent = 'Verifying…'; }
        var res = await invoke('handoff', { action: 'verify', code: code });
        if (!res || !res.ok) {
          var reason = (res && res.error) || 'This code could not be verified.';
          if (result) result.textContent = 'Not verified: ' + reason;
          if (status) status.textContent = reason + ' Scan again.';
          toast(reason);
          return;
        }
        if (result) {
          result.innerHTML = '<b>Verified ✔</b><br>Order ' + esc(res.order_ref) +
            '<br>' + esc(res.item_name) + ' → ' + Number(res.quantity || 1) +
            '<br><b>' + fmtTZS(res.amount) + '</b>' +
            '<br><small>' + esc(res.counterparty) + ' à ' + timeString(res.scanned_at) + '</small>';
        }
        if (status) status.textContent = 'Handoff verified. Release happens when the buyer confirms payment.';
        toast('Handoff verified for ' + res.order_ref);
        await loadSellerOrders();
        render();
      },
    };

    var originalOpenChat = window.openChat;
    window.openChat = async function (i) {
      originalOpenChat.call(window, i);
      var c = chats[i];
      if (c && c.uid && (!c.m || !c.m.length)) {
        var res = await invoke('chat', { action: 'thread', with: c.uid });
        if (res && res.ok) {
          c.m = (res.messages || []).map(function (m) {
            return [m.from === 'me' ? 's' : 'b', m.body, timeString(m.at)];
          });
          render();
          setTimeout(function () { var s = document.getElementById('stage'); if (s) s.scrollTop = 1e6; }, 50);
        }
        invoke('chat', { action: 'read', with: c.uid });
        c.u = 0;
        render();
      }
    };

    window.sendM = async function () {
      var input = document.getElementById('cIn');
      var text = (input && input.value || '').trim();
      var c = chats[ci];
      if (!input || !text || !c || !c.uid) return;
      var res = await invoke('chat', { action: 'send', with: c.uid, text: text });
      if (!res || !res.ok) { toast((res && res.error) || 'Could not send the message.'); return; }
      input.value = '';
      c.m.push(['s', text, timeString(new Date().toISOString())]);
      render();
      setTimeout(function () { var s = document.getElementById('stage'); if (s) s.scrollTop = 1e6; }, 50);
    };

    window.msgBuyer = function (n) {
      var i = chats.findIndex(function (c) { return c.w === n; });
      if (i < 0) {
        var order = orders.find(function (o) { return o.who === n; });
        var uid = order ? order.buyerId : '';
        if (!uid) { toast('Open an order from this buyer to message them.'); return; }
        chats.push({ w: n, uid: uid, u: 0, m: [] });
        i = chats.length - 1;
      }
      ci = i;
      go('chat');
      window.openChat(i);
      setTimeout(function () { var s = document.getElementById('stage'); if (s) s.scrollTop = 1e6; }, 50);
    };

    window.replyD = function (id) {
      var d = disputes.find(function (x) { return x.id === id; });
      if (!d) return;
      pics.ev = '';
      gform('Reply to dispute', [{ k: 'm', l: 'Your response', ta: 1, req: 1, min: 10, p: 'Explain what happened' }],
        async function (o) {
          if (o.m.length < 10) return 'Write at least 10 characters.';
          var paths = [];
          if (pics.ev) {
            try {
              paths = await api().uploadDisputeEvidence(d.uuid, [{ name: 'evidence.jpg', dataUrl: pics.ev }]);
            } catch (e) {
              return (e && e.message) || 'Could not attach the evidence.';
            }
          }
          var res = await invoke('disputes', { action: 'reply', dispute_ref: d.id, text: o.m, evidence_paths: paths });
          if (!res || !res.ok) return (res && res.error) || 'Could not send the reply.';
          await loadSellerDisputes();
          render();
          toast('Reply sent');
          return '';
        }, 'Send reply', 'Reply sent', [['ev', 'Evidence photo (optional)']]);
    };

    window.secPin = function () {
      var ch = secSt.pin;
      if (ch && Date.now() < secSt.lock) {
        return toast('Locked after wrong tries. Try again in ' + Math.ceil((secSt.lock - Date.now()) / 60000) + ' min, or use Forgot PIN.');
      }
      gform(ch ? 'Change transaction PIN' : 'Set transaction PIN',
        (ch ? [{ k: 'old', l: 'Current PIN', t: 'password', p: 'Current PIN' }] : [])
          .concat([
            { k: 'a', l: 'New PIN (6 digits)', t: 'password', p: '6 digits' },
            { k: 'b', l: 'Confirm new PIN', t: 'password', p: 'Repeat PIN' },
            { note: 'Avoid 123456 or repeated digits like 111111.' },
          ]),
        async function (o) {
          if (ch && o.old !== _pin) {
            secSt.bad++;
            if (secSt.bad >= 3) { secSt.lock = Date.now() + 3e5; secSt.bad = 0; back(); return 'Locked for 5 minutes after 3 wrong tries.'; }
            return 'Current PIN is wrong (' + (3 - secSt.bad) + ' tries left).';
          }
          if (!/^\d{6}$/.test(o.a)) return 'Use exactly 6 digits.';
          if (weakPin(o.a)) return 'Too easy to guess. Choose another PIN.';
          if (ch && o.a === o.old) return 'New PIN must be different.';
          if (o.a !== o.b) return 'PINs do not match.';
          var res = ch
            ? await api().pinChange(o.old, o.a)
            : await api().pinSet(o.a);
          if (!res || res.ok === false) return (res && res.reason) || 'Could not save the PIN.';
          _pin = o.a; secSt.pin = true; secSt.bad = 0; render();
          return '';
        }, 'Save PIN', ch ? 'PIN changed' : 'PIN set');
    };

    window.secPass = function () {
      gform('Change password', [
        { k: 'old', l: 'Current password', t: 'password', req: 1 },
        { k: 'a', l: 'New password (8+ characters)', t: 'password', req: 1, min: 8, meter: 1 },
        { k: 'b', l: 'Confirm new password', t: 'password', req: 1, same: 'a' },
        { note: 'Forgot it? Use "Forgot password" on the sign-in page to get a reset link by email.' },
      ], async function (o) {
        if (!o.old) return 'Enter your current password.';
        if ((o.a || '').length < 8) return 'Use at least 8 characters.';
        if (o.a === o.old) return 'New password must be different.';
        if (o.a !== o.b) return 'Passwords do not match.';
        var res = await api().passwordChange(o.old, o.a);
        if (!res || res.ok === false) return (res && res.reason) || 'Could not change the password.';
        return '';
      }, 'Update password', 'Password changed');
    };

    window.sPer = function () {
      gform('Contact details', [
        { k: 'name', l: 'Your name', req: 1, v: user.name },
        { k: 'phone', l: 'Phone number', p: '07XXXXXXXX', v: user.phone },
        { k: 'email', l: 'Email', t: 'email', v: user.email },
      ], async function (o) {
        if (!o.name || o.name.trim().length < 2) return 'Enter your name.';
        var phone = String(o.phone || '').replace(/[\s-]/g, '');
        if (phone.length >= 9 && !/^(\+?255|0)[67]\d{8}$/.test(phone)) return 'Enter a valid mobile number.';
        var payload = { display_name: o.name.trim() };
        if (phone) payload.phone_e164 = phone.charAt(0) === '+' ? phone : '+' + phone.replace(/^0/, '255');
        try {
          var result = await window.KobeSupabase.client.from('profiles').update(payload).eq('id', sellerState.profile.id);
          if (result.error) throw new Error(result.error.message);
        } catch (e) {
          return (e && e.message) || 'Could not save the details.';
        }
        user.name = o.name.trim();
        user.first = user.name.split(/\s+/)[0] || '';
        user.phone = payload.phone_e164 || '';
        user.email = o.email || '';
        pfUpdate();
        return '';
      }, 'Save details', 'Details updated');
    };

    window.profileRequest = function (topic) {
      var currentMap = {
        'Business description': store.desc, 'Opening hours': store.hours,
        'Delivery details': store.delivery, 'Business location': store.loc,
        'Logo and cover image': shopPaths.avatar || shopPaths.cover || '—',
        'Public profile': store.name + ' à ' + (store.loc || 'no location'),
        'Social media link': (store.soc || []).join(', ') || 'none',
        'Support request': '—',
      };
      gform('Request a change: ' + topic, [
        { k: 'proposed', l: 'What should it say?', ta: 1, req: 1, p: 'Enter the new value exactly as it should appear' },
        { k: 'reason', l: 'Why is this changing?', ta: 1, p: 'Optional: explain the change' },
      ], async function (o) {
        try {
          await api().supportRequest({ topic: topic, current: currentMap[topic] || '—', proposed: o.proposed, reason: o.reason });
          return '';
        } catch (e) {
          return (e && e.message) || 'Could not send the request.';
        }
      }, 'Send request', 'Request sent to customer support');
    };
    window.profileSupport = function () {
      gform('Contact customer support', [
        { k: 'proposed', l: 'How can we help?', ta: 1, req: 1, p: 'Describe the problem or question' },
      ], async function (o) {
        try {
          await api().supportRequest({ topic: 'Support request', proposed: o.proposed });
          return '';
        } catch (e) {
          return (e && e.message) || 'Could not send the message.';
        }
      }, 'Send message', 'Message sent');
    };

    window.qrSvg = function (o) {
      if (o && o._sellerCode) {
        try { return window.KobeQr.svg(o._sellerCode, 'Kobe Mweusi seller handoff QR'); } catch (e) { return ''; }
      }
      return originalQrSvg(o);
    };
    var originalOpenOrd = window.openOrd;
    window.openOrd = async function (id) {
      originalOpenOrd.call(window, id);
      var o = orders.find(function (x) { return x.id === id; });
      if (o && o.s === 'In escrow' && !o._sellerCode) {
        var res = await api().handoffIssue(id);
        if (res && res.ok) {
          o._sellerCode = res.seller_code;
          render();
        }
      }
    };

    window.kRefresh = async function (why, force) {
      if (!force && Date.now() - kLast < 15000) return null;
      kLast = Date.now();
      try { await loadSellerData(sellerState); } catch (e) { console.warn(e); }
      render();
      return null;
    };

    window.addEventListener('message', function (e) {
      var data = e.data || {};
      if (data.type === 'OPEN_LINK' && data.link && typeof window.kobeOpenLink === 'function') {
        window.kobeOpenLink(data.link);
      }
    });

    function updateStreamButton() {
      var button = document.querySelector('[onclick="lTT()"]');
      if (button && live) button.textContent = live.platform === 'youtube' ? 'Open YouTube live' : 'Open TikTok live';
    }

    window.startLive = function () {
      var candidates = prods.map(function (product, index) { return { product: product, index: index }; }).filter(function (row) { return row.product.id; });
      if (!candidates.length) return toast('Save at least one product before publishing a live listing.');
      var durations = { '1 hour': 1, '3 hours': 3, '6 hours': 6, '12 hours': 12, '24 hours': 24 };
      gform('Publish a TikTok or YouTube live listing', [
        { k: 't', l: 'Session title', p: "e.g. Today's new arrivals" },
        { k: 'platform', l: 'Platform', o: ['TikTok', 'YouTube'] },
        { k: 'url', l: 'Public live link', p: 'https://www.tiktok.com/@you/live' },
        { k: 'len', l: 'Listing length', o: Object.keys(durations) }
      ].concat(candidates.map(function (_ref) {
        var product = _ref.product, index = _ref.index;
        return { k: 'p' + index, l: product.n, tg: 1, v: product.v };
      })), async function (values) {
        if (!values.t) return 'Give the listing a title.';
        var platform = values.platform.toLowerCase();
        var url;
        try { url = new URL(values.url); } catch (error) { return 'Enter a valid HTTPS live link.'; }
        var host = url.hostname.toLowerCase();
        var validHost = platform === 'tiktok'
          ? host === 'tiktok.com' || host.endsWith('.tiktok.com')
          : host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
        if (url.protocol !== 'https:' || !validHost) return 'Use a public HTTPS link from the selected platform.';
        var selected = candidates.filter(function (_ref2) {
          var index = _ref2.index;
          return values['p' + index];
        });
        if (!selected.length) return 'Feature at least one product.';
        var hours = durations[values.len] || 1;
        var startAt = new Date();
        var endAt = new Date(startAt.getTime() + hours * 3600000);
        var saved = await window.KobeSupabase.saveLiveSession({
          title: values.t,
          platform: platform,
          external_url: url.toString(),
          status: 'live',
          starts_at: startAt.toISOString(),
          ends_at: endAt.toISOString(),
          product_ids: selected.map(function (_ref3) {
            var product = _ref3.product;
            return product.id;
          })
        });
        live = {
          id: saved.id,
          t: saved.title,
          tt: saved.external_url,
          platform: saved.platform,
          n: selected.length,
          products: selected.map(function (_ref4) {
            var product = _ref4.product, index = _ref4.index;
            return {
              id: product.id, i: index, n: product.n, p: Number(product.p), e: product.e,
              img: '', s: Number(product.s), sold: 0, shown: 1
            };
          }),
          start: startAt.getTime(),
          endAt: endAt.getTime(),
          pin: -1,
          feed: [],
          orders: 0,
          rev: 0,
          resv: []
        };
        if (typeof liveNotes !== 'undefined') liveNotes = [];
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

  /* ==================================================================
     BUYER
     ================================================================== */

  var buyerButtonsWired = false;
  var directoryCache = [];
  var chatThreadsCache = [];
  var activeChatUserId = null;
  var handoffTokens = {};

  function toBuyerDispute(d) {
    return {
      id: d.id,
      orderId: d.orderId,
      seller: d.sellerName,
      item: d.item,
      amount: d.amount,
      reason: d.reason,
      description: d.description,
      evidence: d.evidence || [],
      status: d.status,
      createdAt: d.createdAt,
      sellerDeadline: d.sellerDeadline,
      sellerRepliedAt: d.sellerRepliedAt,
      outcome: d.outcome,
      messages: d.messages || [],
    };
  }

  async function bootBuyer(state) {
    wireBuyerButtons();
    await loadBuyerData(state);
    window.dispatchEvent(new CustomEvent('kobe:buyer-ready'));
  }

  async function loadBuyerData(state) {
    var wallet = await api().walletSummary();
    if (wallet) {
      balanceValue = Number(wallet.wallet.balance);
      escrowValue = Number(wallet.wallet.held);
    }
    renderBalances();
    await Promise.all([renderOrders(), renderDisputes(), loadDirectory(), loadChatThreads(), fillAccount(state)]);
  }

  async function loadDirectory() {
    directoryCache = await api().sellerDirectory('');
    window.KobeSellers.set(directoryCache.map(function (s) {
      return {
        i: (s.name || '?').trim().charAt(0).toUpperCase() || 'S',
        id: s.kid, n: s.name, meta: s.region || 'Tanzania',
        deals: s.deals, rating: s.rating ? Number(s.rating).toFixed(1) : '—',
        cancelled: s.cancelled, disputed: s.disputed,
        about: s.about, s: s.region || '', v: true, userId: s.userId,
      };
    }));
  }

  async function loadChatThreads() {
    chatThreadsCache = await api().chatThreads();
    renderChatThreads();
  }

  async function fillAccount(state) {
    var profile = state && state.profile;
    if (!profile) {
      try {
        profile = await api().getMyProfile();
      } catch (e) {
        return;
      }
    }
    if (!profile) return;
    var name = profile.display_name || 'Kobe buyer';
    var big = document.getElementById('account-big-avatar');
    if (big) big.textContent = (name.trim().charAt(0) || 'K').toUpperCase();
    var heading = document.querySelector('#screen-account .account-profile-top h2');
    if (heading) heading.textContent = name;
    var sub = document.querySelector('#screen-account .account-profile-top p');
    if (sub) sub.textContent = (profile.phone_e164 || profile.email || 'kobe buyer') + ' à Buyer';
    var boxes = document.querySelectorAll('#screen-account .account-id-box strong');
    if (boxes[0]) boxes[0].textContent = 'KM-' + String(profile.id || '').slice(0, 8).toUpperCase();
    if (boxes[1] && profile.created_at) {
      boxes[1].textContent = new Date(profile.created_at).toLocaleDateString([], { month: 'long', year: 'numeric' });
    }
  }

  function wireBuyerButtons() {
    if (buyerButtonsWired) return;
    buyerButtonsWired = true;

    var rawListDisputes = KobeApi.listDisputes.bind(KobeApi);
    KobeApi.listDisputes = async function () {
      return (await rawListDisputes()).map(toBuyerDispute);
    };

    window.openHandoff = async function (seller, amount, txId) {
      handoffSeller = seller; handoffAmount = amount; handoffTxId = txId;
      document.getElementById('handoff-lock-text').textContent =
        'This code is identity-locked to @' + seller.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) + ' ô only they can redeem it.';
      var box = document.getElementById('handoff-qr-box');
      box.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px">Generating your handoff code…</p>';
      var res = await KobeApi.handoffIssue(txId);
      if (!res || res.ok === false) {
        box.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px">' +
          esc((res && res.reason) || 'Handoff codes are only available while money is held in escrow.') + '</p>';
        showScreen('handoff');
        return;
      }
      handoffTokens[txId] = res;
      box.innerHTML = KobeApi.handoffCodeSvg(txId);
      showScreen('handoff');
    };
    KobeApi.handoffCodeSvg = function (txId) {
      var issued = handoffTokens[txId];
      return generateQrSvg(issued ? issued.buyer_code : txId);
    };

    window.renderChatThreads = function () {
      var list = document.getElementById('chat-list');
      if (!list) return;
      var search = list.querySelector('.chat-search');
      list.innerHTML = '';
      if (search) list.appendChild(search);
      if (!chatThreadsCache.length) {
        list.insertAdjacentHTML('beforeend',
          '<div class="empty-state" style="padding:32px 20px;"><div class="empty-state-title">No conversations yet</div><div class="empty-state-sub">Messages with sellers about your orders will show up here.</div></div>');
        return;
      }
      chatThreadsCache.forEach(function (t, i) {
        list.insertAdjacentHTML('beforeend',
          '<button class="chat-list-item" data-cidx="' + i + '" type="button">' +
          '<div class="r-avatar">' + esc((t.withName || '?').trim().charAt(0).toUpperCase() || '?') + '</div>' +
          '<div style="flex:1;min-width:0;"><div class="ci-top"><span class="ci-name">' + esc(t.withName) +
          '</span><span class="ci-time">' + (t.lastAt ? fmtWhen(new Date(t.lastAt).getTime()) : '') + '</span></div>' +
          '<div class="ci-msg">' + esc(t.lastBody || 'Say hello to start the conversation') + '</div></div>' +
          (t.unread ? '<span class="pill">' + t.unread + '</span>' : '') +
          '</button>');
      });
    };

    var chatList = document.getElementById('chat-list');
    if (chatList) {
      chatList.addEventListener('click', function (e) {
        var row = e.target.closest('.chat-list-item');
        if (!row || row.id === 'chat-search-result') return;
        var t = chatThreadsCache[Number(row.dataset.cidx)];
        if (t) openChatWith(t);
      });
    }

    window.openChatWith = async function (t) {
      activeChatUserId = t.withUserId;
      openThread(null, t.withName, (t.withName || '?').trim().charAt(0).toUpperCase() || '?');
    };

    window.renderStoredChat = async function (name) {
      var body = document.getElementById('thread-body');
      if (!body) return;
      var thread = chatThreadsCache.find(function (t) {
        return String(t.withName).toLowerCase() === String(name).toLowerCase();
      });
      if (!thread || !activeChatUserId) {
        body.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;">No messages yet ô say hello to start the conversation.</p>';
        return;
      }
      var data = await KobeApi.chatThread(activeChatUserId);
      body.innerHTML = '';
      if (!data || !data.messages || !data.messages.length) {
        body.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;">No messages yet ô say hello to start the conversation.</p>';
      } else {
        data.messages.forEach(function (m) {
          var row = document.createElement('div');
          row.className = 'bubble-row' + (m.from === 'me' ? ' me' : '');
          var bubble = document.createElement('div');
          bubble.className = 'bubble' + (m.from === 'me' ? ' me' : '');
          var msg = document.createElement('span');
          msg.textContent = m.body;
          var meta = document.createElement('div');
          meta.className = 'bubble-meta';
          meta.textContent = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          bubble.appendChild(msg); bubble.appendChild(meta);
          row.appendChild(bubble); body.appendChild(row);
        });
      }
      body.scrollTop = body.scrollHeight;
      KobeApi.markChatRead(activeChatUserId);
    };

    window.sendChatMessage = async function () {
      var input = document.getElementById('chat-message-input');
      var body = document.getElementById('thread-body');
      var text = (input && input.value || '').trim();
      if (!input || !body || !text || !activeChatUserId) return;
      var res = await KobeApi.sendChatMessage({ with: activeChatUserId, text: text });
      if (!res || res.ok === false) {
        kobeToast((res && res.reason) || 'Could not send the message.');
        return;
      }
      input.value = '';
      var name = document.getElementById('th-name');
      window.renderStoredChat(name ? name.textContent : '');
      loadChatThreads();
    };

    window.searchChatSellers = function (query) {
      var q = query.trim().toLowerCase();
      document.querySelectorAll('#chat-list .chat-list-item').forEach(function (row) {
        var name = (row.querySelector('.ci-name') && row.querySelector('.ci-name').textContent || '').toLowerCase();
        row.style.display = !q || name.indexOf(q) >= 0 ? 'flex' : 'none';
      });
      var list = document.getElementById('chat-list');
      var result = document.getElementById('chat-search-result');
      var match = null;
      if (q) {
        match = directoryCache.find(function (s) {
          return s.name.toLowerCase().indexOf(q) >= 0 &&
            !chatThreadsCache.some(function (t) { return t.withUserId === s.userId; });
        });
      }
      if (!q || !match) { if (result) result.remove(); return; }
      if (!result) {
        result = document.createElement('button');
        result.id = 'chat-search-result';
        result.type = 'button';
        result.className = 'chat-new-hint';
        result.style.cssText = 'width:100%;text-align:left;background:transparent;border:0;cursor:pointer;color:var(--ai);';
        list.appendChild(result);
      }
      result.textContent = 'Start a conversation with ' + match.name;
      result.onclick = function () {
        activeChatUserId = match.userId;
        openThread(null, match.name, (match.name || '?').charAt(0).toUpperCase() || '?');
        result.remove();
      };
    };

    window.startChatWithSearchedSeller = function (name) {
      var match = directoryCache.find(function (s) { return s.name === name; });
      if (match) {
        activeChatUserId = match.userId;
        openThread(null, match.name, (match.name || '?').charAt(0).toUpperCase() || '?');
      }
    };

    window.chatWithCurrentSeller = function () {
      showScreen('chat');
      var thread = chatThreadsCache.find(function (t) {
        return String(t.withName).toLowerCase() === String(currentSellerName).toLowerCase();
      });
      if (thread) { window.openChatWith(thread); return; }
      var seller = directoryCache.find(function (s) { return s.kid === currentSellerKid; });
      if (seller) {
        activeChatUserId = seller.userId;
        openThread(null, seller.name, (seller.name || '?').charAt(0).toUpperCase() || '?');
      } else {
        openThread(null, currentSellerName, currentSellerInitial);
      }
    };

    var originalOpenSeller = window.openSeller;
    window.openSeller = function () {
      originalOpenSeller.apply(window, arguments);
      loadSellerExtras(arguments[6]);
    };

    async function loadSellerExtras(kobeId) {
      if (!kobeId) return;
      var seller = directoryCache.find(function (s) { return s.kid === kobeId; });
      var pane = document.getElementById('sp-pane-transactions');
      if (pane) {
        var products = [];
        try { products = await window.KobeSupabase.listPublicProducts(); } catch (e) { products = []; }
        var mine = (products || []).filter(function (p) {
          return seller && p.sellerId === seller.userId && p.status === 'active';
        });
        pane.innerHTML = mine.length ? mine.map(function (p) {
          return '<div class="pm-row"><span class="pm-row-icon">🛍️</span>' +
            '<div class="pm-row-main"><b>' + esc(p.name) + '</b><small>' + Number(p.stockQuantity || p.stock_quantity || 0) + ' in stock</small></div>' +
            '<strong>' + fmtTZS(p.priceTzs || p.price_tzs || 0) + '</strong>' +
            '<button class="chip" onclick="buyProduct(\'' + p.id + '\')">Buy</button></div>';
        }).join('') : '<p class="note">No products listed right now.</p>';
      }
      var data = await KobeApi.sellerReviews(kobeId);
      var reviewsPane = document.getElementById('sp-pane-reviews');
      if (reviewsPane) {
        reviewsPane.innerHTML = (data.reviews || []).length
          ? data.reviews.map(function (r) {
              return '<div class="ds-card" style="margin:8px 16px"><div class="ds-row"><span>Rating</span><span>' +
                '★★★★★'.repeat(r.stars) + '☆☆☆☆☆'.repeat(5 - r.stars) + '</span></div>' +
                (r.comment ? '<p class="ds-desc">' + esc(r.comment) + '</p>' : '') + '</div>';
            }).join('')
          : '<p class="note" style="padding:8px 16px">No reviews yet. Reviews appear after completed orders.</p>';
      }
    }

    window.buyProduct = function (productId) {
      var product = null;
      directoryCache.forEach(function () {});
      window.KobeSupabase.listPublicProducts().then(function (products) {
        product = (products || []).find(function (p) { return p.id === productId; });
        if (!product) return;
        openBuySafely();
        document.getElementById('buy-item-desc').value = product.name;
        document.getElementById('buy-item-amount').value = product.priceTzs || product.price_tzs || '';
        if (typeof fillReview === 'function') fillReview();
        if (typeof goBuyStep === 'function') goBuyStep(1);
      }).catch(function () {});
    };

    var originalShowSpTab = window.showSpTab;
    window.showSpTab = function (name, el) {
      originalShowSpTab.call(window, name, el);
      if (name === 'reviews' && currentSellerKid) {
        KobeApi.sellerReviews(currentSellerKid).then(function (data) {
          var reviewsPane = document.getElementById('sp-pane-reviews');
          if (!reviewsPane) return;
          reviewsPane.innerHTML = (data.reviews || []).length
            ? data.reviews.map(function (r) {
              return '<div class="ds-card" style="margin:8px 16px"><div class="ds-row"><span>Rating</span><span>' +
                '★★★★★'.repeat(r.stars) + '☆☆☆☆☆'.repeat(5 - r.stars) + '</span></div>' +
                (r.comment ? '<p class="ds-desc">' + esc(r.comment) + '</p>' : '') + '</div>';
            }).join('')
            : '<p class="note" style="padding:8px 16px">No reviews yet. Reviews appear after completed orders.</p>';
        }).catch(function () {});
      }
    };

    window.kobeRefresh = async function (why) {
      try {
        var wallet = await api().walletSummary();
        if (wallet) {
          balanceValue = Number(wallet.wallet.balance);
          escrowValue = Number(wallet.wallet.held);
        }
        renderBalances();
        await Promise.all([renderOrders(), renderDisputes(), loadDirectory(), loadChatThreads()]);
      } catch (e) { console.warn(e); }
    };

    window.addEventListener('message', function (e) {
      var data = e.data || {};
      if (data.type === 'PUSH_RESUBSCRIBE') {
        dispatchEvent(new CustomEvent('kobe:push-resubscribe'));
      }
    });
  }

  /* Buyer live-listing backend (from current file) */
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