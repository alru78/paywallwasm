import assert from 'node:assert/strict'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {beforeEach, test} from 'node:test'
import {fileURLToPath, pathToFileURL} from 'node:url'

// Load index.js against an in-memory host that mimics LNbits' owner-scoped
// storage, public projection and wallet APIs.
const devDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(resolve(devDir, 'src/index.js'), 'utf8')
const modulePath = resolve(devDir, 'dist/index.test.mjs')
await mkdir(dirname(modulePath), {recursive: true})
await writeFile(
  modulePath,
  source.replace(
    /^import \{[^}]+\} from '\.\/lnbits-sdk\.js'\n/,
    'const {storage, system, utils, wallet} = globalThis.__paywallHost\n'
  ),
  'utf8'
)

const PUBLIC_FIELDS = ['id', 'memo', 'description', 'amount', 'currency', 'remembers']
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

let rows
let invoices
let owner
let wallets
let counter

function key(table, id) {
  return `${table}/${id}`
}

globalThis.__paywallHost = {
  storage: {
    get(table, id) {
      const row = rows.get(key(table, id))
      return row && row.owner === owner ? structuredClone(row.data) : null
    },
    getPublic(table, id) {
      const row = rows.get(key(table, id))
      if (!row || table !== 'paywalls') return null
      return Object.fromEntries(PUBLIC_FIELDS.map(field => [field, row.data[field]]))
    },
    set(table, data) {
      const existing = rows.get(key(table, data.id))
      // Like crud.py's ON CONFLICT ... WHERE owner_id: a foreign row is
      // silently left alone, not an error.
      if (existing && existing.owner !== owner) return
      rows.set(key(table, data.id), {owner, data: structuredClone(data)})
      return data
    },
    delete(table, id) {
      const row = rows.get(key(table, id))
      if (row && row.owner === owner) rows.delete(key(table, id))
    },
    getPaginated(table, options = {}) {
      const data = [...rows.entries()]
        .filter(([k, row]) => k.startsWith(`${table}/`) && row.owner === owner)
        .map(([, row]) => row.data)
        .filter(item =>
          Object.entries(options.filters || {}).every(([f, v]) => item[f] === v)
        )
      return {data: data.slice(0, options.limit || 25), total: data.length}
    }
  },
  wallet: {
    listUserWallets() {
      return wallets[owner] || []
    },
    createInvoicePublic(request) {
      invoices.push(request)
      return {paymentHash: HASH_A, paymentRequest: 'lnbc1fake', checkingId: HASH_A}
    }
  },
  system: {
    id(prefix) {
      counter += 1
      return `${prefix}_${counter}`
    },
    now() {
      return 1_800_000_000
    },
    log() {}
  },
  utils: {
    currencies: {
      list() {
        return ['sat', 'EUR', 'USD']
      }
    }
  }
}

const ext = await import(pathToFileURL(modulePath).href)

function call(fn, request) {
  const response = JSON.parse(fn(JSON.stringify(request)))
  if (!response.ok) throw new Error(response.error)
  return response.data
}

function callError(fn, request) {
  const response = JSON.parse(fn(JSON.stringify(request)))
  assert.equal(response.ok, false)
  return response.error
}

function paidEvent(paywallId, paymentHash = HASH_A, overrides = {}) {
  return {
    paymentHash,
    walletId: 'w_alice',
    amount: 21000,
    pending: false,
    status: 'success',
    extension: 'paywallwasm',
    extra: {
      tag: 'paywallwasm',
      source_id: paywallId,
      extra_paywallwasm: {paywallId}
    },
    ...overrides
  }
}

function createAlicePaywall(overrides = {}) {
  owner = 'alice'
  return call(ext.createPaywall, {
    walletId: 'w_alice',
    url: 'https://example.com/secret',
    memo: 'Secret article',
    description: 'Worth it',
    amount: 21,
    currency: 'sat',
    remembers: true,
    ...overrides
  }).paywall
}

beforeEach(() => {
  rows = new Map()
  invoices = []
  owner = null
  counter = 0
  wallets = {
    alice: [{id: 'w_alice', name: 'Alice wallet'}],
    bob: [{id: 'w_bob', name: 'Bob wallet'}]
  }
})

test('the public projection never contains the protected url', () => {
  const paywall = createAlicePaywall()
  owner = null
  const view = call(ext.getPublicPaywall, {paywallId: paywall.id}).paywall
  assert.equal(view.memo, 'Secret article')
  assert.equal(view.amount, 21)
  assert.ok(!JSON.stringify(view).includes('example.com'))
  assert.equal(view.walletId, undefined)
})

