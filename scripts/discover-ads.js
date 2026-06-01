#!/usr/bin/env node
/**
 * Lead Discovery — daily Meta-ads scraper.
 *
 * Runs as a Cloud Run Job (separate from the main web service so the
 * scrape engine doesn't bloat the request-serving image). One pass:
 *
 *   1. Walk Datafordeler for active Danish companies in target industries
 *      with at least MIN_EMPLOYEES.
 *   2. Two-phase Apify scrape of facebook.com/ads/library:
 *        a) onlyTotal:true sweep over all candidates (cheap count).
 *        b) resultsLimit:5 follow-up on positives only (verify the ad's
 *           advertiser name actually matches the company name — same
 *           guard the old Playwright classifier had).
 *   3. Persist per-CVR state to gs://$DISCOVERY_BUCKET/discovery/state.json
 *      and a flip-log to gs://$DISCOVERY_BUCKET/discovery/flips_<date>.jsonl
 *      (companies that started/stopped advertising since last run).
 *
 * Also touches /data/meta_ads.json (the main service's existing cache) so
 * the per-lead detail panel and any /api/ads-status caller in the main
 * service immediately reflects the fresh verdict.
 *
 * Why Apify instead of in-process Playwright?
 *   Meta serves empty results to GCP datacenter IPs. Residential proxy
 *   would work but at our scan volume costs $40-60/mo AND introduces
 *   per-page render fragility (captchas, layout drift). Apify's
 *   facebook-ads-scraper actor handles all of that as a service. At
 *   onlyTotal-mode pricing ($0.0058/result × ~200 candidates/day) the
 *   monthly cost lands around $45/mo with much higher reliability.
 *
 * Env:
 *   DATAFORDELER_KEY    — GraphQL apiKey, same secret main service uses
 *   APIFY_API_TOKEN     — Apify account token (Secret Manager: apify-api-token)
 *   DISCOVERY_BUCKET    — GCS bucket name (defaults: vedio-leads-data)
 *   DATA_DIR            — local mount path for meta_ads.json (Cloud Run
 *                         mounts the same bucket at /data, so we just
 *                         write the file there alongside the main service)
 *   DISCOVERY_LIMIT     — max companies per run (default: 200). Hard cap on
 *                         per-run cost: 200 × $0.0058 ≈ $1.16 floor + a small
 *                         tail on verified positives.
 */

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

// ── config ────────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATE_FILE = path.join(DATA_DIR, "discovery", "state.json");
const POOL_FILE = path.join(DATA_DIR, "discovery", "pool.json");
const META_ADS_FILE = path.join(DATA_DIR, "meta_ads.json");
const FLIPS_FILE = path.join(
  DATA_DIR,
  "discovery",
  `flips_${new Date().toISOString().slice(0, 10)}.jsonl`,
);
// Agent runtime config — loaded from /data/discovery/config.json (the main
// service writes it from the UI). Env-var fallback keeps the worker
// runnable in dev and as a safety net if the config file is missing.
function loadAgentConfig() {
  try {
    const p = path.join(DATA_DIR, "discovery", "config.json");
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      console.log(`[discover] loaded agent config from ${p}:`, cfg);
      return cfg;
    }
  } catch (e) {
    console.warn("[discover] config.json load failed, using env defaults:", e.message);
  }
  return {};
}
const AGENT_CFG = loadAgentConfig();
const POOL_TTL_MS = (AGENT_CFG.poolTtlDays || 30) * 24 * 60 * 60 * 1000;
// LIMIT is now a hard per-run cost cap. 200 candidates × $0.0058 onlyTotal ≈
// $1.16 baseline + a small tail on verified positives. Stay under $2/run.
//
// PRIORITY: env > agent config > default. The env var is what deploy-discovery.yml
// sets and is the cost-control source of truth. Reversed from the old order
// because we just had an incident where AGENT_CFG.scrapeLimit=1000 (left over
// from the Playwright era's UI-set value) overrode env DISCOVERY_LIMIT=200,
// causing a 5x cost overrun on the first Apify run + free-tier exhaustion.
const LIMIT = Number(process.env.DISCOVERY_LIMIT) || AGENT_CFG.scrapeLimit || 200;
const MIN_EMPLOYEES = AGENT_CFG.minEmployees ?? 3;
const MAX_EMPLOYEES = AGENT_CFG.maxEmployees ?? 0;

