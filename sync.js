const chainLib = require("@hiveio/dhive");

function reqEnv(name){ const v = process.env[name]; if (!v){ console.error(`missing env: ${name}`); process.exit(1); } return v; }
function numEnv(name, def){ const v = parseFloat(process.env[name]); return isFinite(v) ? v : def; }
function boolEnv(name, def){
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return def;
  return /^(1|true|yes)$/i.test(v.trim());
}

const cfg = {
  username: reqEnv("SVC_USER"),
  keyWif: reqEnv("SVC_KEY"),
  minGapPct: numEnv("MIN_GAP_PCT", 0.6),
  maxUnit: numEnv("MAX_UNIT", 0), // 0 = unlimited (balance-limited only)
  tolPct: numEnv("TOLERANCE_PCT", 1),
  pollIntervalSec: numEnv("POLL_INTERVAL_SEC", 20),
  orderTimeoutSec: numEnv("ORDER_TIMEOUT_SEC", 12),
  minReserveA1: numEnv("MIN_RESERVE_A1", 1),
  minReserveA2: numEnv("MIN_RESERVE_A2", 1),
  minReserveB1: numEnv("MIN_RESERVE_B1", 1),
  minReserveB2: numEnv("MIN_RESERVE_B2", 1),
  live: boolEnv("LIVE", true),
  maxRuntimeMin: numEnv("MAX_RUNTIME_MIN", 340),
  detail: boolEnv("LOG_DETAIL", false),

  // ---- periodic balance transfer settings ----
  relayAccount: process.env.RELAY_ACCOUNT || "graphene-swap",
  balEnabled: boolEnv("BAL_ENABLED", true),
  // outbound transfer memo format confirmed from explorer data, on by default.
  balOutEnabled: boolEnv("BAL_OUT_ENABLED", true),
  // inbound transfer memo format not confirmed (assuming empty memo), off by default.
  balInEnabled: boolEnv("BAL_IN_ENABLED", false),
  balCheckMin: numEnv("BAL_CHECK_MIN", 60),
  balTriggerA1: numEnv("BAL_TRIGGER_A1", 5),
  balTriggerA2: numEnv("BAL_TRIGGER_A2", 5),
  balTriggerB1: numEnv("BAL_TRIGGER_B1", 5),
  balTriggerB2: numEnv("BAL_TRIGGER_B2", 5),
  balMoveA1: numEnv("BAL_MOVE_A1", 10),
  balMoveA2: numEnv("BAL_MOVE_A2", 10),
  relayFeePct: numEnv("RELAY_FEE_PCT", 0.75), // cost charged on EACH relay transfer (either direction)
  // sustained one-directional trading drains one token and piles up the other, so
  // keeping it running needs BOTH a deposit leg and a withdraw leg eventually ->
  // assume 2 crossings by default. Set to 1 only if you're sure just one direction
  // (e.g. only withdraw) will ever be needed for your flow.
  relayLegs: numEnv("RELAY_LEGS", 2),
};

const effectiveRelayFeePct = cfg.relayFeePct * cfg.relayLegs;

// session-level accounting (resets each run; not persisted across scheduled runs)
const stats = { grossGain: 0, relayFeeA1: 0, relayFeeA2: 0, trades: 0, relays: 0 };

const SIDE_B_NODES = [
  "https://api.hive-engine.com/rpc/contracts",
  "https://api2.hive-engine.com/rpc/contracts",
  "https://herpc.dtools.dev/contracts",
  "https://engine.rishipanthee.com/contracts",
  "https://enginerpc.com/contracts",
];
const SIDE_A_NODES = [
  "https://api.hive.blog",
  "https://api.deathwing.me",
  "https://anyx.io",
  "https://hive-api.arcange.eu",
  "https://techcoderx.com",
];
const POOL_FEE = 0.0025;
const NET_ID = "ssc-mainnet-hive";
const client = new chainLib.Client(SIDE_A_NODES, { timeout: 15000 });
const signKey = chainLib.PrivateKey.fromString(cfg.keyWif);

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(msg, level, detail){
  const t = new Date().toISOString().replace("T", " ").slice(0, 19);
  const tag = level === "err" ? "E" : level === "ok" ? "ok" : "i";
  const extra = (cfg.detail && detail) ? " | " + detail : "";
  console.log(`[${t}] [${tag}] ${msg}${extra}`);
}
function roundDown(qty, precision){ const f = Math.pow(10, precision); return Math.floor(qty * f) / f; }

