---
name: surfliquid-sdk-integration
description: Integrate the @surf_liquid/core-sdk TypeScript SDK into a web app — connect a browser wallet, run cookie-based SIWE authentication, deploy a user vault, deposit/withdraw assets on-chain via ethers v6, and read vault portfolio/profit/fee/APY data. Use this skill whenever a task involves wiring up @surf_liquid/core-sdk, SurfClient construction/config, wallet connection or auth, vault deployment, deposits or withdrawals, or reading vault state, and especially when debugging cookie/CORS auth or distinguishing REST-API failures from on-chain RPC failures.
---

# SurfLiquid SDK Integration Skill

## What this is

`@surf_liquid/core-sdk` is a framework-agnostic TypeScript SDK (no React/Vue/Svelte dependency) for integrating SurfLiquid vaults into a web app. It is built on **ethers v6**, which is declared as both a `dependency` and a `peerDependency` (`ethers ^6.0.0`) — consumers should have a single `ethers@^6` installed to avoid version duplication. It has no other runtime dependencies.

The SDK exposes one primary facade class, `SurfClient`, plus a fluent `SurfClientBuilder`. Through it you can:

- **Connect a browser wallet** (MetaMask, Trust, Coinbase, Rabby, Phantom, WalletConnect, or a generic injected provider) via pre-registered adapters.
- **Authenticate** the wallet against the SurfLiquid REST API using a nonce + signed message (SIWE-style). Auth is **cookie-based** (see below).
- **Deploy a per-user vault** through an on-chain factory, coordinated with the backend's deterministic-salt prepare/confirm flow.
- **Deposit and withdraw** ERC-20 assets (with optional native-ETH wrapping and automatic ERC-20 approvals).
- **Read vault state** — portfolio summary, per-asset profit, withdrawable amounts, allowed assets, fee info, supported assets/APY, and agent activity messages.

Package entry points: `main` → `./dist/index.cjs`, `module` → `./dist/index.js`, `types` → `./dist/index.d.ts`. Install with:

```bash
npm install @surf_liquid/core-sdk ethers
# or: yarn add @surf_liquid/core-sdk ethers
# or: pnpm add @surf_liquid/core-sdk ethers
```

## Table of contents

