import { startTransition, useEffect, useRef, useState } from "react";
import type { SurfClient as SurfClientType } from "@surf_liquid/core-sdk";
import { SurfClient, WalletConnectAdapter } from "@surf_liquid/core-sdk";

type WalletOption =
  | "metamask"
  | "trust"
  | "coinbase"
  | "rabby"
  | "phantom"
  | "walletconnect"
  | "injected";

type LogEntry = {
  id: number;
  level: "info" | "success" | "error";
  message: string;
};

// Minimal shape of the vault info we need to decide chain-local deployment.
type VaultLike = {
  exists: boolean;
  assets?: Array<{ chainId: number; vaultAddress?: string }>;
  chainAddresses?: Array<{ chainId: number; vaultAddress?: string }>;
};

// A vault counts as "deployed on this chain" when the vault exists and has at
// least one asset on that chain with a vault address. This mirrors exactly the
// condition the SDK uses internally before it would throw VAULT_ALREADY_EXISTS,
// so the "Deploy vault" button is only shown when a deploy would actually run.
function isVaultDeployedOnChain(vault: VaultLike, chainId: number): boolean {
  return Boolean(
    vault.exists &&
      (vault.chainAddresses?.some(
        (c) => c.chainId === chainId && Boolean(c.vaultAddress),
      ) ||
        vault.assets?.some((a) => a.chainId === chainId && Boolean(a.vaultAddress))),
  );
}

// Resolve the vault's address on a specific chain (it can differ per chain),
// preferring the per-chain `chainAddresses` entry over the home `userVaultAddress`.
function vaultAddressForChain(
  vault: {
    userVaultAddress?: string | null;
    chainAddresses?: Array<{ chainId: number; vaultAddress?: string }>;
  },
  chainId: number,
): string | null {
  return (
    vault.chainAddresses?.find((c) => c.chainId === chainId)?.vaultAddress ??
    vault.userVaultAddress ??
    null
  );
}

const DEFAULTS = {
  projectName: "SDK Example App",
  appId: "replace-with-your-app-id",
  wcProjectId: "",
  environment: "mainnet" as const,
  chainId: "8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  depositAmount: "1",
  withdrawAmount: "0",
  wallet: "metamask" as WalletOption,
};