// ---------------- Side B (secondary) RPC ----------------
let bIdx = 0;
async function bRpc(body){
  let lastErr;
  for (let i = 0; i < SIDE_B_NODES.length * 3; i++){
    const url = SIDE_B_NODES[bIdx % SIDE_B_NODES.length];
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "rpc error");
      return data.result || [];
    } catch (e){ lastErr = e; bIdx++; await sleep(300 + Math.random() * 300); }
  }
  throw new Error("side B rpc unreachable: " + (lastErr ? lastErr.message : "?"));
}
function bFind(contract, table, query, limit){
  return bRpc({ jsonrpc: "2.0", id: Date.now() + Math.random(), method: "find", params: { contract, table, query, limit: limit || 1000, offset: 0 } });
}

// ---------------- Side B: unit price (pool + orderbook) ----------------
async function getSideBPool(){
  let rows = await bFind("marketpools", "pools", { tokenPair: "SWAP.HBD:SWAP.HIVE" }, 1);
  let flip = false;
  if (!rows.length){ rows = await bFind("marketpools", "pools", { tokenPair: "SWAP.HIVE:SWAP.HBD" }, 1); flip = true; }
  if (!rows.length) return null;
  const r = rows[0];
  const baseQty = parseFloat(r.baseQuantity), quoteQty = parseFloat(r.quoteQuantity);
  let qty1, qty2;
  if (!flip){ qty1 = baseQty; qty2 = quoteQty; } else { qty1 = quoteQty; qty2 = baseQty; }
  if (!(qty1 > 0) || !(qty2 > 0)) return null;
  return { tokenPair: r.tokenPair, qty1, qty2 };
}
function poolOut2(pool, in1){ const eff = in1 * (1 - POOL_FEE); return pool.qty2 * eff / (pool.qty1 + eff); }
function poolIn2(pool, out1){
  if (!(out1 > 0) || out1 >= pool.qty1) return Infinity;
  const inEff = out1 * pool.qty2 / (pool.qty1 - out1);
  return inEff / (1 - POOL_FEE);
}
async function getSideBBook(side){
  const table = side === "buy" ? "buyBook" : "sellBook";
  const rows = await bFind("market", table, { symbol: "SWAP.HBD" }, 200);
  const levels = rows.map(r => ({ price: parseFloat(r.price), quantity: parseFloat(r.quantity) })).filter(l => l.price > 0 && l.quantity > 0);
  levels.sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price));
  return levels;
}
function walkBuy(book, qty){ let rem = qty, cost = 0; for (const l of book){ const take = Math.min(rem, l.quantity); if (take <= 0) continue; cost += take * l.price; rem -= take; if (rem <= 1e-8) break; } if (rem > 1e-8) return null; return cost; }
function walkSell(book, qty){ let rem = qty, rev = 0; for (const l of book){ const take = Math.min(rem, l.quantity); if (take <= 0) continue; rev += take * l.price; rem -= take; if (rem <= 1e-8) break; } if (rem > 1e-8) return null; return rev; }

