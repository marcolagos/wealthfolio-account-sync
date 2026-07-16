# Plaid Sync

Wealthfolio addon that auto-syncs bank and brokerage accounts via
[Plaid](https://plaid.com/). Works with Plaid's free **Trial plan** (up to 10
live institutions, includes Transactions + Investments).

## How it works

- **Bank / credit accounts** sync as activities (deposits, withdrawals,
  interest, fees) via `/transactions/sync` cursors. Depository accounts get an
  opening-balance anchor on first sync so computed balances match reported ones.
- **Brokerage / retirement accounts** sync as **real investment activities**
  (BUY/SELL/DIVIDEND/FEE with quantity, price, and fees) via
  `/investments/transactions/get` — full cost basis and history. Positions
  predating Plaid's ~24-month history window come in as baseline TRANSFER_INs
  computed from current holdings, plus a cash anchor.
- **Dedup**: each activity carries its Plaid transaction id in the comment
  (`[plaid:<id>]`), folded into Wealthfolio's content-hash idempotency; re-syncs
  never double-import. Symbol-bearing rows are saved through the asset-creating
  path so tickers resolve to real market-data assets.
- **Auto-sync** runs at app launch when the last run is older than the
  configured interval (default daily, or manual-only).
- Loans are listed but not synced (no liability model in v1).

## Setup

1. Create a Plaid account at dashboard.plaid.com (Trial plan is automatic for
   new US/Canada teams) and grab your `client_id` and environment secret.
2. In Wealthfolio → Plaid Sync: pick the environment, paste `client_id` +
   secret, Save. Credentials live in the encrypted secret store; API calls embed
   them per-request and never touch the browser context.
3. Connect an institution:
   - **Production**: "Connect an institution" creates a Hosted Link session —
     copy the URL into your browser, sign in to your bank, come back and press
     "Check connection".
   - **Sandbox**: "Quick connect" wires up Plaid's test bank (credentials
     `user_good` / `pass_good`) without the Link UI.
4. Map each Plaid account (create new / link existing / ignore) and Sync now.

## Development

```bash
pnpm install
pnpm dev:server   # hot-reload server; enable addon dev mode in Wealthfolio
pnpm bundle       # build + package ZIP for installation
```

Releases: push a `v*` tag and CI attaches the installable ZIP to a GitHub
Release.

E2E coverage: `e2e/98-plaid-addon.spec.ts` in a
[wealthfolio](https://github.com/afadil/wealthfolio) checkout runs the full
sandbox flow (connect → map → sync → dedup → holdings) against a running
web-mode app.
