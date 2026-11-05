(function () {
  const client = window.KobeSupabase.client;
  const loginPanel = document.getElementById('login-panel');
  const adminPanel = document.getElementById('admin-panel');
  const queue = document.getElementById('queue');
  const notice = document.getElementById('notice');
  const noticePanel = document.getElementById('notice-panel');
  const logoutButton = document.getElementById('logout');
  const mfaPanel = document.getElementById('mfa-panel');
  let staffRole = null;
  let staffUserId = null;
  let mfaFactorId = null;
  let mfaChallengeId = null;

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

  /* Call a function and keep the server's own words.
     The client turns a refused request into a generic HTTP error, but the
     body carries the reason the server gave, and that reason is the one
     staff need to read. */
  async function invoke(name, body) {
    const { data, error } = await client.functions.invoke(name, { body });
    if (!error) return data || {};
    let message = error.message || 'The request failed.';
    let failureReason = null;
    const context = error.context;
    if (context && typeof context.json === 'function') {
      try {
        const payload = await context.json();
        if (payload && payload.error) message = payload.error;
        if (payload && payload.reason) failureReason = payload.reason;
      } catch (parseError) { /* the body was not json */ }
    }
    const failure = new Error(message);
    failure.status = error.status || (context && context.status) || null;
    failure.reason = failureReason;
    throw failure;
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
    approve.hidden = staffRole !== 'admin';
    reject.hidden = staffRole !== 'admin' && staffRole !== 'support_agent';
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
      await invoke('kyc-review', { action: 'review', submission_id: id, decision, review_note: reviewNote.trim() });
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
      const data = await invoke('kyc-review', { action: 'list' });
      const submissions = data.submissions || [];
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

  /* ---------------- seller payouts ----------------
     A payout is a request for money that has already been released
     from escrow. The balance check is on the server, so this list is
     only what staff see before approving. */

  function renderPayout(payout) {
    const card = node('article', null, 'submission');
    const details = node('div');
    const actions = node('div');
    const amount = Number(payout.amount_tzs || 0).toLocaleString('en-US');
    details.append(node('h2', 'TSh ' + amount));
    details.append(node('div', `${payout.shop_name || 'Seller'} · ${payout.kobe_id || 'no Kobe ID'}`, 'meta'));
    details.append(node('div', `${payout.method || 'mobile money'} ${payout.destination || 'no destination'}`, 'meta'));
    details.append(node('div', `Requested ${new Date(payout.requested_at).toLocaleString()}`, 'meta'));
    details.append(node('div', `Seller balance: TSh ${Number(payout.seller_balance_tzs || 0).toLocaleString('en-US')}`, 'meta'));
    details.append(node('div', 'Status: ' + (payout.status || 'requested'), 'status-pill'));

    if (staffRole === 'admin') {
      const request = node('button', 'Request second approval', 'btn admin-button admin-button-primary');
      request.type = 'button';
      request.addEventListener('click', () => requestPayoutApproval(payout, request));
      actions.append(request);
    } else {
      actions.append(node('div', 'Two-person administrator approval required.', 'meta'));
    }
    card.append(details, actions);
    return card;
  }

  async function requestPayoutApproval(payout, button) {
    const amount = Number(payout.amount_tzs || 0).toLocaleString('en-US');
    const reason = window.prompt(`Why should a second administrator approve the TSh ${amount} payout to ${payout.shop_name || 'this seller'}?`);
    if (reason === null) return;
    if (reason.trim().length < 5) return setNotice('Provide a reason of at least five characters.', true);
    button.disabled = true;
    try {
      await invoke('admin', { action: 'request-payout-approval', payout_id: payout.id, reason: reason.trim() });
      setNotice(`Second approval requested for the TSh ${amount} payout.`);
      await loadApprovals();
      await loadPayouts();
    } catch (error) {
      button.disabled = false;
      setNotice(error.message || 'Could not request payout approval.', true);
    }
  }

  async function loadPayouts() {
    const list = document.getElementById('payout-queue');
    if (!list) return;
    try {
      const data = await invoke('seller', { action: 'payouts' });
      const payouts = data.payouts || [];
      const count = document.getElementById('payout-count');
      const metric = document.getElementById('metric-payouts');
      if (count) count.textContent = payouts.length ? `${payouts.length} waiting` : 'Queue clear';
      if (metric) metric.textContent = String(payouts.length);
      list.replaceChildren();
      if (!payouts.length) {
        list.append(node('div', 'No payouts are waiting for approval.', 'empty'));
        return;
      }
      payouts.forEach(payout => list.append(renderPayout(payout)));
    } catch (error) {
      setNotice(error.message || 'Could not load the payout queue.', true);
    }
  }

  /* ---------------- the delivery agent network ----------------
     An agent may only scan an order they have been assigned, so the two
     decisions staff make here are: who is an agent, and which orders
     they carry. Both are enforced by the database, not by this page. */

  function agentOptionLabel(agent) {
    const name = agent.display_name || 'Unnamed agent';
    const worker = agent.worker_id ? ` · ${agent.worker_id}` : '';
    return `${name}${worker}`;
  }

  function renderAgent(agent) {
    const card = node('article', null, 'submission');
    const details = node('div');
    const actions = node('div');

    details.append(node('h2', agent.display_name || 'Unnamed agent'));
    details.append(node('div', `Worker ID: ${agent.worker_id || 'not set'} · Region: ${agent.region || 'not set'}`, 'meta'));
    details.append(node('div', agent.phone_e164 || 'No phone on file', 'meta'));
    details.append(node('div', 'Status: ' + (agent.verification_status || 'unverified'), 'status-pill'));

    const assignments = agent.assignments || [];
    details.append(node('div', assignments.length
      ? `Carrying ${assignments.length} order(s): ${assignments.map(row => row.ref || row.order_id).join(', ')}`
      : 'Not carrying any orders right now.', 'meta'));

    const worker = document.createElement('input');
    worker.type = 'text';
    worker.maxLength = 12;
    worker.placeholder = 'KMW-12XL';
    worker.value = agent.worker_id || '';
    worker.setAttribute('aria-label', 'Worker ID');

    const region = document.createElement('input');
    region.type = 'text';
    region.maxLength = 80;
    region.placeholder = 'Dar es Salaam';
    region.value = agent.region || '';
    region.setAttribute('aria-label', 'Region');

    const workerField = node('div', null, 'form-field');
    workerField.append(node('label', 'Worker ID'), worker);
    const regionField = node('div', null, 'form-field');
    regionField.append(node('label', 'Region'), region);

    const save = node('button', 'Save worker ID', 'btn admin-button admin-button-primary');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await invoke('seller', {
          action: 'set-agent-identity',
          agent_id: agent.user_id,
          worker_id: worker.value.trim() || null,
          region: region.value.trim() || null,
        });
        setNotice(`Worker ID saved for ${agent.display_name || 'the agent'}.`);
        await loadAgents();
      } catch (error) {
        save.disabled = false;
        setNotice(error.message || 'Could not save the worker ID.', true);
      }
    });

    const verified = agent.verification_status === 'verified';
    const toggle = node('button', verified ? 'Suspend' : 'Verify', 'btn admin-button' + (verified ? ' btn-danger' : ' admin-button-primary'));
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      if (!window.confirm(`${verified ? 'Suspend' : 'Verify'} ${agent.display_name || 'this agent'}?`)) return;
      toggle.disabled = true;
      try {
        await invoke('seller', {
          action: 'set-agent-verification',
          agent_id: agent.user_id,
          verified: !verified,
        });
        setNotice(`${agent.display_name || 'The agent'} is now ${verified ? 'suspended' : 'verified'}.`);
        await loadAgents();
      } catch (error) {
        toggle.disabled = false;
        setNotice(error.message || 'Could not change the agent status.', true);
      }
    });

    const controls = node('div', null, 'actions');
    controls.append(save, toggle);
    actions.append(workerField, regionField, controls);
    card.append(details, actions);
    return card;
  }

  async function loadAgents() {
    const list = document.getElementById('agent-list');
    if (!list) return;
    try {
      const agents = (await invoke('seller', { action: 'agents' })).agents || [];
      const count = document.getElementById('agent-count');
      const metric = document.getElementById('metric-agents');
      if (count) count.textContent = agents.length ? `${agents.length} agent(s)` : 'No agents yet';
      if (metric) metric.textContent = String(agents.length);

      list.replaceChildren();
      if (!agents.length) {
        list.append(node('div', 'No delivery agents have been registered yet.', 'empty'));
      } else {
        agents.forEach(agent => list.append(renderAgent(agent)));
      }

      const select = document.getElementById('assign-agent');
      if (select) {
        const chosen = select.value;
        select.replaceChildren();
        agents.filter(agent => agent.verification_status === 'verified').forEach(agent => {
          const option = document.createElement('option');
          option.value = agent.user_id;
          option.textContent = agentOptionLabel(agent);
          select.append(option);
        });
        if (chosen) select.value = chosen;
      }
    } catch (error) {
      setNotice(error.message || 'Could not load the agent network.', true);
    }
  }

  async function assignAgent(event) {
    event.preventDefault();
    const orderRef = document.getElementById('assign-order').value.trim().toUpperCase();
    const agentId = document.getElementById('assign-agent').value;
    if (!/^KM-\d{6}$/.test(orderRef)) { setNotice('Enter a valid order reference, like KM-000001.', true); return; }
    if (!agentId) { setNotice('Choose an agent first.', true); return; }
    try {
      await invoke('seller', { action: 'assign-agent', order_ref: orderRef, agent_id: agentId });
      setNotice(`Order ${orderRef} assigned. The agent can now scan for it.`);
      document.getElementById('assign-order').value = '';
      await loadAgents();
    } catch (error) {
      setNotice(error.message || 'Could not assign the agent.', true);
    }
  }

  /* ---------------- the platform, read from the server ----------------
     The dashboard used to show labels with no numbers behind them. These
     four panels read the same records the platform runs on, so what
     staff see is what the money and the orders actually are. */

  /* Money is large enough that a card has to show it short, but the
     exact figure is still one hover (or one tap) away. */
  function money(value) {
    const amount = Number(value || 0);
    if (amount >= 1e9) return 'TSh ' + (amount / 1e9).toFixed(1) + 'B';
    if (amount >= 1e6) return 'TSh ' + (amount / 1e6).toFixed(1) + 'M';
    if (amount >= 1e3) return 'TSh ' + Math.round(amount / 1e3) + 'K';
    return 'TSh ' + amount.toLocaleString('en-US');
  }

  function metric(label, value, note, exact) {
    const card = node('div', null, 'metric-block');
    card.append(node('span', label));
    card.append(node('strong', String(value)));
    if (note) card.append(node('em', note));
    if (exact) card.title = exact;
    return card;
  }

  function moneyMetric(label, value, note) {
    return metric(label, money(value), note, 'TSh ' + Number(value || 0).toLocaleString('en-US'));
  }

  function renderOverview(overview) {
    const grid = document.getElementById('overview-grid');
    if (!grid) return;
    const orders = overview.orders || {};
    const queues = overview.queues || {};
    const moneyBlock = overview.money || {};
    const people = overview.people || {};

    grid.replaceChildren();
    grid.append(
      metric('Orders in escrow', orders.in_escrow || 0, 'Money is held for these'),
      moneyMetric('Money held', moneyBlock.held_in_escrow || 0, 'Left by buyers, not yet with sellers'),
      moneyMetric('On hold', moneyBlock.on_hold || 0, 'Frozen while a dispute is open'),
      metric('Open disputes', queues.disputes || 0, 'Waiting for a decision'),
      metric('Pending verifications', queues.kyc || 0, 'Sellers waiting for review'),
      metric('Pending payouts', queues.payouts || 0, 'Money ready to go out'),
      metric('People', (people.buyers || 0) + (people.sellers || 0), `${people.buyers || 0} buyers, ${people.sellers || 0} sellers`),
      metric('Agents', queues.agents || 0, 'Delivery agents on the network'),
    );

    const escrowMetric = document.getElementById('metric-escrow');
    if (escrowMetric) escrowMetric.textContent = money(moneyBlock.held_in_escrow);
    const disputeMetric = document.getElementById('metric-disputes');
    if (disputeMetric) disputeMetric.textContent = String(queues.disputes || 0);
  }

  function renderAnalytics(overview) {
    const grid = document.getElementById('analytics-grid');
    if (!grid) return;
    const activity = overview.activity || {};
    const moneyBlock = overview.money || {};
    const people = overview.people || {};
    const orders = overview.orders || {};

    grid.replaceChildren();
    grid.append(
      metric('Orders in 24 hours', activity.orders_24h || 0, 'New orders'),
      metric('Orders in 7 days', activity.orders_7d || 0, 'New orders'),
      metric('Released in 7 days', activity.released_7d || 0, 'Escrow releases'),
      metric('Completed orders', orders.completed || 0, 'Delivered and released'),
      moneyMetric('Platform fees', moneyBlock.platform_fees || 0, 'Earned on released escrow'),
      metric('Verified sellers', people.verified_sellers || 0, `of ${people.sellers || 0} sellers`),
    );
  }

  function renderFinance(overview) {
    const grid = document.getElementById('finance-grid');
    if (!grid) return;
    const moneyBlock = overview.money || {};
    grid.replaceChildren();
    grid.append(
      moneyMetric('Held in escrow', moneyBlock.held_in_escrow || 0, 'Owed to sellers'),
      moneyMetric('On hold', moneyBlock.on_hold || 0, 'Frozen by a dispute'),
      moneyMetric('Released to sellers', moneyBlock.released_to_sellers || 0, 'Paid out of escrow'),
      moneyMetric('Platform fees', moneyBlock.platform_fees || 0, 'Revenue'),
      moneyMetric('Pending payouts', moneyBlock.pending_payouts || 0, 'Approved money waiting to go out'),
    );
  }

  function renderOrder(order) {
    const card = node('article', null, 'submission');
    const details = node('div');
    const amount = Number(order.total_due_tzs || 0).toLocaleString('en-US');
    details.append(node('h2', `${order.ref} · ${order.item_name}`));
    details.append(node('div', `${order.buyer_name || 'Buyer'} · ${order.seller_name || 'Seller'}`, 'meta'));
    details.append(node('div', `TSh ${amount} · ${order.quantity || 1} item(s)`, 'meta'));
    details.append(node('div', `Placed ${new Date(order.created_at).toLocaleString()}`, 'meta'));
    details.append(node('div', 'Order: ' + (order.status || 'unknown'), 'status-pill'));
    details.append(node('div', 'Escrow: ' + (order.escrow_status || 'none'), 'status-pill'));
    if (order.open_dispute) details.append(node('div', 'A dispute is open on this order.', 'status-pill'));
    card.append(details);
    return card;
  }

  async function loadOrders(query) {
    const list = document.getElementById('order-list');
    if (!list) return;
    try {
      const data = await invoke('admin', { action: 'orders', query: query || null, limit: 50 });
      const orders = data.orders || [];
      const count = document.getElementById('order-count');
      if (count) count.textContent = orders.length ? `${orders.length} shown` : 'No orders';
      list.replaceChildren();
      if (!orders.length) {
        list.append(node('div', query ? 'No order matches that search.' : 'No orders yet.', 'empty'));
        return;
      }
      orders.forEach(order => list.append(renderOrder(order)));
    } catch (error) {
      setNotice(error.message || 'Could not load the orders.', true);
    }
  }

  function renderDispute(dispute) {
    const card = node('article', null, 'submission');
    const details = node('div');
    const actions = node('div');
    const amount = Number(dispute.escrow_amount_tzs || 0).toLocaleString('en-US');
    details.append(node('h2', `${dispute.order_ref} · ${dispute.reason}`));
    details.append(node('div', `${dispute.buyer_name || 'Buyer'} vs ${dispute.seller_name || 'Seller'}`, 'meta'));
    details.append(node('div', `TSh ${amount} in escrow`, 'meta'));
    details.append(node('div', `Opened ${new Date(dispute.opened_at).toLocaleString()}`, 'meta'));
    details.append(node('div', 'Status: ' + (dispute.status || 'open'), 'status-pill'));
    if (dispute.overdue) {
      details.append(node('div', `Past the seller deadline of ${new Date(dispute.seller_deadline).toLocaleString()}`, 'status-pill'));
    }
    if (dispute.status === 'resolved' && !dispute.financial_action) {
      details.append(node('div', `Decision: ${dispute.outcome} · TSh ${Number(dispute.buyer_amount_tzs || 0).toLocaleString('en-US')} buyer / TSh ${Number(dispute.seller_amount_tzs || 0).toLocaleString('en-US')} seller`, 'meta'));
      if (staffRole === 'admin') {
        const request = node('button', 'Request second approval', 'btn admin-button admin-button-primary');
        request.type = 'button';
        request.addEventListener('click', () => requestDisputeApproval(dispute, request));
        actions.append(request);
      } else {
        actions.append(node('div', 'Waiting for an administrator to request financial execution.', 'meta'));
      }
    } else if (dispute.status !== 'resolved') {
      const reason = node('textarea', null, 'review-note');
      reason.maxLength = 1000;
      reason.placeholder = 'Required decision reason';
      actions.append(reason);
      const controls = node('div', null, 'actions');
      [
        ['buyer_refund', 'Refund buyer'],
        ['seller_release', 'Release to seller'],
        ['split', 'Split escrow'],
      ].forEach(([decision, label]) => {
        const button = node('button', label, 'btn admin-button admin-button-primary');
        button.type = 'button';
        button.addEventListener('click', () => recordDisputeDecision(dispute, decision, reason.value, button));
        controls.append(button);
      });
      actions.append(controls);
    }
    card.append(details, actions);
    return card;
  }

  async function recordDisputeDecision(dispute, decision, reason, button) {
    const cleanReason = reason.trim();
    if (cleanReason.length < 5) return setNotice('Provide a reason of at least five characters.', true);
    const escrow = Number(dispute.escrow_amount_tzs || 0);
    let buyerAmount = decision === 'buyer_refund' ? escrow : 0;
    if (decision === 'split') {
      const entered = window.prompt(`Enter the buyer refund in whole TSh (0–${escrow}). The remainder goes to the seller.`);
      if (entered === null) return;
      buyerAmount = Number(entered);
      if (!Number.isSafeInteger(buyerAmount) || buyerAmount < 0 || buyerAmount > escrow) {
        return setNotice('Enter a whole TSh amount within the escrow balance.', true);
      }
    }
    const label = decision.replace('_', ' ');
    if (!window.confirm(`Record "${label}" for ${dispute.order_ref}? This closes the review and leaves financial execution pending a second administrator.`)) return;
    button.disabled = true;
    try {
      await invoke('admin', {
        action: 'record-dispute-decision',
        dispute_id: dispute.id,
        decision,
        reason: cleanReason,
        buyer_amount_tzs: buyerAmount,
      });
      setNotice(`Decision recorded for ${dispute.order_ref}. Request a second administrator approval to move the funds.`);
      await loadDisputes();
      await loadOverview();
    } catch (error) {
      button.disabled = false;
      setNotice(error.message || 'Could not record the dispute decision.', true);
    }
  }

  async function requestDisputeApproval(dispute, button) {
    const reason = window.prompt(`Why should a second administrator approve this ${dispute.outcome} outcome for ${dispute.order_ref}?`);
    if (reason === null) return;
    if (reason.trim().length < 5) return setNotice('Provide a reason of at least five characters.', true);
    button.disabled = true;
    try {
      await invoke('admin', { action: 'request-dispute-approval', dispute_id: dispute.id, reason: reason.trim() });
      setNotice(`Second approval requested for ${dispute.order_ref}.`);
      await loadApprovals();
    } catch (error) {
      button.disabled = false;
      setNotice(error.message || 'Could not request dispute approval.', true);
    }
  }

  async function loadDisputes() {
    const list = document.getElementById('dispute-list');
    if (!list) return;
    try {
      const data = await invoke('admin', { action: 'disputes', limit: 50 });
      const disputes = data.disputes || [];
      const count = document.getElementById('dispute-count');
      if (count) count.textContent = disputes.length ? `${disputes.length} need action` : 'None open';
      list.replaceChildren();
      if (!disputes.length) {
        list.append(node('div', 'No disputes need action.', 'empty'));
        return;
      }
      disputes.forEach(dispute => list.append(renderDispute(dispute)));
    } catch (error) {
      setNotice(error.message || 'Could not load the disputes.', true);
    }
  }

  function renderApproval(approval) {
    const card = node('article', null, 'submission');
    const details = node('div');
    const actions = node('div');
    const kind = approval.action === 'payout.approve' ? 'Payout' : 'Dispute outcome';
    details.append(node('h2', `${kind} approval · ${approval.status}`));
    const targetLabel = approval.action === 'payout.approve'
      ? `${approval.payload?.shop_name || 'Seller'}${approval.payload?.kobe_id ? ` · ${approval.payload.kobe_id}` : ''}`
      : `Order ${approval.payload?.order_ref || approval.target_id} · ${approval.payload?.outcome || 'dispute outcome'}`;
    details.append(node('div', `Target: ${targetLabel}`, 'meta'));
    if (approval.amount_tzs) details.append(node('div', `Amount: TSh ${Number(approval.amount_tzs).toLocaleString('en-US')}`, 'meta'));
    details.append(node('div', `Requested ${new Date(approval.created_at).toLocaleString()}`, 'meta'));
    details.append(node('div', `Reason: ${approval.reason}`, 'meta'));
    if (approval.requested_by === staffUserId) {
      actions.append(node('div', 'A different administrator must approve this request.', 'meta'));
    } else {
      const approve = node('button', approval.status === 'pending' ? 'Approve & execute' : 'Retry execution', 'btn admin-button admin-button-primary');
      approve.type = 'button';
      approve.addEventListener('click', async () => {
        if (!window.confirm(`Approve and execute this ${kind.toLowerCase()}? This action moves funds.`)) return;
        approve.disabled = true;
        try {
          await invoke('admin', { action: 'approve-admin-request', request_id: approval.id });
          setNotice(`${kind} approved and executed.`);
          await Promise.all([loadApprovals(), loadPayouts(), loadDisputes(), loadOverview()]);
        } catch (error) {
          approve.disabled = false;
          setNotice(error.message || `Could not execute the ${kind.toLowerCase()}.`, true);
        }
      });
      actions.append(approve);
    }
    card.append(details, actions);
    return card;
  }

  async function loadApprovals() {
    const list = document.getElementById('approval-list');
    if (!list || staffRole !== 'admin') return;
    try {
      const data = await invoke('admin', { action: 'approvals' });
      const approvals = data.approvals || [];
      const count = document.getElementById('approval-count');
      if (count) count.textContent = approvals.length ? `${approvals.length} waiting` : 'Queue clear';
      list.replaceChildren();
      if (!approvals.length) {
        list.append(node('div', 'No approvals are waiting.', 'empty'));
        return;
      }
      approvals.forEach(approval => list.append(renderApproval(approval)));
    } catch (error) {
      setNotice(error.message || 'Could not load approval requests.', true);
    }
  }

  async function loadAudit() {
    const list = document.getElementById('audit-list');
    if (!list) return;
    try {
      const data = await invoke('admin', { action: 'audit', limit: 50 });
      const entries = data.entries || [];
      const count = document.getElementById('audit-count');
      if (count) count.textContent = entries.length ? `${entries.length} entries` : 'Nothing recorded yet';
      list.replaceChildren();
      if (!entries.length) {
        list.append(node('div', 'No actions have been recorded yet.', 'empty'));
        return;
      }
      entries.forEach(entry => {
        const card = node('article', null, 'submission');
        const details = node('div');
        details.append(node('h2', entry.action));
        details.append(node('div', `${entry.actor_role || 'staff'} · ${new Date(entry.created_at).toLocaleString()}`, 'meta'));
        if (entry.target_type) details.append(node('div', `Target: ${entry.target_type}`, 'meta'));
        if (entry.reason) details.append(node('div', entry.reason, 'meta'));
        card.append(details);
        list.append(card);
      });
    } catch (error) {
      setNotice(error.message || 'Could not load the audit trail.', true);
    }
  }

  async function loadOverview() {
    try {
      const data = await invoke('admin', { action: 'overview' });
      const overview = data.overview || {};
      renderOverview(overview);
      renderAnalytics(overview);
      renderFinance(overview);
    } catch (error) {
      setNotice(error.message || 'Could not load the operations overview.', true);
    }
  }

  function setMfaNotice(message, error) {
    const target = document.getElementById('mfa-notice');
    target.textContent = message || '';
    target.hidden = !message;
    target.classList.toggle('error', !!error);
  }

  async function prepareMfa() {
    loginPanel.hidden = true;
    adminPanel.hidden = true;
    mfaPanel.hidden = false;
    setMfaNotice('', false);

    const qr = document.getElementById('mfa-qr');
    const secretWrap = document.getElementById('mfa-secret-wrap');
    const help = document.getElementById('mfa-help');
    qr.hidden = true;
    secretWrap.hidden = true;

    const { data: factors, error: factorsError } = await client.auth.mfa.listFactors();
    if (factorsError) throw factorsError;

    const verifiedFactor = (factors.totp || []).find(factor => factor.status === 'verified');
    if (verifiedFactor) {
      mfaFactorId = verifiedFactor.id;
      help.textContent = 'Enter the current 6-digit code from your authenticator app.';
    } else {
      const { data: enrollment, error: enrollmentError } = await client.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Kobe Mweusi admin',
      });
      if (enrollmentError) throw enrollmentError;
      mfaFactorId = enrollment.id;
      help.textContent = 'Set up an authenticator app using the QR code or setup key, then enter its 6-digit code.';
      if (enrollment.totp?.qr_code) {
        qr.src = enrollment.totp.qr_code;
        qr.hidden = false;
      }
      if (enrollment.totp?.secret) {
        document.getElementById('mfa-secret').textContent = enrollment.totp.secret;
        secretWrap.hidden = false;
      }
    }

    const { data: challenge, error: challengeError } = await client.auth.mfa.challenge({
      factorId: mfaFactorId,
    });
    if (challengeError) throw challengeError;
    mfaChallengeId = challenge.id;
    document.getElementById('mfa-code').focus();
  }

  async function showAdmin() {
    try {
      const access = await invoke('admin', { action: 'access' });
      staffRole = access.role;
      document.body.classList.add('admin-authenticated');
      document.getElementById('approvals').hidden = staffRole !== 'admin';
      mfaPanel.hidden = true;
      loginPanel.hidden = true;
      adminPanel.hidden = false;
      logoutButton.hidden = false;
      const { data, error } = await client.auth.getUser();
      if (error) throw error;
      staffUserId = data.user ? data.user.id : null;
      const staffName = data.user ? data.user.email || data.user.id : '';
      document.getElementById('staff-label').textContent = staffName;
      const staffAvatar = document.getElementById('staff-avatar');
      if (staffAvatar) staffAvatar.textContent = (staffName.trim().charAt(0) || 'A').toUpperCase();
      await loadQueue();
      await loadPayouts();
      await loadApprovals();
      await loadAgents();
      await loadOverview();
      await loadOrders();
      await loadDisputes();
      await loadAudit();
    } catch (error) {
      document.body.classList.remove('admin-authenticated');
      adminPanel.hidden = true;
      logoutButton.hidden = true;
      if (error.reason === 'MFA_REQUIRED') {
        try {
          await prepareMfa();
        } catch (mfaError) {
          mfaPanel.hidden = false;
          setMfaNotice(mfaError.message || 'Could not start multi-factor authentication.', true);
        }
        return;
      }
      mfaPanel.hidden = true;
      loginPanel.hidden = false;
      setNotice(error.message || 'Could not verify staff access.', true);
    }
  }

  document.getElementById('mfa-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('mfa-submit');
    button.disabled = true;
    setMfaNotice('', false);
    try {
      const { error } = await client.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: mfaChallengeId,
        code: document.getElementById('mfa-code').value.trim(),
      });
      if (error) throw error;
      document.getElementById('mfa-code').value = '';
      await showAdmin();
    } catch (error) {
      setMfaNotice(error.message || 'That code could not be verified. Try again.', true);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('mfa-cancel').addEventListener('click', async () => {
    const { error } = await client.auth.signOut();
    if (error) return setMfaNotice(error.message || 'Could not sign out.', true);
    mfaPanel.hidden = true;
    loginPanel.hidden = false;
  });

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
  document.getElementById('refresh').addEventListener('click', () => {
    loadQueue();
    loadPayouts();
    loadApprovals();
    loadAgents();
    loadOverview();
    loadOrders(document.getElementById('order-query')?.value);
    loadDisputes();
    loadAudit();
  });
  document.getElementById('assign-form')?.addEventListener('submit', assignAgent);
  document.getElementById('order-search')?.addEventListener('submit', event => {
    event.preventDefault();
    loadOrders(document.getElementById('order-query').value.trim());
  });
  logoutButton.addEventListener('click', async () => {
    await client.auth.signOut();
    location.reload();
  });

  client.auth.getSession().then(({ data }) => {
    if (data.session) showAdmin();
  });
})();