const client = window.createLNbitsExtensionClient({extensionId: 'paywallwasm'})

const state = {
  paywall: null,
  paywallId: null,
  invoice: null,
  qrApp: null,
  unsubscribe: null,
  url: ''
}

const $ = selector => document.querySelector(selector)
const statusText = $('#status')
const paywallSection = $('#paywall')
const invoiceSection = $('#invoice')
const unlockedSection = $('#unlocked')
const payButton = $('#pay-button')

payButton.addEventListener('click', () => createInvoice().catch(showError))
$('#copy-button').addEventListener('click', () => copy(state.invoice?.paymentRequest))
$('#copy-url-button').addEventListener('click', () => copy(state.url))
$('#open-button').addEventListener('click', () => {
  client.openNewTab(state.url).catch(showError)
})

init().catch(showError)

async function init() {
  const context = await client.context()
  state.paywallId = context.routeParams?.paywallId || null
  if (!state.paywallId) throw new Error('Paywall not found.')

  const {paywall} = await client.getPublicPaywall(state.paywallId)
  state.paywall = paywall
  $('#memo').textContent = paywall.memo
  $('#description').textContent = paywall.description
  $('#price').textContent = formatPrice(paywall.amount, paywall.currency)
  statusText.hidden = true
  paywallSection.hidden = false

  if (paywall.remembers) {
    const remembered = await rememberedPaymentHash()
    if (remembered && (await unlockWith(remembered))) return
  }
}

async function createInvoice() {
  payButton.disabled = true
  try {
    state.invoice = await client.createInvoice(state.paywallId)
    renderQrCode(state.invoice.paymentRequest)
    $('#invoice-status').textContent = 'Waiting for payment…'
    invoiceSection.hidden = false
    await watchPayment(state.invoice.paymentHash)
  } finally {
    payButton.disabled = false
  }
}

async function watchPayment(paymentHash) {
  stopWatching()
  state.unsubscribe = await client.subscribePayment(paymentHash, event => {
    if (event.event === 'payment.error') {
      $('#invoice-status').textContent = 'Lost the payment listener. Reload the page after paying.'
      return
    }
    const payment = event.data || {}
    if (event.event === 'payment.settled' || payment.pending === false) {
      // The bridge event is only a hint; the server decides whether it unlocks.
      waitForUnlock(paymentHash).catch(showError)
    }
  })
}

async function waitForUnlock(paymentHash) {
  $('#invoice-status').textContent = 'Payment received, unlocking…'
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await unlockWith(paymentHash)) return
    await sleep(1000)
  }
  $('#invoice-status').textContent =
    'Payment received but not confirmed yet. Reload the page in a moment.'
}

async function unlockWith(paymentHash) {
  const result = await client.checkPayment(state.paywallId, paymentHash)
  if (!result.paid) return false

  stopWatching()
  state.url = result.url
  if (result.remembers) {
    await client.sessionSet(sessionKey(), paymentHash).catch(() => {})
  }
  $('#unlocked-url').textContent = result.url
  paywallSection.hidden = true
  invoiceSection.hidden = true
  unlockedSection.hidden = false
  return true
}

async function rememberedPaymentHash() {
  try {
    const response = await client.sessionGet(sessionKey())
    return response?.value || ''
  } catch {
    return ''
  }
}

function sessionKey() {
  return `unlock:${state.paywallId}`
}

function renderQrCode(value) {
  if (state.qrApp) state.qrApp.unmount()
  const container = $('#qrcode')
  container.textContent = ''
  if (!window.Vue || !window.QrcodeVue?.default) {
    container.textContent = value
    return
  }
  state.qrApp = window.Vue.createApp({
    render() {
      return window.Vue.h(window.QrcodeVue.default, {
        value: `lightning:${value}`.toUpperCase(),
        size: 280,
        margin: 3,
        level: 'Q',
        renderAs: 'svg',
        class: 'qrcode-svg'
      })
    }
  })
  state.qrApp.mount(container)
}

function stopWatching() {
  if (!state.unsubscribe) return
  state.unsubscribe()
  state.unsubscribe = null
}

function copy(text) {
  if (!text) return
  navigator.clipboard
    ?.writeText(text)
    .then(() => client.notify('Copied'))
    .catch(() => client.notifyError('Copying is not available here.'))
}

function formatPrice(amount, currency) {
  if (currency === 'sat') return `${Number(amount).toLocaleString()} sats`
  return `${Number(amount).toFixed(2)} ${currency}`
}

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error)
  statusText.textContent = message
  statusText.hidden = false
  client.notifyError(message).catch(() => {})
}