async function bBuyBest(qty){
  const [pool, sellBook] = await Promise.all([getSideBPool(), getSideBBook("sell")]);
  const opts = [];
  if (pool){ const c = poolIn2(pool, qty); if (isFinite(c) && c > 0) opts.push({ cost: c, via: "pool", pool }); }
  if (sellBook.length){ const c = walkBuy(sellBook, qty); if (c !== null) opts.push({ cost: c, via: "book" }); }
  if (!opts.length) return null;
  opts.sort((a, b) => a.cost - b.cost);
  return opts[0];
}
async function bSellBest(qty){
  const [pool, buyBook] = await Promise.all([getSideBPool(), getSideBBook("buy")]);
  const opts = [];
  if (pool){ const r = poolOut2(pool, qty); if (r > 0) opts.push({ revenue: r, via: "pool", pool }); }
  if (buyBook.length){ const r = walkSell(buyBook, qty); if (r !== null) opts.push({ revenue: r, via: "book" }); }
  if (!opts.length) return null;
  opts.sort((a, b) => b.revenue - a.revenue);
  return opts[0];
}

// ---------------- Side A (primary) market ----------------
let aIdx = 0;
async function aRpc(method, params){
  let lastErr;
  for (let i = 0; i < SIDE_A_NODES.length * 2; i++){
    const url = SIDE_A_NODES[aIdx % SIDE_A_NODES.length];
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "rpc error");
      return data.result;
    } catch (e){ lastErr = e; aIdx++; await sleep(300); }
  }
  throw new Error("side A rpc unreachable: " + (lastErr ? lastErr.message : "?"));
}
function parseAmt(str){ const [a, s] = String(str).split(" "); return { amount: parseFloat(a), symbol: s }; }

async function getSideABook(){
  const ob = await aRpc("condenser_api.get_order_book", [100]);
  const conv = (o) => {
    const base = parseAmt(o.order_price.base), quote = parseAmt(o.order_price.quote);
    let qty1, qty2;
    if (base.symbol === "HBD"){ qty1 = base.amount; qty2 = quote.amount; }
    else { qty1 = quote.amount; qty2 = base.amount; }
    return { price: qty2 / qty1, qty1 };
  };
  const asks = (ob.asks || []).map(conv).filter(l => l.price > 0 && l.qty1 > 0).sort((a, b) => a.price - b.price);
  const bids = (ob.bids || []).map(conv).filter(l => l.price > 0 && l.qty1 > 0).sort((a, b) => b.price - a.price);
  return { asks, bids };
}
function walkA(levels, qty){ let rem = qty, total = 0; for (const l of levels){ const take = Math.min(rem, l.qty1); if (take <= 0) continue; total += take * l.price; rem -= take; if (rem <= 1e-6) break; } if (rem > 1e-6) return null; return total; }

// ---------------- Balances ----------------
async function sideBBalance(symbol){
  const rows = await bFind("tokens", "balances", { account: cfg.username, symbol }, 1);
  return rows.length ? parseFloat(rows[0].balance) : 0;
}
async function sideABalances(){
  const accs = await aRpc("condenser_api.get_accounts", [[cfg.username]]);
  const a = accs && accs[0];
  if (!a) throw new Error("account not found");
  return { v1: parseFloat(a.balance), v2: parseFloat(a.hbd_balance) };
}

// ---------------- Broadcast ----------------
async function broadcastSideB(json, label){
  const op = ["custom_json", { required_auths: [cfg.username], required_posting_auths: [], id: NET_ID, json: JSON.stringify(json) }];
  log(`send ${label}`, "info", JSON.stringify(json));
  if (!cfg.live) return { dryRun: true };
  const r = await client.broadcast.sendOperations([op], signKey);
  log(`sent ${label}`, "ok", `tx ${r.id}`);
  return r;
}
async function sideAFillOrKill(amountToSell, symbolToSell, minToReceive, symbolToReceive){
  const orderid = Math.floor(Date.now() / 7) % 4000000000;
  const op = ["limit_order_create", {
    owner: cfg.username, orderid,
    amount_to_sell: `${amountToSell.toFixed(3)} ${symbolToSell}`,
    min_to_receive: `${minToReceive.toFixed(3)} ${symbolToReceive}`,
    fill_or_kill: true,
    expiration: new Date(Date.now() + cfg.orderTimeoutSec * 1000).toISOString().slice(0, 19),
  }];
  log("send side A FOK order", "info", `${amountToSell.toFixed(3)} ${symbolToSell} -> min ${minToReceive.toFixed(3)} ${symbolToReceive}`);
  if (!cfg.live) return { dryRun: true };
  const r = await client.broadcast.sendOperations([op], signKey);
  log("sent side A order", "ok", `tx ${r.id}`);
  return r;
}

