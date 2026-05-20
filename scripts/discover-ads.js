#!/usr/bin/env node
/**
 * Lead Discovery — daily Meta-ads scraper.
 *
 * Runs as a Cloud Run Job (separate from the main web service so chromium
 * doesn't bloat the request-serving image).  One pass:
 *
 *   1. Walk Datafordeler for active Danish companies in target industries
 *      with at least MIN_EMPLOYEES.
 *   2. For each company, scrape facebook.com/ads/library with the brand
 *      name (legal-name minus GRUPPEN/HOLDING/A/S/ApS/etc).
 *   3. Persist per-CVR state to gs://$DISCOVERY_BUCKET/discovery/state.json
 *      and a flip-log to gs://$DISCOVERY_BUCKET/discovery/flips_<date>.jsonl
 *      (companies that started/stopped advertising since last run).
 *
 * Also touches /data/meta_ads.json (the main service's existing cache) so
 * the per-lead detail panel and any /api/ads-status caller in the main
 * service immediately reflects the fresh verdict.
 *
 * Env:
 *   DATAFORDELER_KEY    — GraphQL apiKey, same secret main service uses
 *   DISCOVERY_BUCKET    — GCS bucket name (defaults: vedio-leads-data)
 *   DATA_DIR            — local mount path for meta_ads.json (Cloud Run
 *                         mounts the same bucket at /data, so we just
 *                         write the file there alongside the main service)
 *   DISCOVERY_LIMIT     — max companies per run (default: 1000). Start small,
 *                         scale up once stable.
 *   CONCURRENCY         — parallel Playwright contexts (default: 5)
 */

const { chromium } = require("playwright");
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
// Datafordeler walk + enrich for the full 80k+ candidate pool takes ~40
// min. Caching it means the daily run is just a state.json read + scrape.
// 7 days is plenty — CVR companies don't churn at human speed.
const POOL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = Number(process.env.DISCOVERY_LIMIT) || 1000;
// Concurrency 8 keeps total Meta-request rate at ~3.2/s
// (8 contexts × 1 req per 2.5s delay). Below the threshold where Meta
// throws bot challenges; above 5 we comfortably finish 1000 scrapes
// inside the 1-hour Cloud Run Job timeout.
const CONCURRENCY = Number(process.env.CONCURRENCY) || 8;
const META_DELAY_MS = 2500; // per-context delay — keeps total throughput ~CONCURRENCY/2.5 req/s
const POST_LOAD_WAIT_MS = 4000;
// Employees filter: a confirmed ≥1 → MIN_EMPLOYEES gate; an entirely
// missing CVR_Beskaeftigelse record → included (we can't tell, and the
// scrape itself is the cheaper way to find out if they advertise).
// Companies with a *confirmed* employee count below this drop out.
// Lowered from 5 to 3 to grow tier-1 (active Danish entities likely to
// advertise) — 3+ employees still filters out lifestyle sole-props
// while catching small but real B2C/B2B shops.
const MIN_EMPLOYEES = 3;

// Curated DB07 codes — industries where active Meta-ads is a strong B2B
// signal. Skipped on purpose: holding companies (642010), shell-co
// patterns (701020), banking/finance (641900 etc), agriculture, public
// admin.  Easy to expand later.
const TARGET_INDUSTRY_CODES = [
  // Byggeri & håndværk
  "412000", "432100", "432200", "433100", "433200", "433410", "439990",
  // Auto
  "451120", "452010",
  // Engros & detail (online retail added: 478910, 478990)
  "461900", "464210", "465100", "466900", "467310", "467400",
  "471900", "477110", "477120", "477610", "475400",
  "478910", "478990",
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

// ── Meta ads scrape helpers (also duplicated from server.js) ──────────────────
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

function classifyAdsPage(text, companyName) {
  if (!text) return { verdict: null, reason: "no body text" };
  if (!/annoncebibliotek/i.test(text) && !/ad library/i.test(text)) {
    return { verdict: null, reason: "ads library chrome missing (bot challenge?)" };
  }
  if (/ingen annoncer matcher/i.test(text) || /no ads match/i.test(text)) {
    return { verdict: false, matched: 0, total: 0, advertisers: [] };
  }
  const parts = text.split(/sponsoreret|\bsponsored\b/i);
  const advertisers = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const lines = parts[i].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) advertisers.push(lines[lines.length - 1]);
  }
  const total = advertisers.length;
  if (total === 0) return { verdict: false, matched: 0, total: 0, advertisers: [] };
  const matched = advertisers.filter((a) => advertiserMatchesCompany(a, companyName)).length;
  return matched > 0
    ? { verdict: true, matched, total, advertisers }
    : { verdict: false, matched: 0, total, advertisers };
}

