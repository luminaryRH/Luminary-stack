"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowUpRight, BookOpen, CalendarDays, Check, CheckCheck, ChevronRight, Clock3, Coins, Copy, Download, ExternalLink, Handshake,
  Info, LayoutDashboard, Loader2, LockKeyhole, Moon, Plus, RefreshCw, ScanLine, Search, ShieldCheck, Sunrise, Sunset, Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Brand, ProtocolDialog, Socials } from "@/components/brand";
import { LanguageSwitcher, useTranslation } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CONFIG, CHAIN_ID, DEPLOYMENT, STOCKS, addressUrl, txUrl } from "@/lib/luminary-config";
import { injectedWallet, loadLive, micro, type Live, type LiveAuction, type LivePrint } from "@/lib/luminary-client";
import { ShieldedAccount, newSession, preloadProver, readIntents, sendIntent, type RfqIntent, type RfqSession } from "@/shielded/client";

const views = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "orders", label: "My orders", icon: LockKeyhole },
  { id: "calendar", label: "Auction calendar", icon: CalendarDays },
  { id: "prints", label: "Public prints", icon: ScanLine },
  { id: "rfq", label: "RFQ desk", icon: Handshake },
  { id: "treasury", label: "Treasury", icon: Wallet },
];
const NAMES: Record<string, string> = { TSLA: "Tesla", AMZN: "Amazon", AMD: "AMD", PLTR: "Palantir", NFLX: "Netflix" };
const COLORS: Record<string, string> = { TSLA: "#ff704b", AMZN: "#c2cdd3", AMD: "#a7c7dd", PLTR: "#8cb5d1", NFLX: "#ff9b7d" };
const KIND_LABEL: Record<string, string> = { OPEN: "Opening call", CLOSE: "Closing call", MIDNIGHT: "Midnight call", NAV: "Treasury NAV call", RFQ: "RFQ block" };
const ASSETS = ["ETH", "TQ", "USDG", ...STOCKS];
type Modal = "wallet" | "funds" | "review" | "feenote" | "proof" | null;
type Snapshot = ReturnType<ShieldedAccount["view"]>;
type FundAction = "mint" | "convert" | "redeem" | "shield" | "unshield" | "feenote";
const errText = (e: unknown) => {
  const x = e as { shortMessage?: string; message?: string; code?: number | string } | null;
  if (x?.code === 4001 || x?.code === "ACTION_REJECTED") return "You rejected the request in your wallet.";
  return (x?.shortMessage ?? x?.message ?? String(e)).slice(0, 300);
};
const fmtQty = (v: number, locale: string) => v.toLocaleString(locale, { maximumFractionDigits: 6 });
const utc = (iso: string | number) => {
  const d = new Date(typeof iso === "number" ? iso * 1000 : iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
};

function Pick({ value, onChange, options, label }: { value: string; onChange: (s: string) => void; options: { value: string; label: string }[]; label: string }) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="field-select" aria-label={t(label)}>
        <SelectValue placeholder={t("None available")} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {t(o.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Navigation({ view, onNavigate, onProtocol }: { view: string; onNavigate: (v: string) => void; onProtocol: () => void }) {
  const { t } = useTranslation();
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar className="dashboard-sidebar">
      <SidebarHeader>
        <Brand tagline="AUCTION TERMINAL / 01" />
      </SidebarHeader>
      <SidebarContent>
        <p className="sidebar-caption">{t("WORKSPACE")}</p>
        <SidebarMenu>
          {views.map((v) => (
            <SidebarMenuItem key={v.id}>
              <SidebarMenuButton isActive={view === v.id} onClick={() => { onNavigate(v.id); setOpenMobile(false); }}>
                <v.icon size={18} />
                <span>{t(v.label)}</span>
                {view === v.id && <span className="active-dot" />}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <div className="sidebar-art">
          <img src="/art/dragon-waves.webp" alt="" />
          <span>{t("Sealed intent.")}<br /><em>{t("Shared conviction.")}</em></span>
        </div>
      </SidebarContent>
      <SidebarFooter>
        <button className="sidebar-help" onClick={onProtocol}><BookOpen size={16} />{t(" Inside the protocol ")}<ArrowUpRight size={14} /></button>
        <Socials />
        <div className="chain-status"><i />{t(" ROBINHOOD CHAIN ")}<span>{t("TESTNET")} {CHAIN_ID}</span></div>
      </SidebarFooter>
    </Sidebar>
  );
}

function Empty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  const { t } = useTranslation();
  return <div className="empty-state"><LockKeyhole size={27} /><h3>{t(title)}</h3><p>{t(description)}</p>{action}</div>;
}

function PageHeading({ kicker, title, description, action }: { kicker: string; title: string; description: string; action?: React.ReactNode }) {
  const { t } = useTranslation();
  return <section className="page-heading"><div><p className="eyebrow orange">{t(kicker)}</p><h1>{t(title)}</h1><p>{t(description)}</p></div>{action}</section>;
}

function SearchField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const { t } = useTranslation();
  return <div className="search-field"><Search size={15} /><Input value={value} onChange={(e) => onChange(e.target.value)} aria-label={t("Search by asset")} placeholder={t("Search assets…")} /></div>;
}

function TxLink({ hash, label }: { hash: string; label?: string }) {
  const { t } = useTranslation();
  return <a className="proof-link" href={txUrl(hash)} target="_blank" rel="noreferrer"><ShieldCheck size={15} />{t(label ?? " Explorer ")}<ExternalLink size={12} /></a>;
}

export default function Dashboard() {
  const { t, locale, formatMoney } = useTranslation();
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState("");
  const [account, setAccount] = useState<ShieldedAccount | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [walletBal, setWalletBal] = useState<{ symbol: string; amount: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("overview");
  const [protocol, setProtocol] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [clock, setClock] = useState<Date | null>(null);
  // order ticket
  const [symbol, setSymbol] = useState<string>("TSLA");
  const [side, setSide] = useState("buy");
  const [kind, setKind] = useState("limit");
  const [qty, setQty] = useState("1");
  const [limit, setLimit] = useState("");
  const [auctionId, setAuctionId] = useState("");
  const [roll, setRoll] = useState(true);
  const [relayed, setRelayed] = useState(true);
  // lists
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [calendarFilter, setCalendarFilter] = useState("all");
  const [proof, setProof] = useState<LivePrint | null>(null);
  // treasury
  const [fundAction, setFundAction] = useState<FundAction>("mint");
  const [fundAsset, setFundAsset] = useState("USDG");
  const [amount, setAmount] = useState("1000");
  // rfq
  const [session, setSession] = useState<RfqSession | null>(null);
  const [peer, setPeer] = useState("");
  const [rfqSide, setRfqSide] = useState("buy");
  const [rfqSymbol, setRfqSymbol] = useState<string>("TSLA");
  const [rfqQty, setRfqQty] = useState("1");
  const [rfqLimit, setRfqLimit] = useState("");
  const [inbox, setInbox] = useState<{ id: number; from: string; intent: RfqIntent; mine?: boolean }[]>([]);

  const load = useCallback(async () => {
    try {
      setError("");
      setLive(await loadLive());
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const refreshAccount = useCallback(async (acc: ShieldedAccount | null = account) => {
    if (!acc) return;
    await acc.sync();
    setSnap(acc.view());
    setWalletBal(await acc.walletBalances().catch(() => []));
  }, [account]);

  useEffect(() => {
    void load();
    const v = new URLSearchParams(window.location.search).get("view");
    if (views.some((x) => x.id === v)) setView(v!);
    setClock(new Date());
    const tick = setInterval(() => setClock(new Date()), 1000);
    const poll = setInterval(() => void load(), 20_000);
    const pop = () => {
      const next = new URLSearchParams(location.search).get("view") || "overview";
      if (views.some((x) => x.id === next)) setView(next);
    };
    window.addEventListener("popstate", pop);
    try {
      const saved = localStorage.getItem("luminary-rfq-session");
      setSession(saved ? (JSON.parse(saved) as RfqSession) : null);
    } catch {
      // private mode: a fresh session per visit
    }
    return () => { clearInterval(tick); clearInterval(poll); window.removeEventListener("popstate", pop); };
  }, [load]);

  useEffect(() => {
    if (!account) return;
    const poll = setInterval(() => void refreshAccount().catch(() => {}), 20_000);
    return () => clearInterval(poll);
  }, [account, refreshAccount]);

  /** Runs a wallet / pool action with progress in one toast, then refreshes everything. */
  const run = useCallback(async (work: (progress: (s: string) => void) => Promise<unknown>, done: string) => {
    setBusy(true);
    const id = toast.loading(t("Working…"));
    try {
      await work((s) => toast.loading(t(s), { id }));
      toast.success(t(done), { id });
      await Promise.all([load(), refreshAccount().catch(() => {})]);
      return true;
    } catch (e) {
      toast.error(t(errText(e)), { id });
      return false;
    } finally {
      setBusy(false);
    }
  }, [t, load, refreshAccount]);

  async function connect() {
    const eth = injectedWallet();
    if (!eth) {
      toast.error(t("No browser wallet found. Install MetaMask or another EIP-1193 wallet, then reload."));
      return;
    }
    setBusy(true);
    const id = toast.loading(t("Sign the key message in your wallet. It is free and sends no transaction."));
    try {
      const acc = await ShieldedAccount.open(eth);
      await acc.ensureChain().catch(() => toast.warning(t("Switch your wallet to Robinhood Chain testnet (46630) before sending transactions.")));
      setAccount(acc);
      setSnap(acc.view());
      setWalletBal(await acc.walletBalances().catch(() => []));
      void preloadProver();
      toast.success(t("Wallet connected. Your shielded account is loaded."), { id });
      setModal(null);
    } catch (e) {
      toast.error(t(errText(e)), { id });
    } finally {
      setBusy(false);
    }
  }

  const navigate = (v: string) => {
    setView(v);
    setFilter("all");
    setSearch("");
    history.pushState({}, "", `/dashboard${v === "overview" ? "" : `?view=${v}`}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ---- derived -------------------------------------------------------------------------------------------------
  const now = clock?.getTime() ?? 0;
  const connected = !!account && !!snap;
  const auctions = useMemo(() => live?.auctions ?? [], [live]);
  const refOf = (s: string) => micro(live?.marks?.prices[s]?.usd);
  const nav = micro(live?.marks?.nav?.nav) || 1;
  const balance = (s: string) => snap?.balances.find((b) => b.symbol === s);
  const upcoming = auctions.filter((a) => (a.status === "scheduled" || a.status === "collecting") && Date.parse(a.callTime) > now);
  const nextEvent = upcoming[0];
  const remaining = nextEvent ? Math.max(0, Date.parse(nextEvent.callTime) - now) : 0;
  const countdown = clock && nextEvent
    ? `${String(Math.floor(remaining / 3_600_000)).padStart(2, "0")} : ${String(Math.floor(remaining / 60_000) % 60).padStart(2, "0")} : ${String(Math.floor(remaining / 1000) % 60).padStart(2, "0")}`
    : "— : — : —";
  const openFor = (s: string) =>
    auctions.filter((a) => a.symbol === s && a.id !== null && a.status === "collecting" && a.kind !== "RFQ" && Date.parse(a.callTime) > now + 60_000);
  const ticketAuctions = openFor(symbol);
  const chosen = ticketAuctions.find((a) => String(a.id) === auctionId) ?? ticketAuctions[0];
  const ref = refOf(symbol);
  const qtyNum = Number(qty);
  const validQty = Number.isFinite(qtyNum) && qtyNum >= 0.001 && /^\d+(\.\d{1,6})?$/.test(qty.trim());
  const limitNum = Number(limit || ref.toFixed(2));
  const pricing = kind === "limit" ? limitNum : ref;
  const estimate = validQty ? qtyNum * pricing : 0;
  // a buy locks TQ: the limit (or 5% over the reference at auction) plus the fee, at the current NAV
  const lockTq = side === "buy" ? (qtyNum * (kind === "limit" ? limitNum : ref * 1.05) * 1.001) / nav : 0;
  const validTicket = validQty && !!chosen && (kind === "auction" || limitNum > 0);
  const orders = snap?.orders ?? [];
  const openOrders = orders.filter((o) => o.status === "open" || o.status === "pinned");
  const reservedTq = Number(balance("TQ")?.inOrders ?? 0);
  const filteredOrders = orders.filter((o) => {
    const group = o.status === "open" || o.status === "pinned" ? "sealed" : o.status === "settled" ? "filled" : "cancelled";
    return (filter === "all" || group === filter) && o.symbol.toLowerCase().includes(search.toLowerCase());
  });
  const prints = live?.prints ?? [];
  const filteredPrints = prints.filter((p) => (filter === "all" || p.symbol === filter) && (p.symbol ?? "").toLowerCase().includes(search.toLowerCase()));
  const calls = useMemo(() => {
    const groups = new Map<string, { kind: string; callTime: string; rows: LiveAuction[] }>();
    for (const a of upcoming) {
      const key = `${a.kind}:${a.callTime}`;
      const g = groups.get(key) ?? { kind: a.kind, callTime: a.callTime, rows: [] };
      g.rows.push(a);
      groups.set(key, g);
    }
    return [...groups.values()].slice(0, 30);
  }, [upcoming]);

  // ---- WebMCP tools (read the account, stage a ticket; never submit) ---------------------------------------------
  useEffect(() => {
    type ToolContext = { registerTool: (t: unknown, o: { signal: AbortSignal }) => void | Promise<void> };
    const ctx = (document as Document & { modelContext?: ToolContext }).modelContext;
    if (!ctx?.registerTool) return;
    const life = new AbortController();
    const tools = [
      {
        name: "read_luminary_account",
        title: "Read account",
        description: "Read the connected Luminary testnet account: shielded balances and sealed orders. Read only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => (snap ? { wallet: snap.wallet, balances: snap.balances, orders: snap.orders } : { connected: false }),
      },
      {
        name: "stage_luminary_order",
        title: "Stage a sealed order",
        description: "Fill the visible order ticket and open review. Does not submit anything.",
        inputSchema: {
          type: "object",
          properties: { symbol: { type: "string", enum: [...STOCKS] }, quantity: { type: "number", minimum: 0.001, maximum: 10000 }, side: { type: "string", enum: ["buy", "sell"] } },
          required: ["symbol", "quantity"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (input: unknown) => {
          const p = input as { symbol: string; quantity: number; side?: string };
          if (!STOCKS.includes(p.symbol as (typeof STOCKS)[number]) || !(p.quantity >= 0.001)) throw new Error("Invalid market or quantity.");
          setSymbol(p.symbol);
          setQty(String(p.quantity));
          setSide(p.side === "sell" ? "sell" : "buy");
          setView("overview");
          setModal("review");
          return { staged: true, submitted: false };
        },
      },
    ];
    for (const tool of tools) {
      try {
        Promise.resolve(ctx.registerTool(tool, { signal: life.signal })).catch(() => {});
      } catch {
        // registration is best effort
      }
    }
    return () => life.abort();
  }, [snap]);

  // ---- actions --------------------------------------------------------------------------------------------------
  function selectMarket(s: string) {
    setSymbol(s);
    setAuctionId("");
    const r = refOf(s);
    if (r) setLimit(r.toFixed(2));
  }

  async function placeOrder(selfSubmit: boolean) {
    if (!account || !chosen) return;
    setBusy(true);
    const id = toast.loading(t("Preparing your sealed order…"));
    try {
      await account.placeOrder(
        {
          auctionId: chosen.id!,
          side: side as "buy" | "sell",
          sizeText: qty.trim(),
          limitText: kind === "limit" ? String(limitNum) : "",
          lockText: side === "buy" ? lockTq.toFixed(6) : undefined,
          roll,
          selfSubmit,
        },
        (s) => toast.loading(t(s), { id }),
      );
      toast.success(t("Order sealed. Your intent is private until the call."), { id });
      setModal(null);
      await refreshAccount();
    } catch (e) {
      if ((e as { code?: string }).code === "needs-fee-note") {
        toast.dismiss(id);
        setModal("feenote");
      } else toast.error(t(errText(e)), { id });
    } finally {
      setBusy(false);
    }
  }

  async function fund() {
    if (!account) return;
    const ok = await run(async (progress) => {
      if (fundAction === "mint") return account.mintUsdg(amount, progress);
      if (fundAction === "convert") return account.toTreasury(amount, progress);
      if (fundAction === "redeem") return account.fromTreasury(amount, progress);
      if (fundAction === "shield") return account.deposit(fundAsset, amount, progress);
      if (fundAction === "unshield") return account.withdraw(fundAsset, amount, account.wallet, fundAsset !== "ETH", progress);
      return account.prepareFeeNote(progress);
    }, fundAction === "shield" ? "Deposited. Your note joins the pool tree within a minute or two." : "Done.");
    if (ok) setModal(null);
  }

  function exportData(rows: Record<string, unknown>[], name: string) {
    if (!rows.length) {
      toast.info(t("There is no data to export yet."));
      return;
    }
    const keys = Object.keys(rows[0]!);
    const csv = [keys.join(","), ...rows.map((r) => keys.map((k) => `"${String(r[k] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `luminary-${name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t("Your export is ready."));
  }

  function calendarFile() {
    if (!nextEvent) return;
    const start = nextEvent.callTime.replace(/[-:]/g, "").replace(/\.\d+/, "").replace(/\+00:?00$/, "Z");
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Luminary//Calendar//EN\r\nBEGIN:VEVENT\r\nUID:${nextEvent.key}@luminary\r\nDTSTAMP:${start}\r\nDTSTART:${start}\r\nSUMMARY:Luminary ${KIND_LABEL[nextEvent.kind]}\r\nDESCRIPTION:Robinhood Chain testnet call auction\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "luminary-next-auction.ics";
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t("Calendar event downloaded."));
  }

  // ---- RFQ ------------------------------------------------------------------------------------------------------
  function rfqSession() {
    if (session) return session;
    const s = newSession();
    setSession(s);
    try {
      localStorage.setItem("luminary-rfq-session", JSON.stringify(s));
    } catch {
      // not persisted
    }
    return s;
  }

  const checkInbox = useCallback(async () => {
    if (!session) return;
    const received = await readIntents(session).catch(() => []);
    setInbox((prev) => [...prev.filter((m) => m.mine), ...received].sort((a, b) => b.id - a.id));
  }, [session]);

  useEffect(() => {
    if (view !== "rfq") return;
    if (!session) {
      rfqSession(); // a key from the first visit, so there is always one to share; this effect reruns with it
      return;
    }
    void checkInbox();
    const poll = setInterval(() => void checkInbox(), 10_000);
    return () => clearInterval(poll);
  }, [view, session, checkInbox]);

  async function sendRequest() {
    if (!account) return setModal("wallet");
    const me = rfqSession();
    const size = Number(rfqQty);
    if (!/^0x0[23][0-9a-fA-F]{64}$/.test(peer.trim())) return toast.error(t("Enter your counterparty's RFQ key (0x02… or 0x03…)."));
    if (!(size >= 0.001)) return toast.error(t("Enter a block size of at least 0.001."));
    const intent: RfqIntent = {
      kind: "request",
      asset: account.marketBySymbol(rfqSymbol).token,
      side: rfqSide as "buy" | "sell",
      qty: String(Math.round(size * 1e6)),
      ...(rfqLimit ? { limitUsd: String(Math.round(Number(rfqLimit) * 1e6)) } : {}),
      nonce: String(BigInt("0x" + crypto.getRandomValues(new Uint8Array(15)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""))),
    };
    await run(async () => {
      const { id } = await sendIntent(me, peer.trim(), intent);
      setInbox((prev) => [{ id, from: me.pub, intent, mine: true }, ...prev]);
    }, "Request sealed and sent to your counterparty.");
  }

  /** Accept a request: open the RFQ auction, tell the requester, place our side. */
  async function acceptRequest(m: { from: string; intent: RfqIntent }) {
    if (!account) return setModal("wallet");
    const me = rfqSession();
    const symbolOf = account.rfqSymbol(m.intent.asset);
    if (!symbolOf) return toast.error(t("This request names an asset the pool does not list."));
    const mySide = m.intent.side === "buy" ? "sell" : "buy";
    await run(async (progress) => {
      await account.openRfq(symbolOf, 300, progress);
      await account.sync();
      const block = [...account.auctions.values()].filter((a) => a.kind === "RFQ" && !a.pinned && !a.settled).sort((a, b) => b.id - a.id)[0];
      progress("Waiting for the RFQ auction to be indexed…");
      let target = block;
      for (let i = 0; !target && i < 18; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        await account.sync();
        target = [...account.auctions.values()].filter((a) => a.kind === "RFQ" && !a.pinned && !a.settled).sort((a, b) => b.id - a.id)[0];
      }
      if (!target) throw Error("The RFQ auction is on chain but not indexed yet. Accept again in a minute.");
      const buyerPub = mySide === "buy" ? me.pub : m.from;
      const sellerPub = mySide === "buy" ? m.from : me.pub;
      const rfq = account.rfqCommitmentOf({ symbol: symbolOf, qty: m.intent.qty, buyerPub, sellerPub, nonce: m.intent.nonce });
      const accept: RfqIntent = { ...m.intent, kind: "accept", side: mySide, auctionId: target.id };
      await sendIntent(me, m.from, accept);
      const size = (Number(m.intent.qty) / 1e6).toString();
      const lock = mySide === "buy" ? ((Number(m.intent.qty) / 1e6) * refOf(symbolOf) * 1.05 / nav).toFixed(6) : undefined;
      await account.placeOrder({ auctionId: target.id, side: mySide, sizeText: size, limitText: "", lockText: lock, rfq, selfSubmit: true }, progress);
    }, "Block accepted. Your side is sealed in the RFQ auction.");
  }

  /** The requester's side once the counterparty accepted into an RFQ auction. */
  async function placeBlock(m: { from: string; intent: RfqIntent }) {
    if (!account || !session || m.intent.auctionId === undefined) return;
    const symbolOf = account.rfqSymbol(m.intent.asset)!;
    const mySide = m.intent.side === "buy" ? "sell" : "buy";
    const buyerPub = mySide === "buy" ? session.pub : m.from;
    const sellerPub = mySide === "buy" ? m.from : session.pub;
    const rfq = account.rfqCommitmentOf({ symbol: symbolOf, qty: m.intent.qty, buyerPub, sellerPub, nonce: m.intent.nonce });
    const size = (Number(m.intent.qty) / 1e6).toString();
    const lock = mySide === "buy" ? ((Number(m.intent.qty) / 1e6) * refOf(symbolOf) * 1.05 / nav).toFixed(6) : undefined;
    await run(
      (progress) => account.placeOrder({ auctionId: m.intent.auctionId!, side: mySide, sizeText: size, limitText: "", lockText: lock, rfq, selfSubmit: true }, progress),
      "Your side of the block is sealed. It settles at the reference after the call.",
    );
  }

  // ---- tables ---------------------------------------------------------------------------------------------------
  function ordersTable(rows: Snapshot["orders"]) {
    if (!rows.length) {
      return (
        <Empty
          title="Your next move is private."
          description={connected ? "Sealed orders will appear here after you submit your first bid." : "Connect your wallet to load your shielded orders."}
          action={<button className="text-link" onClick={() => { navigate("overview"); document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth" }); }}>{t("Go to the auction ")}<ArrowUpRight size={16} /></button>}
        />
      );
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Asset / side")}</TableHead>
            <TableHead>{t("Quantity")}</TableHead>
            <TableHead>{t("Limit price")}</TableHead>
            <TableHead>{t("Auction")}</TableHead>
            <TableHead>{t("Status")}</TableHead>
            <TableHead className="text-right">{t("Action")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((o) => (
            <TableRow key={o.id}>
              <TableCell><strong>{o.symbol}</strong><small className={o.side === "BUY" ? "positive" : "orange"}>{t(o.side)}</small></TableCell>
              <TableCell>{fmtQty(Number(o.size), locale)}{t(" shares")}{o.status === "settled" && <small className="muted"> · {t("filled")} {fmtQty(Number(o.filled), locale)}</small>}</TableCell>
              <TableCell>{o.limit ? formatMoney(Number(o.limit)) : t("At auction")}</TableCell>
              <TableCell>{t(KIND_LABEL[o.kind ?? ""] ?? "Auction")} #{o.auctionId}{o.callTime && <small className="muted"> · {utc(o.callTime)}</small>}</TableCell>
              <TableCell>
                <span className={`order-status ${o.status === "open" || o.status === "pinned" ? "sealed" : o.status === "settled" ? "filled" : "cancelled"}`}>
                  {(o.status === "open" || o.status === "pinned") && <LockKeyhole size={11} />} {t(o.status)}
                </span>
                {o.pStar && <small className="muted"> @ {formatMoney(Number(o.pStar))}{o.rolled ? ` · ${t("rolled")}` : ""}</small>}
              </TableCell>
              <TableCell className="text-right">
                {o.cancellable ? (
                  <Button size="sm" variant="ghost" disabled={busy || !connected} onClick={() => void run((p) => account!.cancel(o.id, p), o.status === "open" ? "Order cancelled. Your lock is back in a new note." : "Lock reclaimed.")}>
                    {t(o.status === "open" ? "Cancel" : "Reclaim")}
                  </Button>
                ) : <span className="muted">—</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  function printsTable(rows: LivePrint[]) {
    if (!rows.length) return <Empty title="No prints yet." description="Each settled auction publishes its clearing price and crossed volume here." />;
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Asset")}</TableHead>
            <TableHead>{t("Clearing price")}</TableHead>
            <TableHead>{t("Crossed volume")}</TableHead>
            <TableHead>{t("Session")}</TableHead>
            <TableHead>{t("Published UTC")}</TableHead>
            <TableHead>{t("Record")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => (
            <TableRow key={p.auctionId}>
              <TableCell><strong>{p.symbol}</strong><small className="muted">#{p.auctionId}</small></TableCell>
              <TableCell>{formatMoney(micro(p.pStar))}</TableCell>
              <TableCell>{fmtQty(micro(p.crossedQty), locale)}{t(" shares")}</TableCell>
              <TableCell>{t(KIND_LABEL[p.kind ?? ""] ?? "Auction")}</TableCell>
              <TableCell>{utc(p.at)}</TableCell>
              <TableCell><button className="proof-link" onClick={() => { setProof(p); setModal("proof"); }}><ShieldCheck size={15} />{t(" View ")}<ArrowUpRight size={13} /></button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  // ---- ticket ---------------------------------------------------------------------------------------------------
  const ticket = (
    <section className="panel order-ticket" id="order-ticket">
      <div className="panel-title"><div><LockKeyhole size={17} /><h2>{t("Sealed order")}</h2></div><span className="tiny-label">{t("PRIVATE")}</span></div>
      <Tabs value={side} onValueChange={setSide} className="side-tabs"><TabsList><TabsTrigger value="buy">{t("Buy")}</TabsTrigger><TabsTrigger value="sell">{t("Sell")}</TabsTrigger></TabsList></Tabs>
      <div className="ticket-fields">
        <label>{t("Asset")}<Pick value={symbol} onChange={selectMarket} label="Order asset" options={STOCKS.map((s) => ({ value: s, label: `${s} · ${NAMES[s]}` }))} /></label>
        <div className="form-row">
          <label>{t("Order type")}<Pick value={kind} onChange={setKind} label="Order type" options={[{ value: "limit", label: "Limit order" }, { value: "auction", label: "At auction price" }]} /></label>
          <label>{t("Auction")}<Pick value={chosen ? String(chosen.id) : ""} onChange={setAuctionId} label="Auction" options={ticketAuctions.map((a) => ({ value: String(a.id), label: `${KIND_LABEL[a.kind]} · ${utc(a.callTime)}` }))} /></label>
        </div>
        <div className="form-row">
          <label>{t("Quantity")}<div className="input-unit"><Input type="number" min="0.001" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} aria-label={t("Order quantity")} /><span>{t("shares")}</span></div></label>
          <label>{t(kind === "limit" ? "Limit price" : "Reference price")}<div className="input-unit"><Input type="number" min="0.01" step="0.01" value={kind === "limit" ? limit || (ref ? ref.toFixed(2) : "") : ref.toFixed(2)} onChange={(e) => setLimit(e.target.value)} disabled={kind === "auction"} aria-label={t("Limit price")} /><span>{t("USD")}</span></div></label>
        </div>
        <div className="roll-row"><div><span>{t("Roll unfilled orders")}</span><small>{t("Keep your intent in the next call.")}</small></div><Switch checked={roll} onCheckedChange={setRoll} aria-label={t("Roll unfilled orders")} /></div>
        <div className="roll-row"><div><span>{t("Relay privately")}</span><small>{t("The relayer submits it, so your wallet is not linked to the order.")}</small></div><Switch checked={relayed} onCheckedChange={setRelayed} aria-label={t("Relay privately")} /></div>
        <div className="ticket-summary">
          <div><span>{t("Estimated value")}</span><strong>{formatMoney(estimate)}</strong></div>
          <div>
            <span>{t(side === "buy" ? "Shielded collateral (TQ)" : `Shielded ${symbol}`)}</span>
            <span>{connected ? fmtQty(Number(balance(side === "buy" ? "TQ" : symbol)?.spendable ?? 0), locale) : "—"}</span>
          </div>
          {side === "buy" && <div><span>{t("Locked for this buy (TQ)")}</span><span>{fmtQty(lockTq, locale)}</span></div>}
        </div>
        <Button className="main-button" disabled={busy || !live || (connected && !validTicket)} onClick={() => setModal(connected ? "review" : "wallet")}>
          {connected ? <><LockKeyhole size={16} />{t(" Review sealed order")}</> : <>{t("Connect wallet ")}<ArrowUpRight size={16} /></>}
        </Button>
        {!chosen && <p className="ticket-note"><Info size={13} />{t(" No auction of this asset is taking orders right now. The next ones go on chain up to 36 hours ahead.")}</p>}
        <p className="ticket-note"><ShieldCheck size={13} />{t(" Only you can see your order before the call.")}</p>
      </div>
    </section>
  );

  // ---- render ---------------------------------------------------------------------------------------------------
  return (
    <SidebarProvider className="dashboard-shell" style={{ "--sidebar-width": "226px" } as React.CSSProperties}>
      <Navigation view={view} onNavigate={navigate} onProtocol={() => setProtocol(true)} />
      <div className="dashboard-main">
        <header className="dashboard-header">
          <div className="dashboard-breadcrumb"><SidebarTrigger /><span>{t("Luminary")}</span><ChevronRight size={13} /><strong>{t(views.find((v) => v.id === view)?.label ?? "")}</strong></div>
          <div className="header-actions">
            <LanguageSwitcher />
            <span className="utc-clock">{clock ? clock.toISOString().slice(11, 19) : "—:—:—"}{t(" UTC")}</span>
            <Button variant={connected ? "outline" : "default"} onClick={() => setModal("wallet")} disabled={busy}>
              <Wallet size={15} />{connected ? `${snap!.wallet.slice(0, 6)}…${snap!.wallet.slice(-4)}` : t("Connect wallet")}
            </Button>
          </div>
        </header>
        <main className="dashboard-content">
          <div className="demo-notice">
            <Info size={14} />
            <span>{t("Robinhood Chain testnet. Test tokens only, with no real value. Reference prices are mirrored from mainnet.")}</span>
            <a href={CONFIG.faucet} target="_blank" rel="noreferrer">{t("Testnet faucet ")}<ArrowUpRight size={12} /></a>
          </div>
          {error && <div role="alert" className="error-notice">{t(error)}<Button variant="outline" size="sm" onClick={() => void load()}>{t("Retry")}</Button></div>}

          {view === "overview" && (
            <>
              <section className="dashboard-welcome">
                <div><p className="eyebrow orange">{t("THE AUCTION FLOOR")}</p><h1>{t("Every order has its moment.")}</h1><p>{t("Your intent stays private. The outcome speaks for itself.")}</p></div>
                <button className="icon-button" aria-label={t("Refresh")} disabled={busy} onClick={() => void run(async () => {}, "Refreshed.")}><RefreshCw className={busy ? "animate-spin" : ""} size={18} /></button>
              </section>
              <div className="dashboard-stats">
                <div><span>{t("Shielded collateral ")}<Wallet size={14} /></span><strong>{connected ? formatMoney(Number(balance("TQ")?.spendable ?? 0) * nav) : "—"}</strong><small>{t("Treasury quote (TQ) · NAV ")}{nav.toFixed(6)}</small></div>
                <div><span>{t("Sealed orders ")}<LockKeyhole size={14} /></span><strong>{connected ? String(openOrders.length).padStart(2, "0") : "00"}<em>{connected ? formatMoney(reservedTq * nav) : "$0.00"}{t(" reserved")}</em></strong><small>{t("Your orders, visible only to you")}</small></div>
                <div><span>{t("Next auction ")}<Clock3 size={14} /></span><strong className="countdown">{countdown}</strong><small>{t(nextEvent ? KIND_LABEL[nextEvent.kind] : "Finding the next call")}{t(" · UTC")}</small></div>
              </div>
              <div className="terminal-grid">
                <div className="market-column">
                  <section className="auction-banner">
                    <img src="/art/landscape.webp" alt={t("Silver mountains under an orange sky")} />
                    <div><p className="eyebrow">{t("SEALED INTENT. SHARED CONVICTION.")}</p><h2>{t("The next chapter")}<br /><em>{t("opens with you.")}</em></h2><button onClick={() => navigate("calendar")}>{t("Explore the auction calendar ")}<ArrowUpRight size={16} /></button></div>
                    <span className="banner-index">{t("LUMINARY / 001")}</span>
                  </section>
                  <section className="panel markets-panel">
                    <div className="panel-title"><div><h2>{t("Markets")}</h2><span className="small-label">{t("REFERENCE")}</span></div><span className="muted text-sm">{STOCKS.length}{t(" assets")}</span></div>
                    <Table>
                      <TableHeader><TableRow><TableHead>{t("Asset")}</TableHead><TableHead>{t("Reference")}</TableHead><TableHead>{t("Source")}</TableHead><TableHead>{t("Updated")}</TableHead><TableHead /></TableRow></TableHeader>
                      <TableBody>
                        {STOCKS.map((s) => {
                          const m = live?.marks?.prices[s];
                          return (
                            <TableRow key={s} data-selected={symbol === s}>
                              <TableCell><div className="asset-name"><span className="asset-letter" style={{ color: COLORS[s] }}>{s[0]}</span><div><strong>{s}</strong><small>{NAMES[s]}</small></div></div></TableCell>
                              <TableCell>{m ? formatMoney(micro(m.usd)) : "—"}</TableCell>
                              <TableCell><small className="muted">{m ? t(m.source === "chainlink-4663" ? "Chainlink (mainnet)" : "Robinhood quote") : "—"}</small></TableCell>
                              <TableCell><small className="muted">{m ? new Date(m.at).toISOString().slice(11, 16) : "—"}</small></TableCell>
                              <TableCell><button className="market-action" aria-label={t(`Trade ${s}`)} onClick={() => { selectMarket(s); document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }}><ArrowUpRight size={17} /></button></TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </section>
                </div>
                {ticket}
              </div>
              <section className="panel">
                <div className="panel-title"><div><h2>{t("Your orders")}</h2><span className="count-badge">{openOrders.length}</span></div><button className="small-link" onClick={() => navigate("orders")}>{t("View all ")}<ArrowUpRight size={15} /></button></div>
                {ordersTable(orders.slice(0, 4))}
              </section>
            </>
          )}

          {view === "orders" && (
            <>
              <PageHeading kicker="YOUR PRIVATE INTENT" title="Sealed orders" description="Track each order from submission to the final call." action={<Button onClick={() => navigate("overview")}>{t("New order ")}<Plus size={16} /></Button>} />
              <div className="toolbar">
                <Tabs value={filter} onValueChange={setFilter}><TabsList>{["all", "sealed", "filled", "cancelled"].map((v) => <TabsTrigger value={v} key={v} className="capitalize">{t(v)}</TabsTrigger>)}</TabsList></Tabs>
                <div className="toolbar-actions"><SearchField value={search} onChange={setSearch} /><Button variant="outline" onClick={() => exportData(filteredOrders as unknown as Record<string, unknown>[], "orders")}><Download size={15} />{t(" Export")}</Button></div>
              </div>
              <section className="panel">{ordersTable(filteredOrders)}</section>
              <p className="footnote">{t("Orders are cleared by the operator at each call: one uniform price, proven on chain. A pinned auction nobody settles within an hour can be abandoned, and every lock can then be reclaimed.")}</p>
            </>
          )}

          {view === "calendar" && (
            <>
              <PageHeading kicker="A SHARED RHYTHM" title="Auction calendar" description="Open. Close. Midnight. Know your next moment." action={<Button variant="outline" onClick={calendarFile} disabled={!nextEvent}><CalendarDays size={16} />{t(" Add next call")}</Button>} />
              <section className="calendar-hero">
                <img src="/art/dragon-phoenix.webp" alt={t("Silver dragon and phoenix illustration")} />
                <div><p className="eyebrow">{t("THE NEXT CALL")}</p><h2>{t(nextEvent ? KIND_LABEL[nextEvent.kind] : "Next auction")}</h2><span className="large-countdown">{countdown}</span><p>{t("HOURS ")}<span>{t("MINUTES")}</span>{t(" SECONDS")}</p></div>
              </section>
              <div className="toolbar">
                <Tabs value={calendarFilter} onValueChange={setCalendarFilter}><TabsList><TabsTrigger value="all">{t("All calls")}</TabsTrigger><TabsTrigger value="OPEN">{t("Open")}</TabsTrigger><TabsTrigger value="CLOSE">{t("Close")}</TabsTrigger><TabsTrigger value="MIDNIGHT">{t("Midnight")}</TabsTrigger></TabsList></Tabs>
                <span className="muted text-sm">{t("All times in UTC")}</span>
              </div>
              <section className="panel calendar-list">
                {calls.filter((c) => calendarFilter === "all" || c.kind === calendarFilter).map((c) => {
                  const Icon = c.kind === "OPEN" ? Sunrise : c.kind === "CLOSE" ? Sunset : Moon;
                  const d = new Date(c.callTime);
                  const onChain = c.rows.filter((r) => r.id !== null).length;
                  return (
                    <div key={`${c.kind}:${c.callTime}`} className="calendar-event">
                      <div className="calendar-date"><strong>{d.getUTCDate()}</strong><span>{d.toLocaleDateString(locale, { month: "short", timeZone: "UTC" })}</span></div>
                      <Icon size={23} />
                      <div><h3>{t(KIND_LABEL[c.kind] ?? c.kind)}</h3><p>{c.rows.map((r) => r.symbol).join(" · ")} · {t(onChain ? `${onChain} on chain` : "planned")}</p></div>
                      <span className="event-time">{d.toISOString().slice(11, 16)} <small>{t("UTC")}</small></span>
                      <Button variant="outline" disabled={!onChain} onClick={() => { const first = c.rows.find((r) => r.id !== null)!; setSymbol(first.symbol); setAuctionId(String(first.id)); navigate("overview"); }}>{t("Place order ")}<ArrowUpRight size={15} /></Button>
                    </div>
                  );
                })}
                {!calls.length && <Empty title="No upcoming calls yet." description="The scheduler plans a week ahead and puts auctions on chain up to 36 hours before their call." />}
              </section>
              <p className="footnote">{t("New York trading days with daylight saving handled. NYSE holidays and early closes are skipped, and an asset pauses on its Ex-Date.")}</p>
            </>
          )}

          {view === "prints" && (
            <>
              <PageHeading kicker="AN OPEN RECORD" title="Public prints" description="A clearing price and crossed volume. Nothing about your identity." action={<Button variant="outline" onClick={() => exportData(filteredPrints as unknown as Record<string, unknown>[], "public-prints")}><Download size={16} />{t(" Export prints")}</Button>} />
              <div className="print-summary"><ScanLine size={34} /><div><span>{t("Transparency at the outcome.")}</span><p>{t("Each settled call publishes one uniform price, in the same transaction that verifies its clearing proof. Individual orders stay private.")}</p></div><span className="demo-pill">{t("ON CHAIN")}</span></div>
              <div className="toolbar">
                <Tabs value={filter} onValueChange={setFilter}><TabsList><TabsTrigger value="all">{t("All assets")}</TabsTrigger>{STOCKS.map((s) => <TabsTrigger value={s} key={s}>{s}</TabsTrigger>)}</TabsList></Tabs>
                <SearchField value={search} onChange={setSearch} />
              </div>
              <section className="panel">{printsTable(filteredPrints)}</section>
            </>
          )}

          {view === "rfq" && (
            <>
              <PageHeading kicker="BETWEEN THE CALLS" title="The RFQ desk" description="Negotiate a private block. It settles whole at the reference price." />
              <div className="rfq-grid">
                <section className="panel rfq-form">
                  <div className="panel-title"><div><Handshake size={18} /><h2>{t("Request a block")}</h2></div><span className="tiny-label">{t("PRIVATE BLOCK")}</span></div>
                  <div className="ticket-fields">
                    <label>{t("Your RFQ key")}
                      <div className="input-unit"><Input readOnly value={session?.pub ?? ""} placeholder={t("Create a key to start")} aria-label={t("Your RFQ key")} /></div>
                      <button type="button" className="small-link" onClick={() => { const s = rfqSession(); void navigator.clipboard.writeText(s.pub).then(() => toast.success(t("Key copied. Share it with your counterparty.")), () => toast.info(t("Select the key above and copy it."))); }}><Copy size={13} />{t(" Copy key")}</button>
                      <small>{t("Share it with your counterparty. Messages are sealed to these keys; the server only sees ciphertext.")}</small>
                    </label>
                    <label>{t("Counterparty key")}<Input value={peer} onChange={(e) => setPeer(e.target.value)} placeholder="0x02…" aria-label={t("Counterparty key")} /></label>
                    <Tabs value={rfqSide} onValueChange={setRfqSide} className="side-tabs"><TabsList><TabsTrigger value="buy">{t("Buy")}</TabsTrigger><TabsTrigger value="sell">{t("Sell")}</TabsTrigger></TabsList></Tabs>
                    <label>{t("Asset")}<Pick value={rfqSymbol} onChange={setRfqSymbol} label="RFQ asset" options={STOCKS.map((s) => ({ value: s, label: `${s} · ${NAMES[s]}` }))} /></label>
                    <div className="form-row">
                      <label>{t("Block size")}<div className="input-unit"><Input value={rfqQty} onChange={(e) => setRfqQty(e.target.value)} type="number" min="0.001" step="0.001" aria-label={t("RFQ quantity")} /><span>{t("shares")}</span></div></label>
                      <label>{t("Limit (optional)")}<div className="input-unit"><Input value={rfqLimit} onChange={(e) => setRfqLimit(e.target.value)} type="number" min="0" step="0.01" aria-label={t("RFQ limit")} /><span>{t("USD")}</span></div></label>
                    </div>
                    <div className="ticket-summary"><div><span>{t("Reference price")}</span><strong>{formatMoney(refOf(rfqSymbol))}</strong></div><div><span>{t("Indicative value")}</span><span>{formatMoney(Number(rfqQty) * refOf(rfqSymbol) || 0)}</span></div></div>
                    <Button className="main-button" disabled={busy} onClick={() => void sendRequest()}>{busy ? <Loader2 className="animate-spin" /> : <Handshake size={16} />} {t(connected ? "Send sealed request" : "Connect wallet")}</Button>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-title"><div><h2>{t("Negotiations")}</h2><span className="count-badge">{inbox.length}</span></div><button className="small-link" onClick={() => void checkInbox()}>{t("Refresh ")}<RefreshCw size={13} /></button></div>
                  {inbox.length ? inbox.map((m) => {
                    const sym = account?.rfqSymbol(m.intent.asset) ?? "?";
                    return (
                      <div key={`${m.id}:${m.mine ? "me" : "in"}`} className="quote-card">
                        <div><span className={m.mine ? "muted" : "positive"}><i />{t(m.mine ? " SENT" : m.intent.kind === "accept" ? " ACCEPTED" : " RECEIVED")}</span><span className="muted">#{m.id}</span></div>
                        <h3>{t(m.intent.side.toUpperCase())} {fmtQty(Number(m.intent.qty) / 1e6, locale)} {sym}</h3>
                        <p>{t("At the reference")}{m.intent.limitUsd ? ` · ${t("limit")} ${formatMoney(micro(m.intent.limitUsd))}` : ""}{m.intent.auctionId !== undefined ? ` · RFQ #${m.intent.auctionId}` : ""}</p>
                        {!m.mine && m.intent.kind === "request" && <Button className="main-button" disabled={busy || !connected} onClick={() => void acceptRequest(m)}>{t("Accept and seal my side ")}<Check size={15} /></Button>}
                        {!m.mine && m.intent.kind === "accept" && <Button className="main-button" disabled={busy || !connected} onClick={() => void placeBlock(m)}>{t("Seal my side of the block ")}<LockKeyhole size={15} /></Button>}
                      </div>
                    );
                  }) : <Empty title="No negotiations yet." description="Requests sealed to your RFQ key appear here." />}
                  <small className="muted">{t("An RFQ block crosses whole at the pinned reference, or both sides are refunded. It never rolls.")}</small>
                </section>
              </div>
            </>
          )}

          {view === "treasury" && (
            <>
              <PageHeading kicker="THE FOUNDATION" title="Your treasury" description="A balance with purpose. Collateral for your next moment." action={<Button disabled={busy} onClick={() => { setFundAction("mint"); setFundAsset("USDG"); setModal(connected ? "funds" : "wallet"); }}><Plus size={16} />{t(" Add funds")}</Button>} />
              <div className="treasury-grid">
                <section className="treasury-balance">
                  <p className="eyebrow">{t("SHIELDED TREASURY COLLATERAL")}</p>
                  <h2>{connected ? formatMoney(Number(balance("TQ")?.spendable ?? 0) * nav) : "—"}</h2>
                  <span>{t("TREASURY QUOTE (TQ) · NAV ")}{nav.toFixed(6)}</span>
                  <div>
                    <p>{t("Spendable ")}<strong>{connected ? fmtQty(Number(balance("TQ")?.spendable ?? 0), locale) : "—"} TQ</strong></p>
                    <p>{t("Reserved in orders ")}<strong>{connected ? fmtQty(reservedTq, locale) : "—"} TQ</strong></p>
                  </div>
                  <Button variant="outline" disabled={!connected} onClick={() => { setFundAction("unshield"); setFundAsset("TQ"); setModal("funds"); }}>{t("Withdraw funds ")}<ArrowUpRight size={15} /></Button>
                </section>
                <section className="treasury-explainer">
                  <Coins size={30} />
                  <h3>{t("Let resting collateral")}<br />{t("work while you wait.")}</h3>
                  <p>{t("Buys lock TreasuryQuote shares. Their NAV accrues while your order waits for its call, so resting collateral earns.")}</p>
                  <small>{t("Testnet: MockUSDG backs TQ and NAV accrues at a fixed 4.5% APY.")}</small>
                  <button className="text-link" onClick={() => setProtocol(true)}>{t("Understand treasury settlement ")}<ArrowUpRight size={15} /></button>
                </section>
              </div>
              <section className="panel">
                <div className="panel-title"><h2>{t("Balances")}</h2><span className="small-label">{t("WALLET / SHIELDED")}</span></div>
                <Table>
                  <TableHeader><TableRow><TableHead>{t("Asset")}</TableHead><TableHead>{t("Wallet")}</TableHead><TableHead>{t("Shielded")}</TableHead><TableHead>{t("Joining the pool")}</TableHead><TableHead>{t("In orders")}</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {ASSETS.map((s) => {
                      const b = balance(s);
                      return (
                        <TableRow key={s}>
                          <TableCell><strong>{s}</strong><small>{NAMES[s] ?? (s === "TQ" ? "Treasury quote" : s === "USDG" ? "Mock USDG" : "Ether")}</small></TableCell>
                          <TableCell>{connected ? fmtQty(Number(walletBal.find((w) => w.symbol === s)?.amount ?? 0), locale) : "—"}</TableCell>
                          <TableCell>{connected ? fmtQty(Number(b?.spendable ?? 0), locale) : "—"}</TableCell>
                          <TableCell>{connected ? fmtQty(Number(b?.pending ?? 0), locale) : "—"}</TableCell>
                          <TableCell>{connected ? fmtQty(Number(b?.inOrders ?? 0), locale) : "—"}</TableCell>
                          <TableCell>
                            <button className="small-link" disabled={!connected} onClick={() => { setFundAction("shield"); setFundAsset(s); setModal("funds"); }}>{t("Shield ")}<ArrowUpRight size={14} /></button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </section>
              <section className="panel activity-panel">
                <div className="panel-title"><h2>{t("Recent activity")}</h2><Activity size={17} /></div>
                {snap?.activity.length ? snap.activity.slice(0, 12).map((a, i) => (
                  <div className="activity-row" key={`${a.tx}:${i}`}><CheckCheck size={17} /><span>{t(a.type)} {a.amount ? `${fmtQty(Number(a.amount), locale)} ${a.symbol}` : ""} {a.priceUsd ? `@ ${formatMoney(Number(a.priceUsd))}` : ""}</span><a href={txUrl(a.tx)} target="_blank" rel="noreferrer"><time>{t("block ")}{a.block}</time></a></div>
                )) : <Empty title="A clean slate." description="Your activity will appear here." />}
              </section>
            </>
          )}

          <footer className="dashboard-foot">
            <span><ShieldCheck size={13} />{t(" PRIVATE BY DESIGN")}</span>
            {DEPLOYMENT && <a href={addressUrl(DEPLOYMENT.AuctionPool)} target="_blank" rel="noreferrer">{t("AUCTION POOL ↗")}</a>}
            <a href="/legal/terms">{t("LEGAL & DISCLOSURES ↗")}</a>
            <button onClick={() => setProtocol(true)}>{t("Protocol information ")}<ArrowUpRight size={12} /></button>
          </footer>
        </main>
      </div>

      <Dialog open={!!modal} onOpenChange={(open) => !open && !busy && setModal(null)}>
        <DialogContent className="action-dialog">
          {modal === "wallet" && (
            <>
              <img className="modal-emblem" src="/art/emblem.webp" alt="" />
              <p className="eyebrow orange">{t("YOUR PRIVATE WORKSPACE")}</p>
              <DialogTitle>{t(connected ? "Your wallet" : "Enter the auction.")}</DialogTitle>
              <DialogDescription>{t(connected ? "Your shielded account is derived from one signature and rebuilt from public chain data on any device." : "Connect a wallet on Robinhood Chain testnet. You sign one message to derive your private keys; no transaction is sent.")}</DialogDescription>
              {connected ? (
                <dl className="review-details">
                  <div><dt>{t("Wallet")}</dt><dd><a href={addressUrl(snap!.wallet)} target="_blank" rel="noreferrer">{snap!.wallet.slice(0, 10)}…{snap!.wallet.slice(-6)}</a></dd></div>
                  <div><dt>{t("Shielded address")}</dt><dd><button className="small-link" onClick={() => void navigator.clipboard.writeText(snap!.shieldedAddress).then(() => toast.success(t("Copied.")))}>{snap!.shieldedAddress.slice(0, 14)}… <Copy size={12} /></button></dd></div>
                  <div><dt>{t("Relayer fee per order")}</dt><dd>{snap!.relayFees.orderEth} ETH</dd></div>
                </dl>
              ) : (
                <div className="modal-callout"><ShieldCheck size={19} /><p>{t("Test tokens only. Get ETH and stock tokens from the Robinhood testnet faucet; mint USDG here.")}</p></div>
              )}
              <Button className="main-button" disabled={busy} onClick={() => (connected ? (setAccount(null), setSnap(null), setModal(null)) : void connect())}>
                {busy ? <Loader2 className="animate-spin" /> : <Wallet size={16} />} {t(connected ? "Disconnect wallet" : "Connect wallet")}
              </Button>
              <a className="text-link" href={CONFIG.faucet} target="_blank" rel="noreferrer">{t("Robinhood testnet faucet ")}<ArrowUpRight size={14} /></a>
            </>
          )}

          {modal === "review" && (
            <>
              <p className="eyebrow orange">{t("ONE LAST LOOK")}</p>
              <DialogTitle>{t("Seal your intent.")}</DialogTitle>
              <DialogDescription>{t("Your browser proves the order and seals it to the clearing committee. It stays private until the call.")}</DialogDescription>
              <div className="review-asset"><span className="asset-letter">{symbol[0]}</span><div><h3>{t(side === "buy" ? "Buy" : "Sell")} {qty} {symbol}</h3><p>{NAMES[symbol]}{t(" · Tokenized stock")}</p></div><LockKeyhole size={24} /></div>
              <dl className="review-details">
                <div><dt>{t("Order type")}</dt><dd>{t(kind === "limit" ? "Limit order" : "At auction price")}</dd></div>
                <div><dt>{t("Price")}</dt><dd>{kind === "limit" ? formatMoney(limitNum) : t("Uniform auction price")}</dd></div>
                <div><dt>{t("Auction")}</dt><dd>{chosen ? `${t(KIND_LABEL[chosen.kind])} #${chosen.id} · ${utc(chosen.callTime)}` : "—"}</dd></div>
                <div><dt>{t("Unfilled orders")}</dt><dd>{t(roll ? "Roll to next call" : "Refund after call")}</dd></div>
                <div><dt>{t(side === "buy" ? "Collateral locked" : "Shares locked")}</dt><dd>{side === "buy" ? `${fmtQty(lockTq, locale)} TQ` : `${qty} ${symbol}`}</dd></div>
                <div><dt>{t("Submitted by")}</dt><dd>{t(relayed ? "The relayer (private)" : "Your wallet")}</dd></div>
              </dl>
              {kind === "auction" && side === "buy" && <p className="footnote">{t("An at-auction buy locks 5% over the reference; whatever it does not spend comes back to you.")}</p>}
              <Button className="main-button" disabled={busy || !validTicket} onClick={() => void placeOrder(!relayed)}>{busy ? <Loader2 className="animate-spin" /> : <LockKeyhole size={16} />} {t("Seal order")}</Button>
            </>
          )}

          {modal === "feenote" && (
            <>
              <p className="eyebrow orange">{t("RELAYER FEE")}</p>
              <DialogTitle>{t("A fee note keeps the relay private.")}</DialogTitle>
              <DialogDescription>{t("A relayed order pays its ETH fee from a separate shielded ETH note, so nothing links the fee to your order. Prepare one from your shielded ETH, or submit this order from your wallet instead.")}</DialogDescription>
              <Button className="main-button" disabled={busy} onClick={() => void run((p) => account!.prepareFeeNote(p), "Fee note ready. Seal your order again.").then((ok) => ok && setModal("review"))}>{t("Prepare a fee note")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void placeOrder(true)}>{t("Submit from my wallet instead")}</Button>
            </>
          )}

          {modal === "funds" && (
            <>
              <p className="eyebrow orange">{t("TREASURY / FUNDS")}</p>
              <DialogTitle>{t("Move funds.")}</DialogTitle>
              <DialogDescription>{t("Mint test USDG, turn it into treasury quote (TQ), and shield it into the pool as buy collateral. Stock tokens and ETH come from the testnet faucet.")}</DialogDescription>
              <label className="modal-label">{t("Action")}
                <Pick value={fundAction} onChange={(v) => { setFundAction(v as FundAction); if (v === "mint" || v === "convert") setFundAsset("USDG"); if (v === "redeem") setFundAsset("TQ"); }} label="Action" options={[
                  { value: "mint", label: "Mint test USDG (faucet)" },
                  { value: "convert", label: "USDG → TQ (treasury quote)" },
                  { value: "redeem", label: "TQ → USDG" },
                  { value: "shield", label: "Shield into the pool" },
                  { value: "unshield", label: "Withdraw to my wallet" },
                  { value: "feenote", label: "Prepare a relayer fee note (ETH)" },
                ]} />
              </label>
              {(fundAction === "shield" || fundAction === "unshield") && (
                <label className="modal-label">{t("Asset")}<Pick value={fundAsset} onChange={setFundAsset} label="Asset" options={ASSETS.map((s) => ({ value: s, label: s }))} /></label>
              )}
              {fundAction !== "feenote" && (
                <label className="modal-label">{t("Amount")}<Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={t("Amount")} /></label>
              )}
              {fundAction === "unshield" && fundAsset !== "ETH" && <p className="footnote">{t("Token withdrawals are sent from your wallet; ETH withdrawals go through the relayer.")}</p>}
              <Button className="main-button" disabled={busy || (fundAction !== "feenote" && !(Number(amount) > 0))} onClick={() => void fund()}>{busy ? <Loader2 className="animate-spin" /> : <Plus size={16} />} {t("Continue")}</Button>
            </>
          )}

          {modal === "proof" && proof && (
            <>
              <p className="eyebrow orange">{t("PUBLIC AUCTION RECORD")}</p>
              <DialogTitle>{proof.symbol} · {formatMoney(micro(proof.pStar))}</DialogTitle>
              <DialogDescription>{t("Printed in the settlement transaction that verified the auction's clearing proof. No individual order or identity is published.")}</DialogDescription>
              <dl className="review-details">
                <div><dt>{t("Auction")}</dt><dd>#{proof.auctionId} · {t(KIND_LABEL[proof.kind ?? ""] ?? "Auction")}</dd></div>
                <div><dt>{t("Crossed volume")}</dt><dd>{fmtQty(micro(proof.crossedQty), locale)}{t(" shares")}</dd></div>
                <div><dt>{t("Reference at the call")}</dt><dd>{proof.refUsd ? formatMoney(micro(proof.refUsd)) : "—"}</dd></div>
                <div><dt>{t("Block")}</dt><dd>{proof.block}</dd></div>
                <div><dt>{t("Published")}</dt><dd>{utc(proof.at)}{t(" UTC")}</dd></div>
              </dl>
              <div className="proof-record"><ShieldCheck size={19} /><code>{proof.tx}</code></div>
              <TxLink hash={proof.tx} label=" View the settlement and its proof " />
            </>
          )}
        </DialogContent>
      </Dialog>
      <ProtocolDialog open={protocol} onClose={() => setProtocol(false)} />
      <Toaster position="bottom-right" theme="dark" richColors closeButton />
    </SidebarProvider>
  );
}