export default function App() {
  const [projectName, setProjectName] = useState(DEFAULTS.projectName);
  const [appId, setAppId] = useState(DEFAULTS.appId);
  const [environment, setEnvironment] = useState<"mainnet" | "testnet">(
    DEFAULTS.environment,
  );
  const [chainId, setChainId] = useState(DEFAULTS.chainId);
  const [walletName, setWalletName] = useState<WalletOption>(DEFAULTS.wallet);
  const [wcProjectId, setWcProjectId] = useState(DEFAULTS.wcProjectId);
  const [asset, setAsset] = useState(DEFAULTS.asset);
  const [depositAmount, setDepositAmount] = useState(DEFAULTS.depositAmount);
  const [withdrawAmount, setWithdrawAmount] = useState(DEFAULTS.withdrawAmount);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // Flow state — drives which buttons are visible.
  const [clientReady, setClientReady] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  // Auth is cookie-based: the SDK never exposes the token (AuthState.token is
  // always null). Track the boolean `authenticated` flag instead.
  const [authenticated, setAuthenticated] = useState(false);
  // null = not checked yet; true/false = whether a vault is deployed on the
  // selected chain (determined from the API after authentication).
  const [vaultDeployed, setVaultDeployed] = useState<boolean | null>(null);
  const [vaultAddress, setVaultAddress] = useState<string | null>(null);
  // The SDK's active chain — mutable via switchChain after creation.
  const [activeChainId, setActiveChainId] = useState<number | null>(null);
  const clientRef = useRef<SurfClientType | null>(null);
  const logIdRef = useRef(0);

  function pushLog(level: LogEntry["level"], message: string) {
    startTransition(() => {
      setLogs((current) => [
        {
          id: ++logIdRef.current,
          level,
          message: `[${new Date().toLocaleTimeString()}] ${message}`,
        },
        ...current,
      ]);
    });
  }

  function ensureClient() {
    if (!clientRef.current) {
      throw new Error("Create the client first.");
    }
    return clientRef.current;
  }

  function attachClientEvents(client: SurfClientType) {
    client.on("wallet:connected", (state) => {
      setWalletAddress(state.address);
      pushLog("success", `Wallet connected: ${state.address} on chain ${state.chainId}`);
    });
    client.on("wallet:disconnected", () => {
      setWalletAddress(null);
      setAuthenticated(false);
      setVaultDeployed(null);
      pushLog("info", "Wallet disconnected");
    });
    client.on("wallet:accountChanged", ({ oldAddress, newAddress }) => {
      setWalletAddress(newAddress);
      // A different account is a different identity: it must re-authenticate and
      // may have a different vault, so reset both.
      setAuthenticated(false);
      setVaultDeployed(null);
      pushLog("info", `Account changed from ${oldAddress} to ${newAddress}`);
    });
    client.on("wallet:chainChanged", ({ chainId: nextChainId }) => {
      pushLog("info", `Chain changed to ${nextChainId}`);
    });
    client.on("auth:authenticated", (state) => {
      setAuthenticated(state.authenticated);
      pushLog("success", `Authenticated for ${state.address}`);
    });
    client.on("vault:deployed", (result) => {
      setVaultAddress(result.vaultAddress);
      setVaultDeployed(true);
      pushLog("success", `Vault deployed at ${result.vaultAddress}`);
    });
    client.on("deposit:approved", ({ asset: approvedAsset, txHash }) => {
      pushLog("info", `Approval sent for ${approvedAsset}: ${txHash}`);
    });
    client.on("deposit:completed", ({ asset: depositedAsset, amount, txHash }) => {
      pushLog("success", `Deposit complete: ${amount} ${depositedAsset} (${txHash})`);
    });
    client.on("withdraw:completed", ({ asset: withdrawnAsset, amount, txHash }) => {
      pushLog("success", `Withdraw complete: ${amount} ${withdrawnAsset} (${txHash})`);
    });
    client.on("error", ({ code, message }) => {
      pushLog("error", `SDK error [${code}]: ${message}`);
    });
  }

  useEffect(() => {
    return () => {
      clientRef.current = null;
    };
  }, []);

  async function runAction<T>(name: string, action: () => Promise<T>) {
    setBusyAction(name);
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", `${name} failed: ${message}`);
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  // Reads the vault from the API and records whether it is deployed on the
  // client's active chain. Drives the Deploy vault vs Get vault + flows split.
  async function refreshVaultStatus(client: SurfClientType): Promise<boolean> {
    const { chainId: activeChainId } = client.getConfig();
    const vault = await client.getVault();
    const deployed = isVaultDeployedOnChain(vault, activeChainId);
    const addr = vaultAddressForChain(vault, activeChainId);
    setVaultAddress(addr);
    setVaultDeployed(deployed);
    pushLog(
      deployed ? "success" : "info",
      deployed
        ? `Vault deployed on chain ${activeChainId}: ${addr}`
        : `No vault on chain ${activeChainId} yet — deploy one to continue.`,
    );
    return deployed;
  }

  async function createClient() {
    await runAction("Create client", async () => {
      const client = SurfClient.create({
        projectName,
        appId,
        environment,
        chainId: Number(chainId),
        // No rpcUrl override: the SDK uses its built-in public RPC for the
        // selected chain. Override via `rpcUrl` with a dedicated endpoint in production.
      });

      // appId is required — validate it against the backend (GET /api/sdk/public/overview
      // with the x-app-id header). Throws SurfError(INVALID_APP_ID) if it's rejected.
      await client.verifyApp();
      pushLog("success", "App ID verified.");

      // Set up WalletConnect adapter if a project ID is provided
      if (wcProjectId.trim()) {
        try {
          const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
          pushLog("info", "Initializing WalletConnect provider...");
          const wcProvider = await EthereumProvider.init({
            projectId: wcProjectId.trim(),
            chains: [Number(chainId)],
            showQrModal: true,
            metadata: {
              name: projectName,
              description: "SurfLiquid SDK example",
              url: window.location.origin,
              icons: [],
            },
          });
          client.registerWalletAdapter("walletconnect", new WalletConnectAdapter(() => wcProvider));
          pushLog("success", "WalletConnect adapter registered.");
        } catch (err) {
          pushLog("error", `WalletConnect init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      clientRef.current = client;
      attachClientEvents(client);
      // Reset flow state for the freshly created client.
      setClientReady(true);
      setActiveChainId(client.getConfig().chainId);
      setWalletAddress(client.getWalletState()?.address ?? null);
      setAuthenticated(client.getAuthState().authenticated);
      setVaultDeployed(null);
      pushLog("success", `Client created for ${environment}:${chainId}`);
    });
  }

  async function connectWallet() {
    await runAction("Connect wallet", async () => {
      const state = await ensureClient().connectWallet(walletName);
      setWalletAddress(state.address);
    });
  }

  async function authenticate() {
    await runAction("Authenticate", async () => {
      const client = ensureClient();
      const state = await client.authenticate();
      setAuthenticated(state.authenticated);
      // Identify whether a vault is already deployed on the selected chain so we
      // show either Deploy vault (none yet) or Get vault + flows (already there).
      await refreshVaultStatus(client);
    });
  }

  async function checkVault() {
    await runAction("Check vault", async () => {
      await refreshVaultStatus(ensureClient());
    });
  }

  async function refreshSession() {
    await runAction("Refresh session", async () => {
      const result = await ensureClient().refreshSession();
      pushLog("success", `Session refreshed — new expiry: ${result.expiresAt || "(unknown)"}`);
    });
  }

  async function resolveVault() {
    await runAction("Get vault", async () => {
      const client = ensureClient();
      const vault = await client.getVault();
      const activeChainId = client.getConfig().chainId;
      setVaultAddress(vaultAddressForChain(vault, activeChainId));
      setVaultDeployed(isVaultDeployedOnChain(vault, activeChainId));

      if (!vault.exists) {
        pushLog("info", "No vault registered yet.");
        return;
      }

      pushLog("success", `Vault: ${vault.userVaultAddress} (${vault.vaultVersion ?? "unknown"} · chain ${vault.homeChainId ?? "n/a"} · active: ${vault.isActive ?? "n/a"})`);

      if (vault.totalValueUSD != null) {
        pushLog("info", `Value: $${vault.totalValueUSD.toFixed(2)} deposited · $${vault.totalDepositedUSD?.toFixed(2) ?? "—"} principal`);
      }

      if (vault.apyBreakdown) {
        const b = vault.apyBreakdown;
        pushLog("info", `APY: ${b.currentAPY}% total (native ${b.nativeAPY}% + merkl ${b.merklAPY}% + league ${b.leagueAPY}%)`);
        pushLog("info", `APY windows: 7d ${b.apy7d ?? "—"}% · 14d ${b.apy14d ?? "—"}% · 30d ${b.apy30d ?? "—"}%`);
      }

      if (vault.earned) {
        const e = vault.earned;
        pushLog("info", `Earned: $${e.totalEarningsUSD.toFixed(4)} total (native $${e.nativeEarningsUSD.toFixed(4)} · merkl $${e.merklRewardsUSD.toFixed(4)} · league $${e.leagueEarnedUSD.toFixed(4)})`);
      }

      if (vault.league) {
        const l = vault.league;
        pushLog("info", `League: rank #${l.rank} · ${l.totalXP} XP · ~${l.estimatedSURF} SURF ($${l.estimatedSURFUSD})`);
      }

      if (vault.assets && vault.assets.length > 0) {
        pushLog("info", `Assets (${vault.assets.length}):`);
        for (const a of vault.assets) {
          pushLog(
            "info",
            `  ${a.assetSymbol} on chain ${a.chainId} [${a.chainStatus}] — balance: ${a.balance} · value: $${a.currentValueUSD.toFixed(2)} · APY: ${a.currentAPY}% (7d ${a.apy7d ?? "—"} · 14d ${a.apy14d ?? "—"} · 30d ${a.apy30d ?? "—"}) · deposited: $${a.depositedAmountUSD.toFixed(2)}`,
          );
        }
      }
    });
  }

  async function deployVault() {
    await runAction("Deploy vault", async () => {
      const result = await ensureClient().deployVault();
      setVaultAddress(result.vaultAddress);
      setVaultDeployed(true);
    });
  }

  async function deposit() {
    await runAction("Deposit", async () => {
      const tx = await ensureClient().deposit({
        asset: asset as `0x${string}`,
        amount: depositAmount,
      });
      pushLog("info", `Deposit tx submitted: ${tx.hash}`);
      await tx.wait();
    });
  }

  async function withdraw() {
    await runAction("Withdraw", async () => {
      const tx = await ensureClient().withdraw({
        asset: asset as `0x${string}`,
        amount: withdrawAmount,
      });
      pushLog("info", `Withdraw tx submitted: ${tx.hash}`);
      await tx.wait();
    });
  }

  async function readPortfolio() {
    await runAction("Read portfolio", async () => {
      // Pass no address: the SDK resolves the vault for the active chain (it can
      // differ per chain). Passing the home address would break on other chains.
      const summary = await ensureClient().getPortfolioSummary();
      pushLog(
        "info",
        `Portfolio active assets: ${summary.activeCount}, tracked assets: ${summary.assets.length}`,
      );
    });
  }

  async function readWithdrawable() {
    await runAction("Read withdrawable amount", async () => {
      const amount = await ensureClient().getWithdrawableAmount(asset as `0x${string}`);
      pushLog("info", `Withdrawable raw amount: ${amount.toString()}`);
    });
  }

  async function getAgentMessages() {
    await runAction("Get agent messages", async () => {
      const result = await ensureClient().getAgentMessages(
        undefined,
        1,
        20,
        fromDate.trim() || undefined,
        toDate.trim() || undefined,
      );
      const filter = fromDate || toDate ? ` (filtered ${fromDate || "…"} → ${toDate || "…"})` : "";
      pushLog(
        "success",
        `Agent messages — page ${result.page}/${result.pages}, total: ${result.total}${filter}`,
      );
      if (result.messages.length === 0) {
        pushLog("info", "No activity found.");
        return;
      }
      for (const msg of result.messages) {
        const date = new Date(msg.timestamp).toLocaleString();
        pushLog(
          "info",
          `[${date}] [${msg.transactionType}] [${msg.executedBy}] chain:${msg.chainId} — ${msg.message}`,
        );
        // Surface the new structured fields when present.
        const parts: string[] = [];
        if (msg.amount != null) {
          parts.push(`amount ${msg.amount}${msg.token ? ` ${msg.token}` : ""}`);
        }
        if (msg.fromVault || msg.toVault) {
          parts.push(`${msg.fromVault?.name ?? "—"} → ${msg.toVault?.name ?? "—"}`);
        }
        if (msg.apyBefore != null || msg.apyAfter != null) {
          parts.push(`APY ${msg.apyBefore ?? "—"}% → ${msg.apyAfter ?? "—"}%`);
        }
        if (parts.length > 0) {
          pushLog("info", `    ↳ ${parts.join(" · ")}`);
        }
      }
    });
  }

  async function getSupportedAssets() {
    await runAction("Get supported assets", async () => {
      const assets = await ensureClient().getSupportedAssets(Number(chainId) || undefined);
      if (assets.length === 0) {
        pushLog("info", "No supported assets found for this chain.");
        return;
      }
      pushLog("success", `${assets.length} supported asset(s) on chain ${chainId}:`);
      for (const a of assets) {
        pushLog(
          "info",
          `${a.assetSymbol} (${a.chainStatus}) — address: ${a.assetAddress} | APY: ${a.currentAPY}% (native ${a.nativeAPY}% + merkl ${a.merklAPY}% + league ${a.leagueAPY}%)`,
        );
      }
    });
  }

  async function readTokenBalance() {
    await runAction("Get token balance", async () => {
      const bal = await ensureClient().getTokenBalance(asset as `0x${string}`);
      pushLog("info", `Token balance (raw) of ${asset}: ${bal.toString()}`);
    });
  }

  async function readAssetProfit() {
    await runAction("Get asset profit", async () => {
      const client = ensureClient();
      const profit = await client.getAssetProfit(asset as `0x${string}`);
      const pct = await client.getAssetProfitPercentage(asset as `0x${string}`);
      pushLog("info", `Profit for ${asset}: ${profit.toString()} (raw) · ${pct.toString()} (pct, raw)`);
    });
  }

  async function readAllowedAssets() {
    await runAction("Get allowed assets", async () => {
      const assets = await ensureClient().getAllowedAssets();
      pushLog("info", `Allowed assets (${assets.length}): ${assets.join(", ") || "none"}`);
    });
  }

  async function readFeeInfo() {
    await runAction("Get fee info", async () => {
      const f = await ensureClient().getFeeInfo();
      pushLog(
        "info",
        `Fees — revenue: ${f.revenueAddress} · fee: ${f.feePercentage.toString()} · rebalance: ${f.rebalanceFeePercentage.toString()} · merkl claim: ${f.merklClaimFeePercentage.toString()}`,
      );
    });
  }

  async function readBestVault() {
    await runAction("Get best vault", async () => {
      const client = ensureClient();
      const symbol =
        client.getSupportedTokens().find((t) => t.address.toLowerCase() === asset.toLowerCase())?.symbol ?? "USDC";
      const options = await client.getBestVault(symbol);
      pushLog(
        "info",
        `Best vault for ${symbol} (${options.length}): ${options.map((o) => `chain ${o.chainId} → ${o.vaultAddress}`).join(" | ") || "none"}`,
      );
    });
  }

  async function readOwnerVaults() {
    await runAction("Get owner vaults", async () => {
      const client = ensureClient();
      const count = await client.getOwnerVaultCount();
      const vaults = await client.getOwnerVaults();
      pushLog("info", `Owner vaults (count ${count}): ${vaults.join(", ") || "none"}`);
    });
  }

  async function checkVaultFromFactory() {
    await runAction("Is vault from factory", async () => {
      if (!vaultAddress) {
        throw new Error("No vault address known — run Get vault first.");
      }
      const ok = await ensureClient().isVaultFromFactory(vaultAddress);
      pushLog("info", `isVaultFromFactory(${vaultAddress}): ${ok}`);
    });
  }

  async function checkHasInitialDeposit() {
    await runAction("Has initial deposit", async () => {
      const ok = await ensureClient().hasInitialDeposit(asset as `0x${string}`);
      pushLog("info", `hasInitialDeposit(${asset}): ${ok}`);
    });
  }

  async function doSwitchChain() {
    await runAction("Switch chain", async () => {
      const client = ensureClient();
      await client.switchChain(Number(chainId));
      const active = client.getConfig().chainId;
      setActiveChainId(active);
      // Point the Asset field at a token on the new chain so token reads don't
      // query a wrong-chain address.
      const tokens = client.getSupportedTokens();
      if (tokens[0]) {
        setAsset(tokens[0].address);
      }
      pushLog("success", `Active chain switched to ${active}`);
      // Re-check vault deployment for the new chain (needs an authenticated wallet).
      if (authenticated) {
        await refreshVaultStatus(client);
      }
    });
  }

  async function doDisconnect() {
    await runAction("Disconnect wallet", async () => {
      await ensureClient().disconnectWallet();
      setWalletAddress(null);
      setAuthenticated(false);
      setVaultDeployed(null);
    });
  }

  async function doLogout() {
    await runAction("Logout", async () => {
      await ensureClient().logout();
      setAuthenticated(false);
      pushLog("info", "Logged out — local auth state cleared (cookie persists until it expires server-side).");
    });
  }

  async function doVerifyApp() {
    await runAction("Verify app", async () => {
      await ensureClient().verifyApp();
      pushLog("success", "App ID is valid.");
    });
  }

  function showSupportedTokens() {
    try {
      const tokens = ensureClient().getSupportedTokens();
      pushLog(
        "success",
        `Supported tokens (${tokens.length}): ${tokens.map((t) => `${t.symbol}@${t.address}`).join(", ") || "none"}`,
      );
    } catch (error) {
      pushLog("error", `Get supported tokens failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function showConfigState() {
    try {
      const client = ensureClient();
      const cfg = client.getConfig();
      pushLog(
        "info",
        `Config — env: ${cfg.environment} · chain: ${cfg.chainId} · rpc: ${cfg.rpcUrl} · api: ${cfg.apiBaseUrl} · factory: ${cfg.factoryAddress} · autoApprove: ${cfg.autoApprove}`,
      );
      const auth = client.getAuthState();
      const wallet = client.getWalletState();
      pushLog(
        "info",
        `State — wallet: ${wallet?.address ?? "none"} (chain ${wallet?.chainId ?? "n/a"}) · authenticated: ${auth.authenticated}`,
      );
    } catch (error) {
      pushLog("error", `Get config/state failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const nextStepHint = !clientReady
    ? "Step 1 — create the client to begin."
    : !walletAddress
      ? "Step 2 — connect your wallet."
      : !authenticated
        ? "Step 3 — authenticate (signs a message; the backend sets a session cookie)."
        : vaultDeployed === null
          ? "Determining vault status for the active chain…"
          : vaultDeployed === false
            ? "No vault on the active chain — Deploy vault (or switch chains). Flow actions error until a vault exists here."
            : "Vault ready on the active chain — use the flows below.";

  return (
    <div className="shell">
      <aside className="panel panel-accent">
        <div className="eyebrow">Surfliquid SDK</div>
        <h1>SDK example app</h1>
        <p className="lede">
          A React + Vite app integrating the published{" "}
          <code>@surf_liquid/core-sdk</code> npm package — copy it as a starting
          point for your own integration.
        </p>
        <div className="status-grid">
          <div>
            <span>Wallet</span>
            <strong>{walletAddress ?? "Not connected"}</strong>
          </div>
          <div>
            <span>Active chain</span>
            <strong>{activeChainId ?? chainId}</strong>
          </div>
          <div>
            <span>Auth</span>
            <strong>{authenticated ? "Authenticated (cookie)" : "Not authenticated"}</strong>
          </div>
          <div>
            <span>Vault</span>
            <strong>
              {vaultDeployed === true
                ? vaultAddress
                : vaultDeployed === false
                  ? "Not deployed (this chain)"
                  : "Unknown"}
            </strong>
          </div>
          <div>
            <span>Busy</span>
            <strong>{busyAction ?? "Idle"}</strong>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <section className="panel">
          <div className="section-head">
            <h2>Configuration</h2>
            <button className="action ghost" onClick={() => setLogs([])}>
              Clear logs
            </button>
          </div>
          <div className="form-grid">
            <label>
              Project name
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            </label>
            <label>
              App id
              <input value={appId} onChange={(event) => setAppId(event.target.value)} />
            </label>
            <label>
              WalletConnect project ID
              <input
                placeholder="Required only for WalletConnect"
                value={wcProjectId}
                onChange={(event) => setWcProjectId(event.target.value)}
              />
            </label>
            <label>
              Environment
              <select
                value={environment}
                onChange={(event) =>
                  setEnvironment(event.target.value as "mainnet" | "testnet")
                }
              >
                <option value="mainnet">mainnet</option>
                <option value="testnet">testnet</option>
              </select>
            </label>
            <label>
              Chain id
              <input value={chainId} onChange={(event) => setChainId(event.target.value)} />
            </label>
            <label>
              Wallet
              <select
                value={walletName}
                onChange={(event) => setWalletName(event.target.value as WalletOption)}
              >
                <option value="metamask">metamask</option>
                <option value="trust">trust</option>
                <option value="coinbase">coinbase</option>
                <option value="rabby">rabby</option>
                <option value="phantom">phantom</option>
                <option value="walletconnect">walletconnect</option>
                <option value="injected">injected</option>
              </select>
            </label>
            <label>
              Asset
              <input value={asset} onChange={(event) => setAsset(event.target.value)} />
            </label>
            <label>
              Deposit amount
              <input
                value={depositAmount}
                onChange={(event) => setDepositAmount(event.target.value)}
              />
            </label>
            <label>
              Withdraw amount
              <input
                value={withdrawAmount}
                onChange={(event) => setWithdrawAmount(event.target.value)}
              />
            </label>
            <label>
              Activity from (ISO, optional)
              <input
                placeholder="2026-06-01"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </label>
            <label>
              Activity to (ISO, optional)
              <input
                placeholder="2026-06-15"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="action primary" onClick={createClient} disabled={Boolean(busyAction)}>
              {clientReady ? "Recreate client" : "Create client"}
            </button>
            {clientReady && !walletAddress && (
              <button className="action" onClick={connectWallet} disabled={Boolean(busyAction)}>
                Connect wallet
              </button>
            )}
            {clientReady && walletAddress && !authenticated && (
              <button className="action" onClick={authenticate} disabled={Boolean(busyAction)}>
                Authenticate
              </button>
            )}
            {authenticated && vaultDeployed === null && (
              <button className="action" onClick={checkVault} disabled={Boolean(busyAction)}>
                Check vault
              </button>
            )}
            {authenticated && vaultDeployed === false && (
              <button className="action primary" onClick={deployVault} disabled={Boolean(busyAction)}>
                Deploy vault
              </button>
            )}
            {authenticated && (
              <button className="action" onClick={resolveVault} disabled={Boolean(busyAction)}>
                Get vault
              </button>
            )}
            {authenticated && (
              <button className="action" onClick={refreshSession} disabled={Boolean(busyAction)}>
                Refresh session
              </button>
            )}
          </div>
          <p className="hint">{nextStepHint}</p>
        </section>

        {authenticated && (
          <section className="panel">
            <div className="section-head">
              <h2>Flows</h2>
            </div>
            <div className="button-row">
              <button className="action primary" onClick={deposit} disabled={Boolean(busyAction)}>
                Deposit
              </button>
              <button className="action primary" onClick={withdraw} disabled={Boolean(busyAction)}>
                Withdraw
              </button>
              <button className="action" onClick={readPortfolio} disabled={Boolean(busyAction)}>
                Read portfolio
              </button>
              <button className="action" onClick={readWithdrawable} disabled={Boolean(busyAction)}>
                Read withdrawable
              </button>
              <button className="action" onClick={getSupportedAssets} disabled={Boolean(busyAction)}>
                Get supported assets
              </button>
              <button className="action" onClick={getAgentMessages} disabled={Boolean(busyAction)}>
                Get agent messages
              </button>
            </div>
          </section>
        )}

        {clientReady && (
          <section className="panel">
            <div className="section-head">
              <h2>All SDK methods</h2>
            </div>
            <div className="button-row">
              <button className="action" onClick={showConfigState} disabled={Boolean(busyAction)}>
                Config &amp; state
              </button>
              <button className="action" onClick={showSupportedTokens} disabled={Boolean(busyAction)}>
                Supported tokens
              </button>
              <button className="action" onClick={doVerifyApp} disabled={Boolean(busyAction)}>
                Verify app
              </button>
              <button className="action" onClick={readTokenBalance} disabled={Boolean(busyAction)}>
                Token balance
              </button>
              <button className="action" onClick={readBestVault} disabled={Boolean(busyAction)}>
                Best vault
              </button>
              <button className="action" onClick={readOwnerVaults} disabled={Boolean(busyAction)}>
                Owner vaults
              </button>
            </div>
            <div className="button-row">
              <button className="action" onClick={readFeeInfo} disabled={Boolean(busyAction)}>
                Fee info
              </button>
              <button className="action" onClick={readAllowedAssets} disabled={Boolean(busyAction)}>
                Allowed assets
              </button>
              <button className="action" onClick={checkHasInitialDeposit} disabled={Boolean(busyAction)}>
                Has initial deposit
              </button>
              <button className="action" onClick={readAssetProfit} disabled={Boolean(busyAction)}>
                Asset profit
              </button>
              <button className="action" onClick={checkVaultFromFactory} disabled={Boolean(busyAction)}>
                Is vault from factory
              </button>
            </div>
            <div className="button-row">
              <button className="action" onClick={doSwitchChain} disabled={Boolean(busyAction)}>
                Switch chain
              </button>
              <button className="action" onClick={doDisconnect} disabled={Boolean(busyAction)}>
                Disconnect wallet
              </button>
              <button className="action" onClick={doLogout} disabled={Boolean(busyAction)}>
                Logout
              </button>
            </div>
            <p className="hint">
              These exercise every public SDK method. Vault reads (fee info, allowed assets, profit,
              has-initial-deposit) need a deployed vault; token balance / owner vaults need a connected
              wallet — otherwise they log a clear SDK error.
            </p>
          </section>
        )}

        <section className="panel log-panel">
          <div className="section-head">
            <h2>Event log</h2>
          </div>
          <div className="log-list">
            {logs.length === 0 ? (
              <div className="log-empty">No activity yet.</div>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className={`log-entry ${entry.level}`}>
                  {entry.message}
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
