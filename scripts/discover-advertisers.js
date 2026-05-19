#!/usr/bin/env node
/**
 * Meta-first lead discovery.
 *
 * Meta's Ad Library UI refuses to render results without a search seed
 * ("Søg efter nøgleord eller en annoncør"). So we sweep through a list of
 * short Danish-language seed terms (single letters by default), let the
 * results render, and harvest the unique advertiser names visible across
 * all of them.
 *
 * Advertiser extraction follows the recipe from the COO project's
 * check-ads-status.ts: parse `document.body.innerText`, split by the
 * "Sponsoreret" / "Sponsored" labels, and take the last non-empty line
 * before each split as the advertiser page name. That dodges Meta's
 * obfuscated class names which would otherwise break the scraper every
 * 6 months.
 *
 * Each discovered advertiser is then exact-name-matched against
 * Datafordeler for CVR / industry / employees enrichment. Foreign brands
 * targeting DK (or non-corporate entities) stay in the dataset flagged
 * as `cvrMatch: null` — caller can filter them out if they want strictly
 * Danish CVRs.
 *
 * Env:
 *   DATAFORDELER_KEY    — Datafordeler GraphQL key
 *   DATA_DIR            — GCS mount path (default /data)
 *   SEEDS               — comma-separated seed terms (default: a..z + æ ø å)
 *   SCROLLS_PER_SEED    — scroll passes per seed (default 12)
 *   SCROLL_INTERVAL_MS  — pause between scrolls (default 2500)
 *   POST_LOAD_WAIT_MS   — initial wait after navigation (default 6000)
 *   ENRICH_CONCURRENCY  — parallel CVR lookups (default 5)
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

// ── config ─────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || "/data";
const ADVERTISERS_FILE = path.join(DATA_DIR, "discovery", "advertisers.json");
const DEBUG_SAMPLE_FILE = path.join(DATA_DIR, "discovery", "debug_last_sample.json");

const DEFAULT_SEEDS = "a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,æ,ø,å";
const SEEDS = (process.env.SEEDS || DEFAULT_SEEDS).split(",").map((s) => s.trim()).filter(Boolean);
const SCROLLS_PER_SEED = Number(process.env.SCROLLS_PER_SEED) || 12;
const SCROLL_INTERVAL_MS = Number(process.env.SCROLL_INTERVAL_MS) || 2500;
const POST_LOAD_WAIT_MS = Number(process.env.POST_LOAD_WAIT_MS) || 6000;
const SEED_GAP_MS = Number(process.env.SEED_GAP_MS) || 3000;
const ENRICH_CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY) || 5;

function seedUrl(q) {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: "DK",
    is_targeted_country: "false",
    media_type: "all",
    search_type: "keyword_unordered",
    q,
  });
  return `https://www.facebook.com/ads/library/?${params}`;
}

// Per-advertiser deep-link (used by the UI later).
function advertiserDeepLink(name) {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: "DK",
    is_targeted_country: "true",
    media_type: "all",
    search_type: "page",
    q: name,
  });
  return `https://www.facebook.com/ads/library/?${params}`;
}

// ── Datafordeler ────────────────────────────────────────────────────────────
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
  if (!r.ok) throw new Error(`Datafordeler ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(`GraphQL: ${j.errors[0].message}`);
  return j.data;
}

async function cvrLookupByName(advertiserName) {
  // Datafordeler only supports `eq` on strings. Try a handful of normalised
  // variants — the advertiser's FB-page name is often the brand without a
  // legal suffix, so we add the common ones back when probing.
  const trimmed = advertiserName.trim();
  const variants = [
    trimmed,
    trimmed.toUpperCase(),
    `${trimmed} A/S`,
    `${trimmed} ApS`,
    `${trimmed.toUpperCase()} A/S`,
    `${trimmed.toUpperCase()} APS`,
    trimmed.replace(/\.dk$/i, ""),
    trimmed.replace(/\.dk$/i, "") + " A/S",
    trimmed.replace(/\.dk$/i, "") + " ApS",
  ];
  for (const v of variants) {
    if (!v) continue;
    try {
      const r = await dfGqlFetch(
        `{ CVR_Navn(first: 5, where: { vaerdi: { eq: "${v.replace(/"/g, '\\"')}" } }) { edges { node { CVREnhedsId vaerdi } } } }`,
      );
      const hit = r?.CVR_Navn?.edges?.[0]?.node;
      if (hit) return { enhedsId: hit.CVREnhedsId, matchedName: hit.vaerdi, matchedVariant: v };
    } catch (e) { /* try next */ }
  }
  return null;
}