// ---------------- Relay (periodic balance transfer) ----------------
// Outbound (side B -> side A): confirmed from explorer data.
// Uses a "transfer" contract action with memo "<SYMBOL> <target_account>" (e.g. "HBD venapboyz").
async function relayOut(symbolB, amount){
  const q = roundDown(amount, 8);
  if (!(q > 0)) return null;
  const symbolA = symbolB.replace("SWAP.", "");
  const memo = `${symbolA} ${cfg.username}`;
  const fee = q * cfg.relayFeePct / 100;
  recordRelayFee(symbolA, fee);
  log(`relay fee est.`, "info", `${fee.toFixed(6)} ${symbolA} (${cfg.relayFeePct}% of ${q.toFixed(6)})`);
  return broadcastSideB({
    contractName: "tokens", contractAction: "transfer",
    contractPayload: { symbol: symbolB, to: cfg.relayAccount, quantity: q.toFixed(8), memo },
  }, `relay-out-${symbolB}`);
}

// Inbound (side A -> side B): memo format not directly confirmed from explorer data
// (only the credit side was visible, not the original transfer's memo). Tries an
// empty memo; off by default until manually verified with a small test transfer.
async function relayIn(symbolA, amount){
  const q = roundDown(amount, 3);
  if (!(q > 0)) return null;
  const fee = q * cfg.relayFeePct / 100;
  recordRelayFee(symbolA, fee);
  log(`relay fee est.`, "info", `${fee.toFixed(6)} ${symbolA} (${cfg.relayFeePct}% of ${q.toFixed(6)})`);
  const op = ["transfer", { from: cfg.username, to: cfg.relayAccount, amount: `${q.toFixed(3)} ${symbolA}`, memo: "" }];
  log(`send relay-in-${symbolA}`, "info", `${q.toFixed(3)} ${symbolA}`);
  if (!cfg.live) return { dryRun: true };
  const r = await client.broadcast.sendOperations([op], signKey);
  log(`sent relay-in-${symbolA}`, "ok", `tx ${r.id}`);
  return r;
}

function recordRelayFee(symbolA, fee){
  stats.relays++;
  if (symbolA === "HIVE") stats.relayFeeA1 += fee;
  else if (symbolA === "HBD") stats.relayFeeA2 += fee;
}

async function balanceCheck(){
  if (!cfg.balEnabled) return;
  try {
    const [b1, b2, a] = await Promise.all([
      sideBBalance("SWAP.HBD"), sideBBalance("SWAP.HIVE"), sideABalances(),
    ]);

    if (b1 < cfg.balTriggerB1 && a.v2 > cfg.balTriggerA2 + cfg.balMoveA2){
      if (cfg.balInEnabled){ log("balance: A2 -> B1", "info", `${cfg.balMoveA2}`); await relayIn("HBD", cfg.balMoveA2); }
      else log(`balance: B1 low (${b1.toFixed(3)}) but inbound relay disabled, skipping`, "err");
    } else if (a.v2 < cfg.balTriggerA2 && b1 > cfg.balTriggerB1 + cfg.balMoveA2){
      if (cfg.balOutEnabled){ log("balance: B1 -> A2", "info", `${cfg.balMoveA2}`); await relayOut("SWAP.HBD", cfg.balMoveA2); }
    }

    if (b2 < cfg.balTriggerB2 && a.v1 > cfg.balTriggerA1 + cfg.balMoveA1){
      if (cfg.balInEnabled){ log("balance: A1 -> B2", "info", `${cfg.balMoveA1}`); await relayIn("HIVE", cfg.balMoveA1); }
      else log(`balance: B2 low (${b2.toFixed(3)}) but inbound relay disabled, skipping`, "err");
    } else if (a.v1 < cfg.balTriggerA1 && b2 > cfg.balTriggerB2 + cfg.balMoveA1){
      if (cfg.balOutEnabled){ log("balance: B2 -> A1", "info", `${cfg.balMoveA1}`); await relayOut("SWAP.HIVE", cfg.balMoveA1); }
    }
  } catch (e){ log("balance check error", "err", e.message); }
}

