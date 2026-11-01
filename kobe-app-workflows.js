  async function loadBuyerData(state) {
    /* Start profile hydration first so the sidebar and menu can show the
       real buyer name as soon as auth data is ready. Waiting for the wallet
       call first caused the name to stay on the fallback text for too long. */
    var profilePromise = fillAccount(state).catch(function (e) {
      console.warn('fillAccount', e);
    });
    var walletPromise = api().walletSummary().catch(function (e) {
      console.warn('walletSummary', e);
      return null;
    });
    var wallet = await walletPromise;
    if (wallet && wallet.wallet) {
      balanceValue = Number(wallet.wallet.balance);
      escrowValue = Number(wallet.wallet.held);
      var walletId = wallet.wallet.wallet_id || '';
      var walletIdEl = document.getElementById('wId');
      if (walletIdEl) walletIdEl.textContent = walletId || 'Wallet ID not assigned yet';
      var accountWalletId = document.getElementById('accountWalletId');
      if (accountWalletId) accountWalletId.textContent = walletId || 'Not assigned yet';
      var sandboxBtn = document.getElementById('sandbox-credit-btn');
      var sandboxHint = document.getElementById('sandbox-credit-hint');
      if (sandboxBtn) sandboxBtn.style.display = wallet.sandbox_available ? 'block' : 'none';
      if (sandboxHint) sandboxHint.style.display = wallet.sandbox_available ? 'block' : 'none';
    }
    renderBalances();
    await profilePromise;

    Promise.all([
      renderOrders().catch(function (e) { console.warn('renderOrders', e); }),
      renderDisputes().catch(function (e) { console.warn('renderDisputes', e); })
    ]);

    Promise.all([
      loadDirectory().catch(function (e) { console.warn('loadDirectory', e); }),
      loadChatThreads().catch(function (e) { console.warn('loadChatThreads', e); })
    ]);
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
    var name = (profile.display_name || '').trim();
    var fallbackName = name || 'Buyer';
    var email = (profile.phone_e164 || profile.email || '').trim();
    var displayEmail = email || 'Buyer';
    var initial = (name ? name.charAt(0) : 'B').toUpperCase();
    var big = document.getElementById('account-big-avatar');
    if (big) big.textContent = initial;
    var heading = document.querySelector('#screen-account .account-profile-top h2');
    if (heading) heading.textContent = fallbackName;
    var sub = document.querySelector('#screen-account .account-profile-top p');
    if (sub) sub.textContent = (email || 'Buyer') + ' · Buyer';
    var boxes = document.querySelectorAll('#screen-account .account-id-box strong');
    if (boxes[0]) boxes[0].textContent = 'KM-' + String(profile.id || '').slice(0, 8).toUpperCase();
    if (boxes[1] && profile.created_at) {
      boxes[1].textContent = new Date(profile.created_at).toLocaleDateString([], { month: 'long', year: 'numeric' });
    }
    /* Keep the persistent sidebar and profile menu in sync right away. */
    var sideName = document.querySelector('.side-profile .name');
    if (sideName) sideName.textContent = fallbackName;
    var sideEmail = document.getElementById('side-email');
    if (sideEmail) sideEmail.textContent = displayEmail;
    var menuName = document.querySelector('.profile-menu .pm-name');
    if (menuName) menuName.textContent = fallbackName;
    var menuEmail = document.getElementById('pm-email');
    if (menuEmail) menuEmail.textContent = displayEmail;
    var sideAvatar = document.getElementById('side-avatar');
    if (sideAvatar) sideAvatar.textContent = initial;
  }
