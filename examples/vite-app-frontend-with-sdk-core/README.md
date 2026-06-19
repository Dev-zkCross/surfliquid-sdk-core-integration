# SurfLiquid SDK Example

A minimal **React + Vite** app that integrates the published
[`@surf_liquid/core-sdk`](https://www.npmjs.com/package/@surf_liquid/core-sdk)
npm package. Use it as a starting point for your own SurfLiquid integration —
wallet connection, cookie-based authentication, vault deployment,
deposits/withdrawals, and on-chain reads.

> This example depends on the **published npm package** (not local SDK source).
> It requires `@surf_liquid/core-sdk@^0.3.0`.

---

## Setup guide

### Prerequisites

- **Node.js 18+** and npm.
- A **browser wallet extension** (MetaMask, Coinbase Wallet, Rabby, etc.) for the
  wallet-based steps. Read-only actions don't need one.
- **SurfLiquid project credentials** — a `projectName` and `appId` issued by the
  SurfLiquid team. Sent as headers on every API request.

### 1. Install

```bash
npm install
```

This pulls `@surf_liquid/core-sdk` (and its `ethers` peer) from npm — there is no
local SDK source or build step; the package resolves from `node_modules` exactly
as it would in any consumer app.

### 2. Configure

Set these in the app's **Configuration** panel at runtime (or change the
`DEFAULTS` object in `src/App.tsx`):

| Field | Notes |
|-------|-------|
| **Project name** | Your SurfLiquid project name. |
| **App ID** | Your SurfLiquid app/project ID. |
| **Environment** | `mainnet` or `testnet`. |
| **Chain ID** | e.g. `1` (Ethereum), `8453` (Base), or `137` (Polygon). |
| **Wallet** | `metamask`, `trust`, `coinbase`, `rabby`, `phantom`, `walletconnect`, or `injected`. |
| **WalletConnect project ID** | Only required when the wallet is `walletconnect`. |
| **Asset / Deposit / Withdraw amount** | Used by the deposit/withdraw flow actions. |
| **Activity from / Activity to** | Optional ISO dates (e.g. `2026-06-01`) to date-range filter "Get agent messages". |

### 3. Run

```bash
npm run dev
```

The dev server runs on **http://localhost:3000**.

> **Why port 3000?** SurfLiquid auth is **cookie-based** (httpOnly,
> `SameSite=None`). For the browser to send/receive that cookie cross-origin, the
> API must respond with a *specific* `Access-Control-Allow-Origin` (never `*`) plus
> `Access-Control-Allow-Credentials: true`, and your serving origin must be on the
> API's allowlist. `http://localhost:3000` is allowlisted by default — if you serve
> from another origin, it must be allowlisted too. The port is pinned via
> `strictPort` so Vite won't silently fall back to a non-allowlisted port.

Other scripts: `npm run build` (production build), `npm run preview` (serve the
build on port 3000), `npm run typecheck` (`tsc --noEmit`).

---

## Flow guide

The UI uses **progressive disclosure**: only the buttons relevant to your current
step are shown, so the happy path is hard to get wrong. The sidebar status panel
(**Wallet / Auth / Vault / Busy**) reflects state at each step, and every action +
error is written to the **Event log**.

### Step 1 — Create client

Always available; **required first** (every other action needs a client). Builds a
`SurfClient` from the configuration. Once created, the button becomes
**Recreate client** (re-create it after changing config). → reveals **Connect wallet**.

### Step 2 — Connect wallet

Shown after the client exists. Connects the selected wallet and switches it to the
configured chain. The address appears in the sidebar. → reveals **Authenticate**.

### Step 3 — Authenticate

Shown once a wallet is connected. Signs a message and logs in; the backend sets an
**httpOnly session cookie** (the SDK never exposes the token — `AuthState.token` is
always `null`, so the app gates on the `authenticated` flag, not a token).

Immediately after authenticating, the app calls the API and determines whether a
vault is **already deployed on the selected chain**, then shows the right next step.

A **Refresh session** button also appears once authenticated — it calls
`refreshSession()` to extend the httpOnly cookie session (new ~7-day expiry)
without prompting for another signature.

### Step 4 — Deploy vault *(only if needed)*

- **No vault on this chain yet** → a **Deploy vault** button appears. It deploys,
  then unlocks the flows.
- **Vault already exists on this chain** → no Deploy button; instead **Get vault**
  (which also reports trailing **7/14/30-day APY** per asset and portfolio) and the
  **Flows** section appear directly.
- If the post-auth check couldn't complete, a **Check vault** button lets you retry.

> The "deployed on this chain" test mirrors the exact condition the SDK uses
> internally before it would throw `VAULT_ALREADY_EXISTS`, so Deploy vault only
> appears when a deploy would actually succeed — you can't accidentally redeploy.

### Step 5 — Flows *(requires authenticated + a vault on the chain)*

The **Flows** panel appears only when you're authenticated **and** a vault exists on
the selected chain:

- **Deposit** / **Withdraw** — move assets in/out of the vault.
- **Read portfolio** / **Read withdrawable** — read on-chain vault state.
- **Get supported assets** — supported assets + live APY for the chain, including
  trailing **7/14/30-day** windows (`apy7d`/`apy14d`/`apy30d`).
- **Get agent messages** — recent activity for the connected wallet, with per-event
  **structured fields** (amount, token, from → to vault, APY before → after). Use the
  optional **Activity from / Activity to** inputs to filter by date range.

---

## How it integrates

The only SurfLiquid-specific code lives in `src/App.tsx`:

```ts
import { SurfClient, WalletConnectAdapter } from "@surf_liquid/core-sdk";

const client = SurfClient.create({
  projectName: "your-project",
  appId: "your-app-id",
  environment: "mainnet",
  chainId: 8453,
});

await client.connectWallet("metamask");
await client.authenticate();              // sets the session cookie
const vault = await client.getVault();    // inspect / decide whether to deploy
```

Because auth is cookie-based, **gate your UI on `client.getAuthState().authenticated`,
never on a token** — there isn't one to read.

---

## Troubleshooting

- **"No supported assets found" / empty reads** — make sure the installed SDK is
  `@surf_liquid/core-sdk@>=0.3.0` (`npm ls @surf_liquid/core-sdk`). If you swapped the
  SDK build in `node_modules`, restart Vite with `npm run dev -- --force` to clear its
  dependency pre-bundle cache.
- **Request shows HTTP 200 in DevTools but the call still fails / no cookie is set** —
  a CORS misconfiguration. The API must return a specific `Access-Control-Allow-Origin`
  (not `*`) and `Access-Control-Allow-Credentials: true` for your origin. Serve from an
  allowlisted origin (e.g. `http://localhost:3000`).
- **Wallet buttons do nothing** — a browser wallet extension must be installed; for
  WalletConnect, set a WalletConnect project ID.

## Notes

- Amounts passed to `deposit()` / `withdraw()` are **human-readable strings**
  (e.g. `"10.5"`), not wei.
- For the full SDK API, see the
  [`@surf_liquid/core-sdk` README](https://www.npmjs.com/package/@surf_liquid/core-sdk).