// ---------------- Main cycle ----------------
let busy = false;
async function cycleOnce(){
  if (busy) return; busy = true;
  try {
    const probeQty = 5; // reference size for price measurement
    const [bBuy, bSell, a] = await Promise.all([
      bBuyBest(probeQty), bSellBest(probeQty), getSideABook(),
    ]);
    const aBuyPrice = a.asks.length ? a.asks[0].price : null;
    const aSellPrice = a.bids.length ? a.bids[0].price : null;
    const bBuyPrice = bBuy ? bBuy.cost / probeQty : null;
    const bSellPrice = bSell ? bSell.revenue / probeQty : null;

    let dir = null, gainPct = 0;
    if (bSellPrice && aBuyPrice){
      const g = (bSellPrice - aBuyPrice) / aBuyPrice * 100;
      if (g > gainPct){ gainPct = g; dir = "sellB_buyA"; }
    }
    if (aSellPrice && bBuyPrice){
      const g = (aSellPrice - bBuyPrice) / bBuyPrice * 100;
      if (g > gainPct){ gainPct = g; dir = "sellA_buyB"; }
    }
    // net of the relay cost the cycle eventually pays to stay balanced
    // (deposit leg + withdraw leg, see RELAY_LEGS)
    const netGainPct = gainPct - effectiveRelayFeePct;
    if (!dir || netGainPct < cfg.minGapPct){
      log("cycle: no gap", "info", `raw=${gainPct.toFixed(3)}% net=${netGainPct.toFixed(3)}% (relay cost ${effectiveRelayFeePct}%) bBuy=${bBuyPrice} bSell=${bSellPrice} aBuy=${aBuyPrice} aSell=${aSellPrice}`);
      return;
    }
    log(`cycle: opportunity ${dir} raw=${gainPct.toFixed(3)}% net=${netGainPct.toFixed(3)}%`, "ok");
    await process_(dir, { bBuyPrice, aBuyPrice, bSellPrice, aSellPrice, gainPct: netGainPct });
  } catch (e){
    log("cycle error", "err", e.message);
  } finally { busy = false; }
}