test('a paywall cannot point at another user\'s wallet', () => {
  owner = 'bob'
  const error = callError(ext.createPaywall, {
    walletId: 'w_alice',
    url: 'https://example.com',
    memo: 'x',
    amount: 1
  })
  assert.match(error, /Wallet not found/)
})

test('urls must be http(s)', () => {
  owner = 'alice'
  for (const url of ['javascript:alert(1)', 'ftp://example.com', 'example.com']) {
    const error = callError(ext.createPaywall, {walletId: 'w_alice', url, memo: 'x', amount: 1})
    assert.match(error, /url must start/)
  }
})

test('invoices use the stored price and reject underpayment', () => {
  const paywall = createAlicePaywall()
  const invoice = call(ext.createPaywallInvoice, {paywallId: paywall.id})
  assert.equal(invoice.amount, 21)
  assert.deepEqual(invoices[0], {
    sourceId: paywall.id,
    amount: 21,
    currency: 'sat',
    memo: 'Secret article',
    extra: {paywallId: paywall.id, amount: 21, currency: 'sat'}
  })
  assert.match(callError(ext.createPaywallInvoice, {paywallId: paywall.id, amount: 5}), /Minimum amount/)
  assert.equal(call(ext.createPaywallInvoice, {paywallId: paywall.id, amount: 50}).amount, 50)
})

test('fiat paywalls invoice in their own currency', () => {
  const paywall = createAlicePaywall({amount: 2.5, currency: 'eur'})
  assert.equal(paywall.currency, 'EUR')
  call(ext.createPaywallInvoice, {paywallId: paywall.id})
  assert.equal(invoices[0].currency, 'EUR')
  assert.equal(invoices[0].amount, 2.5)
})

test('the url is only revealed after a recorded payment', () => {
  const paywall = createAlicePaywall()
  assert.deepEqual(call(ext.checkPaywallPayment, {paywallId: paywall.id, paymentHash: HASH_A}), {paid: false})

  assert.equal(call(ext.recordPayment, paidEvent(paywall.id)).recorded, true)
  assert.deepEqual(call(ext.checkPaywallPayment, {paywallId: paywall.id, paymentHash: HASH_A}), {
    paid: true,
    url: 'https://example.com/secret',
    remembers: true
  })
})

test('a payment for one paywall does not unlock another', () => {
  const first = createAlicePaywall()
  const second = createAlicePaywall({url: 'https://example.com/other'})
  call(ext.recordPayment, paidEvent(first.id))
  assert.deepEqual(call(ext.checkPaywallPayment, {paywallId: second.id, paymentHash: HASH_A}), {paid: false})
})

test('pending, foreign and mismatched events are ignored', () => {
  const paywall = createAlicePaywall()
  const cases = [
    paidEvent(paywall.id, HASH_A, {pending: true}),
    paidEvent(paywall.id, HASH_A, {status: 'failed'}),
    paidEvent(paywall.id, HASH_A, {extension: 'tips'}),
    paidEvent(paywall.id, HASH_A, {
      extra: {source_id: paywall.id, extra_paywallwasm: {paywallId: 'pw_other'}}
    })
  ]
  for (const event of cases) {
    assert.equal(call(ext.recordPayment, event).recorded, false)
  }
  assert.deepEqual(call(ext.checkPaywallPayment, {paywallId: paywall.id, paymentHash: HASH_A}), {paid: false})
})

test('duplicate events record one unlock', () => {
  const paywall = createAlicePaywall()
  call(ext.recordPayment, paidEvent(paywall.id))
  assert.equal(call(ext.recordPayment, paidEvent(paywall.id)).alreadyRecorded, true)
  const payments = call(ext.listPaywallPayments, {paywallId: paywall.id})
  assert.equal(payments.total, 1)
  assert.equal(payments.payments[0].amountSat, 21)
})

test('payment hashes are validated', () => {
  const paywall = createAlicePaywall()
  assert.match(callError(ext.checkPaywallPayment, {paywallId: paywall.id, paymentHash: 'xyz'}), /64 character hex/)
  assert.deepEqual(
    call(ext.checkPaywallPayment, {paywallId: paywall.id, paymentHash: HASH_B.toUpperCase()}),
    {paid: false}
  )
})