async function enrichByEnhedsId(enhedsId) {
  const w = `CVREnhedsId: { eq: "${enhedsId}" }`;
  const [rV, rB, rE, rA] = await Promise.all([
    dfGqlFetch(`{ CVR_Virksomhed(first: 1, where: { id: { eq: "${enhedsId}" } }) { edges { node { CVRNummer status virksomhedStartdato } } } }`),
    dfGqlFetch(`{ CVR_Branche(first: 1, where: { ${w} }) { edges { node { vaerdi vaerdiTekst } } } }`),
    dfGqlFetch(`{ CVR_Beskaeftigelse(first: 1, where: { ${w} }) { edges { node { antal intervalFra intervalTil } } } }`),
    dfGqlFetch(`{ CVR_Adressering(first: 1, where: { ${w} }) { edges { node { CVRAdresse_postdistrikt CVRAdresse_postnummer } } } }`),
  ]);
  const v = rV?.CVR_Virksomhed?.edges?.[0]?.node;
  const b = rB?.CVR_Branche?.edges?.[0]?.node;
  const e = rE?.CVR_Beskaeftigelse?.edges?.[0]?.node;
  const a = rA?.CVR_Adressering?.edges?.[0]?.node;
  return {
    cvr: v?.CVRNummer ? String(v.CVRNummer) : null,
    status: v?.status || null,
    founded: v?.virksomhedStartdato || null,
    industry: b?.vaerdi || null,
    industryName: b?.vaerdiTekst || null,
    employees: e?.antal || e?.intervalFra || null,
    city: a?.CVRAdresse_postdistrikt || null,
    zip: a?.CVRAdresse_postnummer || null,
  };
}

// ── Advertiser extraction ───────────────────────────────────────────────────
// Same recipe as the COO project: split body innerText by the "Sponsoreret"
// markers (or "Sponsored" in English locales — we set Danish but keep both
// for robustness), and take the last non-empty line in each chunk as the
// advertiser page name. Filters out junk lines that are clearly not names.
function extractAdvertisersFromText(text) {
  if (!text || (!/annoncebibliotek/i.test(text) && !/ad library/i.test(text))) {
    return null; // page didn't render — caller should treat as bot challenge
  }
  const parts = text.split(/\bsponsoreret\b|\bsponsored\b/i);
  if (parts.length < 2) return [];
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const lines = parts[i].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const candidate = lines[lines.length - 1];
    // Reject UI chrome / boilerplate that often shows up at the very top of
    // the page before the first card.
    if (looksLikeChrome(candidate)) continue;
    out.push(candidate);
  }
  return out;
}

function looksLikeChrome(s) {
  if (!s) return true;
  if (s.length < 2 || s.length > 100) return true;
  // Common Meta chrome strings. Add more here as we see them.
  if (/^(metas|annoncebibliotek|rapport|api|brandet|log på|systemstatus|abonner|ofte|om annoncer|privatindstillinger|vilkår|cookies|søg|angiv|danmark|annoncekategori|udforsk|download|tilpas|brug|gå til|hvem|folk|alle|filter|udfyld|sortér)/i.test(s)) return true;
  // Pure separator
  if (/^[\s—–·•|]+$/.test(s)) return true;
  return false;
}

