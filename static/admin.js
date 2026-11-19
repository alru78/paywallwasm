const client = window.createLNbitsExtensionClient({extensionId: 'paywallwasm'})

const state = {
  editingId: null,
  support: null,
  paywalls: [],
  wallets: []
}

const $ = selector => document.querySelector(selector)
const form = $('#paywall-form')
const saveButton = $('#save-button')
const cancelButton = $('#cancel-button')
const list = $('#paywall-list')

saveButton.addEventListener('click', () => save().catch(showError))
cancelButton.addEventListener('click', resetForm)

init().catch(showError)

async function init() {
  const [{wallets}, {currencies}] = await Promise.all([
    client.listWallets(),
    client.listCurrencies()
  ])
  state.wallets = wallets || []
  fillSelect(
    field('walletId'),
    state.wallets.map(wallet => [wallet.id, wallet.name || wallet.id])
  )
  fillSelect(
    field('currency'),
    (currencies || ['sat']).map(currency => [currency, currency])
  )
  await refresh()
}

async function refresh() {
  const [response, support] = await Promise.all([
    client.listPaywalls({limit: 100}),
    client.getDeveloperSupport()
  ])
  state.paywalls = response.paywalls || []
  state.support = support
  renderSupportHint()
  renderList()
  renderSupportPanel()
}

function renderSupportHint() {
  const s = state.support
  if (!s) return
  $('#support-label').textContent =
    `Support the developer with ${s.feePercent}% of this paywall's payments`
  $('#support-hint').textContent =
    `Off by default. When on, ${s.feePercent}% of each payment is collected and sent ` +
    `from the paywall's wallet to ${s.lightningAddress} once at least ` +
    `${s.payoutThresholdSat} sats have built up (at most ${s.payoutMaxSat} sats per payout). ` +
    `LNbits asks you to approve these payouts for the wallet. You can switch it off any time.`
}

function renderSupportPanel() {
  const s = state.support
  const panel = $('#support-panel')
  const container = $('#support-wallets')
  container.textContent = ''
  const supported = new Set(
    state.paywalls.filter(p => p.supportDeveloper).map(p => p.walletId)
  )
  const rows = new Map((s?.wallets || []).map(row => [row.walletId, row]))
  for (const walletId of supported) {
    if (!rows.has(walletId)) rows.set(walletId, {walletId, owedSat: 0, paidSat: 0, payouts: 0, lastError: ''})
  }
  panel.hidden = rows.size === 0
  for (const row of rows.values()) {
    const name = state.wallets.find(w => w.id === row.walletId)?.name || row.walletId
    const children = [
      el('strong', {}, name),
      el(
        'div',
        {class: 'muted small'},
        `Collected, not yet sent: ${row.owedSat} sats · sent: ${row.paidSat} sats in ${row.payouts} payout(s)`
      )
    ]
    if (row.lastError) {
      children.push(el('div', {class: 'text-negative small'}, `Last payout failed: ${row.lastError}`))
    }
    children.push(
      el('div', {class: 'actions'}, [
        button('Approve payouts for this wallet', () => requestPayoutPermission(row.walletId))
      ])
    )
    container.append(el('article', {class: 'item'}, children))
  }
}

async function requestPayoutPermission(walletId) {
  const s = state.support
  await client.requestBackgroundPaymentPermission({
    wallet_id: walletId,
    max_amount: s?.payoutMaxSat || 1000,
    destination_policy: 'external_allowed'
  })
}

async function save() {
  saveButton.disabled = true
  try {
    const payload = {
      memo: field('memo').value,
      description: field('description').value,
      url: field('url').value,
      amount: Number(field('amount').value),
      currency: field('currency').value,
      walletId: field('walletId').value,
      remembers: field('remembers').checked,
      supportDeveloper: field('supportDeveloper').checked
    }
    if (state.editingId) {
      await client.updatePaywall(state.editingId, payload)
      client.notify('Paywall updated').catch(() => {})
    } else {
      await client.createPaywall(payload)
      client.notify('Paywall created').catch(() => {})
    }
    if (payload.supportDeveloper) {
      // Payouts need the user's grant for this wallet; without it the fee is
      // only collected and the panel shows why payouts fail.
      await requestPayoutPermission(payload.walletId).catch(() => {})
    }
    resetForm()
    await refresh()
  } finally {
    saveButton.disabled = false
  }
}