test('owners cannot see or change each other\'s paywalls', () => {
  const paywall = createAlicePaywall()
  owner = 'bob'
  assert.equal(call(ext.listPaywalls, {}).total, 0)
  assert.match(callError(ext.updatePaywall, {paywallId: paywall.id, walletId: 'w_bob', url: 'https://evil.example', memo: 'x', amount: 1}), /Paywall not found/)
  assert.match(callError(ext.deletePaywall, {paywallId: paywall.id}), /Paywall not found/)
})

test('deleting a paywall removes its unlocks', () => {
  const paywall = createAlicePaywall()
  call(ext.recordPayment, paidEvent(paywall.id))
  call(ext.deletePaywall, {paywallId: paywall.id})
  assert.equal(rows.size, 0)
})

test('fiat prices that round to zero are rejected', () => {
  owner = 'alice'
  const base = {walletId: 'w_alice', url: 'https://example.com/secret', memo: 'm', currency: 'EUR'}
  assert.match(callError(ext.createPaywall, {...base, amount: 0.004}), /at least 0.01/)
  assert.equal(call(ext.createPaywall, {...base, amount: 0.005}).paywall.amount, 0.01)
})

test('events for another wallet do not unlock', () => {
  const paywall = createAlicePaywall()
  const result = call(ext.recordPayment, paidEvent(paywall.id, HASH_A, {walletId: 'w_bob'}))
  assert.deepEqual(result, {recorded: false, reason: 'wallet mismatch'})
  assert.deepEqual(call(ext.checkPaywallPayment, {paywallId: paywall.id, paymentHash: HASH_A}), {paid: false})
})

function issuedEvent(paywallId, issued, overrides = {}, paymentExtra = {}) {
  return paidEvent(paywallId, HASH_A, {
    // The host stores invoice extra values as strings, like LNbits does.
    extra: {
      source_id: paywallId,
      extra_paywallwasm: {paywallId, ...Object.fromEntries(Object.entries(issued).map(([k, v]) => [k, String(v)]))},
      ...paymentExtra
    },
    ...overrides
  })
}

test('sat payments below the issued price do not unlock', () => {
  const paywall = createAlicePaywall()
  const short = issuedEvent(paywall.id, {amount: 50, currency: 'sat'}, {amount: 21_000})
  assert.equal(call(ext.recordPayment, short).reason, 'amount below invoice')
  const exact = issuedEvent(paywall.id, {amount: 50, currency: 'sat'}, {amount: 50_000})
  assert.equal(call(ext.recordPayment, exact).recorded, true)
})

test('a price raise does not break invoices issued at the old price', () => {
  const paywall = createAlicePaywall()
  call(ext.updatePaywall, {...paywall, paywallId: paywall.id, walletId: 'w_alice', amount: 100})
  const old = issuedEvent(paywall.id, {amount: 21, currency: 'sat'}, {amount: 21_000})
  assert.equal(call(ext.recordPayment, old).recorded, true)
})

test('fiat payments are checked against the recorded fiat amount', () => {
  const paywall = createAlicePaywall({amount: 2.5, currency: 'EUR'})
  const issued = {amount: 2.5, currency: 'EUR'}
  const wrongCurrency = issuedEvent(paywall.id, issued, {}, {fiat_currency: 'USD', fiat_amount: 2.5})
  assert.equal(call(ext.recordPayment, wrongCurrency).reason, 'currency mismatch')
  const short = issuedEvent(paywall.id, issued, {}, {fiat_currency: 'EUR', fiat_amount: 1})
  assert.equal(call(ext.recordPayment, short).reason, 'amount below invoice')
  const ok = issuedEvent(paywall.id, issued, {}, {fiat_currency: 'EUR', fiat_amount: 2.5})
  assert.equal(call(ext.recordPayment, ok).recorded, true)
})

test('fiat in the wallet currency is checked via wallet_fiat_amount', () => {
  const paywall = createAlicePaywall({amount: 2.5, currency: 'EUR'})
  const issued = {amount: 2.5, currency: 'EUR'}
  const short = issuedEvent(paywall.id, issued, {}, {wallet_fiat_currency: 'EUR', wallet_fiat_amount: 1})
  assert.equal(call(ext.recordPayment, short).reason, 'amount below invoice')
  const ok = issuedEvent(paywall.id, issued, {}, {wallet_fiat_currency: 'EUR', wallet_fiat_amount: 2.5})
  assert.equal(call(ext.recordPayment, ok).recorded, true)
})
