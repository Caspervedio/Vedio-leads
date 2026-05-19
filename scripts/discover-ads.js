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
const META_ADS_FILE = path.join(DATA_DIR, "meta_ads.json");
const FLIPS_FILE = path.join(
  DATA_DIR,
  "discovery",
  `flips_${new Date().toISOString().slice(0, 10)}.jsonl`,
);
const LIMIT = Number(process.env.DISCOVERY_LIMIT) || 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 5;
const META_DELAY_MS = 2500; // per-context delay — keeps total throughput ~CONCURRENCY/2.5 req/s
const POST_LOAD_WAIT_MS = 4000;
const MIN_EMPLOYEES = 10;

// Curated DB07 codes — industries where active Meta-ads is a strong B2B
// signal. Skipped on purpose: holding companies (642010), shell-co
// patterns (701020), banking/finance (641900 etc), agriculture, public
// admin.  Easy to expand later.
const TARGET_INDUSTRY_CODES = [
  // Byggeri & håndværk
  "412000", "432100", "432200", "433100", "433200", "433410", "439990",
  // Auto
  "451120", "452010",
  // Engros & detail
  "461900", "464210", "465100", "466900", "467310", "467400",
  "471900", "477110", "477120", "477610", "475400",
  // Hotel & restaurant
  "551000", "551010", "551020", "551110", "551120",
  "561010", "561020", "563000", "563010",
  // Transport (ekskl. taxa)
  "494100",
  // IT, software, web
  "620100", "620200", "621000", "622000",
  // Ejendom & service
  "681000", "682030", "682040", "683110", "683210",
  // Rådgivning, jura, revision
  "691000", "692000", "702000", "702200", "702100", "701020",
  "711100", "711210",
  // Reklame, marketing, design
  "731000", "733000",
  // Udlejning & rejse
  "773200", "773300", "773400", "773900", "773990",
  "791100", "791200",
  // Rengøring & service
  "812100",
  // Sundhed & personlig service
  "862100", "869090", "869900", "960210",
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

function advertiserMatchesCompany(advertiser, company) {
  const a = normalizeCompanyName(advertiser);
  const c = normalizeCompanyName(company);
  if (!a || !c) return false;
  if (a === c) return true;
  if (c.length < 4) return false;
  const aTokens = new Set(a.split(" ").filter((t) => t.length >= 4));
  const cTokens = c.split(" ").filter((t) => t.length >= 4);
  if (cTokens.some((t) => aTokens.has(t))) return true;
  const aWord = ` ${a} `;
  const cWord = ` ${c} `;
  if (aWord.includes(cWord)) return true;
  if (c.length >= 6 && cWord.includes(aWord)) return true;
  return false;
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
  // Same pagination pattern as server.js's searchDatafordeler. Capped at
  // 3 pages × 1000 = 3000 IDs per industry — enough headroom for the
  // biggest target codes without burning quota.
  const MAX_PAGES = 3;
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
    const empNode = empByEid[eid] || {};
    const employees = empNode.antal || empNode.intervalFra || 0;
    return {
      enhedsId: eid,
      cvr: String(cvrByEid[eid] || ""),
      name: names[names.length - 1] || "",
      status: statusByEid[eid] || "",
      founded: startByEid[eid] || "",
      employees,
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
  // Filter to active + ≥MIN_EMPLOYEES + has a CVR
  const filtered = enriched.filter(
    (c) => c.status === "aktiv" && c.cvr && c.employees >= MIN_EMPLOYEES,
  );
  // Stable order — sort by CVR so runs are reproducible.
  filtered.sort((a, b) => a.cvr.localeCompare(b.cvr));
  console.log(`[discover] candidate pool: ${filtered.length} (after active + ≥${MIN_EMPLOYEES} emp)`);
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
async function main() {
  const startTime = Date.now();
  console.log(`[discover] start · limit=${LIMIT} concurrency=${CONCURRENCY}`);

  const candidates = await buildCandidatePool();
  // Trim to LIMIT for this pass. The order matters — sorted by CVR above, so
  // we get reproducible coverage. (Future: prioritise stale entries first.)
  const work = candidates.slice(0, LIMIT);
  console.log(`[discover] scraping Meta-ads for ${work.length} companies…`);

  const prev = loadJson(STATE_FILE, { companies: {} }).companies || {};
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