async function scrapePageWithContext(context, name) {
  const page = await context.newPage();
  try {
    await page.goto(buildAdsUrl(name), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(POST_LOAD_WAIT_MS);
    await page.waitForSelector('[role="main"], [role="article"]', { timeout: 5000 }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText).catch(() => null);
    return classifyAdsPage(text, name);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Datafordeler walk: build candidate pool ───────────────────────────────────
async function fetchAllEnhedsIdsForCode(code) {
  // Pagination — Datafordeler caps `first` at 1000, and the largest DB07
  // codes (412000 construction, 477110 clothing retail, …) have several
  // thousand companies. 10 pages = up to 10k IDs per code; that's enough
  // even for the broadest categories without burning quota.
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
  const [rN, rV, rB, rA] = await Promise.all([
    dfGqlFetch(`{ CVR_Navn(first: ${sz * 6}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
    dfGqlFetch(`{ CVR_Virksomhed(first: ${sz}, where: { id: { in: [${idList}] } }) { edges { node { id CVRNummer status virksomhedStartdato } } } }`),
    dfGqlFetch(`{ CVR_Beskaeftigelse(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId antal intervalFra intervalTil } } } }`),
    dfGqlFetch(`{ CVR_Adressering(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId CVRAdresse_postdistrikt CVRAdresse_postnummer } } } }`),
  ]);
  // Names: keep all in insertion order so we can take the latest below
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
      employees,        // null if no Beskaeftigelse record exists
      hasEmpData,       // distinguishes "confirmed 0" from "unknown"
      city: addrByEid[eid]?.CVRAdresse_postdistrikt || "",
      zip: addrByEid[eid]?.CVRAdresse_postnummer || "",
    };
  });
}

async function buildCandidatePool() {
  console.log(`[discover] walking ${TARGET_INDUSTRY_CODES.length} industry codes…`);
  const allByEid = new Map(); // dedupe across codes
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
  // Filter: must be active + have a CVR + either confirmed ≥MIN_EMPLOYEES
  // or no employee data at all (rather than confirmed 0).
  const filtered = enriched.filter((c) => {
    if (c.status !== "aktiv" || !c.cvr) return false;
    if (c.hasEmpData) return (c.employees || 0) >= MIN_EMPLOYEES;
    return true; // unknown — keep, the scrape will tell us
  });
  // Stable order — sort by CVR so runs are reproducible.
  filtered.sort((a, b) => a.cvr.localeCompare(b.cvr));
  const breakdown = {
    confirmedAtLeast: filtered.filter((c) => c.hasEmpData).length,
    unknown:          filtered.filter((c) => !c.hasEmpData).length,
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function loadOrBuildPool() {
  // Use cached pool if it exists and is fresher than POOL_TTL_MS.
  // FORCE_POOL_REFRESH=1 forces a full rebuild — useful for manual runs.
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

async function main() {
  const startTime = Date.now();
  console.log(`[discover] start · limit=${LIMIT} concurrency=${CONCURRENCY}`);

  const candidates = await loadOrBuildPool();
  const prev = loadJson(STATE_FILE, { companies: {} }).companies || {};
  // BECK-bug fix: Datafordeler's CVR_Beskaeftigelse returns transient
  // nulls (the same company can come back with employees=12 one day and
  // employees=null the next). When pool.json was built we got null for
  // some companies that we *already know* are confirmed-size from earlier
  // scrapes. Merge state.json's known employees back in so they land in
  // tier 1 instead of getting buried in the unknown long tail forever.
  const isConfirmedSize = (c) => {
    if (c.hasEmpData) return true;
    const knownEmp = prev[c.cvr]?.employees;
    return typeof knownEmp === "number" && knownEmp >= MIN_EMPLOYEES;
  };
  // Two-tier rotation by signal density:
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
    `[discover] scraping Meta-ads for ${work.length} companies (${tier1} confirmed-size, ${work.length - tier1} unknown-size, ${neverChecked} never-checked overall)…`,
  );

  const next = { ...prev };
  const metaAdsCache = loadJson(META_ADS_FILE, {});
  const flips = [];

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const contexts = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        locale: "da-DK",
        viewport: { width: 1280, height: 800 },
      }),
    ),
  );

  let i = 0;
  let ok = 0;
  let fail = 0;
  let withAds = 0;

  const worker = async (workerIdx) => {
    const ctx = contexts[workerIdx];
    while (true) {
      const myIdx = i++;
      if (myIdx >= work.length) break;
      const c = work[myIdx];
      const search = brandNameFromLegal(c.name);
      try {
        const r = await scrapePageWithContext(ctx, search);
        if (r.verdict !== null) {
          const previously = prev[c.cvr];
          const wasAds = previously?.ads?.verdict === true;
          const isAds = r.verdict === true;
          if (wasAds !== isAds && previously) {
            // Flip detected — log it for the daily flips file.
            flips.push({
              cvr: c.cvr,
              name: c.name,
              flip: isAds ? "started" : "stopped",
              at: new Date().toISOString(),
              prev_checked: previously.ads?.checkedAt || null,
            });
          }
          next[c.cvr] = {
            cvr: c.cvr,
            enhedsId: c.enhedsId,
            name: c.name,
            brandName: search,
            industry: c.code,
            employees: c.employees,
            city: c.city,
            zip: c.zip,
            status: c.status,
            founded: c.founded,
            ads: {
              verdict: r.verdict,
              matched: r.matched || 0,
              total: r.total || 0,
              advertisers: r.advertisers || [],
              checkedAt: new Date().toISOString(),
            },
          };
          // Also update the main service's meta_ads.json so its detail
          // panel reflects fresh data without a separate API call.
          metaAdsCache[c.cvr] = {
            name: c.name,
            searchName: search,
            verdict: r.verdict,
            matched: r.matched || 0,
            total: r.total || 0,
            advertisers: r.advertisers || [],
            checkedAt: new Date().toISOString(),
          };
          ok++;
          if (isAds) withAds++;
        } else {
          fail++;
        }
      } catch (e) {
        fail++;
        if (myIdx < 3 || myIdx % 50 === 0) {
          console.error(`  [${myIdx + 1}] ${c.cvr} (${search}) — ${e.message}`);
        }
      }
      if (myIdx > 0 && myIdx % 50 === 0) {
        console.log(`  ${myIdx + 1}/${work.length} · ok=${ok} fail=${fail} ads=${withAds}`);
        // Checkpoint mid-run in case the Job is killed.
        saveJson(STATE_FILE, { lastRunStartedAt: new Date(startTime).toISOString(), companies: next });
        saveJson(META_ADS_FILE, metaAdsCache);
      }
      await new Promise((r) => setTimeout(r, META_DELAY_MS));
    }
  };

  await Promise.all(contexts.map((_, idx) => worker(idx)));
  await browser.close().catch(() => {});

  // Final write
  saveJson(STATE_FILE, {
    lastRunStartedAt: new Date(startTime).toISOString(),
    lastRunCompletedAt: new Date().toISOString(),
    candidatePoolSize: candidates.length,
    scrapedThisRun: work.length,
    ok,
    fail,
    withAds,
    companies: next,
  });
  saveJson(META_ADS_FILE, metaAdsCache);
  for (const flip of flips) appendJsonl(FLIPS_FILE, flip);

  const minutes = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(
    `[discover] done in ${minutes} min · ok=${ok} fail=${fail} ads=${withAds} flips=${flips.length}`,
  );
}

main()
  .catch((err) => { console.error("[discover] fatal:", err); process.exit(1); })
  .finally(() => process.exit(0));
