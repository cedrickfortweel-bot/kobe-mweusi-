(function () {
  const client = window.KobeSupabase.client;
  const loginPanel = document.getElementById('login-panel');
  const adminPanel = document.getElementById('admin-panel');
  const queue = document.getElementById('queue');
  const notice = document.getElementById('notice');
  const noticePanel = document.getElementById('notice-panel');
  const logoutButton = document.getElementById('logout');

  function setNotice(message, error) {
    [notice, noticePanel].filter(Boolean).forEach(target => {
      target.textContent = message || '';
      target.hidden = !message;
      target.classList.toggle('error', !!error);
    });
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function renderSubmission(submission) {
    const card = node('article', null, 'submission');
    const details = node('div');
    const actions = node('div');
    details.append(node('h2', submission.legal_name));
    details.append(node('div', `${submission.entity_type} · ${submission.status} · ${new Date(submission.submitted_at).toLocaleString()}`, 'meta'));
    if (submission.business_name) details.append(node('div', `Business: ${submission.business_name}`, 'meta'));
    if (submission.business_type) details.append(node('div', `Business type: ${submission.business_type}`, 'meta'));
    if (submission.registration_number) details.append(node('div', `Registration: ${submission.registration_number}`, 'meta'));
    if (submission.region) details.append(node('div', `Region: ${submission.region}`, 'meta'));
    if (submission.representative_role) details.append(node('div', `Representative: ${submission.representative_role}`, 'meta'));
    details.append(node('div', `Seller: ${submission.seller_id} · ID ending ${submission.id_last4 || '—'} · TIN ending ${submission.tax_id_last4 || '—'}`, 'meta'));
    if (submission.seller_profiles?.kobe_id) details.append(node('div', `Kobe ID: ${submission.seller_profiles.kobe_id}`, 'meta kobe-id'));
    details.append(node('div', 'Review state: ' + (submission.status === 'under_review' ? 'In review' : 'Waiting for review'), 'status-pill'));

    const documents = node('div', null, 'docs');
    (submission.documents || []).forEach((document, index) => {
      const link = node('a');
      link.href = document.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `Document ${index + 1}`;
      documents.append(link);
    });
    details.append(documents);

    const note = node('textarea', null, 'review-note');
    note.maxLength = 2000;
    note.placeholder = 'Required reason when rejecting; optional for approval';
    actions.append(note);
    const controls = node('div', null, 'actions');
    const approve = node('button', 'Approve', 'btn admin-button admin-button-primary');
    const reject = node('button', 'Reject', 'btn admin-button btn-danger');
    approve.type = reject.type = 'button';
    approve.addEventListener('click', () => decide(submission.id, 'approved', note.value, approve, reject));
    reject.addEventListener('click', () => decide(submission.id, 'rejected', note.value, approve, reject));
    controls.append(approve, reject);
    actions.append(controls);
    card.append(details, actions);
    return card;
  }

  async function decide(id, decision, reviewNote, approve, reject) {
    if (decision === 'rejected' && !reviewNote.trim()) return setNotice('Add a reason before rejecting a submission.', true);
    if (!window.confirm(`${decision === 'approved' ? 'Approve' : 'Reject'} this seller verification?`)) return;
    approve.disabled = reject.disabled = true;
    try {
      const { error } = await client.functions.invoke('kyc-review', {
        body: { action: 'review', submission_id: id, decision, review_note: reviewNote.trim() }
      });
      if (error) throw error;
      setNotice(`Submission ${decision}. The seller status has been updated.`);
      await loadQueue();
    } catch (error) {
      approve.disabled = reject.disabled = false;
      setNotice(error.message || 'Could not submit the review decision.', true);
    }
  }

  async function loadQueue() {
    setNotice('Loading verification queue…');
    queue.replaceChildren();
    try {
      const { data, error } = await client.functions.invoke('kyc-review', { body: { action: 'list' } });
      if (error) throw error;
      const submissions = data && data.submissions || [];
      const queueCount = document.getElementById('queue-count');
      const kycMetric = document.getElementById('metric-kyc');
      if (queueCount) queueCount.textContent = submissions.length ? `${submissions.length} waiting` : 'Queue clear';
      if (kycMetric) kycMetric.textContent = String(submissions.length);
      setNotice(submissions.length ? `${submissions.length} pending submission(s).` : 'No pending submissions.');
      if (!submissions.length) queue.append(node('div', 'No sellers are waiting for review.', 'empty'));
      submissions.forEach(submission => queue.append(renderSubmission(submission)));
    } catch (error) {
      setNotice(error.message || 'Could not load the verification queue.', true);
    }
  }

  async function showAdmin() {
    loginPanel.hidden = true;
    adminPanel.hidden = false;
    logoutButton.hidden = false;
    const { data } = await client.auth.getUser();
    const staffName = data.user ? data.user.email || data.user.id : ''; document.getElementById('staff-label').textContent = staffName; const staffAvatar = document.getElementById('staff-avatar'); if (staffAvatar) staffAvatar.textContent = (staffName.trim().charAt(0) || 'A').toUpperCase();
    await loadQueue();
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('login-button');
    button.disabled = true;
    setNotice('Signing in…');
    try {
      const { error } = await client.auth.signInWithPassword({
        email: document.getElementById('email').value.trim().toLowerCase(),
        password: document.getElementById('password').value
      });
      if (error) throw error;
      await showAdmin();
    } catch (error) {
      setNotice(error.message || 'Staff sign-in failed.', true);
    } finally {
      button.disabled = false;
    }
  });

  async function oauth(provider) {
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.href }
    });
    if (error) setNotice(error.message || 'Social sign-in is not available.', true);
  }

  document.getElementById('google-login')?.addEventListener('click', () => oauth('google'));
  document.getElementById('microsoft-login')?.addEventListener('click', () => oauth('azure'));
  document.getElementById('refresh').addEventListener('click', loadQueue);
  logoutButton.addEventListener('click', async () => {
    await client.auth.signOut();
    location.reload();
  });

  client.auth.getSession().then(({ data }) => {
    if (data.session) showAdmin();
  });
})();