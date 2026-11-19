const client = window.createLNbitsExtensionClient({extensionId: 'paywallwasm'})

const state = {
  editingId: null,
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
  const response = await client.listPaywalls({limit: 100})
  state.paywalls = response.paywalls || []
  renderList()
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
      remembers: field('remembers').checked
    }
    if (state.editingId) {
      await client.updatePaywall(state.editingId, payload)
      client.notify('Paywall updated').catch(() => {})
    } else {
      await client.createPaywall(payload)
      client.notify('Paywall created').catch(() => {})
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