// ── Meta walk: one seed at a time, scroll, harvest ──────────────────────────
async function walkSeed(page, seed, advertisers) {
  await page.goto(seedUrl(seed), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(POST_LOAD_WAIT_MS);

  let lastTextLen = 0;
  let stuckCount = 0;
  const beforeCount = advertisers.size;
  let didDebugDump = false;

  for (let i = 0; i < SCROLLS_PER_SEED; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(SCROLL_INTERVAL_MS);

    const visibleText = await page.evaluate(() => document.body.innerText).catch(() => null);
    const harvested = extractAdvertisersFromText(visibleText);
    if (harvested == null) {
      console.warn(`  [seed=${seed}] page didn't render the Ad Library — bot challenge?`);
      if (!didDebugDump) {
        try {
          fs.mkdirSync(path.dirname(DEBUG_SAMPLE_FILE), { recursive: true });
          fs.writeFileSync(DEBUG_SAMPLE_FILE, JSON.stringify({ seed, sample: (visibleText || "").slice(0, 1500) }, null, 2));
          didDebugDump = true;
        } catch (_) {}
      }
      break;
    }
    for (const name of harvested) {
      const key = name.toLowerCase();
      if (!advertisers.has(key)) advertisers.set(key, { name, firstSeenSeed: seed, firstSeenPass: i });
    }
    // Detect "no more results" by tracking body text length plateau.
    const curLen = (visibleText || "").length;
    if (curLen === lastTextLen) {
      stuckCount++;
      if (stuckCount >= 3) break; // 3 plateaus in a row → done with this seed
    } else {
      stuckCount = 0;
      lastTextLen = curLen;
    }
  }
  const gained = advertisers.size - beforeCount;
  console.log(`  seed='${seed}' · +${gained} unique advertisers (total now ${advertisers.size})`);
}

async function walkMeta() {
  console.log(`[discover-advertisers] launching chromium…`);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "da-DK",
    viewport: { width: 1280, height: 1000 },
  });
  const page = await ctx.newPage();

  const advertisers = new Map(); // normalised name → {name, firstSeenSeed, firstSeenPass}
  for (let i = 0; i < SEEDS.length; i++) {
    const seed = SEEDS[i];
    console.log(`[discover-advertisers] seed ${i + 1}/${SEEDS.length}: '${seed}'`);
    try {
      await walkSeed(page, seed, advertisers);
    } catch (e) {
      console.error(`  seed='${seed}' failed: ${e.message}`);
    }
    if (i < SEEDS.length - 1) await page.waitForTimeout(SEED_GAP_MS);
  }
  await browser.close();
  return [...advertisers.values()];
}

// ── Enrichment ──────────────────────────────────────────────────────────────
async function enrichAdvertisers(list) {
  console.log(`[discover-advertisers] enriching ${list.length} advertisers via Datafordeler…`);
  const enriched = [];
  let done = 0;
  for (let i = 0; i < list.length; i += ENRICH_CONCURRENCY) {
    const batch = list.slice(i, i + ENRICH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (a) => {
      const base = { ...a, deepLink: advertiserDeepLink(a.name) };
      if (!a.name) return { ...base, cvrMatch: null };
      try {
        const hit = await cvrLookupByName(a.name);
        if (!hit) return { ...base, cvrMatch: null };
        const cvr = await enrichByEnhedsId(hit.enhedsId);
        return {
          ...base,
          cvrMatch: { enhedsId: hit.enhedsId, matchedName: hit.matchedName, matchedVariant: hit.matchedVariant },
          ...cvr,
        };
      } catch (e) {
        return { ...base, cvrMatch: null, enrichError: e.message };
      }
    }));
    enriched.push(...results);
    done += batch.length;
    if (done % 100 === 0) console.log(`  enriched ${done}/${list.length}`);
  }
  const matched = enriched.filter((a) => a.cvrMatch).length;
  console.log(`[discover-advertisers] ${matched} of ${enriched.length} matched a Danish CVR`);
  return enriched;
}

async function main() {
  const startTime = Date.now();
  console.log(`[discover-advertisers] start · seeds=${SEEDS.length} · scrolls/seed=${SCROLLS_PER_SEED}`);

  const advertisers = await walkMeta();
  const walkMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`[discover-advertisers] walked Meta — ${advertisers.length} unique advertisers in ${walkMin} min`);

  if (advertisers.length === 0) {
    console.error("[discover-advertisers] ⚠ no advertisers harvested — check debug_last_sample.json");
    process.exit(2);
  }

  const enriched = await enrichAdvertisers(advertisers);

  fs.mkdirSync(path.dirname(ADVERTISERS_FILE), { recursive: true });
  fs.writeFileSync(ADVERTISERS_FILE, JSON.stringify({
    walkedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
    seedsUsed: SEEDS,
    totalUnique: enriched.length,
    cvrMatched: enriched.filter((a) => a.cvrMatch).length,
    advertisers: enriched,
  }, null, 2));

  console.log(`[discover-advertisers] done in ${((Date.now() - startTime) / 60000).toFixed(1)} min`);
}

main().catch((err) => {
  console.error("[discover-advertisers] fatal:", err);
  process.exit(1);
});
