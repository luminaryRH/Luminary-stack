// bun src/server/luminary/calendar.check.ts
// DST switch days, NYSE holidays and early closes, and the Ex-Date pause.
import assert from "node:assert/strict";
import { nyDate, nyTime, planAuctions, type MarketDay } from "./calendar";

const iso = (d: Date) => d.toISOString().slice(0, 16);

// DST: spring forward Sunday 2026-03-08, fall back Sunday 2026-11-01
assert.equal(iso(nyTime("2026-03-06", 9, 30)), "2026-03-06T14:30"); // EST
assert.equal(iso(nyTime("2026-03-09", 9, 30)), "2026-03-09T13:30"); // EDT
assert.equal(iso(nyTime("2026-03-08", 9, 30)), "2026-03-08T13:30"); // the switch day itself, after 02:00
assert.equal(iso(nyTime("2026-10-30", 16, 0)), "2026-10-30T20:00"); // EDT
assert.equal(iso(nyTime("2026-11-02", 16, 0)), "2026-11-02T21:00"); // EST
assert.equal(nyDate(new Date("2026-11-03T03:30:00Z")), "2026-11-02");

const calendar: MarketDay[] = [
  { day: "2026-11-26", kind: "holiday", closeTime: null },
  { day: "2026-11-27", kind: "early_close", closeTime: "13:00:00" },
];

// a week with Thanksgiving: no auctions on the holiday or the weekend, an early CLOSE on Friday
{
  const plan = planAuctions(["TSLA"], new Date("2026-11-22T23:00:00Z"), 6, calendar, []);
  const days = [...new Set(plan.map((p) => p.tradingDay))];
  assert.deepEqual(days, ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
  const friday = plan.filter((p) => p.tradingDay === "2026-11-27").map((p) => `${p.kind}@${iso(p.callTime)}`);
  assert.deepEqual(friday, ["MIDNIGHT@2026-11-27T00:00", "OPEN@2026-11-27T14:30", "CLOSE@2026-11-27T18:00"]);
  assert.equal(plan.length, 12);
}

// the DST switch week: Friday in EST offsets, Monday in EDT
{
  const plan = planAuctions(["AMD"], new Date("2026-03-06T00:00:00Z"), 4, [], []);
  assert.deepEqual(
    plan.filter((p) => p.kind === "OPEN").map((p) => iso(p.callTime)),
    ["2026-03-06T14:30", "2026-03-09T13:30"],
  );
}

// Ex-Date: TSLA pauses on 2026-10-14, AMZN does not
{
  const plan = planAuctions(["TSLA", "AMZN"], new Date("2026-10-13T12:00:00Z"), 2, [], [{ symbol: "TSLA", exDate: "2026-10-14" }]);
  assert.equal(plan.filter((p) => p.symbol === "TSLA" && p.tradingDay === "2026-10-14").length, 0);
  assert.equal(plan.filter((p) => p.symbol === "AMZN" && p.tradingDay === "2026-10-14").length, 3);
  assert.equal(plan.filter((p) => p.symbol === "TSLA" && p.tradingDay === "2026-10-15").length, 3);
}

// only calls after `from`; keys are unique
{
  const from = new Date("2026-10-13T15:00:00Z"); // after Tuesday's open
  const plan = planAuctions(["TSLA"], from, 0, [], []);
  assert.deepEqual(plan.map((p) => p.kind), ["CLOSE"]);
  const many = planAuctions(["TSLA", "AMZN", "AMD", "PLTR", "NFLX"], from, 30, [], []);
  assert.equal(new Set(many.map((p) => p.key)).size, many.length);
}

console.log("calendar: ok");