// Apify config — Cloud Run Job pulls APIFY_API_TOKEN from Secret Manager.
const APIFY_TOKEN = process.env.APIFY_API_TOKEN || "";
const APIFY_ACTOR = "apify~facebook-ads-scraper";
const APIFY_RUN_MEMORY_MB = 2048;
const APIFY_RUN_TIMEOUT_S = 3600; // hard cap per run
const APIFY_POLL_INTERVAL_MS = 5000;
const APIFY_MAX_WAIT_MS = 25 * 60 * 1000; // 25 min — well under task-timeout

// Curated DB07 codes — industries where active Meta-ads is a strong B2B
// signal. Skipped on purpose: holding companies (642010), shell-co
// patterns (701020), banking/finance (641900 etc), agriculture, public
// admin. Easy to expand later.
const TARGET_INDUSTRY_CODES = [
  // Byggeri & håndværk
  "412000", "432100", "432200", "433100", "433200", "433410", "439990",
  // Auto
  "451120", "452010",
  // Engros & detail — broadened to catch all retail subsectors that
  // commonly run e-commerce + Meta ads. Covers 47.4 (computer/electronics
  // retail), 47.5 (textile/hardware/home goods), 47.6 (books/sport/games),
  // 47.7 (specialty: cosmetics/jewelry/pets/flowers etc), plus the 47.9
  // 'not-in-store' codes for pure online retail.
  "461900", "464210", "465100", "466900", "467310", "467400",
  // 47.1 generalist
  "471900",
  // 47.4 information & communications equipment retail
  "474100", "474200", "474300",
  // 47.5 home goods retail
  "475100", "475200", "475300", "475400", "475900",
  // 47.6 cultural & recreation retail
  "476100", "476200", "476400", "476500",
  // 47.7 specialty retail (cosmetics, pharma, watches, eyewear, pets etc)
  "477110", "477120", "477300", "477400", "477500", "477610", "477620",
  "477710", "477820", "477830", "477890", "477990",
  // 47.9 not-in-store retail (mail order, internet retail, market stalls)
  "478100", "478910", "478990",
  // Hotel, restaurant & catering
  "551000", "551010", "551020", "551110", "551120",
  "561010", "561020", "563000", "563010",
  "562900",
  // Transport (ekskl. taxa)
  "494100",
  // IT, software, web (host/portal added: 631100, 631200)
  "620100", "620200", "621000", "622000",
  "631100", "631200",
  // Forlag & medier (publishing, film/video — directly relevant for Vedio's
  // ICP), music, broadcasting
  "581300", "581400",
  "591100", "591200", "592000",
  "600100", "601000",
  // Ejendom & service
  "681000", "682030", "682040", "683110", "683210",
  // Rådgivning, jura, revision, engineering, R&D
  "691000", "692000", "702000", "702200", "702100", "701020",
  "711100", "711200", "711210", "712000",
  "722000",
  // Reklame, marketing, design
  "731000", "733000",
  // Translation & other professional services
  "743000", "749000",
  // Udlejning & rejse
  "773200", "773300", "773400", "773900", "773990",
  "791100", "791200",
  // Education (other / driving schools / language)
  "855900",
  // Rengøring & service
  "812100",
  // Sundhed & personlig service (vet, beauty, fitness added)
  "752000",
  "862100", "869090", "869900", "960210", "960400",
  // Sports, fitness & entertainment
  "900400", "931100", "931200", "931300", "932100",
];

// ── Datafordeler helpers (duplicated from server.js — Cloud Run Job runs
// in its own process and we don't want to drag the whole web server in.
// If they drift, the COO project's pattern is to extract to a shared lib;
// for now the duplication is cheap and the surface area is small) ─────────────
function getDfGqlUrl() {
  const key = process.env.DATAFORDELER_KEY;
  if (!key) throw new Error("DATAFORDELER_KEY env var is required");
  return `https://graphql.datafordeler.dk/CVR/v1?apiKey=${encodeURIComponent(key)}`;
}

