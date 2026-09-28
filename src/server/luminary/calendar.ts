// AuctionCalendar: which auctions run when. Pure; the scheduler feeds it the market calendar and corporate actions from
// Supabase and plans the result into lum_auctions.
//   OPEN      09:30 America/New_York on each NYSE trading day
//   CLOSE     16:00 New York (13:00 on early-close days)
//   MIDNIGHT  00:00 UTC on each trading day's date: the overnight call leading into that session
//   NAV       TreasuryQuote's fund auction, requested by an admin (not on the calendar)
// No auctions on weekends or NYSE holidays; an asset's auctions pause on its Ex-Date. Every New York time is converted
// with the offset in force at that instant, so DST switch days are exact.

export type CalendarKind = "OPEN" | "CLOSE" | "MIDNIGHT";

export interface MarketDay {
  day: string; // YYYY-MM-DD, New York date
  kind: "holiday" | "early_close";
  closeTime: string | null; // HH:MM[:SS] New York, for early closes
}

export interface CorporateAction {
  symbol: string;
  exDate: string; // YYYY-MM-DD
}

export interface PlannedAuction {
  key: string;
  symbol: string;
  kind: CalendarKind;
  callTime: Date;
  tradingDay: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** New York's UTC offset in hours (−4 or −5) at an instant. */
export function nyOffset(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT-4" / "GMT-5"
  return Number(name.replace("GMT", ""));
}

/** The instant of New York wall time `hh:mm` on New York date `day`. */
export function nyTime(day: string, hh: number, mm: number): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall - nyOffset(new Date(wall - 5 * 3_600_000)) * 3_600_000;
  t = wall - nyOffset(new Date(t)) * 3_600_000; // settle on the offset in force at the result itself
  return new Date(t);
}

/** New York's calendar date at an instant. */
export function nyDate(at: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return `${p["year"]}-${p["month"]}-${p["day"]}`;
}

export const auctionKey = (symbol: string, kind: string, callTime: Date) => `${symbol}:${kind}:${callTime.toISOString()}`;

/** Auctions with a call after `from`, for trading days from `from`'s New York date through `days` days later. */
export function planAuctions(symbols: readonly string[], from: Date, days: number, calendar: MarketDay[], actions: CorporateAction[]): PlannedAuction[] {
  const special = new Map(calendar.map((c) => [c.day, c]));
  const exDates = new Set(actions.map((a) => `${a.symbol}:${a.exDate}`));
  const start = new Date(`${nyDate(from)}T00:00:00Z`);
  const out: PlannedAuction[] = [];
  for (let i = 0; i <= days; i++) {
    const date = new Date(start.getTime() + i * 86_400_000);
    const day = ymd(date);
    const weekday = date.getUTCDay();
    const s = special.get(day);
    if (weekday === 0 || weekday === 6 || s?.kind === "holiday") continue;
    const [ch, cm] = s?.kind === "early_close" && s.closeTime ? s.closeTime.split(":").map(Number) : [16, 0];
    const calls: [CalendarKind, Date][] = [
      ["MIDNIGHT", new Date(`${day}T00:00:00Z`)],
      ["OPEN", nyTime(day, 9, 30)],
      ["CLOSE", nyTime(day, ch!, cm!)],
    ];
    for (const symbol of symbols) {
      if (exDates.has(`${symbol}:${day}`)) continue; // paused across the Ex-Date
      for (const [kind, callTime] of calls) {
        if (callTime > from) out.push({ key: auctionKey(symbol, kind, callTime), symbol, kind, callTime, tradingDay: day });
      }
    }
  }
  return out.sort((a, b) => a.callTime.getTime() - b.callTime.getTime() || a.symbol.localeCompare(b.symbol));
}