async function process_(dir, prices){
  const [b1, b2, a] = await Promise.all([
    sideBBalance("SWAP.HBD"), sideBBalance("SWAP.HIVE"), sideABalances(),
  ]);

  let qty;
  if (dir === "sellB_buyA"){
    const availB1 = Math.max(0, b1 - cfg.minReserveB1);
    const availA1 = Math.max(0, a.v1 - cfg.minReserveA1);
    qty = Math.min(availB1, availA1 / prices.aBuyPrice);
  } else {
    const availA2 = Math.max(0, a.v2 - cfg.minReserveA2);
    const availB2 = Math.max(0, b2 - cfg.minReserveB2);
    qty = Math.min(availA2, availB2 / prices.bBuyPrice);
  }
  if (cfg.maxUnit > 0) qty = Math.min(qty, cfg.maxUnit);
  qty = roundDown(qty, 3); // side A precision = 3
  if (!(qty > 0)){
    log("process: insufficient balance, skipping", "info", dir);
    return;
  }

  if (dir === "sellB_buyA"){
    const sell = await bSellBest(qty);
    const aAsks = (await getSideABook()).asks;
    const cost = walkA(aAsks, qty);
    if (!sell || cost === null){ log("process: could not re-quote", "err", dir); return; }
    const minRevenue = sell.revenue * (1 - cfg.tolPct / 100);
    const maxCost = cost * (1 + cfg.tolPct / 100);

    const [r1, r2] = await Promise.allSettled([
      sell.via === "pool"
        ? broadcastSideB({ contractName: "marketpools", contractAction: "swapTokens", contractPayload: { tokenPair: sell.pool.tokenPair, tokenSymbol: "SWAP.HBD", tokenAmount: qty.toFixed(8), tradeType: "exactInput", minAmountOut: minRevenue.toFixed(8) } }, "sideB-sell-pool")
        : broadcastSideB({ contractName: "market", contractAction: "sell", contractPayload: { symbol: "SWAP.HBD", quantity: qty.toFixed(8), price: (minRevenue / qty).toFixed(8) } }, "sideB-sell-book"),
      sideAFillOrKill(maxCost, "HIVE", qty, "HBD"),
    ]);
    logLegResults(r1, r2, dir, qty, prices.gainPct);
  } else {
    const buy = await bBuyBest(qty);
    const aBids = (await getSideABook()).bids;
    const revenue = walkA(aBids, qty);
    if (!buy || revenue === null){ log("process: could not re-quote", "err", dir); return; }
    const maxCost = buy.cost * (1 + cfg.tolPct / 100);
    const minRevenue = revenue * (1 - cfg.tolPct / 100);

    const [r1, r2] = await Promise.allSettled([
      buy.via === "pool"
        ? broadcastSideB({ contractName: "marketpools", contractAction: "swapTokens", contractPayload: { tokenPair: buy.pool.tokenPair, tokenSymbol: "SWAP.HBD", tokenAmount: qty.toFixed(8), tradeType: "exactOutput", maxAmountIn: maxCost.toFixed(8) } }, "sideB-buy-pool")
        : broadcastSideB({ contractName: "market", contractAction: "buy", contractPayload: { symbol: "SWAP.HBD", quantity: qty.toFixed(8), price: (maxCost / qty).toFixed(8) } }, "sideB-buy-book"),
      sideAFillOrKill(qty, "HBD", minRevenue, "HIVE"),
    ]);
    logLegResults(r1, r2, dir, qty, prices.gainPct);
  }
}

function logLegResults(r1, r2, dir, qty, gainPct){
  const ok1 = r1.status === "fulfilled", ok2 = r2.status === "fulfilled";
  if (ok1 && ok2){
    stats.trades++;
    if (qty && gainPct){ stats.grossGain += qty * gainPct / 100; } // rough estimate, HBD-equivalent units
    log(`done: ${dir}`, "ok");
    return;
  }
  // Each leg draws from its own balance, so a failed leg just shifts the inventory
  // ratio rather than locking funds. Logged anyway for visibility.
  log(`ATTENTION: one leg of ${dir} failed — inventory ratio shifted, no funds locked, but check it`, "err",
    `leg1=${ok1 ? "ok" : (r1.reason && r1.reason.message)} leg2=${ok2 ? "ok" : (r2.reason && r2.reason.message)}`);
}

async function main(){
  log(`start live=${cfg.live}`);
  if (!cfg.live) log("dry mode");
  if (cfg.balEnabled) log(`balance transfer on: out=${cfg.balOutEnabled} in=${cfg.balInEnabled}`);

  const startedAt = Date.now();
  const deadline = startedAt + cfg.maxRuntimeMin * 60 * 1000;

  if (cfg.balEnabled) await balanceCheck();
  const balTimer = setInterval(() => { balanceCheck().catch(e => log("balance tick error", "err", e.message)); }, cfg.balCheckMin * 60 * 1000);

  while (Date.now() < deadline){
    await cycleOnce().catch(e => log("cycle fatal", "err", e.message));
    await sleep(cfg.pollIntervalSec * 1000);
  }
  clearInterval(balTimer);
  log(`runtime limit (${cfg.maxRuntimeMin}m) reached, exiting`);
  log("session summary", "info",
    `trades=${stats.trades} gross~${stats.grossGain.toFixed(4)} HBD-eq | relays=${stats.relays} relayFee~${stats.relayFeeA2.toFixed(4)} HBD + ${stats.relayFeeA1.toFixed(4)} HIVE`);
  process.exit(0);
}
main().catch(e => { log("fatal: " + String((e && e.message) || e), "err"); process.exit(1); });