async function dfGqlFetch(gql) {
  const r = await fetch(getDfGqlUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Datafordeler ${r.status}: ${body.substring(0, 200)}`);
  }
  const j = await r.json();
  if (j.errors?.length) throw new Error(`GraphQL: ${j.errors[0].message}`);
  return j.data;
}

function brandNameFromLegal(legal) {
  const cleaned = String(legal || "")
    .replace(/\b(GRUPPEN|GROUP|HOLDING|HOLDINGSELSKAB|INVEST(ERING|MENT)?S?|INTERNATIONAL|DANMARK|DENMARK|SCANDINAVIA|NORDIC|EUROPE|EU)\b/gi, " ")
    .replace(/\b(A\/S|ApS|IVS|I\/S|K\/S|P\/S|S\.A\.|GmbH|Ltd|Inc|Corp|LLC)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : String(legal || "").trim();
}

// ── Meta ads helpers (kept identical to server.js logic) ──────────────────────
function normalizeCompanyName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[®©™]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(aps|a\/s|as|ivs|i\/s|ltd|inc|gmbh|sa|sarl|dk|denmark|danmark|gruppen)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strict-match: exact equality OR brand-as-whole-word substring only if
// the brand is ≥ 7 chars (avoids "beck" → "Beck Institute" false positives).
// Stay in sync with the identically-named function in server.js.
function advertiserMatchesCompany(advertiser, company) {
  const a = normalizeCompanyName(advertiser);
  const c = normalizeCompanyName(company);
  if (!a || !c) return false;
  if (a === c) return true;
  if (c.length < 7) return false;
  const aWord = ` ${a} `;
  const cWord = ` ${c} `;
  return aWord.includes(cWord);
}

function buildAdsUrl(name) {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: "DK",
    is_targeted_country: "false",
    media_type: "all",
    search_type: "keyword_exact_phrase",
    q: name,
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

// ── Apify actor wrapper ──────────────────────────────────────────────────────
// Async-start + poll. The sync endpoint caps at 5 minutes; 200 startUrls can
// take longer, so we always use the async pattern for safety.
async function apifyRun(input, label) {
  if (!APIFY_TOKEN) throw new Error("APIFY_API_TOKEN env var is required");
  console.log(`[apify] ${label}: starting actor with ${input.startUrls?.length || 0} startUrls`);

  // 1. Start run
  const startUrl = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${APIFY_TOKEN}&memory=${APIFY_RUN_MEMORY_MB}&timeout=${APIFY_RUN_TIMEOUT_S}`;
  const startResp = await fetch(startUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!startResp.ok) {
    const body = await startResp.text();
    throw new Error(`Apify start ${label} ${startResp.status}: ${body.substring(0, 400)}`);
  }
  const { data: run } = await startResp.json();
  console.log(`[apify] ${label}: run id=${run.id} status=${run.status}`);

  // 2. Poll until terminal
  const t0 = Date.now();
  let status = run.status;
  let runData = run;
  while (status === "READY" || status === "RUNNING") {
    if (Date.now() - t0 > APIFY_MAX_WAIT_MS) {
      throw new Error(`Apify ${label} timeout after ${(APIFY_MAX_WAIT_MS / 60000).toFixed(0)} min (run ${run.id})`);
    }
    await new Promise((r) => setTimeout(r, APIFY_POLL_INTERVAL_MS));
    const pollResp = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${APIFY_TOKEN}`);
    if (!pollResp.ok) {
      console.warn(`[apify] ${label}: poll ${pollResp.status} — retrying`);
      continue;
    }
    const pollJson = await pollResp.json();
    runData = pollJson.data;
    status = runData.status;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[apify] ${label}: status=${status} elapsed=${elapsed}s`);
  }

  if (status !== "SUCCEEDED") {
    throw new Error(`Apify ${label} ended with status ${status}: ${runData.statusMessage || "(no message)"}`);
  }

  // 3. Fetch dataset items
  const datasetId = runData.defaultDatasetId;
  const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&clean=false`);
  if (!itemsResp.ok) throw new Error(`Apify dataset fetch ${itemsResp.status} for ${label}`);
  const items = await itemsResp.json();
  // Charge metadata for observability — Apify exposes per-run charges on the run object.
  const charge = runData?.usage?.totalChargeUsd ?? runData?.chargedEventCounts ?? "n/a";
  console.log(`[apify] ${label}: ${items.length} dataset items · charge=${JSON.stringify(charge)}`);
  return { items, runData };
}

// ── Datafordeler walk: build candidate pool ───────────────────────────────────
async function fetchAllEnhedsIdsForCode(code) {
  const MAX_PAGES = 10;
  const ids = [];
  let cursor = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const r = await dfGqlFetch(
      `{ CVR_Branche(first: 1000${afterClause}, where: { vaerdi: { eq: "${code}" } }) { pageInfo { hasNextPage endCursor } edges { node { CVREnhedsId } } } }`,
    );
    const d = r?.CVR_Branche;
    ids.push(...(d?.edges || []).map((e) => e.node.CVREnhedsId));
    if (!d?.pageInfo?.hasNextPage) break;
    cursor = d.pageInfo.endCursor;
  }
  return ids;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function enrichBatch(ids) {
  const idList = ids.map((id) => `"${id}"`).join(",");
  const w = `CVREnhedsId: { in: [${idList}] }`;
  const sz = ids.length;
  const [rN, rV, rB, rA, rT] = await Promise.all([
    dfGqlFetch(`{ CVR_Navn(first: ${sz * 6}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
    dfGqlFetch(`{ CVR_Virksomhed(first: ${sz}, where: { id: { in: [${idList}] } }) { edges { node { id CVRNummer status virksomhedStartdato } } } }`),
    dfGqlFetch(`{ CVR_Beskaeftigelse(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId antal intervalFra intervalTil } } } }`),
    dfGqlFetch(`{ CVR_Adressering(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId CVRAdresse_postdistrikt CVRAdresse_postnummer } } } }`),
    dfGqlFetch(`{ CVR_Telefonnummer(first: ${sz * 3}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
  ]);
  const namesByEid = {};
  for (const e of rN?.CVR_Navn?.edges || []) {
    (namesByEid[e.node.CVREnhedsId] = namesByEid[e.node.CVREnhedsId] || []).push(e.node.vaerdi);
  }
  const cvrByEid = {};
  const statusByEid = {};
  const startByEid = {};
  for (const e of rV?.CVR_Virksomhed?.edges || []) {
    cvrByEid[e.node.id] = e.node.CVRNummer;
    statusByEid[e.node.id] = e.node.status;
    startByEid[e.node.id] = e.node.virksomhedStartdato;
  }
  const empByEid = {};
  for (const e of rB?.CVR_Beskaeftigelse?.edges || []) {
    empByEid[e.node.CVREnhedsId] = e.node;
  }
  const addrByEid = {};
  for (const e of rA?.CVR_Adressering?.edges || []) {
    addrByEid[e.node.CVREnhedsId] = e.node;
  }
  const phoneByEid = {};
  for (const e of rT?.CVR_Telefonnummer?.edges || []) {
    const v = String(e.node.vaerdi || "").trim();
    if (v) phoneByEid[e.node.CVREnhedsId] = v;
  }
  return ids.map((eid) => {
    const names = namesByEid[eid] || [];
    const empNode = empByEid[eid];
    const hasEmpData = !!empNode;
    const employees = empNode ? (empNode.antal || empNode.intervalFra || 0) : null;
    return {
      enhedsId: eid,
      cvr: String(cvrByEid[eid] || ""),
      name: names[names.length - 1] || "",
      status: statusByEid[eid] || "",
      founded: startByEid[eid] || "",
      employees,
      hasEmpData,
      city: addrByEid[eid]?.CVRAdresse_postdistrikt || "",
      zip: addrByEid[eid]?.CVRAdresse_postnummer || "",
      phone: phoneByEid[eid] || "",
    };
  });
}

async function buildCandidatePool() {
  console.log(`[discover] walking ${TARGET_INDUSTRY_CODES.length} industry codes…`);
  const allByEid = new Map();
  for (const code of TARGET_INDUSTRY_CODES) {
    try {
      const ids = await fetchAllEnhedsIdsForCode(code);
      for (const id of ids) if (!allByEid.has(id)) allByEid.set(id, { enhedsId: id, code });
      console.log(`  ${code}: ${ids.length} IDs (cumulative unique: ${allByEid.size})`);
    } catch (e) {
      console.error(`  ${code}: failed — ${e.message}`);
    }
  }
  const allIds = [...allByEid.keys()];
  console.log(`[discover] enriching ${allIds.length} candidates in batches of 100…`);
  const enriched = [];
  let done = 0;
  for (const batch of chunk(allIds, 100)) {
    try {
      const rows = await enrichBatch(batch);
      enriched.push(...rows);
    } catch (e) {
      console.error(`  enrich batch failed: ${e.message}`);
    }
    done += batch.length;
    if (done % 500 === 0) console.log(`  enriched ${done}/${allIds.length}`);
  }
  const filtered = enriched.filter((c) => {
    if (c.status !== "aktiv" || !c.cvr) return false;
    if (c.hasEmpData) {
      const e = c.employees || 0;
      if (e < MIN_EMPLOYEES) return false;
      if (MAX_EMPLOYEES > 0 && e > MAX_EMPLOYEES) return false;
      return true;
    }
    return true;
  });
  filtered.sort((a, b) => a.cvr.localeCompare(b.cvr));
  const breakdown = {
    confirmedAtLeast: filtered.filter((c) => c.hasEmpData).length,
    unknown: filtered.filter((c) => !c.hasEmpData).length,
  };
  console.log(`[discover] candidate pool: ${filtered.length} (confirmed ≥${MIN_EMPLOYEES}: ${breakdown.confirmedAtLeast}, unknown emp: ${breakdown.unknown})`);
  return filtered;
}

// ── State load/save ───────────────────────────────────────────────────────────
function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) { console.error("loadJson:", file, e.message); }
  return fallback;
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

async function loadOrBuildPool() {
  try {
    if (fs.existsSync(POOL_FILE) && process.env.FORCE_POOL_REFRESH !== "1") {
      const cached = JSON.parse(fs.readFileSync(POOL_FILE, "utf-8"));
      const age = Date.now() - new Date(cached.builtAt).getTime();
      if (age < POOL_TTL_MS) {
        console.log(
          `[discover] using cached pool (${cached.candidates.length} candidates, age ${Math.round(age / 3600_000)} h)`,
        );
        return cached.candidates;
      }
      console.log(`[discover] cached pool is stale (${Math.round(age / 3600_000)} h old) — rebuilding`);
    }
  } catch (e) { console.error("[discover] pool cache read failed:", e.message); }

  const candidates = await buildCandidatePool();
  saveJson(POOL_FILE, { builtAt: new Date().toISOString(), candidates });
  return candidates;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  if (AGENT_CFG.enabled === false) {
    console.log("[discover] agent disabled via config.enabled=false — exiting cleanly");
    return;
  }
  if (!APIFY_TOKEN) {
    console.error("[discover] APIFY_API_TOKEN env var is missing — refusing to run (would just fail downstream)");
    process.exit(2);
  }
  console.log(`[discover] start · provider=apify · limit=${LIMIT}`);

  const candidates = await loadOrBuildPool();
  const prevState = loadJson(STATE_FILE, { companies: {} });
  const prev = prevState.companies || {};
  const prevRuns = Array.isArray(prevState.runs) ? prevState.runs.slice(-99) : [];

  // BECK-bug fix carry-over: merge state.json's known employees back in.
  const isConfirmedSize = (c) => {
    if (c.hasEmpData) return true;
    const knownEmp = prev[c.cvr]?.employees;
    return typeof knownEmp === "number" && knownEmp >= MIN_EMPLOYEES;
  };
  // Two-tier rotation by signal density (unchanged from Playwright version):
  //  1. confirmed ≥MIN_EMPLOYEES (high prior probability of advertising)
  //  2. unknown-employee long tail (low prior — sole props, shells)
  // Inside each tier, prioritise never-checked, then oldest.
  candidates.sort((a, b) => {
    const tierA = isConfirmedSize(a) ? 0 : 1;
    const tierB = isConfirmedSize(b) ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    const ta = prev[a.cvr]?.ads?.checkedAt ? new Date(prev[a.cvr].ads.checkedAt).getTime() : 0;
    const tb = prev[b.cvr]?.ads?.checkedAt ? new Date(prev[b.cvr].ads.checkedAt).getTime() : 0;
    return ta - tb;
  });
  const work = candidates.slice(0, LIMIT);
  const neverChecked = work.filter((c) => !prev[c.cvr]?.ads?.checkedAt).length;
  const tier1 = work.filter((c) => c.hasEmpData).length;
  console.log(
    `[discover] scanning Meta-ads for ${work.length} companies (${tier1} confirmed-size, ${work.length - tier1} unknown-size, ${neverChecked} never-checked overall)…`,
  );

  const next = { ...prev };
  const metaAdsCache = loadJson(META_ADS_FILE, {});
  const flips = [];

  // Pair each candidate with the brand-name search URL we'll send to Apify.
  // We need a way to map dataset items back to the candidate — the actor
  // echoes the inputUrl on each result, so a Map keyed on URL handles it.
  const tagged = work.map((c) => {
    const brand = brandNameFromLegal(c.name);
    return { c, brand, url: buildAdsUrl(brand) };
  });
  const cvrByUrl = new Map(tagged.map((t) => [t.url, t.c.cvr]));
  const brandByCvr = new Map(tagged.map((t) => [t.c.cvr, t.brand]));

  // ── Phase 1: cheap onlyTotal sweep over all candidates ─────────────────────
  let phase1Items = [];
  try {
    const { items } = await apifyRun(
      {
        startUrls: tagged.map((t) => ({ url: t.url })),
        onlyTotal: true,
      },
      "phase1-count",
    );
    phase1Items = items;
  } catch (e) {
    console.error(`[discover] phase1 failed: ${e.message}`);
    // Without phase1 there's nothing to do — exit cleanly so the cron
    // doesn't keep state but preserves prior runs.
    saveJson(STATE_FILE, { ...prevState, lastError: e.message, lastErrorAt: new Date().toISOString() });
    process.exit(1);
  }

  // Map each cvr → totalCount (and whether we got a result at all).
  const totalByCvr = new Map();
  for (const item of phase1Items) {
    const cvr = cvrByUrl.get(item.inputUrl);
    if (!cvr) continue;
    const tc = Number(item.totalCount || 0);
    totalByCvr.set(cvr, tc);
  }
  const phase1Hits = [...totalByCvr.values()].filter((n) => n > 0).length;
  console.log(`[discover] phase1 done: ${totalByCvr.size}/${work.length} resolved · ${phase1Hits} with totalCount>0`);

  // ── Phase 2: verify positives have an advertiser-name match ────────────────
  // Even with `keyword_exact_phrase` Meta sometimes returns ads for similarly
  // named pages. The current classifier rejects "Beck Institute" when scanning
  // for "BECK"; we keep that guard. Phase 2 fetches up to 5 ads per positive
  // candidate so we can run advertiserMatchesCompany() across pageNames.
  const positives = tagged.filter((t) => (totalByCvr.get(t.c.cvr) || 0) > 0);
  let phase2Items = [];
  let phase2Succeeded = false;
  if (positives.length > 0) {
    try {
      const { items } = await apifyRun(
        {
          startUrls: positives.map((t) => ({ url: t.url })),
          onlyTotal: false,
          resultsLimit: 5,
        },
        `phase2-verify (${positives.length} candidates)`,
      );
      phase2Items = items;
      phase2Succeeded = true;
    } catch (e) {
      console.error(`[discover] phase2 failed: ${e.message} — positives will be left unverified (prior verdicts preserved)`);
    }
  } else {
    // No positives means everyone said totalCount=0; phase 2 was never needed.
    phase2Succeeded = true;
  }

  // Map cvr → list of advertiser pageNames from phase2.
  const advsByCvr = new Map();
  for (const item of phase2Items) {
    const cvr = cvrByUrl.get(item.inputUrl);
    if (!cvr) continue;
    const name = item.pageName || item.snapshot?.pageName || "";
    if (!name) continue;
    const list = advsByCvr.get(cvr) || [];
    if (!list.includes(name)) list.push(name);
    advsByCvr.set(cvr, list);
  }

  // ── Apply verdicts to state.json ────────────────────────────────────────────
  let ok = 0;
  let fail = 0;
  let withAds = 0;

  for (const { c, brand } of tagged) {
    const totalCount = totalByCvr.get(c.cvr);
    if (totalCount === undefined) {
      // Apify returned nothing for this URL — treat as inconclusive so we
      // don't wipe a previously-good record. Matches the Playwright
      // classifier's verdict=null behaviour.
      fail++;
      continue;
    }
    // BECK-bug guard: when totalCount>0 BUT phase2 didn't succeed, we have
    // no way to verify the ads actually belong to this company. Leave the
    // record untouched rather than risk flipping a verified verdict=true
    // to verdict=false based on unverified data. (This is the same lesson
    // the Playwright classifier learned the hard way back when Meta's
    // challenge pages would silently wipe ICP-klar records.)
    if (totalCount > 0 && !phase2Succeeded) {
      fail++;
      continue;
    }
    const advertisers = advsByCvr.get(c.cvr) || [];
    let matched = 0;
    if (totalCount > 0) {
      // Try matching against both the legal name AND the brand name (the
      // brand is what we searched for; advertiserMatchesCompany handles
      // company-side normalization but is exact on the brand side).
      matched = advertisers.filter(
        (a) =>
          advertiserMatchesCompany(a, c.name) ||
          advertiserMatchesCompany(a, brand),
      ).length;
    }
    const verdict = matched > 0;
    const previously = prev[c.cvr];
    const wasAds = previously?.ads?.verdict === true;
    const isAds = verdict === true;
    if (wasAds !== isAds && previously) {
      flips.push({
        cvr: c.cvr,
        name: c.name,
        flip: isAds ? "started" : "stopped",
        at: new Date().toISOString(),
        prev_checked: previously.ads?.checkedAt || null,
      });
    }
    // ICP-fit gate — same rules as before; matched count still drives it.
    const ICP_MIN_MATCHED_ADS = AGENT_CFG.icpMinAds ?? 3;
    const ICP_MIN_EMPLOYEES_KNOWN = AGENT_CFG.icpMinEmployees ?? 5;
    const icpFit =
      verdict === true &&
      matched >= ICP_MIN_MATCHED_ADS &&
      !!c.cvr &&
      c.status === "aktiv" &&
      (c.employees == null || c.employees >= ICP_MIN_EMPLOYEES_KNOWN);

    next[c.cvr] = {
      cvr: c.cvr,
      enhedsId: c.enhedsId,
      name: c.name,
      brandName: brand,
      industry: c.code,
      employees: c.employees,
      city: c.city,
      zip: c.zip,
      phone: c.phone || previously?.phone || "",
      status: c.status,
      founded: c.founded,
      ads: {
        verdict,
        matched,
        total: totalCount,
        advertisers,
        checkedAt: new Date().toISOString(),
        // Source tag — useful when diffing pre/post-Apify state to
        // confirm the rewrite landed end-to-end.
        source: "apify",
      },
      icpFit,
      pushed_to_cloudtalk_at: previously?.pushed_to_cloudtalk_at || null,
      twenty_opportunity_id: previously?.twenty_opportunity_id || null,
    };
    metaAdsCache[c.cvr] = {
      name: c.name,
      searchName: brand,
      verdict,
      matched,
      total: totalCount,
      advertisers,
      checkedAt: new Date().toISOString(),
    };
    ok++;
    if (isAds) withAds++;
  }

  // ── Persist + summarise ─────────────────────────────────────────────────────
  const thisRun = {
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
    scrapedThisRun: work.length,
    ok,
    fail,
    withAds,
    hitratePct: ok > 0 ? Math.round((withAds / ok) * 10000) / 100 : 0,
    tier1Scanned: work.filter((c) => c.hasEmpData).length,
    flips: flips.length,
    provider: "apify",
    phase1Resolved: totalByCvr.size,
    phase1Positives: phase1Hits,
    phase2Verified: phase2Items.length,
  };
  const runs = [...prevRuns, thisRun];
  const window = runs.slice(-10);
  const winOk = window.reduce((s, r) => s + (r.ok || 0), 0);
  const winAds = window.reduce((s, r) => s + (r.withAds || 0), 0);
  const winHitrate = winOk > 0 ? Math.round((winAds / winOk) * 10000) / 100 : 0;
  saveJson(STATE_FILE, {
    lastRunStartedAt: thisRun.startedAt,
    lastRunCompletedAt: thisRun.completedAt,
    candidatePoolSize: candidates.length,
    scrapedThisRun: work.length,
    ok,
    fail,
    withAds,
    hitratePct: thisRun.hitratePct,
    rollingHitrate10: winHitrate,
    runs,
    companies: next,
  });
  saveJson(META_ADS_FILE, metaAdsCache);
  for (const flip of flips) appendJsonl(FLIPS_FILE, flip);

  const minutes = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(
    `[discover] done in ${minutes} min · ok=${ok} fail=${fail} ads=${withAds} flips=${flips.length} · hitrate=${thisRun.hitratePct}% (10-run rolling: ${winHitrate}%)`,
  );
  if (window.length >= 5 && winHitrate < 2.0) {
    console.log(
      `[discover] ⚠ rolling hitrate ${winHitrate}% below 2.0% threshold over last ${window.length} runs — consider broadening tier-1 industries`,
    );
  }
}

main()
  .catch((err) => { console.error("[discover] fatal:", err); process.exit(1); })
  .finally(() => process.exit(0));
