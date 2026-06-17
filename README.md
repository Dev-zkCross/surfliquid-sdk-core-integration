# SurfLiquid SDK — Core Integration

Integration resources for [`@surf_liquid/core-sdk`](https://www.npmjs.com/package/@surf_liquid/core-sdk),
the framework-agnostic TypeScript SDK for wiring SurfLiquid vaults into a web app.

This repo is **not** the SDK source — it's everything you need _around_ the SDK to
integrate it correctly and quickly:

- **[`SKILL.md`](./SKILL.md)** — an agent skill for the SDK, written **for AI coding agents** (Claude Code and similar).
- **[`examples/vite-app-frontend-with-sdk-core/`](./examples/vite-app-frontend-with-sdk-core/)** — a runnable React + Vite app that consumes the published npm package end to end.

> The full integration guide is on the
> [npm package page](https://www.npmjs.com/package/@surf_liquid/core-sdk).

---

## What the SDK does

`@surf_liquid/core-sdk` exposes one facade class, `SurfClient`, built on **ethers v6**
(its only runtime/peer dependency). Through it you can:

- **Connect a browser wallet** — MetaMask, Trust, Coinbase, Rabby, Phantom, WalletConnect, or a generic injected provider.
- **Authenticate** the wallet against the SurfLiquid REST API with a nonce + signed message (SIWE-style). Auth is **cookie-based** (httpOnly session cookie).
- **Deploy a per-user vault** through an on-chain factory, coordinated with the backend's prepare/confirm flow.
- **Deposit and withdraw** ERC-20 assets, with optional native-ETH wrapping and automatic approvals.
- **Read vault state** — portfolio summary, per-asset profit, withdrawable amounts, allowed assets, fee info, supported assets/APY, and agent activity.

Supported mainnet chains out of the box: **Base** (`8453`, default) and **Polygon** (`137`).

---

## Repo layout

```
.
├── SKILL.md                                # Agent skill (for AI coding agents)
└── examples/
    └── vite-app-frontend-with-sdk-core/    # Runnable React + Vite example app
```

> Auth is **cookie-based**: the SDK sets and sends the session cookie for you, so
> there's nothing to configure on your side.

---

## 1. The agent skill — `SKILL.md`

`SKILL.md` is a [Claude Code](https://claude.com/claude-code) / agent skill — written
**for AI coding agents**. It encodes the entire SDK surface
in a way an agent can act on: `SurfClient` construction, wallet connection, cookie-based
auth, vault deployment, deposits/withdrawals, on-chain reads, the full API reference,
events, error codes, types, copy-paste recipes, and the common footguns (CORS, the
always-`null` auth token, REST-vs-RPC failure modes).

**Use it with an AI agent.** Point Claude Code (or any agent that loads skills) at this
file when a task involves `@surf_liquid/core-sdk`. The frontmatter `description` makes it
auto-trigger on SDK-related work — constructing a client, debugging auth, implementing
deposit/withdraw, reading vault analytics, and so on.

To install it as a personal Claude Code skill:

```bash
mkdir -p ~/.claude/skills/surfliquid-sdk-integration
cp SKILL.md ~/.claude/skills/surfliquid-sdk-integration/SKILL.md
```

> Integrating by hand? Read the guide on the
> [npm page](https://www.npmjs.com/package/@surf_liquid/core-sdk) instead.

---

## 2. The example app — React + Vite

A minimal frontend that integrates the **published npm package** and walks through the full happy path with progressive-disclosure UI: create
client → connect wallet → authenticate → deploy vault → deposit / withdraw / read.

### Run it

```bash
cd examples/vite-app-frontend-with-sdk-core
npm install        # pulls @surf_liquid/core-sdk + ethers from npm
npm run dev        # start the example
```

You'll need:

- **Node.js 18+** and npm.
- A **browser wallet extension** (for the wallet-based steps; reads work without one).
- **SurfLiquid project credentials** — your `projectName` and an `appId`, which you create at <https://sdk.surfliquid.com/>. Set them in the app's Configuration panel or edit `DEFAULTS` in `src/App.tsx`.

See the example's [own README](./examples/vite-app-frontend-with-sdk-core/README.md)
for the step-by-step flow guide and troubleshooting.

---

## Quick start (in your own app)

```bash
npm install @surf_liquid/core-sdk ethers
```

> Create your `appId` and set your project name at <https://sdk.surfliquid.com/>.

```ts
import { SurfClient } from "@surf_liquid/core-sdk";

const surf = SurfClient.create({
  projectName: "My DApp",   // required — your project name
  appId: "your-app-id",     // required — from https://sdk.surfliquid.com/
  environment: "mainnet",   // "mainnet" ("testnet" support coming soon)
  chainId: 8453,            // Base (default); Polygon = 137
});

await surf.connectWallet("metamask");
await surf.authenticate();              // SDK handles the session cookie
const vault = await surf.getVault();    // inspect / decide whether to deploy
```

> Auth is cookie-based and the SDK manages the cookie for you, so **gate your UI on
> `surf.getAuthState().authenticated`, never on a token** — `AuthState.token` is always
> `null`. See the [npm guide](https://www.npmjs.com/package/@surf_liquid/core-sdk) for more.

---

## Links

- SDK + full integration guide on npm: <https://www.npmjs.com/package/@surf_liquid/core-sdk>
- Agent skill (for AI agents): [`SKILL.md`](./SKILL.md)
- Example app: [`examples/vite-app-frontend-with-sdk-core/`](./examples/vite-app-frontend-with-sdk-core/)