- [What this is](#what-this-is)
- [When to use this skill](#when-to-use-this-skill)
- [Two surfaces you must distinguish](#two-surfaces-you-must-distinguish)
- [Supported chains](#supported-chains)
- [Installation](#installation)
- [Initialization](#initialization)
- [Integration flow (do this in order)](#integration-flow-do-this-in-order)
- [Authentication & networking (cookie-based — READ THIS)](#authentication--networking-cookie-based--read-this)
- [API reference](#api-reference)
- [Events](#events)
- [Error handling](#error-handling)
- [Types](#types)
- [Recipes](#recipes)
- [Gotchas & footguns](#gotchas--footguns)
- [Integration checklist](#integration-checklist)

## When to use this skill

Reach for this skill when a task involves any of the following:

- Adding, configuring, or upgrading `@surf_liquid/core-sdk` in a frontend or Node/TypeScript project.
- Constructing a `SurfClient` (via `SurfClient.create(config)` or `SurfClient.builder()`), setting `projectName`/`appId`, chain, RPC URL, API base URL, factory address, or `autoApprove`.
- Implementing or debugging **wallet connection** (`connectWallet`, `switchChain`, account/chain-change events) or **authentication** (`authenticate`, `getAuthState`, `logout`).
- Implementing **vault deployment** (`deployVault`), **deposits** (`deposit`), or **withdrawals** (`withdraw`), including approval handling and native-token wrapping.
- Reading vault analytics: `getVault`, `getPortfolioSummary`, `getAssetProfit`, `getAssetProfitPercentage`, `getWithdrawableAmount`, `getAllowedAssets`, `getFeeInfo`, `getSupportedAssets`, `getBestVault`, `getAgentMessages`, `getTokenBalance`.
- Debugging `SurfError` failures, `auth`/CORS/cookie issues, or confusion over whether a failure originated in the REST API or in an on-chain RPC call.
- Wiring SDK events (`wallet:*`, `auth:*`, `vault:deployed`, `deposit:*`, `withdraw:*`, `error`) into UI state.

## Two surfaces you must distinguish

`SurfClient` is a facade over **two completely different transports**. Knowing which surface a method uses is essential for debugging, because they fail for entirely different reasons.

| Surface | Transport | What it does | Auth mechanism | Backed by |
|---|---|---|---|---|
| **REST API** | `fetch` over HTTPS to `apiBaseUrl` (default `https://api.surfliquid.com`) | Wallet auth (nonce/login), vault metadata, supported assets, APY breakdown, best-vault lookup, agent activity, and the vault deploy prepare/confirm handshake | **Cookie-based** (httpOnly session cookie, `credentials: 'include'`) | `HttpClient`, `AuthService`, `VaultApiService` |
| **On-chain RPC** | ethers v6 over `rpcUrl` (reads) or the wallet's signer (writes) | Vault factory deploy/compute, deposit/withdraw, portfolio summary, profits, allowed assets, fees, ERC-20 balance/allowance/approve, WETH wrap | Wallet signer (transactions); no cookie involved | `FactoryService`, `VaultService`, `TokenService` (ABIs in `src/abis/`) |

REST methods (auth, `getVault`, `getSupportedAssets`, `getBestVault`, `getAgentMessages`, and the `prepare`/`confirm` steps of `deployVault`) hit the API server and fail with `SurfError(API_ERROR, "Request failed with status …")`, blocked CORS preflights, or a missing session cookie.

On-chain methods (everything in `FactoryService`/`VaultService`/`TokenService`, plus `getPortfolioSummary`, `getAssetProfit*`, `getWithdrawableAmount`, `getAllowedAssets`, `getFeeInfo`, `getTokenBalance`, and the factory write in `deployVault`/`deposit`/`withdraw`) hit an RPC node or the wallet and fail with revert reasons, gas/nonce errors, or wrong-chain mismatches.

**`deployVault` is the one mixed method**: it calls REST (`getVault`, `prepare`, `confirm`) *and* on-chain RPC (`computeVaultAddress`, `deployVault` factory write) in a single flow — so a failure there could come from either surface.

Two cookie-auth consequences that drive most auth bugs:

- **`AuthState.token` is always `null`**, even when `authenticated: true`. The session token is delivered as an httpOnly cookie and is never returned in the login body, never stored by the SDK, and never sent as an `Authorization: Bearer` header. Gate all logic on `getAuthState().authenticated` / `.user`, never on `.token`.
- **CORS for credentialed requests**: because every request uses `credentials: 'include'`, the API must respond with a *specific* `Access-Control-Allow-Origin` (not `*`) plus `Access-Control-Allow-Credentials: true`, and the consumer's web origin must be allowlisted (the bundled `examples/test-frontend` uses `http://localhost:3000`). `logout()` only clears local SDK state — it cannot delete the cross-origin httpOnly cookie from JavaScript.

## Supported chains

Defined in `src/config/chains.ts` (`CHAIN_REGISTRIES` + `DEFAULT_CHAIN_IDS`). There are two environments, `"mainnet"` (default) and `"testnet"`.

| Environment | Chain | Chain ID | Default RPC URL | Factory address | WETH address | Block explorer | Tokens | Default for env |
|---|---|---|---|---|---|---|---|---|
| `mainnet` | Base | `8453` | `https://mainnet.base.org` | `0x8fa50DeA8DB10987D7d22ac092001c3613C18779` | `0x4200000000000000000000000000000000000006` | `https://basescan.org` | USDC, WETH, cbBTC | yes |
| `mainnet` | Ethereum | `1` | `https://ethereum-rpc.publicnode.com` | `0x8fa50DeA8DB10987D7d22ac092001c3613C18779` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `https://etherscan.io` | USDC, WETH | — |
| `mainnet` | Polygon | `137` | `https://polygon-bor-rpc.publicnode.com` | `0x8fa50DeA8DB10987D7d22ac092001c3613C18779` | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` (Polygon WETH) | `https://polygonscan.com` | USDC | — |
| `testnet` | Base Sepolia | `84532` | `""` (none — you must supply `rpcUrl`) | `0x0000…0000` (zero) | `0x0000…0000` (zero) | `https://sepolia.basescan.org` | none (`[]`) | yes |

Notes:

- Base, Polygon, and Ethereum **share the same factory address** (`0x8fa50DeA…C18779`).
- Polygon's config field is named `wethAddress` but holds Polygon's WETH (`0x7ceB23fD…f619`), not WMATIC/WPOL — the field name is generic across chains.
- The default RPCs are public and rate-limited; production consumers should override via `setRpcUrl(...)` or the `rpcUrl` config field.
- **Base Sepolia (testnet) is a non-functional stub** out of the box: empty `rpcUrl`, zero factory/WETH addresses, and no tokens. To use it you must supply your own `rpcUrl` and register the chain's real contracts/tokens via `registerChain` / `registerToken` (or `setFactoryAddress`).

## Installation

`@surf_liquid/core-sdk` is framework-agnostic and ships ESM, CJS, and type declarations. It requires `ethers` v6 as a peer dependency (you must install it alongside the SDK).

```bash
npm install @surf_liquid/core-sdk ethers
# or
yarn add @surf_liquid/core-sdk ethers
# or
pnpm add @surf_liquid/core-sdk ethers
```

- Peer dependency: `ethers@^6.0.0`. Install it in your app so a single, version-compatible copy is used.
- The SDK has no other runtime dependencies.
- Everything is re-exported from the package root, e.g. `import { SurfClient, SurfClientBuilder } from "@surf_liquid/core-sdk"`.

## Initialization

There are two ways to construct a client. Both are static methods on `SurfClient` and both funnel through the same validation/defaulting logic.

- `SurfClient.create(config)` — **recommended**. A single-call convenience that maps a plain config object onto the builder and returns a ready client.
- `SurfClient.builder()` — a fluent builder for advanced setup: registering custom chains/tokens or swapping/adding wallet adapters (e.g. wiring up WalletConnect).

> **`projectName` + an id are required.** You must pass `projectName` and at least one of `appId` / `projectId`, or initialization throws `SurfError` with code `MISSING_PROJECT_ID`. `projectId` is a backwards-compatible alias for `appId`; the SDK keeps both unified and `appId` takes precedence (`appId ?? projectId`).

### Option 1 — `SurfClient.create(config)` (recommended)

```ts
import { SurfClient } from "@surf_liquid/core-sdk";

const surf = SurfClient.create({
  projectName: "My DApp",        // required
  appId: "your-app-id",          // required (projectId is an accepted alias)
  environment: "mainnet",        // default: "mainnet"
  chainId: 8453,                 // default: 8453 (Base) on mainnet, 84532 on testnet
  // rpcUrl: "https://...",      // optional; defaults to the chain's built-in RPC
  // apiBaseUrl: "https://api.surfliquid.com", // optional; this is the default
  // autoApprove: true,          // optional; DEFAULT IS true (see note below)
  // logger: "error",            // optional; default: "error"
});
```

Minimal valid config:

```ts
const surf = SurfClient.create({
  projectName: "My DApp",
  appId: "your-app-id",
});
// -> environment "mainnet", chainId 8453 (Base), rpcUrl https://mainnet.base.org,
//    apiBaseUrl https://api.surfliquid.com, autoApprove true, logger "error"
```

### Option 2 — `SurfClient.builder()` (fluent / advanced)

Every setter returns `this` for chaining; call `.build()` to produce the client. Use this when you need to register a custom chain/token or provide a wallet adapter (such as a configured WalletConnect provider).

```ts
import {
  SurfClientBuilder,
  SurfClient,
  WalletConnectAdapter,
} from "@surf_liquid/core-sdk";

const surf = SurfClient.builder()        // same as: new SurfClientBuilder()
  .setProject("My DApp", "your-app-id")  // sets projectName + appId (+ projectId alias)
  .setEnvironment("mainnet")
  .setChain(137)                         // e.g. Polygon
  .setRpcUrl("https://your-dedicated-rpc.example")
  .setApiBaseUrl("https://api.surfliquid.com")
  .setAutoApprove(true)
  .setLogLevel("error")                  // NOTE: method is setLogLevel (config field is `logger`)
  // Wire up WalletConnect (it is pre-registered but inert without a provider factory):
  .registerWalletAdapter(
    "walletconnect",
    new WalletConnectAdapter(() => yourConfiguredWalletConnectProvider),
  )
  .build();
```

Builder-only capabilities (not expressible via `SurfClient.create`):

```ts
const surf = SurfClient.builder()
  .setProject("My DApp", "your-app-id")
  .setEnvironment("testnet")
  // Register a custom chain (validated; addresses must be valid EVM addresses):
  .registerChain("testnet", {
    environment: "testnet",
    chainId: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://your-base-sepolia-rpc.example", // required: testnet ships with no default RPC
    factoryAddress: "0xYourFactoryAddress",
    wethAddress: "0xYourWethAddress",
    tokens: [],
  })
  // Add a token to an already-registered chain:
  .registerToken("testnet", 84532, {
    symbol: "USDC",
    address: "0xTokenAddress",
    decimals: 6,
    vaultAddresses: ["0xVaultAddress"],
  })
  .setChain(84532)
  .build();
```

> Note: `registerChain` / `registerToken` mutate the builder's own (cloned) registry; the standalone helpers `getFactoryAddress` / `getWethAddress` read from the shared default registry and will **not** see chains you register this way.

### Configuration options

These are the fields of `SurfConfig` (the input to `SurfClient.create`). Defaults are the values resolved by `validateConfig` / `build()`.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `projectName` | `string` | **Yes** | — | Your project's display name. Sent on API requests. Empty/missing throws `MISSING_PROJECT_ID`. |
| `appId` | `string` | **Yes** (one of `appId`/`projectId`) | — | Your Surf application id. Takes precedence over `projectId`. |
| `projectId` | `string` | **Yes** (one of `appId`/`projectId`) | — | Backwards-compatible alias for `appId`. Resolved as `appId ?? projectId`; the SDK unifies both to a single value. |
| `environment` | `"mainnet"` \| `"testnet"` | No | `"mainnet"` | Target environment. Anything else throws `INVALID_ENVIRONMENT`. |
| `chainId` | `number` | No | `8453` on mainnet, `84532` on testnet | Chain to use. Must be a chain registered for the environment, else `UNSUPPORTED_CHAIN`. Built-in mainnet chains: `8453` (Base), `137` (Polygon), `1` (Ethereum). |
| `rpcUrl` | `string` | No | the selected chain's built-in `rpcUrl` | JSON-RPC endpoint. If omitted, falls back to the chain default (Base → `https://mainnet.base.org`, Polygon → `https://polygon-bor-rpc.publicnode.com`, Ethereum → `https://ethereum-rpc.publicnode.com`). Base Sepolia has no default, so you must supply one. Use a dedicated RPC in production. |
| `apiBaseUrl` | `string` | No | `"https://api.surfliquid.com"` | Base URL of the Surf backend API. |
| `factoryAddress` | `` `0x${string}` `` | No | the selected chain's `factoryAddress` | Override the vault factory address. If omitted (or set to the zero address), the chain's configured factory is used. |
| `autoApprove` | `boolean` | No | `true` | When `true`, ERC-20 approvals are handled automatically before deposits. **Defaults to `true`** — pass `false` to require explicit approvals. |
| `logger` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"none"` | No | `"error"` | Log verbosity. (In the builder, set this via `setLogLevel(...)`; there is no `setLogger`.) |

## Integration flow (do this in order)

This is the exact, dependency-aware sequence to take a user from zero to a funded vault. Each step lists what must already be true before you call it. Do not reorder: event listeners must be registered before connecting, a wallet must be connected before authenticating or deploying, and a vault must exist before depositing or reading on-chain vault state.

Capability legend for every call below:
- **Public** — no wallet, no auth, no vault required. Safe to call right after `SurfClient.create(...)`.
- **Wallet** — requires `connectWallet(...)` first (internally `requireWallet()`; otherwise throws `SurfError(WALLET_NOT_CONNECTED)`).
- **Auth** — the user must have completed `authenticate()` so the httpOnly session cookie is set (needed for the user-scoped REST mutations the backend gates, e.g. vault `prepare`/`confirm` inside `deployVault`).
- **Vault** — a deployed vault must exist (a `userVaultAddress` resolvable via `getVault()`), or you must pass `vaultAddress` explicitly.

> Auth is cookie-based. After `authenticate()`, `getAuthState().token` is **always `null`** — gate on `getAuthState().authenticated` / `.user`, never on `.token`. For the cross-origin cookie to be sent, the API must allow your exact web origin (not `*`) with `Access-Control-Allow-Credentials: true`.

### Step 1 — Create the client (synchronous, no network)

**Prerequisites:** none. `SurfClient.create(...)` is synchronous and does not touch the network or a wallet.

```ts
import { SurfClient } from "@surf_liquid/core-sdk";

const client = SurfClient.create({
  projectName: "SDK Test App",
  appId: "your-app-id",          // also used as projectId
  environment: "mainnet",         // "mainnet" | "testnet"
  chainId: 8453,                  // Base. Polygon 137, Base Sepolia 84532
  // apiBaseUrl, rpcUrl, factoryAddress, autoApprove, logger are optional
});
```

Notes:
- `appId` doubles as `projectId` (the builder sets both). These are sent on every request as `X-Surf-Project-Name` / `X-Surf-Project-Id`; `X-App-ID` is sent only on login.
- `autoApprove` defaults to **`true`** — `deposit()` will auto-approve the vault as spender when needed (see Step 6).
- If you omit `chainId`, it defaults per environment (mainnet → 8453, testnet → 84532). `rpcUrl`/`factoryAddress` fall back to the registry entry for the chosen chain.

You can already call **Public** reads at this point (no wallet/auth):

```ts
const assets = await client.getSupportedAssets(8453); // SupportedAsset[]
const best   = await client.getBestVault("USDC");     // BestVaultOption[]
const tokens = client.getSupportedTokens();           // TokenConfig[] (sync)
```

### Step 2 — Register event listeners BEFORE connecting

**Prerequisites:** client created. **Do this before Step 3** so you don't miss `wallet:connected`. `on`/`off` are synchronous and have no wallet/auth requirement.

```ts
client.on("wallet:connected", (state) => {/* { address, chainId, connected } */});
client.on("wallet:accountChanged", ({ oldAddress, newAddress }) => {/* ... */});
client.on("wallet:chainChanged", ({ chainId }) => {/* ... */});
client.on("wallet:disconnected", () => {/* state is void */});
client.on("auth:authenticated", (auth) => {/* AuthState; auth.token is null */});
client.on("auth:logout", () => {/* void */});
client.on("vault:deployed", ({ vaultAddress, transactionHash, salt }) => {/* ... */});
client.on("deposit:started",   ({ asset, amount }) => {/* ... */});
client.on("deposit:approved",  ({ asset, txHash }) => {/* ... */});
client.on("deposit:completed", ({ asset, amount, txHash }) => {/* ... */});
client.on("withdraw:started",   ({ asset, amount }) => {/* ... */});
client.on("withdraw:completed", ({ asset, amount, txHash }) => {/* ... */});
client.on("error", ({ code, message }) => {/* ... */});
```

### Step 3 — Connect a wallet

**Prerequisites:** client created; listeners registered (Step 2). The adapter must be registered — the built-in names are `"metamask" | "trust" | "coinbase" | "rabby" | "phantom" | "walletconnect" | "injected"` (the `WalletName` type). An unregistered name throws `SurfError(WALLET_NOT_INSTALLED)`.

```ts
const wallet = await client.connectWallet("metamask"); // WalletState { address, chainId, connected }
// emits "wallet:connected"
```

After this, **Wallet**-level calls become available. `getWalletState()` returns the current `WalletState | null` synchronously.

> `switchChain(chainId)` changes only the wallet's chain; it does **not** change `config.chainId`. Token resolution, factory address, and `getChainConfig()` keep using the chain you passed to `create(...)`. Keep the wallet on the same chain you configured.

### Step 4 — Authenticate (sets the httpOnly cookie)

**Prerequisites:** wallet connected (Step 3). The flow is: fetch nonce → wallet signs the message → backend `login` sets the cookie. A user-rejected signature throws `SurfError(SIGNATURE_REJECTED)`.

```ts
const auth = await client.authenticate(); // AuthState
// emits "auth:authenticated"

if (auth.authenticated) {
  // ✅ correct gate
} 
// ❌ never do: if (auth.token) — token is always null under cookie auth
```

`getAuthState()` returns `{ token, address, authenticated, user }`; `token` is always `null`. `logout()` clears local state only and emits `auth:logout` — it cannot delete the cross-origin httpOnly cookie from JS.

### Step 5 — Get the vault; deploy it if it doesn't exist

**Prerequisites for `getVault()` with no arg:** wallet connected (it uses the connected address). Passing an explicit `walletAddress` makes it **Public** (no wallet needed). **Prerequisites for `deployVault()`:** wallet connected; the user authenticated (the backend `prepare`/`confirm` calls inside it rely on the session cookie).

```ts
const vault = await client.getVault(); // VaultInfo
if (!vault.exists) {
  const { vaultAddress, transactionHash, salt } = await client.deployVault();
  // emits "vault:deployed"; this sends an on-chain factory tx and waits for the receipt
}
const vaultAddress = (await client.getVault()).userVaultAddress; // null until deployed
```

Notes:
- `vault.exists` is `Boolean(userVaultAddress)`. `deployVault()` throws `SurfError(VAULT_ALREADY_EXISTS)` if a vault is already deployed on the current chain.
- `deployVault()` does the on-chain factory deploy and `await tx.wait()` internally, so `vault:deployed` fires only after the receipt is mined.

### Step 6 — Deposit / withdraw and read state

**Prerequisites:** wallet connected; a vault exists (resolved automatically from `getVault()` when you omit `vaultAddress`, otherwise pass it). `deposit`/`withdraw` send on-chain transactions via the wallet signer.

`deposit()` — match `asset` by **token address** (not symbol). An unregistered address throws `SurfError(INVALID_CONFIG)`. `amount` is a human string parsed with the token's decimals.

```ts
const usdc = client.getSupportedTokens().find((t) => t.symbol === "USDC")!;

const tx = await client.deposit({
  asset: usdc.address,   // Address, matched case-insensitively against the chain token list
  amount: "100",          // human units; parsed via the token's decimals
  // vaultAddress?: override; bestVault?: override; wrapEth?: true to wrap native first
});
// emits "deposit:started", maybe "deposit:approved", then "deposit:completed"
await tx.wait(); // deposit() does NOT await the final tx — you must call wait()
```

Behavior to know:
- With `autoApprove` (default `true`), if the current allowance `< amount`, the SDK approves `amount + 0.1%` (a 10 bps buffer via `addApprovalBuffer`) to the vault and awaits that approval before depositing. The buffer is on the **approval**, not the deposited amount.
- First deposit for an asset uses the contract's `initialDeposit` (with a resolved best vault); later deposits use `userDeposit`. The best vault is resolved from `bestVault` → `getBestVault(symbol)` (matching `config.chainId`) → on-chain available vaults; if none, throws `SurfError(NO_BEST_VAULT)`.
- `wrapEth: true` wraps native to WETH first (awaited) and switches the deposit asset to the configured WETH address.

`withdraw()` — omitting `amount` (or passing `"0"`) means **full withdrawal** (the contract treats `0` as withdraw-all). There is no separate "withdraw all" method. Decimals are fetched fresh on-chain.

```ts
const tx = await client.withdraw({ asset: usdc.address }); // amount omitted => withdraw all
// emits "withdraw:started" then "withdraw:completed"
await tx.wait();
```

Reads (all on-chain via the configured RPC; **Wallet** only when the address/vault arg is omitted, otherwise **Public**):

```ts
await client.getPortfolioSummary(vaultAddress); // { assets, deposited, currentValues, profits(int256, can be negative), activeCount }
await client.getWithdrawableAmount(usdc.address, vaultAddress); // bigint (vault holdings)
await client.getTokenBalance(usdc.address);   // bigint — EOA wallet balance, NOT vault holdings
await client.getAssetProfit(usdc.address, vaultAddress);          // bigint (int256)
await client.hasInitialDeposit(usdc.address, vaultAddress);       // boolean
```

### End-to-end example

```ts
import { SurfClient } from "@surf_liquid/core-sdk";

async function run() {
  // 1. Create (sync, no network)
  const client = SurfClient.create({
    projectName: "SDK Test App",
    appId: "your-app-id",
    environment: "mainnet",
    chainId: 8453,
  });

  // 2. Listeners BEFORE connecting
  client.on("auth:authenticated", (a) => console.log("authed:", a.authenticated));
  client.on("vault:deployed", (v) => console.log("vault:", v.vaultAddress));
  client.on("deposit:completed", (d) => console.log("deposit tx:", d.txHash));
  client.on("error", (e) => console.error(e.code, e.message));

  // 3. Connect wallet
  await client.connectWallet("metamask");

  // 4. Authenticate (sets httpOnly cookie; token stays null)
  const auth = await client.authenticate();
  if (!auth.authenticated) throw new Error("Authentication failed");

  // 5. Ensure a vault exists
  let info = await client.getVault();
  if (!info.exists) {
    await client.deployVault(); // on-chain factory tx + backend confirm
    info = await client.getVault();
  }
  const vaultAddress = info.userVaultAddress!;

  // 6. Deposit (match by token ADDRESS) then await the tx yourself
  const usdc = client.getSupportedTokens().find((t) => t.symbol === "USDC")!;
  const tx = await client.deposit({ asset: usdc.address, amount: "100" });
  await tx.wait();

  // Reads
  const summary = await client.getPortfolioSummary(vaultAddress);
  console.log("active positions:", summary.activeCount);
}
```

## Authentication & networking (cookie-based — READ THIS)

Authentication in `@surf_liquid/core-sdk` is **cookie-based**. There is no bearer token, no `Authorization` header, and no token for your code to store. The session lives in an **httpOnly cookie** that the browser attaches automatically. Read this section before writing any auth or gating logic — the most common integration bug is treating this like token auth.

### The `authenticate()` flow

`client.authenticate(): Promise<AuthState>` runs a three-step SIWE-style handshake:

1. **Nonce** — `POST /api/auth/nonce` with `{ walletAddress }`. The SDK reads back `data.message` (the message to sign).
2. **Sign** — the active wallet adapter's `signMessage(message)` is called. If the user rejects, the SDK throws `SurfError(SurfErrorCode.SIGNATURE_REJECTED, "Failed to sign authentication message")`.
3. **Login** — `POST /api/auth/login` with `{ walletAddress, message, signature }` plus a per-call header `X-App-ID` (the `appId` from your builder config). This is the **only** request that sends `X-App-ID`.

On success the backend responds with a `Set-Cookie` header containing the session token:

```
Set-Cookie: <session>; HttpOnly; SameSite=None; Secure
```

The token is delivered **only** in that cookie. It is **not** in the login response body — the SDK does not read it, does not store it, and never attaches it to later requests. The login body is used solely to populate `AuthState.user`.

```ts
const auth = await client.authenticate();
// auth.authenticated === true
// auth.user          === { walletAddress, isActive, activeStrategies, vaultVersion, ... }
// auth.token         === null   <-- ALWAYS null, by design
```

### How requests carry the session

Every request the SDK makes goes through one `fetch` call hardcoded with `credentials: "include"`. That is the entire auth mechanism: the browser attaches the httpOnly cookie to each cross-origin request automatically. `credentials: "include"` is not opt-in and not configurable.

The only app-level headers sent on every request are:

```
Content-Type: application/json
X-Surf-Project-Name: <your projectName>
X-Surf-Project-Id: <your projectId>
```

There is **no `Authorization` header anywhere** and no `Bearer` token. Do not try to inject one — the API does not look for it.

### `AuthState.token` is null even when authenticated

`AuthState` is shaped as:

```ts
interface AuthState {
  token: string | null;       // ALWAYS null under cookie auth
  address: Address | null;
  authenticated: boolean;
  user: UserProfile | null;
}
```

After a successful `authenticate()`, `authState.token` is **explicitly set to `null`** while `authState.authenticated` is `true`. **Never gate logic on `authState.token`.**

```ts
// WRONG — token is always null, this branch never runs
if (client.getAuthState().token) { /* ... */ }

// RIGHT — gate on authenticated / user
const { authenticated, user } = client.getAuthState();
if (authenticated && user) { /* proceed */ }
```

`LoginResponse.token` / `LoginResponse.expiresAt` are marked **deprecated** and are `undefined` under cookie auth — ignore them.

### CORS requirements

Because `credentials: "include"` is sent on every request, the API **must** be configured for credentialed cross-origin requests. Specifically the API responses must include:

- `Access-Control-Allow-Origin: <your exact web origin>` — a **specific** origin, **never** `*`. A wildcard is rejected by the browser for credentialed requests.
- `Access-Control-Allow-Credentials: true`
- Your consumer web origin must be on the API's allowlist (the bundled `examples/test-frontend` uses `http://localhost:3000`).

**Symptom of misconfiguration:** in DevTools the network request shows **HTTP 200** with a valid response body, yet the `fetch` promise **rejects** (TypeError) and your frontend errors out / no cookie is stored. That mismatch — 200 on the wire but a rejected promise in JS — almost always means the `Access-Control-Allow-Origin` is `*` (or absent / not matching your origin) or `Access-Control-Allow-Credentials: true` is missing. Fix it on the API's CORS config, not in SDK code.

### Session after page reload

`AuthState` is held **in memory only**. After a full page reload, `authenticated` resets to `false` and `user` to `null` — **even though the httpOnly cookie is still valid** and will still be attached to requests. The SDK has no persistence layer for auth state.

To restore the in-memory state on load, do one of:

- Call `client.authenticate()` again (prompts another signature), or
- Wire up `client.getMe()` style rehydration: `getMe()` (`GET /api/auth/me`) uses the existing cookie to return the live `UserProfile`. Note: `getMe()` exists on `AuthService` but is **not** wired into `SurfClient`'s public flow — you'd access it via your own integration if you want silent rehydration without a fresh signature.

To **extend** an already-valid session (not just read it), call `client.refreshSession()` (`POST /api/auth/refresh`). It uses the existing cookie to rotate it for a new ~7-day token without a fresh signature, returning `{ expiresAt }`. It does not repopulate the in-memory `AuthState`, so pair it with `authenticate()` or `getMe()` if you also need to restore `authenticated`/`user`.

### `logout()` is local-only

`client.logout()` clears the in-memory `AuthState` (sets `token`, `address`, `user` to `null` and `authenticated` to `false`) and emits `auth:logout`. It **cannot** delete the httpOnly, cross-origin cookie from JavaScript — that cookie is invisible to script by design. To truly end the session you must call a server-side logout endpoint that clears the cookie (`Set-Cookie` with an expired/empty value); the SDK does not do this for you.

## API reference

Every method below is an instance method on a built `SurfClient` (created via `SurfClient.create(config)` or `SurfClient.builder()...build()`). The **Requires** column states the precondition the method enforces at runtime:

- **none** — callable immediately after construction.
- **wallet** — a wallet must be connected (`connectWallet`) or the method throws `SurfError(WALLET_NOT_CONNECTED, "Wallet connection is required for this operation")` via the internal `requireWallet()` guard.
- **wallet (conditional)** — wallet only required when the optional address/vault argument is omitted; if you pass it explicitly, no wallet is needed.
- **vault** — a deployed user vault must be resolvable; on-chain reads/writes operate against a vault address (passed explicitly, or resolved from the backend via `getVault()`).

Two cross-cutting rules to internalize:

- **Amounts in `deposit`/`withdraw` are human-readable decimal strings, never wei.** `deposit({ amount: "100" })` means 100 USDC; the SDK calls `parseUnits` internally using the token's decimals. Do not pre-multiply by `10 ** decimals`.
- **All portfolio/profit/fee/balance reads return `bigint` (base units / wei), not numbers or strings.** Use `formatTokenAmount(value, decimals)` (exported from the SDK) to render them. `int256` values (`profits`, `getAssetProfit`, `getAssetProfitPercentage`) can be **negative**.

---

### Wallet

#### `connectWallet(walletName: WalletName | string): Promise<WalletState>`

| | |
|---|---|
| **Params** | `walletName` — one of `"metamask" \| "trust" \| "coinbase" \| "rabby" \| "phantom" \| "walletconnect" \| "injected"`, or a custom adapter name you registered. |
| **Returns** | `Promise<WalletState>` where `WalletState = { address: Address; chainId: ChainId; connected: boolean }`. |
| **Requires** | none |

Looks up the named adapter in the internal registry. If it isn't registered, throws `SurfError(WALLET_NOT_INSTALLED, "Wallet adapter <name> is not registered")`. If a *different* adapter was already active, it is disconnected first. Connects via `adapter.connect(config.chainId)`, then wires `onAccountsChanged` (emits `wallet:accountChanged` with `{ oldAddress, newAddress }`), `onChainChanged` (emits `wallet:chainChanged`), and `onDisconnect` (clears state, emits `wallet:disconnected`). Emits `wallet:connected` and returns the new `WalletState`.

> Note: `"walletconnect"` is pre-registered but **inert** unless you re-register it with a provider factory: `client.registerWalletAdapter("walletconnect", new WalletConnectAdapter(() => yourWcProvider))`. Otherwise `connect()` throws `WALLET_NOT_INSTALLED`.

#### `disconnectWallet(): Promise<void>`

| | |
|---|---|
| **Params** | none |
| **Returns** | `Promise<void>` |
| **Requires** | none |

Calls `activeWalletAdapter?.disconnect()`, clears the active adapter and wallet state, and emits `wallet:disconnected`. Safe to call when nothing is connected (no throw).

#### `getWalletState(): WalletState | null`

| | |
|---|---|
| **Params** | none |
| **Returns** | `WalletState \| null` (synchronous). `null` when no wallet is connected. |
| **Requires** | none |

#### `switchChain(chainId: number): Promise<void>`

| | |
|---|---|
| **Params** | `chainId` — target chain id. |
| **Returns** | `Promise<void>` |
| **Requires** | wallet |

Calls `activeWalletAdapter.switchChain(chainId)` and updates `walletState.chainId`.

> Important: this updates **only the wallet state**, not `config.chainId`. `getChainConfig()`, `factoryAddress`, `wethAddress`, and token resolution all continue using the originally-configured chain. To target a different chain for SDK operations, construct a new client with that `chainId`.

#### `registerWalletAdapter(name: string, adapter: IWalletAdapter): void`

| | |
|---|---|
| **Params** | `name` — lookup key used by `connectWallet`; `adapter` — an `IWalletAdapter` implementation. |
| **Returns** | `void` (synchronous). |
| **Requires** | none |

Adds or overwrites the adapter under `name`. Use this to supply a configured `WalletConnectAdapter` or a custom adapter.

---

### Auth

> Authentication is **cookie-based**. On successful login the backend sets an httpOnly session cookie (`SameSite=None; Secure`); the SDK never receives or stores a bearer token. Every request is sent with `credentials: "include"` so the browser attaches the cookie automatically. **Consequence:** `AuthState.token` is `null` even when `authenticated` is `true` — gate your logic on `getAuthState().authenticated` / `.user`, never on `.token`. For cross-origin requests to work, the API must return a specific `Access-Control-Allow-Origin` (not `*`) plus `Access-Control-Allow-Credentials: true`, with your web origin allowlisted.

#### `authenticate(): Promise<AuthState>`

| | |
|---|---|
| **Params** | none |
| **Returns** | `Promise<AuthState>` where `AuthState = { token: string \| null; address: Address \| null; authenticated: boolean; user: UserProfile \| null }`. `token` is always `null`. |
| **Requires** | wallet |

Flow: requests a nonce/message (`POST /api/auth/nonce`), asks the wallet to `signMessage(message)`, then logs in (`POST /api/auth/login`, which also sends the per-call `X-App-ID` header). On success sets `authState.address`, `authState.user`, `authState.authenticated = true`, leaves `token` `null`, emits `auth:authenticated`, and returns a copy of the auth state.

**Throws:** `SurfError(SIGNATURE_REJECTED, "Failed to sign authentication message", cause)` if the user rejects/`signMessage` fails; `SurfError(API_ERROR, "Request failed with status <code>", <body text>)` on a non-2xx nonce/login response.

> The returned `user` has `morphoVault`, `isInitialDeposit`, and `isWhitelisted` set to hardcoded placeholders (`null`/`false`) — the SDK does not call `/api/auth/me`, so those fields are not real server values.

#### `getAuthState(): AuthState`

| | |
|---|---|
| **Params** | none |
| **Returns** | `AuthState` — a shallow copy (`{ ...authState }`), synchronous. |
| **Requires** | none |

`token` is **always** `null` under cookie auth. Check `.authenticated` / `.user`.

#### `logout(): Promise<void>`

| | |
|---|---|
| **Params** | none |
| **Returns** | `Promise<void>` |
| **Requires** | none |

Clears local auth state (`token`, `address`, `user`, `authenticated`) and emits `auth:logout`. It does **not** call the backend and **cannot** delete the httpOnly cross-origin cookie from JS — the browser session may persist server-side until it expires.

#### `refreshSession(): Promise<RefreshResult>`

| | |
|---|---|
| **Params** | none |
| **Returns** | `Promise<RefreshResult>` = `{ expiresAt: string }` (ISO 8601 expiry of the freshly issued session token). |
| **Requires** | a currently-valid session cookie (no wallet signature, no body) |

REST `POST /api/auth/refresh`. Extends the session using the existing httpOnly auth cookie sent via `credentials: "include"` — there is **no** wallet signature and **no** request body (`Content-Type: application/json` is set automatically). The backend rotates the cookie (issuing a new ~7-day token) and invalidates the old token immediately. Does not re-prompt the wallet and does not mutate `getAuthState()`.

**Throws:** `SurfError(API_ERROR, "Request failed with status 401", ...)` if the cookie is missing, expired, or already revoked.

> Recommended usage: call this **proactively before expiry** (e.g. when fewer than 24h remain on the session) to extend the session without re-signing. Because it relies on the existing cookie, the same credentialed-CORS requirements apply.

---

### Vault

#### `getVault(walletAddress?: Address): Promise<VaultInfo>`

| | |
|---|---|
| **Params** | `walletAddress` — optional EOA address. |
| **Returns** | `Promise<VaultInfo>`. Key fields: `userVaultAddress: string \| null`, `deploymentSalt: string \| null`, `exists: boolean` (true iff `userVaultAddress` is set), `assets?: VaultAsset[]` (defaults to `[]`), plus optional `homeChainId`, `totalValueUSD`, `apyBreakdown` (which carries `currentAPY`/`nativeAPY`/`merklAPY`/`leagueAPY` and optional `totalAPY`, `apy7d`/`apy14d`/`apy30d`), etc. |
| **Requires** | wallet (conditional — only when `walletAddress` is omitted) |

REST `GET /api/v4/vault?walletAddress=<addr>`. When `walletAddress` is omitted, uses the connected wallet's address.

#### `deployVault(): Promise<DeployVaultResult>`

| | |
|---|---|
| **Params** | none |
| **Returns** | `Promise<DeployVaultResult>` = `{ vaultAddress: string; transactionHash: string; salt: string }`. |
| **Requires** | wallet |

Mixed REST + on-chain flow. Checks `getVault()` for an existing vault on the configured chain; if one already exists there, throws `SurfError(VAULT_ALREADY_EXISTS, "Vault already deployed on chain <id> at <address>")`. For a first-time deployment it calls `POST /api/v4/vault/prepare` to obtain a `salt` and predicted address, verifies the backend prediction matches the on-chain `computeVaultAddress` (throws `SurfError(VAULT_DEPLOY_FAILED, ...)` on mismatch), sends the on-chain `deployVault(owner, salt)` transaction, waits for the receipt (throws `SurfError(TRANSACTION_FAILED, "Vault deployment transaction did not return a receipt")` if none), then calls `POST /api/v4/vault/confirm`. Emits `vault:deployed`.

> A vault is treated as "new" (re-running prepare/confirm) when it doesn't exist **or** has no stored `deploymentSalt`. When reusing an existing salt for a vault that already exists on another chain, `confirm` is skipped.

#### `getSupportedAssets(chainId?: number): Promise<SupportedAsset[]>`

| | |
|---|---|
| **Params** | `chainId` — optional; filters results client-side. |
| **Returns** | `Promise<SupportedAsset[]>`; each = `{ assetAddress, assetSymbol, assetDecimals, chainId, chainStatus, currentAPY, nativeAPY, merklAPY, leagueAPY }` plus optional trailing-window APYs `apy7d?`, `apy14d?`, `apy30d?` (`number \| null`, `null` until enough history exists). |
| **Requires** | none |

REST. Internally reads the `defaultAssets` of `GET /api/v4/vault?walletAddress=0x` (sentinel address) and filters by `chainId` in-process if provided.

#### `getAgentMessages(walletAddress?: Address, page = 1, limit = 20, from?: string, to?: string): Promise<AgentMessagesResult>`

| | |
|---|---|
| **Params** | `walletAddress` — optional; `page` (default `1`), `limit` (default `20`); `from` / `to` — optional ISO-8601 timestamp strings that filter results by `timestamp`, inclusive on both ends. |
| **Returns** | `Promise<AgentMessagesResult>` = `{ page, limit, total, pages, messages: AgentMessage[] }`. |
| **Requires** | wallet (conditional — only when `walletAddress` is omitted) |

REST `GET /api/v4/agent-messages?walletAddress=&page=&limit=` (with `&from=&to=` appended, URL-encoded, when provided).

#### `getOwnerVaults(owner?: Address): Promise<string[]>`

| | |
|---|---|
| **Params** | `owner` — optional EOA address. |
| **Returns** | `Promise<string[]>` — vault addresses deployed by the owner. |
| **Requires** | wallet (conditional — only when `owner` is omitted) |

On-chain factory read (`getOwnerVaults`) via the configured read RPC.

#### `getOwnerVaultCount(owner?: Address): Promise<number>`

| | |
|---|---|
| **Params** | `owner` — optional EOA address. |
| **Returns** | `Promise<number>` (the `uint256` count is wrapped in `Number(...)`). |
| **Requires** | wallet (conditional — only when `owner` is omitted) |

On-chain factory read.

#### `isVaultFromFactory(vaultAddress: string): Promise<boolean>`

| | |
|---|---|
| **Params** | `vaultAddress` — address to check. |
| **Returns** | `Promise<boolean>`. |
| **Requires** | none |

On-chain factory read confirming the vault was deployed by the configured factory.

#### `getAllowedAssets(vaultAddress?: string): Promise<string[]>`

| | |
|---|---|
| **Params** | `vaultAddress` — optional; resolved via `getVault()` if omitted. |
| **Returns** | `Promise<string[]>` — asset addresses the vault permits. |
| **Requires** | vault; wallet (conditional — only when `vaultAddress` is omitted, to resolve via REST) |

On-chain vault read (`getAllowedAssets`).

#### `getFeeInfo(vaultAddress?: string): Promise<FeeInfo>`

| | |
|---|---|
| **Params** | `vaultAddress` — optional; resolved via `getVault()` if omitted. |
| **Returns** | `Promise<FeeInfo>` = `{ revenueAddress: string; feePercentage: bigint; rebalanceFeePercentage: bigint; merklClaimFeePercentage: bigint }`. The three percentages are `bigint`. |
| **Requires** | vault; wallet (conditional — only when `vaultAddress` is omitted) |

On-chain vault read (`getFeeInfo`).

#### `hasInitialDeposit(asset: string, vaultAddress?: string): Promise<boolean>`

| | |
|---|---|
| **Params** | `asset` — token address; `vaultAddress` — optional, resolved via `getVault()` if omitted. |
| **Returns** | `Promise<boolean>` — whether the asset has had its initial deposit into the vault. |
| **Requires** | vault; wallet (conditional — only when `vaultAddress` is omitted) |

On-chain vault read (`assetHasInitialDeposit`). Determines which deposit path runs inside `deposit()` (initial vs. user deposit). Throws `SurfError(VAULT_NOT_FOUND, "User vault could not be resolved")` if the vault cannot be resolved.

---

### Deposits / Withdrawals

#### `deposit(params: DepositParams): Promise<TransactionResult>`

| | |
|---|---|
| **Params** | `DepositParams = { asset: Address; amount: string; vaultAddress?: string; bestVault?: string; wrapEth?: boolean }`. `asset` is matched against the configured chain's token list **by address** (case-insensitive). `amount` is a **human-readable decimal string** (e.g. `"100"`), not wei. |
| **Returns** | `Promise<TransactionResult>` = `{ hash: string; wait(): Promise<TransactionReceipt \| null> }`. |
| **Requires** | wallet; vault |

Flow: resolves the token from `asset` (throws `SurfError(INVALID_CONFIG, "Asset <asset> is not registered on chain <id>")` if the address isn't in the chain's token list — **passing a symbol like `"USDC"` will fail**). Resolves the vault address (from `vaultAddress`, else `getVault()`; throws `SurfError(VAULT_NOT_FOUND, ...)` if unresolved). Emits `deposit:started`. Converts the amount with `parseTokenAmount(amount, token.decimals)`. If `wrapEth` is true, wraps native into WETH first (awaited) and switches the deposit asset to WETH. If `autoApprove` is enabled (**default `true`**) and current allowance is below the amount, approves `addApprovalBuffer(amountWei)` (amount + 0.1%) to the vault, emits `deposit:approved`, and awaits the approval. Then branches: if the asset already has an initial deposit it calls `userDeposit`, otherwise `initialDeposit` (resolving a best vault via `bestVault` param → REST `getBestVault(symbol)` → on-chain available vaults, else throws `SurfError(NO_BEST_VAULT, "No best vault available for <symbol>")`). Emits `deposit:completed`.

> The returned deposit transaction is **not** awaited internally — only the optional wrap and approval are. Call `result.wait()` yourself to await confirmation. The 0.1% buffer is added to the **approval** amount only, never to the deposited amount.

#### `withdraw(params: WithdrawParams): Promise<TransactionResult>`

| | |
|---|---|
| **Params** | `WithdrawParams = { asset: Address; amount?: string; vaultAddress?: string }`. `amount` is a **human-readable decimal string**. Omitting `amount` (or passing `"0"`) means **withdraw all**. |
| **Returns** | `Promise<TransactionResult>` = `{ hash; wait() }`. |
| **Requires** | wallet; vault |

Resolves the vault address (REST if omitted). If `amount` is provided and not `"0"`, fetches the asset's decimals **fresh on-chain** (`tokenService.decimals`) and converts via `parseUnits`; otherwise `amountWei = 0n`, which the contract interprets as a **full withdrawal** (there is no separate withdraw-all method). Emits `withdraw:started`, submits the on-chain `withdraw(asset, amount)` tx, emits `withdraw:completed`, and returns the `TransactionResult`. The tx is not awaited internally — call `result.wait()` to confirm.

#### `getWithdrawableAmount(asset: string, vaultAddress?: string): Promise<bigint>`

| | |
|---|---|
| **Params** | `asset` — token address; `vaultAddress` — optional, resolved via `getVault()` if omitted. |
| **Returns** | `Promise<bigint>` — the vault's holdings of `asset`, in base units. |
| **Requires** | vault; wallet (conditional — only when `vaultAddress` is omitted) |

On-chain vault read (`getAssetVaultAssets`). This is the **vault's** balance, distinct from `getTokenBalance` (the EOA's wallet balance).

#### `getBestVault(assetSymbol: string): Promise<BestVaultOption[]>`

| | |
|---|---|
| **Params** | `assetSymbol` — token symbol (e.g. `"USDC"`); URL-encoded internally. |
| **Returns** | `Promise<BestVaultOption[]>`; each = `{ chainId: number; vaultAddress: Address }`. |
| **Requires** | none |

REST `GET /api/v4/vaults/best?assetSymbol=<encoded>`. Useful for pre-selecting a `bestVault` to pass into `deposit()`.

---

### Portfolio

> All numeric outputs here are `bigint` in base units. `profits` (and `getAssetProfit`/`getAssetProfitPercentage`) are `int256` and **can be negative** — no sign normalization is applied.

#### `getPortfolioSummary(vaultAddress?: string): Promise<PortfolioSummary>`

| | |
|---|---|
| **Params** | `vaultAddress` — optional; resolved via `getVault()` if omitted. |
| **Returns** | `Promise<PortfolioSummary>` = `{ assets: string[]; deposited: bigint[]; currentValues: bigint[]; profits: bigint[]; activeCount: number }`. The four arrays are index-aligned by asset; `profits` may contain negatives. |
| **Requires** | vault; wallet (conditional — only when `vaultAddress` is omitted) |

On-chain vault read (`getPortfolioSummary`).

#### `getAssetProfit(asset: string, vaultAddress?: string): Promise<bigint>`

| | |
|---|---|
| **Params** | `asset` — token address; `vaultAddress` — optional. |
| **Returns** | `Promise<bigint>` — absolute profit in base units (`int256`, can be negative). |
| **Requires** | vault; wallet (conditional — only when `vaultAddress` is omitted) |

On-chain vault read (`getAssetProfit`).

#### `getAssetProfitPercentage(asset: string, vaultAddress?: string): Promise<bigint>`

| | |
|---|---|
| **Params** | `asset` — token address; `vaultAddress` — optional. |
| **Returns** | `Promise<bigint>` — profit percentage as an on-chain scaled `int256` (can be negative). |
| **Requires** | vault; wallet (conditional — only when `vaultAddress` is omitted) |

On-chain vault read (`getAssetProfitPercentage`).

---

### Token utils

#### `getTokenBalance(token: string, owner?: string): Promise<bigint>`

| | |
|---|---|
| **Params** | `token` — ERC-20 token address; `owner` — optional EOA, defaults to the connected wallet. |
| **Returns** | `Promise<bigint>` — the **wallet (EOA)** balance in base units. |
| **Requires** | wallet (conditional — only when `owner` is omitted) |

On-chain ERC-20 `balanceOf`. This is the user's wallet balance, **not** the vault's holdings (use `getWithdrawableAmount` / `getPortfolioSummary` for vault balances).

#### `getSupportedTokens(): TokenConfig[]`

| | |
|---|---|
| **Params** | none |
| **Returns** | `TokenConfig[]` (a clone), each = `{ symbol: string; address: Address; decimals: number; vaultAddresses: Address[] }`, synchronous. |
| **Requires** | none |

Returns the token list for the configured chain. Use the `address` field as the `asset` argument for `deposit`/`withdraw`, and `decimals` for formatting bigint balances.

#### `getConfig(): Readonly<ResolvedSurfConfig>`

| | |
|---|---|
| **Params** | none |
| **Returns** | `Readonly<ResolvedSurfConfig>` — a frozen copy: `{ projectName, projectId, appId, environment, chainId, rpcUrl, apiBaseUrl, factoryAddress, autoApprove, logger }`, synchronous. |
| **Requires** | none |

Returns the fully-resolved, immutable configuration the client is running with (defaults applied, addresses/RPC resolved).

## Events

`SurfClient` is an event emitter. Subscribe with `client.on(eventName, handler)` and unsubscribe with `client.off(eventName, sameHandlerReference)`. Both are strongly typed against `SurfEventMap`, so the handler's `data` argument is inferred per event. There is **no** `once`; pass the **same function reference** to `off` that you passed to `on`.

```ts
import type { SurfEventMap, WalletState, AuthState } from "@surf_liquid/core-sdk";

const onConnected = (data: WalletState) => {
  console.log("connected", data.address, data.chainId, data.connected);
};

client.on("wallet:connected", onConnected);
client.on("auth:authenticated", (auth: AuthState) => {
  // NOTE: under cookie auth, auth.token is null — gate on auth.authenticated / auth.user
  console.log("authed?", auth.authenticated, auth.user?.walletAddress);
});
client.on("deposit:completed", ({ asset, amount, txHash }) => {
  console.log(`deposited ${amount} of ${asset} in tx ${txHash}`);
});
client.on("error", ({ code, message }) => {
  console.error(`[${code}] ${message}`);
});

// Later — must be the SAME function reference:
client.off("wallet:connected", onConnected);
```

### Complete event map (`SurfEventMap`)

| Event name | Payload type | Emitted when |
|---|---|---|
| `wallet:connected` | `WalletState` (`{ address; chainId; connected }`) | A wallet adapter connects successfully. |
| `wallet:disconnected` | `void` (handler receives `undefined`) | The wallet disconnects, or a disconnect is observed from the provider. |
| `wallet:accountChanged` | `{ oldAddress: string; newAddress: string }` | The active account changes in the wallet. |
| `wallet:chainChanged` | `{ chainId: number }` | The wallet switches network. |
| `auth:authenticated` | `AuthState` (`{ token; address; authenticated; user }`) | Login/auth completes. `token` is `null` under cookie auth — read `authenticated`/`user`. |
| `auth:logout` | `void` (handler receives `undefined`) | `logout()` is called (clears local state only). |
| `vault:deployed` | `DeployVaultResult` (`{ vaultAddress; transactionHash; salt }`) | A new user vault is deployed on-chain. |
| `deposit:started` | `{ asset: string; amount: string }` | A deposit flow begins. |
| `deposit:approved` | `{ asset: string; txHash: string }` | An ERC-20 approval tx for the deposit is confirmed. |
| `deposit:completed` | `{ asset: string; amount: string; txHash: string }` | The deposit tx is confirmed. |
| `withdraw:started` | `{ asset: string; amount: string }` | A withdraw flow begins. |
| `withdraw:completed` | `{ asset: string; amount: string; txHash: string }` | The withdraw tx is confirmed. |
| `error` | `{ code: string; message: string }` | An operation fails (unprefixed key). `code` is a plain `string`, **not** the `SurfErrorCode` enum type. |

Notes:
- The `error` event key is **unprefixed** (`"error"`), unlike every other namespaced `x:y` key.
- `wallet:disconnected` and `auth:logout` carry a `void` payload; handlers receive `undefined`, not an object.
- Handler exceptions are caught internally and logged (`console.error`); a throwing handler will not break the emit loop or other listeners.

## Error handling

Recoverable failures throw a `SurfError`, which extends the native `Error` with a typed `code` (a `SurfErrorCode` enum value), the human-readable `message`, and an optional `cause` (the underlying error/object that triggered it). `error.name` is always `"SurfError"`.

```ts
export class SurfError extends Error {
  constructor(
    public readonly code: SurfErrorCode,
    message: string,
    public readonly cause?: unknown,
  );
  // sets this.name = "SurfError"
}
```

Branch on `error.code` (compare against `SurfErrorCode` enum members), not on the message string:

```ts
import { SurfError, SurfErrorCode } from "@surf_liquid/core-sdk";

try {
  await client.deposit({ asset: "0x...", amount: "100" });
} catch (err) {
  if (err instanceof SurfError) {
    switch (err.code) {
      case SurfErrorCode.WALLET_NOT_CONNECTED:
        // prompt the user to connect a wallet
        break;
      case SurfErrorCode.INSUFFICIENT_BALANCE:
        // show "not enough balance"
        break;
      case SurfErrorCode.WALLET_REJECTED:
      case SurfErrorCode.SIGNATURE_REJECTED:
        // user cancelled in the wallet — usually safe to ignore
        break;
      default:
        console.error(err.code, err.message, err.cause);
    }
  } else {
    throw err; // not a SurfError
  }
}
```

### Complete `SurfErrorCode` table

Each enum member's string value is identical to its key (e.g. `SurfErrorCode.AUTH_FAILED === "AUTH_FAILED"`).

| Code | Typical cause |
|---|---|
| `INVALID_CONFIG` | Supplied `SurfConfig` failed validation. |
| `MISSING_PROJECT_ID` | Required project identifier was not provided/resolved. |
| `INVALID_ENVIRONMENT` | `environment` is not `"mainnet"` or `"testnet"`. |
| `UNSUPPORTED_CHAIN` | The requested `chainId` is not in the chain registry for the environment. |
| `ENVIRONMENT_CHAIN_MISMATCH` | The chain does not belong to the configured environment (e.g. testnet chain on mainnet). |
| `WALLET_NOT_INSTALLED` | The requested wallet adapter/extension is not available in the browser. |
| `WALLET_NOT_CONNECTED` | An operation requiring a connected wallet was attempted before connecting. |
| `WALLET_REJECTED` | The user rejected a wallet request (e.g. connect/switch chain). |
| `WRONG_CHAIN` | The wallet is on a different chain than the operation requires. |
| `AUTH_FAILED` | Authentication (nonce/login/session) failed. |
| `SIGNATURE_REJECTED` | The user declined to sign the login/auth message. |
| `VAULT_NOT_FOUND` | No vault exists for the given owner/address. |
| `VAULT_ALREADY_EXISTS` | Attempted to deploy a vault that already exists for the owner/salt. |
| `VAULT_DEPLOY_FAILED` | The on-chain vault deployment transaction failed. |
| `INSUFFICIENT_BALANCE` | The wallet lacks enough token balance for the operation. |
| `APPROVE_FAILED` | An ERC-20 approval transaction failed. |
| `DEPOSIT_FAILED` | A deposit transaction failed. |
| `WITHDRAW_FAILED` | A withdraw transaction failed. |
| `NO_BEST_VAULT` | No best vault could be resolved for the asset. |
| `API_ERROR` | A REST API request returned an error/non-OK response. |
| `RPC_ERROR` | A JSON-RPC / provider call failed. |
| `TRANSACTION_FAILED` | A transaction failed/reverted (generic on-chain failure). |

> The `error` event payload's `code` is a plain `string` (mirroring `SurfError.code`'s value), not the `SurfErrorCode` enum type. When matching, compare against the enum members' string values.

## Types

All interfaces below are publicly exported from `@surf_liquid/core-sdk` (reproduced verbatim from source).

### Primitives & aliases (`common.ts`)

```ts
import type { TransactionReceipt } from "ethers";

export type Address = `0x${string}`;
export type ChainId = number;
export type Environment = "mainnet" | "testnet";
export type LogLevel = "debug" | "info" | "warn" | "error" | "none";
export type WalletName =
  | "metamask"
  | "trust"
  | "coinbase"
  | "rabby"
  | "phantom"
  | "walletconnect"
  | "injected";

export interface TransactionResult {
  hash: string;
  wait(): Promise<TransactionReceipt | null>;
}
```

> `Address` is a **template-literal type** (`` `0x${string}` ``), not a plain `string`. Use `0x`-prefixed string literals or cast (`addr as Address`) when feeding plain strings into APIs that expect `Address`.
> `TransactionResult.wait()` can resolve to `null` (ethers may return a null receipt).

### Auth (`auth.ts`)

```ts
export interface UserProfile {
  morphoVault: string | null;
  isInitialDeposit: boolean;
  isWhitelisted: boolean;
  vaultVersion: string;
  walletAddress?: Address;
  isActive?: boolean;
  activeStrategies?: string[];
  twitterAccount?: string;
}

export interface AuthState {
  token: string | null;
  address: Address | null;
  authenticated: boolean;
  user: UserProfile | null;
}

export interface RefreshResult {
  expiresAt: string;
}
```

> **Cookie-based auth:** `AuthState.token` is typed `string | null` but is **always `null`** even when `authenticated: true` — the session lives in an httpOnly cookie the SDK never reads. Gate logic on `authenticated` / `user`, never on `token`.
> `login()` returns a partial `UserProfile` with `morphoVault: null`, `isInitialDeposit: false`, `isWhitelisted: false` hardcoded regardless of backend state. To get the real values of those three flags (plus `vaultVersion`), call `getMe()`.

### Wallet (`wallet.ts`)

```ts
export interface WalletState {
  address: Address;
  chainId: ChainId;
  connected: boolean;
}
```

### Vault (`vault.ts`)

```ts
export interface VaultEarned {
  nativeEarningsUSD: number;
  merklRewardsUSD: number;
  leagueEarnedUSD: number;
  totalEarningsUSD: number;
}

export interface VaultApyBreakdown {
  nativeAPY: number;
  merklAPY: number;
  leagueAPY: number;
  currentAPY: number;
  totalAPY?: number;            // alias some responses use for the blended current APY
  apy7d?: number | null;        // trailing-window APYs (portfolio-weighted); null until enough history
  apy14d?: number | null;
  apy30d?: number | null;
}

export interface VaultLeague {
  totalXP: number;
  rank: number;
  estimatedSURF: number;
  estimatedSURFUSD: number;
  joinDate: string;
}

export interface VaultAsset {
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  chainId: number;
  chainStatus: string;
  morphoVaultAddress: string;
  balance: number;
  currentValueUSD: number;
  depositedAmountUSD: number;
  totalEarnings: number;
  totalEarningsUSD: number;
  currentAPY: number;
  nativeAPY: number;
  merklAPY: number;
  leagueAPY: number;
  apy7d?: number | null;        // trailing-window APYs for this asset; null until enough history
  apy14d?: number | null;
  apy30d?: number | null;
  leagueEarnedUSD: number;
  cumulativeReturn: number;
  vaultAddress: string;
  vaultVersion: string;
}

export interface VaultInfo {
  userVaultAddress: string | null;
  deploymentSalt: string | null;
  exists: boolean;
  walletAddress?: string | null;
  homeChainId?: number | null;
  vaultVersion?: string | null;
  isActive?: boolean;
  totalValueUSD?: number | null;
  totalDepositedUSD?: number | null;
  earned?: VaultEarned | null;
  apyBreakdown?: VaultApyBreakdown | null;
  league?: VaultLeague | null;
  assets?: VaultAsset[];
  /** Per-chain vault addresses; can differ from userVaultAddress (e.g. Ethereum). */
  chainAddresses?: VaultChainAddress[];
}

export interface VaultChainAddress {
  chainId: number;
  vaultAddress: string;
}

export interface PortfolioSummary {
  assets: string[];
  deposited: bigint[];
  currentValues: bigint[];
  profits: bigint[];
  activeCount: number;
}

export interface FeeInfo {
  revenueAddress: string;
  feePercentage: bigint;
  rebalanceFeePercentage: bigint;
  merklClaimFeePercentage: bigint;
}

export interface DepositParams {
  asset: Address;
  amount: string;
  vaultAddress?: string;
  bestVault?: string;
  wrapEth?: boolean;
}

export interface WithdrawParams {
  asset: Address;
  amount?: string;
  vaultAddress?: string;
}

export interface SupportedAsset {
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  chainId: number;
  chainStatus: string;
  currentAPY: number;
  nativeAPY: number;
  merklAPY: number;
  leagueAPY: number;
  apy7d?: number | null;        // trailing-window APYs; null/absent when the position has no history
  apy14d?: number | null;
  apy30d?: number | null;
}

export interface VaultRef {
  name: string;
  address: string;
  apy: number;
}

export interface AgentMessage {
  message: string;
  txHash: string;
  timestamp: string;
  transactionType:
    | "INITIAL_DEPOSIT"
    | "DEPOSIT"
    | "USER_DEPOSIT"
    | "WITHDRAWAL"
    | "USER_WITHDRAWAL"
    | "REBALANCE"
    | "REBALANCE_COMPLETED"
    | "REBALANCE_CANCELLED"
    | "CROSS_CHAIN_REBALANCE"
    | "MERKL_CLAIM"
    | "ASSET_ADDED"
    | "ASSET_REMOVED"
    | "ASSET_SWAPPED"
    | "MIGRATE"
    | string;
  executedBy: "USER" | "AGENT";
  vaultVersion: string;
  chainId: number;
  // Optional structured fields derived from the transaction; omitted when not applicable.
  signal?: string | null;
  amount?: number | null;
  token?: string | null;
  fromVault?: VaultRef | null;
  toVault?: VaultRef | null;
  apyBefore?: number | null;
  apyAfter?: number | null;
}

export interface AgentMessagesResult {
  page: number;
  limit: number;
  total: number;
  pages: number;
  messages: AgentMessage[];
}

export interface BestVaultOption {
  chainId: number;
  vaultAddress: Address;
}
```

> `PortfolioSummary.deposited` / `currentValues` / `profits` are `bigint[]` (raw on-chain values aligned by index with `assets`); format with `formatTokenAmount` for display. `activeCount` is the number of active asset positions.
> `FeeInfo` fee fields are `bigint` (scaled basis points), not JS numbers; `revenueAddress` is a plain `string`.
> Mixed address typing: `DepositParams.asset`, `WithdrawParams.asset`, and `BestVaultOption.vaultAddress` are typed `Address`, while `VaultInfo.userVaultAddress`, `VaultAsset.assetAddress`, `SupportedAsset.assetAddress`, and `DepositParams.vaultAddress`/`bestVault` are plain `string`.
> `AgentMessage.transactionType` is widened by `| string`, so the literal union (which now also covers `DEPOSIT`, `WITHDRAWAL`, `REBALANCE_COMPLETED`, `REBALANCE_CANCELLED`, `MERKL_CLAIM`, `ASSET_ADDED`, `ASSET_REMOVED`, `ASSET_SWAPPED`) is non-exhaustive — handle unknown values in switch statements. The structured fields (`amount`, `token`, `fromVault`, `toVault`, `apyBefore`, `apyAfter`, `signal`) are optional **and** nullable, and present only for the transaction types they apply to (e.g. `fromVault`/`toVault`/`apyBefore`/`apyAfter` on rebalance/migration messages).
> Check `VaultInfo.exists` first; analytics fields (`earned`/`apyBreakdown`/`league`/`assets`) and most metadata are optional **and** nullable, so a present-but-`null` value differs from an absent (`undefined`) one.
> Trailing-window APYs (`apy7d`/`apy14d`/`apy30d`) on `VaultApyBreakdown` (portfolio-weighted, alongside the optional `totalAPY` alias for the blended current APY), `VaultAsset`, and `SupportedAsset` are optional and `null` until enough history exists — distinguish `null` (insufficient history) from absent.

### Config (`config.ts`)

```ts
export interface TokenConfig {
  symbol: string;
  address: Address;
  decimals: number;
  vaultAddresses: Address[];
}

export interface ChainConfig {
  environment: Environment;
  chainId: ChainId;
  name: string;
  rpcUrl: string;
  factoryAddress: Address;
  wethAddress: Address;
  tokens: TokenConfig[];
  blockExplorerUrl?: string;
}

export interface SurfConfig {
  projectName: string;
  projectId?: string;
  appId?: string;
  environment?: Environment;
  chainId?: ChainId;
  rpcUrl?: string;
  apiBaseUrl?: string;
  factoryAddress?: Address;
  autoApprove?: boolean;
  logger?: LogLevel;
}
```

> `SurfConfig` is the consumer-supplied input: only `projectName` is required; the builder fills the rest (`projectId`, `appId`, `environment`, `chainId`, `rpcUrl`, `apiBaseUrl`, `factoryAddress`, `autoApprove`, `logger`) into a fully-required internal `ResolvedSurfConfig`.

## Recipes

Every import below uses the exact published package name `@surf_liquid/core-sdk` and only real exported names. `ethers@^6` must be available in the consuming project (it is a peer dependency).

Two cross-cutting rules that every recipe respects:

- **Gate authenticated UI on `getAuthState().authenticated` / `.user`, never on `.token`.** Auth is cookie-based: the session is delivered as an httpOnly cookie, so `AuthState.token` is always `null` even when `authenticated: true`.
- **`deposit()` / `withdraw()` match `asset` by ADDRESS, not symbol.** Pass a token address that is registered in the active chain config (see `getSupportedTokens()`), otherwise `deposit()` throws `SurfError(INVALID_CONFIG)`.

---

### 1. React — full flow (connect → authenticate → getVault/deploy → deposit)

Create the client once at module scope (it is synchronous and stateful). Register event listeners inside `useEffect` so they are cleaned up on unmount. Gate the deposit UI on `authState.authenticated`.

```tsx
import { useEffect, useState, useCallback } from "react";
import {
  SurfClient,
  SurfError,
  type AuthState,
  type WalletState,
  type VaultInfo,
} from "@surf_liquid/core-sdk";

// Module scope: one client for the whole app. create() is synchronous.
const surf = SurfClient.create({
  projectName: "My DApp",
  appId: "your-app-id", // appId or projectId (appId wins). projectName + one of them is required.
  environment: "mainnet", // default; chainId then defaults to Base 8453
  // chainId: 8453,        // optional; Base mainnet is the default for mainnet
  // rpcUrl: "https://...",// optional; falls back to the chain default (Base => https://mainnet.base.org)
  // autoApprove: true,    // default true: deposit() auto-approves amount + 0.1% buffer when needed
});

// Base mainnet USDC (6 decimals) — a real entry in the default chain token list.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function VaultPanel() {
  const [wallet, setWallet] = useState<WalletState | null>(surf.getWalletState());
  const [auth, setAuth] = useState<AuthState>(surf.getAuthState());
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [status, setStatus] = useState<string>("");

  // Listeners live in useEffect so React cleans them up. Mirror SDK state into React state.
  useEffect(() => {
    const onConnected = (w: WalletState) => setWallet(w);
    const onDisconnected = () => {
      setWallet(null);
      setAuth(surf.getAuthState());
    };
    const onAccountChanged = () => {
      setWallet(surf.getWalletState());
      setAuth(surf.getAuthState());
    };
    const onAuthed = (a: AuthState) => setAuth(a);
    const onLogout = () => setAuth(surf.getAuthState());
    const onDeposited = (e: { asset: string; amount: string; txHash: string }) =>
      setStatus(`Deposit submitted: ${e.txHash}`);

    surf.on("wallet:connected", onConnected);
    surf.on("wallet:disconnected", onDisconnected);
    surf.on("wallet:accountChanged", onAccountChanged);
    surf.on("auth:authenticated", onAuthed);
    surf.on("auth:logout", onLogout);
    surf.on("deposit:completed", onDeposited);

    return () => {
      surf.off("wallet:connected", onConnected);
      surf.off("wallet:disconnected", onDisconnected);
      surf.off("wallet:accountChanged", onAccountChanged);
      surf.off("auth:authenticated", onAuthed);
      surf.off("auth:logout", onLogout);
      surf.off("deposit:completed", onDeposited);
    };
  }, []);

  const connect = useCallback(async () => {
    try {
      // "metamask" is one of the 7 pre-registered adapter names.
      await surf.connectWallet("metamask");
    } catch (err) {
      if (err instanceof SurfError) setStatus(`${err.code}: ${err.message}`);
    }
  }, []);

  const authenticate = useCallback(async () => {
    try {
      // Triggers a signature, then POST /api/auth/login. The session arrives as an httpOnly cookie.
      await surf.authenticate();
    } catch (err) {
      if (err instanceof SurfError) setStatus(`${err.code}: ${err.message}`);
    }
  }, []);

  const loadOrDeployVault = useCallback(async () => {
    try {
      const existing = await surf.getVault(); // uses connected wallet address
      if (existing.exists) {
        setVault(existing);
        setStatus(`Vault: ${existing.userVaultAddress}`);
        return;
      }
      // No vault yet: prepare (REST) + deploy (on-chain) + confirm (REST), all inside deployVault().
      const result = await surf.deployVault();
      setStatus(`Vault deployed at ${result.vaultAddress} (tx ${result.transactionHash})`);
      setVault(await surf.getVault());
    } catch (err) {
      if (err instanceof SurfError) setStatus(`${err.code}: ${err.message}`);
    }
  }, []);

  const depositUsdc = useCallback(async () => {
    try {
      // amount is a human string; the SDK parses it with the token's decimals.
      const tx = await surf.deposit({ asset: USDC, amount: "10" });
      setStatus(`Deposit tx ${tx.hash} — awaiting confirmation`);
      await tx.wait(); // deposit() does NOT await the tx itself; call wait() yourself.
      setStatus(`Deposit confirmed: ${tx.hash}`);
    } catch (err) {
      if (err instanceof SurfError) setStatus(`${err.code}: ${err.message}`);
    }
  }, []);

  return (
    <div>
      {!wallet && <button onClick={connect}>Connect MetaMask</button>}

      {wallet && !auth.authenticated && (
        <button onClick={authenticate}>Sign in</button>
      )}

      {/* Gate on authenticated, NOT auth.token (token is always null under cookie auth). */}
      {auth.authenticated && (
        <>
          <button onClick={loadOrDeployVault}>Load / deploy vault</button>
          <button onClick={depositUsdc} disabled={!vault?.exists}>
            Deposit 10 USDC
          </button>
        </>
      )}

      <p>{status}</p>
    </div>
  );
}
```

---

### 2. Vanilla JS / browser (ESM)

Public reads like `getSupportedAssets()` need no wallet and no auth. The same client then drives the full connect → authenticate → deposit flow once the user clicks. This assumes a bundler (Vite/webpack) resolving the package; serve from an allowlisted origin (the example harness uses `http://localhost:3000`) so the credentialed cookie requests pass CORS.

```html
<!doctype html>
<html>
  <body>
    <button id="connect">Connect</button>
    <button id="auth">Sign in</button>
    <button id="deposit">Deposit 5 USDC</button>
    <pre id="log"></pre>

    <script type="module">
      import {
        SurfClient,
        SurfError,
        formatTokenAmount,
      } from "@surf_liquid/core-sdk";

      const log = (m) => (document.getElementById("log").textContent += m + "\n");

      const surf = SurfClient.create({
        projectName: "Vanilla Demo",
        appId: "your-app-id",
        environment: "mainnet", // Base 8453 by default
      });

      const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

      surf.on("deposit:approved", (e) => log(`Approved ${e.asset}: ${e.txHash}`));
      surf.on("deposit:completed", (e) => log(`Deposit done: ${e.txHash}`));

      // Public, no wallet / no auth required:
      const assets = await surf.getSupportedAssets(8453);
      assets.forEach((a) =>
        log(`${a.assetSymbol} @ ${a.assetAddress} — APY ${a.currentAPY}`),
      );

      document.getElementById("connect").onclick = async () => {
        try {
          const w = await surf.connectWallet("injected"); // raw window.ethereum
          log(`Connected ${w.address} on chain ${w.chainId}`);
        } catch (err) {
          if (err instanceof SurfError) log(`${err.code}: ${err.message}`);
        }
      };

      document.getElementById("auth").onclick = async () => {
        const auth = await surf.authenticate(); // signature + httpOnly cookie session
        log(`Authenticated: ${auth.authenticated}`); // auth.token is null by design
      };

      document.getElementById("deposit").onclick = async () => {
        try {
          const existing = await surf.getVault();
          if (!existing.exists) {
            const d = await surf.deployVault();
            log(`Vault deployed: ${d.vaultAddress}`);
          }
          const tx = await surf.deposit({ asset: USDC, amount: "5" });
          await tx.wait();
          // USDC has 6 decimals; format a bigint balance for display:
          const bal = await surf.getTokenBalance(USDC);
          log(`Wallet USDC balance: ${formatTokenAmount(bal, 6)}`);
        } catch (err) {
          if (err instanceof SurfError) log(`${err.code}: ${err.message}`);
        }
      };
    </script>
  </body>
</html>
```

---

### 3. Node — read-only (no wallet)

Public REST reads (`getVault(address)`, `getSupportedAssets()`, `getBestVault()`) and on-chain reads that take an explicit address (`isVaultFromFactory()`, `getOwnerVaults(owner)`) need no wallet and no signing. Read methods hit the configured `rpcUrl` (Base mainnet defaults to the public `https://mainnet.base.org`; override for production).

```ts
import { SurfClient, formatTokenAmount } from "@surf_liquid/core-sdk";

async function main() {
  const surf = SurfClient.create({
    projectName: "Read-only Service",
    appId: "your-app-id",
    environment: "mainnet",
    chainId: 8453,
    // rpcUrl: "https://your-base-rpc", // recommended for production over the public default
  });

  // Pass the address explicitly so no wallet is needed.
  const wallet = "0x1111111111111111111111111111111111111111";

  // REST (no wallet, no auth):
  const vault = await surf.getVault(wallet);
  console.log("Vault exists:", vault.exists, "->", vault.userVaultAddress);

  const supported = await surf.getSupportedAssets(8453);
  console.log("Supported assets:", supported.map((a) => a.assetSymbol).join(", "));

  const best = await surf.getBestVault("USDC");
  console.log("Best USDC vaults:", best);

  // On-chain reads against the configured RPC (no wallet):
  const count = await surf.getOwnerVaultCount(wallet);
  console.log("Vault count:", count);

  if (vault.userVaultAddress) {
    const fromFactory = await surf.isVaultFromFactory(vault.userVaultAddress);
    console.log("Recognized by factory:", fromFactory);

    // Withdrawable USDC in the vault (bigint, raw units). USDC = 6 decimals.
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const withdrawable = await surf.getWithdrawableAmount(USDC, vault.userVaultAddress);
    console.log("Withdrawable USDC:", formatTokenAmount(withdrawable, 6));
  }
}

main().catch(console.error);
```

> Note: methods that omit the address argument (e.g. `getVault()`, `getTokenBalance()`) fall back to the connected wallet and throw `SurfError(WALLET_NOT_CONNECTED)` in a wallet-less Node context. Always pass the address for read-only use.

---

### 4. Custom wallet adapter (implement `IWalletAdapter`)

You can register any object that satisfies `IWalletAdapter`. The easiest path is to extend `BaseWalletAdapter`, which already implements `connect`, `disconnect`, `switchChain`, `getSigner`, `getProvider`, `getBrowserProvider`, `signMessage`, and the listener plumbing — you only supply `name`, the `installed` getter, and `resolveProvider()`.

```ts
import {
  SurfClient,
  BaseWalletAdapter,
} from "@surf_liquid/core-sdk";
import type { Eip1193Provider } from "ethers";

// Minimal adapter that wraps a specific injected provider you locate yourself.
class MyWalletAdapter extends BaseWalletAdapter {
  readonly name = "mywallet";

  get installed(): boolean {
    return Boolean(this.resolveProvider());
  }

  protected resolveProvider(): Eip1193Provider | undefined {
    if (typeof window === "undefined") return undefined; // SSR-safe
    const eth = (window as any).ethereum;
    // Pick the provider your wallet injects (brand flag, dedicated global, etc.):
    return eth?.isMyWallet ? eth : (window as any).myWallet;
  }
}

const surf = SurfClient.create({
  projectName: "Custom Wallet Demo",
  appId: "your-app-id",
});

// Register under a name, then connect by that name.
surf.registerWalletAdapter("mywallet", new MyWalletAdapter());
const state = await surf.connectWallet("mywallet");
console.log("Connected:", state.address, "chain", state.chainId);
```

If you implement the interface from scratch (without `BaseWalletAdapter`), provide every member:

```ts
import type { IWalletAdapter, WalletState } from "@surf_liquid/core-sdk";
import type { Signer, Eip1193Provider, BrowserProvider } from "ethers";

const adapter: IWalletAdapter = {
  name: "scratch",
  get installed() {
    return true;
  },
  async connect(chainId: number): Promise<WalletState> {
    /* request accounts, switch chain, return { address, chainId, connected: true } */
    return { address: "0x...", chainId, connected: true };
  },
  async disconnect(): Promise<void> {},
  async switchChain(_chainId: number): Promise<void> {},
  async getSigner(): Promise<Signer> {
    throw new Error("provide ethers Signer");
  },
  async getProvider(): Promise<Eip1193Provider> {
    throw new Error("provide Eip1193Provider");
  },
  async getBrowserProvider(): Promise<BrowserProvider> {
    throw new Error("provide ethers BrowserProvider");
  },
  async signMessage(_message: string): Promise<string> {
    return "0x...";
  },
  onAccountsChanged(_cb: (accounts: string[]) => void): void {},
  onChainChanged(_cb: (chainId: number) => void): void {},
  onDisconnect(_cb: () => void): void {},
  removeAllListeners(): void {},
};

surf.registerWalletAdapter("scratch", adapter);
```

---

### 5. WalletConnect via `WalletConnectAdapter(() => provider)`

`"walletconnect"` is pre-registered but inert by default: with no provider factory its `installed` is `false` and `connect()` throws `SurfError(WALLET_NOT_INSTALLED, "WalletConnect requires a provider factory during SDK setup")`. To enable it, construct your WalletConnect EIP-1193 provider and re-register the adapter with a factory that returns it.

```ts
import { SurfClient, WalletConnectAdapter } from "@surf_liquid/core-sdk";
import { EthereumProvider } from "@walletconnect/ethereum-provider";

const surf = SurfClient.create({
  projectName: "WalletConnect Demo",
  appId: "your-app-id",
  environment: "mainnet",
  chainId: 8453,
});

// Build the WalletConnect provider (your WC projectId from cloud.walletconnect.com).
const wcProvider = await EthereumProvider.init({
  projectId: "YOUR_WALLETCONNECT_PROJECT_ID",
  chains: [8453], // Base mainnet
  showQrModal: true,
});

// Re-register the adapter with a factory returning that provider, then connect.
surf.registerWalletAdapter(
  "walletconnect",
  new WalletConnectAdapter(() => wcProvider),
);

const state = await surf.connectWallet("walletconnect");
console.log("WalletConnect session:", state.address, state.chainId);

// From here the flow is identical: authenticate(), getVault()/deployVault(), deposit().
await surf.authenticate();
```

> The factory signature is `() => Eip1193Provider | undefined`. `WalletConnectAdapter.connect()` calls `provider.connect({ chains: [chainId] })` to establish the session before requesting accounts.

---

### 6. Register a custom chain + token via the builder

Use `SurfClient.builder()` for fluent setup. `registerChain(environment, ChainConfig)` adds a chain to the builder's cloned registry; `registerToken(environment, chainId, TokenConfig)` appends a token to a chain that must already be registered (it throws a plain `Error` for an unknown chain). Addresses are validated via ethers `isAddress` and throw `SurfError(INVALID_CONFIG)` if malformed.

```ts
import {
  SurfClient,
  type ChainConfig,
  type TokenConfig,
} from "@surf_liquid/core-sdk";

// A custom mainnet-environment chain (example: Optimism, chainId 10).
const optimism: ChainConfig = {
  environment: "mainnet",
  chainId: 10,
  name: "Optimism",
  rpcUrl: "https://mainnet.optimism.io",
  factoryAddress: "0x8fa50DeA8DB10987D7d22ac092001c3613C18779",
  wethAddress: "0x4200000000000000000000000000000000000006",
  tokens: [], // can be empty here; add tokens below
  blockExplorerUrl: "https://optimistic.etherscan.io",
};

const usdcOnOptimism: TokenConfig = {
  symbol: "USDC",
  address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  decimals: 6,
  vaultAddresses: ["0xAcB0DCe4b0FF400AD8F6917f3ca13E434C9ed6bC"],
};

const surf = SurfClient.builder()
  .setProject("Custom Chain Demo", "your-app-id") // sets projectName + appId/projectId
  .setEnvironment("mainnet")
  .registerChain("mainnet", optimism) // chain must be registered before its tokens
  .registerToken("mainnet", 10, usdcOnOptimism)
  .setChain(10) // select the custom chain as the active one
  .setRpcUrl("https://mainnet.optimism.io") // optional; otherwise falls back to chain.rpcUrl
  .setAutoApprove(true)
  .build();

console.log("Active chain:", surf.getConfig().chainId); // 10
console.log("Tokens:", surf.getSupportedTokens().map((t) => t.symbol)); // ["USDC"]
```

> You can also add a token to a built-in chain — e.g. `.registerToken("mainnet", 8453, myBaseToken)` after the default Base chain is already in the registry. The deposit/withdraw `asset` you pass at call time must match one of these registered token addresses (case-insensitive).

## Gotchas & footguns

- **Auth is cookie-based — `authState.token` is always `null`.** After `authenticate()`, the session arrives as an httpOnly cookie; the SDK never reads or stores a token and sends no `Authorization` header. `AuthState.token` stays `null` even when `authenticated: true`. **Gate every "is the user logged in?" check on `getAuthState().authenticated` (or `.user`), never on `.token`.** Likewise, `login()` hardcodes `morphoVault: null`, `isInitialDeposit: false`, `isWhitelisted: false` in the returned user — those are placeholders, not real backend state.
- **CORS must use a specific origin + credentials.** Because `credentials: "include"` is hardcoded on **every** request, the API must respond with `Access-Control-Allow-Origin: <your-exact-origin>` (NOT `*`) **and** `Access-Control-Allow-Credentials: true`, and your web origin must be on the backend's allowlist. The example harness uses `http://localhost:3000`. With `*` or an un-allowlisted origin, the browser blocks the response and **all** authenticated requests fail.
- **`logout()` can't kill the server session.** It only clears local SDK state and emits `auth:logout`; it does not call the backend and cannot delete the cross-origin httpOnly cookie from JS. The browser session may persist until the cookie expires server-side.
- **Deposit/withdraw amounts are human-readable strings, not wei.** `DepositParams.amount` / `WithdrawParams.amount` are decimal strings like `"100"` or `"0.05"`. The SDK calls `parseUnits(amount, decimals)` internally. Do **not** pre-multiply by `10**decimals` or pass a `bigint`. (Deposit uses the configured `TokenConfig.decimals`; withdraw fetches decimals fresh on-chain from `params.asset`.)
- **`withdraw` with no/`"0"` amount = withdraw ALL.** Omitting `amount`, passing `undefined`, or passing the string `"0"` results in `amountWei = 0n`, which the contract treats as a full withdrawal. There is no separate "withdraw all" method, so be deliberate about empty amounts.
- **Portfolio/profit/fee values are `bigint` — `JSON.stringify` throws on them.** `getPortfolioSummary()` (`deposited`/`currentValues`/`profits`), `getAssetProfit`, `getAssetProfitPercentage`, `getWithdrawableAmount`, `getTokenBalance`, and `FeeInfo.{feePercentage,rebalanceFeePercentage,merklClaimFeePercentage}` are all `bigint`. `JSON.stringify({ x: 1n })` throws `TypeError: Do not know how to serialize a BigInt`. Convert first with `formatTokenAmount(value, decimals)` (display) or `value.toString()` (transport), or supply a replacer. Note `profits` are `int256` and **can be negative**.
- **`autoApprove` defaults to `true`.** Unless you explicitly pass `autoApprove: false`, `deposit()` checks the ERC-20 allowance and, if it's below the amount, sends an approval transaction for `addApprovalBuffer(amountWei)` (amount + 0.1% / 10 bps) to the vault and awaits it before depositing. Expect a possible extra approval prompt and tx. The buffer is added to the **approval**, not to the deposited amount. With `autoApprove: false` you must pre-approve the vault yourself or the deposit reverts.
- **`wrapEth: true` wraps native ETH → WETH first.** When set on `deposit()`, the SDK calls `wrapNative(amountWei, wethAddress)` (the WETH `deposit({ value })` call), awaits it, then switches the deposited asset to the chain's `wethAddress`. Only use this on chains where `wethAddress` is the canonical wrapped-native token, and make sure `params.amount` is the native amount to wrap.
- **`deposit()` does not await the deposit tx.** It returns a `TransactionResult { hash, wait() }` immediately after submitting the deposit (only the optional wrap and approval txs are awaited internally). Call `await result.wait()` yourself if you need on-chain confirmation. `wait()` can resolve to `null`.
- **`deposit` matches `asset` by ADDRESS, not symbol.** `params.asset` must be a token **address** registered in the current chain's token list (case-insensitive match). Passing a symbol like `"USDC"` throws `SurfError(INVALID_CONFIG, ...)`. Pull addresses from `getSupportedTokens()` / `getSupportedAssets()`.
- **Best-vault resolution order:** `params.bestVault` (if provided) → REST `getBestVault(token.symbol)` filtered to `config.chainId` → on-chain `getAssetAvailableVaults(vault, asset)` taking index `[0]` → otherwise throws `SurfError(NO_BEST_VAULT, ...)`. This only matters for the **initial** deposit of an asset (subsequent deposits route through `userDeposit` and need no best vault).
- **`rpcUrl` override applies to ALL chains.** The single `rpcUrl` config builds one `JsonRpcProvider` used for every read. It is not keyed per chain. Do **not** hardcode one chain's RPC if you may operate on another — every read method goes through that one provider. If omitted, the SDK falls back to the configured chain's default RPC (Base `https://mainnet.base.org`, Polygon `https://polygon-bor-rpc.publicnode.com`; Base Sepolia has `""` and **must** be supplied).
- **A vault can have a different address per chain.** `VaultInfo.chainAddresses` lists per-chain vault addresses; on chains like Ethereum the vault address differs from the top-level `userVaultAddress` (the home-chain address). The SDK resolves the correct per-chain address automatically **only when you pass no `vaultAddress`** to `deposit`/`withdraw`/`getPortfolioSummary`/`getWithdrawableAmount`/`getAssetProfit`/etc. **Passing an explicit `userVaultAddress` on a non-home chain bypasses that resolution** and targets an address with no vault contract there, so the call fails with ethers `BAD_DATA` (`could not decode result data`, `value="0x"`). If you must pass one, use `chainAddresses.find(c => c.chainId === activeChainId)?.vaultAddress`.
- **`switchChain()` does not update `config.chainId`.** It changes only the wallet's chain (`walletState.chainId`). `getChainConfig()`, `factoryAddress`, `wethAddress`, token resolution, and the read provider all keep using the originally configured chain. To truly operate on another chain, build a new client (or `setChain` before build), don't rely on `switchChain`.
- **`getVault`, `getSupportedAssets`, `getAgentMessages`, `getBestVault` are public** (no wallet/auth required) — but `getVault` and `getAgentMessages` need an address. If you omit `walletAddress`, they fall back to `requireWallet().address` and will throw `WALLET_NOT_CONNECTED` when no wallet is connected. Pass an explicit address to call them without a connected wallet. (`getSupportedAssets` and `getBestVault` need neither wallet nor an address.)
- **Register custom chains/tokens BEFORE `setChain`/`build`.** Use the builder: `registerChain(env, chainConfig)` then `registerToken(...)`, and only then `setChain(chainId)` / `build()`. Registering after build has no effect on an already-constructed client. Note also that the standalone helpers `getFactoryAddress`/`getWethAddress` read the module-level `CHAIN_REGISTRIES`, so they won't see chains you registered on the builder.
- **`deployVault()` throws `VAULT_ALREADY_EXISTS` if a vault already exists on the current chain.** The guard checks `existing.exists && existing.assets.some(a => a.chainId === config.chainId && a.vaultAddress)`. A vault that exists only on a *different* chain is fine (it reuses the stored `deploymentSalt` and re-deploys on the current chain). Check `getVault()` / catch this error before calling `deployVault()`.
- **`getTokenBalance` is the EOA's wallet balance, not vault holdings.** It returns the wallet's ERC-20 `balanceOf`. For vault holdings use `getWithdrawableAmount(asset)` or `getPortfolioSummary()`.
- **`Address` is a template-literal type `` `0x${string}` ``, not `string`.** `DepositParams.asset` / `WithdrawParams.asset` are typed `Address`. TypeScript callers must use `0x`-prefixed literals or cast (`addr as Address`); a plain runtime `string` won't satisfy the type.
- **`WalletConnectAdapter` is pre-registered but inert.** Its default no-arg form has `installed: false` and `connect()` throws `WALLET_NOT_INSTALLED`. To use it: `registerWalletAdapter("walletconnect", new WalletConnectAdapter(() => yourWcProvider))`. The `"injected"` adapter does no brand check and returns raw `window.ethereum`, which may not be the wallet the user intended when multiple extensions are installed.
- **Errors are `SurfError` with a `code`.** Catch and branch on `error.code` (a `SurfErrorCode`), e.g. `WALLET_NOT_CONNECTED`, `SIGNATURE_REJECTED`, `VAULT_ALREADY_EXISTS`, `NO_BEST_VAULT`, `INVALID_CONFIG`, `API_ERROR`. The emitted `"error"` event payload is `{ code: string; message: string }` (plain string code, not the enum).

## Integration checklist

- [ ] Installed `@surf_liquid/core-sdk` and have `ethers@^6` available (it is both a dependency and a peer dependency — verify a single ethers v6 resolves to avoid version-mismatch issues).
- [ ] Created a client via `SurfClient.create({ projectName, appId /* or projectId */, ... })` or `SurfClient.builder()...build()`, supplying at minimum `projectName` and one of `appId`/`projectId` (otherwise `MISSING_PROJECT_ID` is thrown).
- [ ] Set `environment`/`chainId` explicitly for your target chain (mainnet → Base 8453 / Polygon 137; testnet → Base Sepolia 84532). For testnet, supplied a real `rpcUrl` (Base Sepolia ships with empty RPC, zero factory/WETH, and no tokens) and registered any chain/token configs **before** `build()`.
- [ ] Provided a production `rpcUrl` rather than relying on the public rate-limited defaults, understanding it applies to all reads on the configured chain.
- [ ] Connected a wallet with `connectWallet("metamask" | "trust" | "coinbase" | "rabby" | "phantom" | "walletconnect" | "injected")` and confirmed `getWalletState()` is non-null (for WalletConnect, registered an adapter with a provider factory first).
- [ ] Called `authenticate()` and confirmed login by checking `getAuthState().authenticated === true` (and `.user`), **never** `getAuthState().token`.
- [ ] Verified the backend CORS responses on a credentialed request return your exact origin in `Access-Control-Allow-Origin` plus `Access-Control-Allow-Credentials: true`, and that the session cookie is set (no requests blocked by the browser).
- [ ] Subscribed to relevant events (`wallet:connected`, `auth:authenticated`, `deposit:started`/`deposit:approved`/`deposit:completed`, `withdraw:*`, `vault:deployed`, `error`) via `on(...)`, and remembered `wallet:disconnected`/`auth:logout` payloads are `void`.
- [ ] Resolved deposit/withdraw assets by **address** from `getSupportedTokens()`/`getSupportedAssets()` (not by symbol).
- [ ] Deployed the user vault with `deployVault()`, handling the `VAULT_ALREADY_EXISTS` case (vault already on the current chain) gracefully.
- [ ] Performed a deposit with a human-readable string amount (e.g. `"100"`), decided on `autoApprove` (default `true`), and `await result.wait()`-ed the returned `TransactionResult` to confirm on-chain success.
- [ ] If wrapping native ETH, set `wrapEth: true` only on a chain whose `wethAddress` is the canonical wrapped-native token, with `amount` as the native amount.
- [ ] Performed a withdraw, treating omitted/`"0"` amount as a full withdrawal intentionally.
- [ ] Rendered `bigint` results (`getPortfolioSummary`, `getAssetProfit(+Percentage)`, `getFeeInfo`, `getWithdrawableAmount`, `getTokenBalance`) via `formatTokenAmount(...)` or `.toString()`, and confirmed no code path `JSON.stringify`s a raw `bigint` (it throws).
- [ ] Wrapped SDK calls in error handling that branches on `error.code` (`SurfErrorCode`) for the failures relevant to each flow (`WALLET_NOT_CONNECTED`, `SIGNATURE_REJECTED`, `VAULT_ALREADY_EXISTS`, `NO_BEST_VAULT`, `INVALID_CONFIG`, `API_ERROR`, `TRANSACTION_FAILED`).
