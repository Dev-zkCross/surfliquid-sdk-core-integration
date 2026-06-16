# Surfliquid Test Frontend

Small Vite + React harness for exercising the SDK locally.

## Run

```bash
cd examples/test-frontend
npm install
npm run dev
```

The dev server runs on **http://localhost:3000** (the origin allowlisted by the API's CORS config). Auth is cookie-based, so the API must allow this origin with credentials for authenticated calls to work.

## Usage flow

The buttons are **order-dependent** — each step relies on the previous one. Follow this sequence:

1. **Fill in the configuration.** Set Project name, App ID, Environment, Chain ID, and Wallet. (WalletConnect project ID is only needed if you pick the `walletconnect` wallet.) The Asset / Deposit amount / Withdraw amount fields are used later by the flow actions.

2. **Create client.** Initializes the SDK with the configuration above. This must be done first — every other action requires an existing client.

3. **Connect wallet.** Connects the selected browser wallet and switches it to the configured chain. The connected address appears in the sidebar.

4. **Authenticate.** Signs a message with the wallet and logs in. The session token is set by the backend as an httpOnly cookie (SameSite=None) — it is **not** stored or read by the SDK; subsequent requests send it automatically.

5. **Get vault.** Looks up the user's vault for the connected wallet.
   - If a vault address is shown, you're ready to use the flow actions.
   - If it's `null` / "No vault registered yet", click **Deploy vault** to deploy one. After deployment, the vault address appears in the sidebar and you're ready.

6. **Use the flow actions.** Once the user is **authenticated** *and* **has a vault**, the buttons under **Flows** become usable:
   - **Deposit** / **Withdraw** — require a connected wallet, authentication, and a deployed vault.
   - **Read portfolio** / **Read withdrawable** — read on-chain vault state; require a vault to exist.
   - **Get supported assets** — public; works without a wallet, auth, or vault.
   - **Get agent messages** — read-only; uses the connected wallet's address, so it needs a connected wallet (no vault required).

All actions and errors are written to the **Event log** panel at the bottom.

## Notes

- This app imports `@surf_liquid/core-sdk` from `../../src/index.ts` through a Vite alias, so it tests the local SDK source directly.
- Wallet-based actions require a browser wallet extension and a valid Surf project configuration.
- If you want to test `testnet`, register real testnet RPC and contract metadata in the SDK registry first.
</content>
</invoke>
