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
};

// A vault counts as "deployed on this chain" when the vault exists and has at
// least one asset on that chain with a vault address. This mirrors exactly the
// condition the SDK uses internally before it would throw VAULT_ALREADY_EXISTS,
// so the "Deploy vault" button is only shown when a deploy would actually run.
function isVaultDeployedOnChain(vault: VaultLike, chainId: number): boolean {
  return Boolean(
    vault.exists &&
      vault.assets?.some((a) => a.chainId === chainId && Boolean(a.vaultAddress)),
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
    setVaultAddress(vault.userVaultAddress);
    setVaultDeployed(deployed);
    pushLog(
      deployed ? "success" : "info",
      deployed
        ? `Vault deployed on chain ${activeChainId}: ${vault.userVaultAddress}`
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
        // selected chain (Base -> mainnet.base.org, Polygon -> rpc.ankr.com/polygon).
      });

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

  async function resolveVault() {
    await runAction("Get vault", async () => {
      const client = ensureClient();
      const vault = await client.getVault();
      setVaultAddress(vault.userVaultAddress);
      setVaultDeployed(isVaultDeployedOnChain(vault, client.getConfig().chainId));

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
            `  ${a.assetSymbol} on chain ${a.chainId} [${a.chainStatus}] — balance: ${a.balance} · value: $${a.currentValueUSD.toFixed(2)} · APY: ${a.currentAPY}% · deposited: $${a.depositedAmountUSD.toFixed(2)}`,
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
      const client = ensureClient();
      const targetVault = vaultAddress ?? (await client.getVault()).userVaultAddress;
      if (!targetVault) {
        throw new Error("No vault address available.");
      }
      const summary = await client.getPortfolioSummary(targetVault);
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
      const result = await ensureClient().getAgentMessages();
      pushLog(
        "success",
        `Agent messages — page ${result.page}/${result.pages}, total: ${result.total}`,
      );
      if (result.messages.length === 0) {
        pushLog("info", "No activity found.");
        return;
      }
      for (const msg of result.messages) {
        const date = new Date(msg.timestamp).toLocaleString();
        pushLog(
          "info",
          `[${date}] [${msg.transactionType}] [${msg.executedBy}] chain:${msg.chainId} tx:${msg.txHash} — ${msg.message}`,
        );
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

  // The flows require an authenticated session AND a vault on the selected chain.
  const flowsReady = authenticated && vaultDeployed === true;

  const nextStepHint = !clientReady
    ? "Step 1 — create the client to begin."
    : !walletAddress
      ? "Step 2 — connect your wallet."
      : !authenticated
        ? "Step 3 — authenticate (signs a message; the backend sets a session cookie)."
        : vaultDeployed === null
          ? "Determining vault status for the selected chain…"
          : vaultDeployed === false
            ? "No vault on this chain yet — deploy one to unlock the flows."
            : "Vault ready — use the flows below.";

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
            {flowsReady && (
              <button className="action" onClick={resolveVault} disabled={Boolean(busyAction)}>
                Get vault
              </button>
            )}
          </div>
          <p className="hint">{nextStepHint}</p>
        </section>

        {flowsReady && (
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