function edit(paywall) {
  state.editingId = paywall.id
  field('memo').value = paywall.memo
  field('description').value = paywall.description
  field('url').value = paywall.url
  field('amount').value = String(paywall.amount)
  field('currency').value = paywall.currency
  field('walletId').value = paywall.walletId
  field('remembers').checked = paywall.remembers
  field('supportDeveloper').checked = paywall.supportDeveloper
  $('#form-title').textContent = 'Edit paywall'
  saveButton.textContent = 'Save changes'
  cancelButton.hidden = false
  window.scrollTo(0, 0)
}

function resetForm() {
  state.editingId = null
  for (const name of ['memo', 'description', 'url']) field(name).value = ''
  field('amount').value = '100'
  field('currency').value = 'sat'
  field('remembers').checked = false
  field('supportDeveloper').checked = false
  $('#form-title').textContent = 'New paywall'
  saveButton.textContent = 'Create paywall'
  cancelButton.hidden = true
}

// The sandboxed iframe has no allow-modals, so window.confirm() is unavailable:
// the first click arms the button, the second one deletes.
async function remove(paywall, node) {
  if (node.dataset.armed !== 'true') {
    node.dataset.armed = 'true'
    node.textContent = 'Click again to delete'
    window.setTimeout(() => {
      node.dataset.armed = 'false'
      node.textContent = 'Delete'
    }, 4000)
    return
  }
  await client.deletePaywall(paywall.id)
  if (state.editingId === paywall.id) resetForm()
  await refresh()
}

async function showPayments(paywall, container) {
  const {payments, total} = await client.listPayments(paywall.id, {limit: 25})
  container.textContent = ''
  if (!total) {
    container.append(el('p', {class: 'muted'}, 'No payments yet.'))
  } else {
    const sum = payments.reduce((acc, payment) => acc + payment.amountSat, 0)
    container.append(
      el('p', {class: 'muted'}, `${total} payment(s); latest ${payments.length}: ${sum.toLocaleString()} sats`)
    )
    for (const payment of payments) {
      container.append(
        el(
          'div',
          {class: 'payment'},
          `${new Date(payment.paidAt * 1000).toLocaleString()} · ${payment.amountSat.toLocaleString()} sats`
        )
      )
    }
  }
  container.hidden = false
}

function renderList() {
  list.textContent = ''
  $('#empty').hidden = state.paywalls.length > 0
  for (const paywall of state.paywalls) {
    const link = publicLink(paywall.id)
    const payments = el('div', {class: 'payments', hidden: true})
    list.append(
      el('article', {class: 'item'}, [
        el('div', {class: 'item-head'}, [
          el('strong', {}, paywall.memo),
          el('span', {class: 'muted'}, formatPrice(paywall.amount, paywall.currency))
        ]),
        el('div', {class: 'muted small'}, `Wallet: ${paywall.walletName || paywall.walletId}`),
        el('div', {class: 'muted small url'}, `Unlocks: ${paywall.url}`),
        paywall.supportDeveloper
          ? el('div', {class: 'muted small'}, `Developer support: ${state.support?.feePercent ?? 1}%`)
          : '',
        el('div', {class: 'actions'}, [
          button('Open public page', () => client.openNewTab(link)),
          button('Copy link', () => copy(link)),
          button('Payments', () => showPayments(paywall, payments)),
          button('Edit', () => edit(paywall)),
          button('Delete', node => remove(paywall, node), 'text-negative')
        ]),
        payments
      ])
    )
  }
}

function publicLink(paywallId) {
  return `${window.location.origin}/ext/paywallwasm/${encodeURIComponent(paywallId)}`
}

function button(label, onClick, extraClass = 'text-grey-2') {
  const node = el('button', {class: `q-btn ${extraClass}`, type: 'button'}, label)
  node.addEventListener('click', () => {
    Promise.resolve(onClick(node)).catch(showError)
  })
  return node
}

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) node.setAttribute(name, '')
    else if (value !== false && value !== undefined) node.setAttribute(name, value)
  }
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function fillSelect(select, options) {
  select.textContent = ''
  for (const [value, label] of options) {
    select.append(el('option', {value}, label))
  }
}

function field(name) {
  return form.querySelector(`[name="${name}"]`)
}

function copy(text) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => client.notify('Copied'))
    .catch(() => client.notifyError('Copying is not available here.'))
}

function formatPrice(amount, currency) {
  if (currency === 'sat') return `${Number(amount).toLocaleString()} sats`
  return `${Number(amount).toFixed(2)} ${currency}`
}

function showError(error) {
  client.notifyError(error).catch(() => {})
}
