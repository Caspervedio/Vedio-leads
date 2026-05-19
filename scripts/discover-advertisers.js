#!/usr/bin/env node
/**
 * Meta-first lead discovery.
 *
 * Walks facebook.com/ads/library with country=DK + active_status=active
 * (no keyword filter) and dedupes by advertiser page ID. For each unique
 * advertiser we then try an exact-name lookup in Datafordeler to enrich
 * with CVR / industry / employees / address — but advertisers that don't
 * match a Danish CVR are kept anyway, flagged as `cvrMatch: null` (foreign
 * brands targeting DK, individuals, non-corporate entities).
 *
 * Why this replaces the old discover-ads.js:
 * - 100% hit rate (every entry is, by definition, currently advertising)
 * - No name-matching false positives (we have the actual page ID)
 * - Smaller dataset to scan (~10–30k DK active advertisers vs 85k CVRs)
 * - Works in one pass (~10–30 min) instead of weeks of rotation
 *
 * Env:
 *   DATAFORDELER_KEY   — same secret main service uses
 *   DATA_DIR           — GCS-mounted dir for state (default /data)
 *   SCROLL_PASSES      — number of scroll cycles (default 200 ≈ 6k cards)
 *   SCROLL_INTERVAL_MS — pause between scrolls (default 2500)
 *   POST_LOAD_WAIT_MS  — initial wait after navigation (default 6000)
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const DATA_DIR = process.env.DATA_DIR || "/data";
const ADVERTISERS_FILE = path.join(DATA_DIR, "discovery", "advertisers.json");
const DEBUG_SAMPLE_FILE = path.join(DATA_DIR, "discovery", "debug_last_sample.json");

const SCROLL_PASSES = Number(process.env.SCROLL_PASSES) || 200;
const SCROLL_INTERVAL_MS = Number(process.env.SCROLL_INTERVAL_MS) || 2500;
const POST_LOAD_WAIT_MS = Number(process.env.POST_LOAD_WAIT_MS) || 6000;
const ENRICH_CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY) || 5;

// Walk the DK active commercial ads listing. is_targeted_country=false so
// foreign-brand ads served to DK are also surfaced — caller can choose to
// filter by `cvrMatch !== null` if they want strictly Danish entities.
const META_URL =
  "https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=DK&is_targeted_country=false&media_type=all";

// ── Datafordeler — same helpers as the legacy CVR-walk worker. Kept
//    duplicated rather than imported to keep this script self-contained
//    inside the Cloud Run Job image. ─────────────────────────────────────────
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

// Best-effort exact-name lookup. Datafordeler only supports `eq` on
// strings, so we try a few normalised variants and take the first hit.
async function cvrLookupByName(advertiserName) {
  const variants = [
    advertiserName,
    advertiserName.toUpperCase(),
    advertiserName + " A/S",
    advertiserName + " ApS",
    advertiserName + " A/S".toUpperCase(),
    advertiserName.replace(/\.dk$/i, ""),
  ];
  for (const v of variants) {
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

// ── Meta walk ───────────────────────────────────────────────────────────────
// We extract everything we can from the rendered DOM. The Ad Library uses
// obfuscated class names so we anchor on stable patterns: links that
// reference `view_all_page_id=`, the "Library ID:" prefix, and the
// "Sponsoreret" / "Sponsored" labels for advertiser-name extraction.
//
// First run also writes a debug_last_sample.json so we can see exactly
// what the DOM looked like if our selectors miss everything.
async function walkAdLibrary() {
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

  console.log(`[discover-advertisers] navigating to Ads Library…`);
  await page.goto(META_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(POST_LOAD_WAIT_MS);

  // Sanity check — is the Ads Library actually loaded (didn't hit a login
  // wall / bot challenge)?
  const initialText = await page.evaluate(() => document.body.innerText.slice(0, 600));
  const okLoaded = /annoncebibliotek|ad library/i.test(initialText);
  if (!okLoaded) {
    console.error(`[discover-advertisers] ⚠ ads library not detected on initial load — saving sample for inspection`);
    fs.mkdirSync(path.dirname(DEBUG_SAMPLE_FILE), { recursive: true });
    fs.writeFileSync(DEBUG_SAMPLE_FILE, JSON.stringify({ url: META_URL, initialText }, null, 2));
    await browser.close();
    throw new Error("Ads Library page did not load — body text doesn't mention 'Annoncebibliotek' / 'Ad Library'");
  }
  console.log(`[discover-advertisers] page loaded — beginning ${SCROLL_PASSES} scroll passes…`);

  // Map keyed by pageId (when we have it) or by normalised name (fallback).
  const advertisers = new Map();

  for (let i = 0; i < SCROLL_PASSES; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(SCROLL_INTERVAL_MS);

    const harvested = await page.evaluate(() => {
      // Anchor 1: links that go straight to per-page ad views. These carry
      // the page ID in a query param.
      const pageLinks = Array.from(document.querySelectorAll('a[href*="view_all_page_id="]')).map((a) => ({
        href: a.href,
        text: (a.innerText || "").trim().slice(0, 120),
      }));
      // Anchor 2: visible "Library ID:" markers tell us how many cards
      // are on the page (useful for diagnostics).
      const libraryIdCount = (document.body.innerText.match(/Library ID|Bibliotek-ID/gi) || []).length;
      return { pageLinks, libraryIdCount };
    });

    for (const link of harvested.pageLinks) {
      const m = link.href.match(/view_all_page_id=(\d+)/);
      if (!m) continue;
      const pageId = m[1];
      if (advertisers.has(pageId)) continue;
      advertisers.set(pageId, {
        pageId,
        name: link.text || null,
        href: link.href,
        firstSeenPass: i,
      });
    }

    if (i % 20 === 0 || i === SCROLL_PASSES - 1) {
      console.log(`  pass ${i + 1}/${SCROLL_PASSES} · cards-on-page=${harvested.libraryIdCount} · unique advertisers so far=${advertisers.size}`);
    }
  }

  // Save a debug sample of the final DOM state so we can iterate selectors
  // without re-running the whole scrape.
  const debugSample = await page.evaluate(() => ({
    bodyTextHead: document.body.innerText.slice(0, 2000),
    pageLinks: Array.from(document.querySelectorAll('a[href*="view_all_page_id="]')).slice(0, 5).map((a) => a.outerHTML.slice(0, 400)),
  }));
  fs.mkdirSync(path.dirname(DEBUG_SAMPLE_FILE), { recursive: true });
  fs.writeFileSync(DEBUG_SAMPLE_FILE, JSON.stringify(debugSample, null, 2));

  await browser.close();
  return [...advertisers.values()];
}

// ── Enrichment ──────────────────────────────────────────────────────────────
async function enrichAdvertisers(list) {
  console.log(`[discover-advertisers] enriching ${list.length} advertisers via Datafordeler…`);
  const enriched = [];
  let done = 0;
  // Sequential with throttle is fine here — Datafordeler isn't the bottleneck
  // and we're not trying to win latency wars.
  for (let i = 0; i < list.length; i += ENRICH_CONCURRENCY) {
    const batch = list.slice(i, i + ENRICH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (a) => {
      if (!a.name) return { ...a, cvrMatch: null };
      try {
        const hit = await cvrLookupByName(a.name);
        if (!hit) return { ...a, cvrMatch: null };
        const cvr = await enrichByEnhedsId(hit.enhedsId);
        return {
          ...a,
          cvrMatch: { enhedsId: hit.enhedsId, matchedName: hit.matchedName, matchedVariant: hit.matchedVariant },
          ...cvr,
        };
      } catch (e) {
        return { ...a, cvrMatch: null, enrichError: e.message };
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
  console.log(`[discover-advertisers] start · scrolls=${SCROLL_PASSES} · interval=${SCROLL_INTERVAL_MS}ms`);

  const advertisers = await walkAdLibrary();
  console.log(`[discover-advertisers] walked Meta — ${advertisers.length} unique advertisers in ${((Date.now() - startTime) / 60000).toFixed(1)} min`);

  if (advertisers.length === 0) {
    console.error("[discover-advertisers] ⚠ no advertisers harvested — check debug_last_sample.json");
    process.exit(2);
  }

  const enriched = await enrichAdvertisers(advertisers);

  fs.mkdirSync(path.dirname(ADVERTISERS_FILE), { recursive: true });
  fs.writeFileSync(ADVERTISERS_FILE, JSON.stringify({
    walkedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
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
