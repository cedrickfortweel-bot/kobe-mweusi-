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
    /* Keep the persistent sidebar and profile menu in sync immediately after sign-in. */
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
