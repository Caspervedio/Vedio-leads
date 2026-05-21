require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DATA_FILE = path.join(DATA_DIR, "data.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Shared helpers ─────────────────────────────────────────────────────────────
function loadJsonFile(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) { console.error("loadJsonFile failed:", filePath, e.message); }
  return defaultValue;
}

async function callAnthropic(apiKey, prompt, maxTokens = 600) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  const data = await r.json();
  const text = data.content?.[0]?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
}

// ── Persistent data ───────────────────────────────────────────────────────────
function loadData() {
  return loadJsonFile(DATA_FILE, {
    leads: [],
    lists: [{ id: "all", name: "Alle leads" }],
    icpScores: {},
    pipeline: {},
    notes: {},
    tags: {},
    followup: {},
  });
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

function ensurePipelines(d) {
  if (!d.pipelines)     d.pipelines = { sdr: {}, ae: {} };
  if (!d.pipelines.sdr) d.pipelines.sdr = {};
  if (!d.pipelines.ae)  d.pipelines.ae  = {};
}

// ── User auth ─────────────────────────────────────────────────────────────────
const sessions = new Map(); // token -> userId

function loadUsers() {
  return loadJsonFile(USERS_FILE, []);
}

function getUserDataFile(userId) {
  return path.join(DATA_DIR, `data_${userId}.json`);
}

function loadUserData(userId) {
  const file = getUserDataFile(userId);
  const d = loadJsonFile(file, null);
  if (d) {
    // Migrate old flat pipeline to dual pipelines if needed
    if (!d.pipelines && d.pipeline) {
      const SDR_STAGES = new Set(['Ny','Kontaktet','Kvalificeret']);
      d.pipelines = { sdr: {}, ae: {} };
      Object.entries(d.pipeline).forEach(([cvr, stage]) => {
        if (SDR_STAGES.has(stage)) d.pipelines.sdr[cvr] = stage;
        else d.pipelines.ae[cvr] = stage;
      });
    }
    ensurePipelines(d);
    return d;
  }
  return {
    leads: [],
    lists: [{ id: "all", name: "Alle leads" }],
    icpScores: {},
    pipeline: {},
    pipelines: { sdr: {}, ae: {} },
    notes: {},
    tags: {},
    followup: {},
    contacts: {},
    deal: {},
    history: {},
    customers: [],
    discovery_patterns: [],
    discovery_runs: [],
    discovery_results: [],
  };
}

function saveUserData(userId, d) {
  fs.writeFileSync(getUserDataFile(userId), JSON.stringify(d, null, 2));
}

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Ikke logget ind" });
  req.userId = sessions.get(token);
  next();
}

// ── In-memory cache ──────────────────────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutter

// ── Datafordeler API-nøgle (query parameter) ──────────────────────────────────
function getDfGqlUrl() {
  const key = process.env.DATAFORDELER_KEY;
  if (!key) throw new Error("DATAFORDELER_KEY mangler i .env");
  console.log(`[df] Key length: ${key.length}, first 10: ${key.substring(0,10)}`);
  return `https://graphql.datafordeler.dk/CVR/v1?apiKey=${encodeURIComponent(key)}`;
}

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return hit.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

// ── CVR via Datafordeler GraphQL ──────────────────────────────────────────────

async function dfGqlFetch(gql) {
  const gqlUrl = getDfGqlUrl();
  const res = await fetch(gqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) { console.error('[df 401 full body]', body); throw new Error(`Datafordeler 401: ${body.substring(0, 500)}`); }
    throw new Error(`Datafordeler GraphQL svarede ${res.status}: ${body.substring(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL fejl: ${json.errors[0]?.message}`);
  return json.data;
}

async function lookupDatafordeler(cvr) {
  const cacheKey = `df-gql:lookup:${cvr}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Trin 1: Hent CVREnhedsId fra CVR-nummer
  const step1 = await dfGqlFetch(`{
    CVR_Virksomhed(first: 1, where: { CVRNummer: { eq: ${Number(cvr)} } }) {
      edges { node { id CVRNummer status virksomhedStartdato virksomhedOphoersdato } }
    }
  }`);
  const virk = step1?.CVR_Virksomhed?.edges?.[0]?.node;
  if (!virk) throw new Error(`CVR ${cvr} ikke fundet i Datafordeler`);
  const eid = virk.id;

  // Trin 2: Hent relaterede entiteter parallelt
  // CVR_Navn returns historical names (e.g. CVR 55930317 has 3 entries spanning
  // 1976→today: SANDER HANSESNS → SANDER HANSENS → BYGMA GRUPPEN A/S). The
  // result is ordered chronologically so we fetch up to 50 and pick the last
  // edge as the current legal name. The other entities are single-valued in
  // practice but kept at first:1 to stay cheap.
  const w = `CVREnhedsId: { eq: "${eid}" }`;
  const [dNavn, dAdr, dTlf, dEmail, dBranche, dForm, dBesk] = await Promise.all([
    dfGqlFetch(`{ CVR_Navn(first: 50, where: { ${w} }) { edges { node { vaerdi } } } }`),
    dfGqlFetch(`{ CVR_Adressering(first: 1, where: { ${w} }) { edges { node { CVRAdresse_vejnavn CVRAdresse_husnummerFra CVRAdresse_postnummer CVRAdresse_postdistrikt } } } }`),
    dfGqlFetch(`{ CVR_Telefonnummer(first: 1, where: { ${w} }) { edges { node { vaerdi } } } }`),
    dfGqlFetch(`{ CVR_e_mailadresse(first: 1, where: { ${w} }) { edges { node { vaerdi } } } }`),
    dfGqlFetch(`{ CVR_Branche(first: 1, where: { ${w} }) { edges { node { vaerdi vaerdiTekst } } } }`),
    dfGqlFetch(`{ CVR_Virksomhedsform(first: 1, where: { ${w} }) { edges { node { vaerdi vaerdiTekst } } } }`),
    dfGqlFetch(`{ CVR_Beskaeftigelse(first: 1, where: { ${w} }) { edges { node { antal intervalFra intervalTil } } } }`),
  ]);

  const step2 = {
    navn:    dNavn?.CVR_Navn,
    adr:     dAdr?.CVR_Adressering,
    tlf:     dTlf?.CVR_Telefonnummer,
    email:   dEmail?.CVR_e_mailadresse,
    branche: dBranche?.CVR_Branche,
    form:    dForm?.CVR_Virksomhedsform,
    besk:    dBesk?.CVR_Beskaeftigelse,
  };

  const company = normalizeDatafordeler(virk, step2);
  cacheSet(cacheKey, company);
  return company;
}

function normalizeDatafordeler(virk, d) {
  if (!virk) return null;
  const adr   = d?.adr?.edges?.[0]?.node    || {};
  const br    = d?.branche?.edges?.[0]?.node || {};
  const form  = d?.form?.edges?.[0]?.node   || {};
  const besk  = d?.besk?.edges?.[0]?.node   || {};
  const empStr = (besk.intervalFra != null && besk.intervalTil != null)
    ? `${besk.intervalFra}-${besk.intervalTil}`
    : (besk.antal ? String(besk.antal) : "");
  return {
    cvr:         String(virk.CVRNummer || ""),
    // Use the LAST edge of CVR_Navn — historical names are returned in
    // chronological order (oldest → current).
    name:        d?.navn?.edges?.length ? d.navn.edges[d.navn.edges.length - 1].node.vaerdi || "" : "",
    address:     [adr.CVRAdresse_vejnavn, adr.CVRAdresse_husnummerFra].filter(Boolean).join(" "),
    zip:         String(adr.CVRAdresse_postnummer || ""),
    city:        adr.CVRAdresse_postdistrikt || "",
    phone:       d?.tlf?.edges?.[0]?.node?.vaerdi || "",
    email:       d?.email?.edges?.[0]?.node?.vaerdi || "",
    web:         "",
    industry:    br.vaerdiTekst || "",
    industryCode: String(br.vaerdi || "").substring(0, 2),
    employees:   empStr,
    employeeCount: besk.antal || 0,
    status:      virk.virksomhedOphoersdato ? "inactive" : "active",
    founded:     virk.virksomhedStartdato?.substring(0, 4) || "",
    form:        form.vaerdiTekst || form.vaerdi || "",
    adProtected: false,
    owners:      [],
    revenue: 0, grossProfit: 0, equity: 0, result: 0,
    ig: "", fb: "", tt: "", li: "",
    tech: [],
  };
}

// ── Local company cache (persisted to disk, rebuilt weekly) ──────────────────
const CACHE_DIR = path.join(__dirname, '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
// Purge old cache on startup to force re-filtering with updated quality rules
try { for (const f of fs.readdirSync(CACHE_DIR)) fs.unlinkSync(path.join(CACHE_DIR, f)); console.log('[cache] Purged old cache on startup'); } catch(e) {}

// In-memory company index: Map<industryCode6, Company[]>
const _companyCache = new Map();
const CACHE_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days

function loadCachedIndustry(code) {
  if (_companyCache.has(code)) return _companyCache.get(code);
  const file = path.join(CACHE_DIR, `ind_${code}.json`);
  try {
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const data = qualityFilter(raw);
        _companyCache.set(code, data);
        console.log(`[cache] Loaded ${data.length} companies for code ${code} from disk (${raw.length - data.length} filtered)`);
        return data;
      } else {
        fs.unlinkSync(file); // expired
      }
    }
  } catch(e) {}
  return null;
}

function saveCachedIndustry(code, companies) {
  const cleaned = qualityFilter(companies);
  _companyCache.set(code, cleaned);
  const file = path.join(CACHE_DIR, `ind_${code}.json`);
  try { fs.writeFileSync(file, JSON.stringify(cleaned)); } catch(e) {}
}

// Quality filter — removes shelf companies, holdings, inactive, no contact info
function qualityFilter(companies) {
  return companies.filter(c => {
    if (!c.name || !c.name.trim()) return false;
    const n = c.name.toUpperCase();
    if (/\b(PSE|KBUS|SPKR|PRGF|ASM|KOMPLEMENTAR)\b/.test(n)) return false;
    if (/^(A\/S|APS|K\/S|I\/S)\s+(PSE|KBUS|SPKR|PRGF|ASM|AF\s+\d)/i.test(n)) return false;
    if (/\bNR\.\s*\d+/.test(n)) return false;
    if (/^(A\/S|APS|K\/S|I\/S)\s+\d+$/i.test(c.name.trim())) return false;
    if (/^CVR\s/i.test(n)) return false;
    if (/\bHOLDING\b/i.test(n)) return false;
    if (/^\d/.test(c.name.trim())) return false;
    if (!c.phone && !c.email) return false;
    return true;
  });
}

// ── Search via Datafordeler GraphQL (branche-baseret søgning, batch queries) ──
async function searchDatafordeler(query, filters = {}) {
  const fromOffset = Number(filters._from) || 0;
  const pageSize = Math.min(Number(filters._size) || 50, 500);

  // Check if we have cached IDs for this query (for pagination)
  const idsCacheKey = `df-allids:${query}`;
  const cachedAllIds = cacheGet(idsCacheKey);

  // Industry codes verified against Datafordeler (6-digit format)
  const INDUSTRY_MAP = {
    // Byggeri
    'bygge': ['412000','451100'],
    'tømrer': ['433200','454200'],
    'murer': ['433100'],
    'maler': ['433410'],
    'el': ['432100','453100'],
    'elektrik': ['432100','453100'],
    'vvs': ['432200','453300'],
    // IT & Software
    'it': ['620100','620200','621000','622000'],
    'software': ['620100','621000'],
    'computer': ['620100','621000','622000'],
    // Handel
    'butik': ['471900','521120'],
    'detail': ['471900'],
    'grossist': ['461900','466900'],
    'tøj': ['477110','477120','524230','524240'],
    // Mad & Drikke
    'restaurant': ['561010','561020','563000'],
    'mad': ['561010','561020'],
    'pizza': ['561020'],
    'cafe': ['563000','563010'],
    'bar': ['563000'],
    'hotel': ['551000','551010','551020','551110','551120'],
    // Transport
    'transport': ['494100','602410'],
    'taxi': ['493200'],
    'vognmand': ['494100','602410'],
    // Professionelle tjenester
    'advokat': ['691000','741100'],
    'jura': ['691000','741100'],
    'revisor': ['692000','741200'],
    'regnskab': ['692000','741200'],
    'konsulent': ['702000','702200','741490'],
    'rådgivning': ['702000','702200','702100'],
    'arkitekt': ['711100','742040'],
    'ingeniør': ['711210','742010','742020'],
    'reklame': ['731000','733000'],
    'marketing': ['731000','733000','702100'],
    // Ejendom
    'ejendom': ['681000','682030','682040','683110','683210'],
    'udlejning': ['682030','682040'],
    'mægler': ['683110','703110'],
    // Sundhed
    'læge': ['862100','869090','869900'],
    'sundhed': ['862100','869090','869900'],
    // Service
    'rengøring': ['812100','747010'],
    'frisør': ['960210'],
    'vagt': ['746000'],
    // Finans
    'bank': ['641900','651200'],
    'forsikring': ['660310','662200'],
    'finans': ['641900','649900','649910'],
    // Landbrug
    'landbrug': ['011190','015000'],
    // Auto
    'auto': ['451120','452010','502010'],
    'mekaniker': ['452010','502010'],
    // Rejse
    'rejse': ['791100','791200','633020','633030'],
  };

  const q = query.trim().toLowerCase();
  let enhedsIds = [];

  // Fast path: use cached enriched companies (already sorted alphabetically, deduped, quality-filtered)
  const enrichedCacheKey = `df-enriched:${query}`;
  const cachedEnriched = cacheGet(enrichedCacheKey);
  if (cachedAllIds && cachedEnriched) {
    const allCompanies = cachedAllIds.map(cvr => cachedEnriched[cvr]).filter(Boolean);
    console.log(`[search] Fast path: ${allCompanies.length} cached companies for "${q}" (from=${fromOffset}, size=${pageSize})`);
    const page = allCompanies.slice(fromOffset, fromOffset + pageSize);
    return { companies: page, total: page.length, totalAvailable: allCompanies.length };
  }

  // 1. If numeric 8-digit → single CVR lookup
  if (/^\d{8}$/.test(q)) {
    try {
      const company = await lookupDatafordeler(q);
      const result = { companies: [company], total: 1 };
      cacheSet(cacheKey, result);
      return result;
    } catch (e) {
      return { companies: [], total: 0 };
    }
  }

  // 2. Find matching industry codes from keyword map
  let codes = [];
  for (const [keyword, c] of Object.entries(INDUSTRY_MAP)) {
    if (q.includes(keyword) || keyword.includes(q)) {
      codes.push(...c);
    }
  }

  // Also try if user enters a numeric industry code directly
  if (/^\d{2,6}$/.test(q)) {
    codes.push(q);
  }

  // Also use branche filter if provided (sends 2-digit codes like "69", "41")
  if (filters.branche) {
    const BRANCHE_CODES = {
      '41': ['412000'],
      '43': ['432100','432200','433200','433410','433100','439990'],
      '45': ['451120','452010'],
      '46': ['461900','464210','465100','466900','467310','467400'],
      '47': ['471900','477110','477120','477610','475400'],
      '55': ['551000','551010','551020','551110','551120'],
      '56': ['561010','561020','563000','563010'],
      '49': ['494100','493200'],
      '62': ['620100','620200','621000','622000'],
      '64': ['641900','642010','642020','649900','649910'],
      '68': ['681000','682030','682040','683110','683210'],
      '69': ['691000','692000'],
      '70': ['702000','702200','702100','701020'],
      '71': ['711100','711210'],
      '73': ['731000','733000'],
      '77': ['773200','773300','773400','773900','773990'],
      '79': ['791100','791200'],
      '81': ['812100'],
      '86': ['862100','869090','869900'],
      '96': ['960210'],
    };
    const bCodes = BRANCHE_CODES[filters.branche] || [];
    if (bCodes.length > 0) codes.push(...bCodes);
    else {
      // Fallback: try common suffixes
      const b = filters.branche;
      ['0000','1000','0100','0010','1100','0200','2000'].forEach(s => codes.push(b + s));
    }
  }

  // 3. Check local cache first, then fetch from Datafordeler for uncached codes
  let allCompanies = [];
  if (codes.length > 0) {
    const uniqueCodes = [...new Set(codes)];
    const uncachedCodes = [];

    // Load from local cache (enriched companies) or pre-fetched IDs
    for (const code of uniqueCodes) {
      const cached = loadCachedIndustry(code);
      if (cached) {
        allCompanies.push(...cached);
      } else {
        // Check if we have pre-fetched IDs from prewarm
        const prewarmIds = cacheGet(`df-ids-code:${code}`);
        if (prewarmIds) {
          enhedsIds.push(...prewarmIds);
        } else {
          uncachedCodes.push(code);
        }
      }
    }

    // Fetch uncached codes from Datafordeler
    if (uncachedCodes.length > 0) {
      console.log(`[search] Fetching ${uncachedCodes.length} uncached codes from Datafordeler:`, uncachedCodes);
      const MAX_PAGES = 3; // 3 pages × 1000 = up to 3000 companies per code
      const fetchAllIds = async (code) => {
        const ids = [];
        let cursor = null, hasNext = true, page = 0;
        while (hasNext && page < MAX_PAGES) {
          try {
            const afterClause = cursor ? `, after: "${cursor}"` : '';
            const r = await dfGqlFetch(`{ CVR_Branche(first: 1000${afterClause}, where: { vaerdi: { eq: "${code}" } }) { pageInfo { hasNextPage endCursor } edges { node { CVREnhedsId } } } }`);
            const data = r?.CVR_Branche;
            ids.push(...(data?.edges || []).map(e => e.node.CVREnhedsId));
            hasNext = data?.pageInfo?.hasNextPage || false;
            cursor = data?.pageInfo?.endCursor || null;
            page++;
          } catch (e) {
            console.error(`[search] Branche page failed for ${code}:`, e.message);
            hasNext = false;
          }
        }
        console.log(`[search] Code ${code}: ${ids.length} IDs (${page} pages)`);
        return { code, ids };
      };
      const codeResults = await Promise.all(uncachedCodes.slice(0, 5).map(fetchAllIds));
      for (const { code, ids } of codeResults) {
        if (ids.length > 0) enhedsIds.push(...ids);
      }
      console.log(`[search] Found ${enhedsIds.length} new enhedsIds to enrich`);
    } else {
      console.log(`[search] All ${uniqueCodes.length} codes served from cache (${allCompanies.length} companies)`);
    }
  }

  // If nothing found at all, return empty
  if (enhedsIds.length === 0 && allCompanies.length === 0) {
    console.log(`[search] No matches for "${q}"`);
    return { companies: [], total: 0, totalAvailable: 0 };
  }

  // Helper: split array into chunks of N
  const chunk = (arr, n) => { const chunks = []; for (let i = 0; i < arr.length; i += n) chunks.push(arr.slice(i, i + n)); return chunks; };

  // 4. Enrich ONLY the IDs needed for current page (not all)
  if (enhedsIds.length > 0) {
    const allNewIds = [...new Set(enhedsIds)];
    const totalNewIds = allNewIds.length;
    // Enrich ALL IDs so pagination works from cache (max 3000 to keep it fast)
    const maxEnrich = 3000;
    const newIds = allNewIds.slice(0, maxEnrich);
    console.log(`[search] Enriching ${newIds.length} of ${totalNewIds} IDs...`);
    const idBatches = chunk(newIds, 100);

    // Get CVR numbers
    let virksomheder = [];
    for (const batch of idBatches) {
      try {
        const r = await dfGqlFetch(`{
          CVR_Virksomhed(first: ${batch.length}, where: { id: { in: [${batch.map(id => `"${id}"`).join(',')}] } }) {
            edges { node { id CVRNummer status virksomhedStartdato virksomhedOphoersdato } }
          }
        }`);
        virksomheder.push(...(r?.CVR_Virksomhed?.edges?.map(e => e.node) || []));
      } catch(e) { console.error('[search] Virksomhed batch failed:', e.message); }
    }

    // Batch enrich entities
    const navnMap = new Map(), adrMap = new Map(), tlfMap = new Map();
    const emailMap = new Map(), brancheMap = new Map(), formMap = new Map(), beskMap = new Map();
    const addToMap = (map, data, entity) => {
      for (const e of (data?.[entity]?.edges || [])) {
        const id = e.node.CVREnhedsId;
        if (!map.has(id)) map.set(id, e.node);
      }
    };
    for (const batch of idBatches) {
      const idList = batch.map(id => `"${id}"`).join(',');
      const w = `CVREnhedsId: { in: [${idList}] }`;
      const sz = batch.length;
      try {
        const [rN, rA, rT, rE, rB, rF, rBe] = await Promise.all([
          dfGqlFetch(`{ CVR_Navn(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
          dfGqlFetch(`{ CVR_Adressering(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId CVRAdresse_vejnavn CVRAdresse_husnummerFra CVRAdresse_postnummer CVRAdresse_postdistrikt } } } }`),
          dfGqlFetch(`{ CVR_Telefonnummer(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
          dfGqlFetch(`{ CVR_e_mailadresse(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
          dfGqlFetch(`{ CVR_Branche(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi vaerdiTekst } } } }`),
          dfGqlFetch(`{ CVR_Virksomhedsform(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi vaerdiTekst } } } }`),
          dfGqlFetch(`{ CVR_Beskaeftigelse(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId antal intervalFra intervalTil } } } }`),
        ]);
        addToMap(navnMap, rN, 'CVR_Navn'); addToMap(adrMap, rA, 'CVR_Adressering');
        addToMap(tlfMap, rT, 'CVR_Telefonnummer'); addToMap(emailMap, rE, 'CVR_e_mailadresse');
        addToMap(brancheMap, rB, 'CVR_Branche'); addToMap(formMap, rF, 'CVR_Virksomhedsform');
        addToMap(beskMap, rBe, 'CVR_Beskaeftigelse');
      } catch(e) { console.error('[search] Entity batch failed:', e.message); }
    }

  // Build company objects — include ALL companies, even with missing data
  const newCompanies = virksomheder.map(virk => {
    const eid = virk.id;
    const navn = navnMap.get(eid);
    const adr = adrMap.get(eid) || {};
    const tlf = tlfMap.get(eid);
    const email = emailMap.get(eid);
    const br = brancheMap.get(eid) || {};
    const form = formMap.get(eid) || {};
    const besk = beskMap.get(eid) || {};

    const empStr = (besk.intervalFra != null && besk.intervalTil != null)
      ? `${besk.intervalFra}-${besk.intervalTil}`
      : (besk.antal ? String(besk.antal) : "");

    return {
      cvr: String(virk.CVRNummer || ""),
      name: navn?.vaerdi || `CVR ${virk.CVRNummer}`,
      address: [adr.CVRAdresse_vejnavn, adr.CVRAdresse_husnummerFra].filter(Boolean).join(" "),
      zip: String(adr.CVRAdresse_postnummer || ""),
      city: adr.CVRAdresse_postdistrikt || "",
      phone: tlf?.vaerdi || "",
      email: email?.vaerdi || "",
      web: "",
      industry: br.vaerdiTekst || "",
      industryCode: String(br.vaerdi || "").substring(0, 2),
      employees: empStr,
      employeeCount: besk.antal || 0,
      status: virk.virksomhedOphoersdato ? "inactive" : "active",
      founded: virk.virksomhedStartdato?.substring(0, 4) || "",
      form: form.vaerdiTekst || form.vaerdi || "",
      adProtected: false,
      owners: [],
      revenue: 0, grossProfit: 0, equity: 0, result: 0,
      ig: "", fb: "", tt: "", li: "",
      tech: [],
    };
  })
  .filter(c => c.name && c.name.trim().length > 0);

    // Save to local cache per industry code (for future fast lookups)
    // Group new companies by their 6-digit industry code and save
    const codeGroups = new Map();
    for (const c of newCompanies) {
      const fullCode = String(brancheMap.get(virksomheder.find(v => String(v.CVRNummer) === c.cvr)?.id)?.vaerdi || '');
      if (fullCode) {
        if (!codeGroups.has(fullCode)) codeGroups.set(fullCode, []);
        codeGroups.get(fullCode).push(c);
      }
    }
    for (const [code, cos] of codeGroups) {
      const existing = loadCachedIndustry(code) || [];
      const merged = [...existing, ...cos];
      // Deduplicate by CVR
      const unique = [...new Map(merged.map(c => [c.cvr, c])).values()];
      saveCachedIndustry(code, unique);
      console.log(`[cache] Saved ${unique.length} companies for code ${code}`);
    }

    allCompanies.push(...newCompanies);
    console.log(`[search] Built ${newCompanies.length} new companies, total: ${allCompanies.length}`);
  }

  // Deduplicate, quality-filter, and sort alphabetically
  const deduped = qualityFilter([...new Map(allCompanies.map(c => [c.cvr, c])).values()])
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'da'));

  // Cache the full sorted+deduped list for pagination (so page 2+ returns correct order)
  if (deduped.length > 0) {
    // Cache CVR list in sorted order so pagination follows same alphabetical order
    const sortedIds = deduped.map(c => c.cvr);
    cacheSet(idsCacheKey, sortedIds);
    // Also cache the enriched companies by CVR for instant page 2+
    const enrichedCacheKey = `df-enriched:${query}`;
    const enrichedMap = {};
    deduped.forEach(c => { enrichedMap[c.cvr] = c; });
    cacheSet(enrichedCacheKey, enrichedMap);
  }
  // totalAvailable = actual enriched+filtered count (NOT raw IDs)
  const totalAvailable = deduped.length;

  // Paginate from the full sorted list
  const page = deduped.slice(fromOffset, fromOffset + pageSize);

  return { companies: page, total: page.length, totalAvailable };
}

// ── Enrichment ────────────────────────────────────────────────────────────────
async function enrichWithClearbit(company) {
  const key = process.env.CLEARBIT_KEY;
  if (!key || !company.email) return company;
  try {
    const domain = company.email.split("@")[1];
    const res = await fetch(`https://company.clearbit.com/v2/companies/find?domain=${domain}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return company;
    const data = await res.json();
    return {
      ...company,
      web: data.domain || company.web,
      li: data.linkedin?.handle || company.li,
      fb: data.facebook?.handle || company.fb,
      tech: data.tech || company.tech,
    };
  } catch (e) {
    return company;
  }
}

// ── Filters ──────────────────────────────────────────────────────────────────
function applyFilters(companies, f) {
  return companies.filter((c) => {
    if (f.branche && !c.industryCode.startsWith(f.branche)) return false;
    if (f.zip && !c.zip.startsWith(f.zip)) return false;
    if (f.city && !c.city.toLowerCase().includes(f.city.toLowerCase())) return false;
    if (f.form && c.form !== f.form) return false;
    if (f.status && c.status !== f.status) return false;
    if (f.hasPhone === "true" && !c.phone) return false;
    if (f.hasEmail === "true" && !c.email) return false;
    if (f.foundedFrom && c.founded && Number(c.founded) < Number(f.foundedFrom)) return false;
    if (f.foundedTo && c.founded && Number(c.founded) > Number(f.foundedTo)) return false;
    if (f.empMin && c.employeeCount < Number(f.empMin)) return false;
    if (f.empMax && c.employeeCount > Number(f.empMax)) return false;
    if (f.adProtect === "skjul" && c.adProtected) return false;
    if (f.adProtect === "kun" && !c.adProtected) return false;
    return true;
  });
}

// ── API Routes ────────────────────────────────────────────────────────────────

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const users = loadUsers();
  const user = users.find((u) => (u.email === email || u.id === email) && u.password === password);
  if (!user) return res.status(401).json({ error: "Forkert email eller adgangskode" });
  const token = Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
  sessions.set(token, user.id);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, color: user.color, avatar: user.avatar || null } });
});

// ── Google OAuth login ────────────────────────────────────────────────────────
function makeLoginOAuth2Client() {
  const { google } = require("googleapis");
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID og GOOGLE_CLIENT_SECRET mangler i .env");
  const redirectUri  = process.env.GOOGLE_LOGIN_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

app.get("/api/auth/google", (req, res) => {
  try {
    const auth = makeLoginOAuth2Client();
    const url = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "select_account",
      scope: ["https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"],
    });
    res.redirect(url);
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent("Google OAuth ikke konfigureret — tilføj GOOGLE_CLIENT_ID og GOOGLE_CLIENT_SECRET i .env")}`);
  }
});

app.get("/api/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`/?error=${encodeURIComponent(error || "Google login annulleret")}`);
  try {
    const auth = makeLoginOAuth2Client();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);
    const { google } = require("googleapis");
    const oauth2 = google.oauth2({ version: "v2", auth });
    const info = await oauth2.userinfo.get();
    const { email, name, picture } = info.data;
    if (!email) return res.redirect(`/?error=${encodeURIComponent("Kunne ikke hente email fra Google")}`);

    const users = loadUsers();
    let user = users.find(u => u.email === email);
    if (!user) {
      // First user becomes admin, subsequent users become SDR
      user = {
        id: "g_" + Date.now(),
        name: name || email.split("@")[0],
        email,
        password: "",
        role: users.length === 0 ? "admin" : "sdr",
        color: "#8258a8",
        avatar: picture || null,
        googleAuth: true,
      };
      users.push(user);
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } else if (picture && !user.avatar) {
      // Update avatar if missing
      user.avatar = picture;
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    }

    const token = Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
    sessions.set(token, user.id);
    res.redirect(`/?token=${token}`);
  } catch (err) {
    console.error("Google auth callback error:", err.message);
    res.redirect(`/?error=${encodeURIComponent("Google login fejlede: " + err.message)}`);
  }
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const users = loadUsers();
  const user = users.find((u) => u.id === req.userId);
  if (!user) return res.status(404).json({ error: "Bruger ikke fundet" });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, color: user.color, avatar: user.avatar || null });
});

app.post("/api/auth/logout", authMiddleware, (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  sessions.delete(token);
  res.json({ ok: true });
});

app.patch("/api/auth/profile", authMiddleware, (req, res) => {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: "Bruger ikke fundet" });
  const { name, email, color, avatar } = req.body;
  if (name && name.trim()) users[idx].name = name.trim();
  if (email && email.trim()) {
    const taken = users.find((u) => u.email === email.trim() && u.id !== req.userId);
    if (taken) return res.status(400).json({ error: "Email er allerede i brug af en anden bruger" });
    users[idx].email = email.trim();
  }
  if (color) users[idx].color = color;
  if (avatar !== undefined) users[idx].avatar = avatar; // base64 data URL or null
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  const u = users[idx];
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, avatar: u.avatar || null });
});

app.post("/api/auth/change-password", authMiddleware, (req, res) => {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: "Bruger ikke fundet" });
  const { currentPassword, newPassword } = req.body;
  if (users[idx].password !== currentPassword)
    return res.status(400).json({ error: "Nuværende adgangskode er forkert" });
  if (!newPassword || newPassword.length < 3)
    return res.status(400).json({ error: "Ny adgangskode skal være mindst 3 tegn" });
  users[idx].password = newPassword;
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok: true });
});

// ── Team stats ────────────────────────────────────────────────────────────────
app.get("/api/stats/team", authMiddleware, (req, res) => {
  const users = loadUsers();
  const teamStats = users.map((u) => {
    const d = loadUserData(u.id);
    const aePipe = (d.pipelines && d.pipelines.ae) || d.pipeline || {};
    const sdrPipe = (d.pipelines && d.pipelines.sdr) || {};
    const stages = {};
    Object.values(aePipe).forEach((s) => { stages[s] = (stages[s] || 0) + 1; });
    Object.values(sdrPipe).forEach((s) => { stages[s] = (stages[s] || 0) + 1; });
    const wonLeads = d.leads.filter((l) => aePipe[l.cvr] === "Vundet");
    const lostLeads = d.leads.filter((l) => aePipe[l.cvr] === "Tabt");
    const wonValue = wonLeads.reduce((s, l) => s + (l.omsaetning || 0), 0);
    const winRate = (wonLeads.length + lostLeads.length) > 0
      ? Math.round((wonLeads.length / (wonLeads.length + lostLeads.length)) * 100)
      : 0;
    return {
      userId: u.id, name: u.name, role: u.role, color: u.color,
      leadsCount: d.leads.length, stages, wonValue, wonCount: wonLeads.length,
      lostCount: lostLeads.length, winRate,
    };
  });
  res.json(teamStats);
});

// ── Søg virksomheder
app.get("/api/search", async (req, res) => {
  const { q = "", from = 0, size = 500, ...filters } = req.query;
  if (q.trim().length < 2 && !filters.branche) {
    return res.status(400).json({ error: "Søgning skal være mindst 2 tegn" });
  }
  try {
    // Pass pagination params to search function
    filters._from = Number(from);
    filters._size = Number(size);
    const result = await searchDatafordeler(q, filters);
    return res.json({ ...result, from: Number(from), provider: "datafordeler" });
  } catch (err) {
    console.error("Søgefejl:", err.message);
    res.status(502).json({ error: err.message, code: "SEARCH_ERROR" });
  }
});

// Enkelt CVR-opslag
app.get("/api/company/:cvr", async (req, res) => {
  try {
    let company = await lookupDatafordeler(req.params.cvr);
    if (process.env.CLEARBIT_KEY) company = await enrichWithClearbit(company);
    res.json(company);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// META ADS — public Ad Library scrape via Playwright. No Meta API token: the
// official /ads_archive endpoint is restricted to political/issue ads outside
// the US and commercial-ad access takes weeks of DSA review. The scrape is
// brittle (Meta restructures the page ~every 6–12 months → expect ~1–2 hrs of
// selector maintenance) but it's the same approach used in the COO project.
// ─────────────────────────────────────────────────────────────────────────────
const META_ADS_FILE = path.join(DATA_DIR, "meta_ads.json");
const META_ADS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days — re-check after this

function loadMetaAds() { return loadJsonFile(META_ADS_FILE, {}); }
function saveMetaAds(d) { try { fs.writeFileSync(META_ADS_FILE, JSON.stringify(d, null, 2)); } catch (e) { console.error("[ads] save failed:", e.message); } }
function getCachedAds(cvr) {
  const e = loadMetaAds()[cvr];
  if (!e) return null;
  if (Date.now() - new Date(e.checkedAt).getTime() > META_ADS_TTL) return null;
  return e;
}
function setCachedAds(cvr, data) {
  const all = loadMetaAds();
  all[cvr] = { ...data, checkedAt: new Date().toISOString() };
  saveMetaAds(all);
}

// Datafordeler returns the legal company name ("BYGMA GRUPPEN A/S") which
// almost never appears verbatim inside ad creative. Meta's keyword_exact_phrase
// search needs the *brand* name — the bit advertisers actually print on their
// ads ("Bygma"). This strips common Danish corporate suffixes and shell-company
// noise so we feed Meta something searchable. Tested cases:
//   "BYGMA GRUPPEN A/S"          → "BYGMA"
//   "A.P. Møller - Mærsk A/S"    → "A.P. Møller - Mærsk"  (no GROUP/HOLDING)
//   "JYSK HOLDING A/S"           → "JYSK"
//   "DAGROFA APS"                → "DAGROFA"
// If the cleaned name is too short (<2 chars after trim), we fall back to the
// raw input so we don't blow away one-letter brand names.
function brandNameFromLegal(legal) {
  const cleaned = String(legal || "")
    .replace(/\b(GRUPPEN|GROUP|HOLDING|HOLDINGSELSKAB|INVEST(ERING|MENT)?S?|INTERNATIONAL|DANMARK|DENMARK|SCANDINAVIA|NORDIC|EUROPE|EU)\b/gi, " ")
    .replace(/\b(A\/S|ApS|IVS|I\/S|K\/S|P\/S|S\.A\.|GmbH|Ltd|Inc|Corp|LLC)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : String(legal || "").trim();
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

// Strict-match: exact equality OR brand-as-whole-word substring for
// brand names that are distinctive enough.
//
// Why strict: short, generic brand names ("BECK", "MASTER", "STAR") match
// dozens of unrelated US/EU advertisers under the COO project's looser
// token-overlap rule (verified on real data — BECK A/S was matching "Beck
// Institute for Cognitive Behavior Therapy", "Brooks & Beck", etc.). The
// false-positive rate made the count meaningless for short names.
//
// Trade-off: we lose some recall on edge cases like "Bygma Aalborg" being
// a separate page name of the same company. Those need a manual override
// per company once we add that surface.
function advertiserMatchesCompany(advertiser, company) {
  const a = normalizeCompanyName(advertiser);
  const c = normalizeCompanyName(company);
  if (!a || !c) return false;
  if (a === c) return true;
  // Brand needs to be ≥ 7 chars before substring matching is allowed.
  // 4–6 chars are too generic ("beck", "master", "vedio").
  if (c.length < 7) return false;
  const aWord = ` ${a} `;
  const cWord = ` ${c} `;
  if (aWord.includes(cWord)) return true;
  return false;
}

// Parse the rendered Ads Library page text and verify ≥1 ad card matches
// the searched company. The page structure (DK locale) is:
//   Aktiv · Vist {date} · Platforme · Facebook, Instagram
//   <Advertiser page name>          ← we want this
//   Sponsoreret
//   <ad body / CTA>
// Last non-empty line before each "Sponsoreret" = advertiser name.
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

async function launchAdsBrowser() {
  // Lazy-require so the server still boots when playwright isn't installed
  // locally (the production Dockerfile uses the playwright base image; dev
  // machines without it get 503 on /api/check-ads but the rest of the app
  // works normally).
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch (e) { throw new Error("playwright not installed: " + e.message); }
  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "da-DK",
    viewport: { width: 1280, height: 800 },
  });
  return { browser, context };
}

async function scrapeMetaAds(name, opts = {}) {
  const { browser, context } = opts.context ? { browser: null, context: opts.context } : await launchAdsBrowser();
  try {
    const page = await context.newPage();
    try {
      await page.goto(buildAdsUrl(name), { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000);
      await page.waitForSelector('[role="main"], [role="article"]', { timeout: 5000 }).catch(() => {});
      const text = await page.evaluate(() => document.body.innerText).catch(() => null);
      return classifyAdsPage(text, name);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (browser && !opts.context) await browser.close().catch(() => {});
  }
}

// POST /api/check-ads/:cvr — scrape Meta and update cache for one company.
// Accepts an optional `name` override in the body (so the UI can let users
// hand-tune the search term per row). If omitted, we derive a brand-name
// guess from Datafordeler's legal name via brandNameFromLegal().
app.post("/api/check-ads/:cvr", authMiddleware, async (req, res) => {
  const cvr = req.params.cvr;
  try {
    const company = await lookupDatafordeler(cvr).catch(() => null);
    const override = req.body && req.body.name;
    const searchName = override || brandNameFromLegal(company?.name);
    if (!searchName) return res.status(400).json({ error: "Company name not available" });
    const result = await scrapeMetaAds(searchName);
    if (result.verdict !== null) {
      setCachedAds(cvr, {
        name: company?.name || searchName,
        searchName,
        verdict: result.verdict,
        matched: result.matched || 0,
        total: result.total || 0,
        advertisers: result.advertisers || [],
      });
    }
    res.json({ cvr, name: searchName, ...result, checkedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[ads] check failed for", cvr, e.message);
    res.status(503).json({ error: e.message });
  }
});

// GET /api/ads-status/:cvr — cached verdict only
app.get("/api/ads-status/:cvr", authMiddleware, (req, res) => {
  const cached = getCachedAds(req.params.cvr);
  res.json(cached || { cached: false });
});

// GET /api/ads-status — bulk fetch via ?cvrs=a,b,c (so the leads table can
// paint pills in one round-trip instead of N).
app.get("/api/ads-status", authMiddleware, (req, res) => {
  const cvrs = String(req.query.cvrs || "").split(",").map((s) => s.trim()).filter(Boolean);
  const all = loadMetaAds();
  const out = {};
  for (const cvr of cvrs) {
    const e = all[cvr];
    if (!e) continue;
    if (Date.now() - new Date(e.checkedAt).getTime() > META_ADS_TTL) continue;
    out[cvr] = e;
  }
  res.json(out);
});

// POST /api/check-ads-batch — body: { items: [{cvr, name}, ...] }
// Reuses a single browser context across the batch to skip the ~1.5s
// chromium launch on each company. Sequential with a 2.5s delay between
// hits — Meta is rate-friendly at this pace.
app.post("/api/check-ads-batch", authMiddleware, async (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items) || items.length === 0) return res.json({});
  let browser, context;
  const results = {};
  try {
    ({ browser, context } = await launchAdsBrowser());
    for (let i = 0; i < items.length; i++) {
      const { cvr, name } = items[i];
      if (!cvr || !name) continue;
      const searchName = brandNameFromLegal(name);
      try {
        const r = await scrapeMetaAds(searchName, { context });
        if (r.verdict !== null) {
          setCachedAds(cvr, { name, searchName, verdict: r.verdict, matched: r.matched || 0, total: r.total || 0, advertisers: r.advertisers || [] });
        }
        results[cvr] = r;
      } catch (err) {
        results[cvr] = { verdict: null, reason: err.message };
      }
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, 2500));
    }
    res.json(results);
  } catch (e) {
    res.status(503).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAD DISCOVERY — read endpoints
// The lead-discovery Cloud Run Job (separate service) writes a single
// state.json + daily flips_<date>.jsonl into the same bucket the main
// service mounts. These endpoints just expose those files to the UI.
// ─────────────────────────────────────────────────────────────────────────────
const DISCOVERY_STATE_FILE = path.join(DATA_DIR, "discovery", "state.json");
const DISCOVERY_CONFIG_FILE = path.join(DATA_DIR, "discovery", "config.json");

function loadDiscoveryState() {
  return loadJsonFile(DISCOVERY_STATE_FILE, { companies: {} });
}

// Agent runtime config — the discover-ads.js Cloud Run Job reads this on
// startup, falls back to env-var defaults if missing. Keeps the SDR in
// control of the knobs without redeploying.
const DISCOVERY_CONFIG_DEFAULTS = {
  enabled: true,           // master switch — UI toggle flips this; worker exits early when false
  minEmployees: 3,         // tier-1 gate (confirmed headcount)
  icpMinAds: 3,            // min Meta-ads to qualify as ICP
  icpMinEmployees: 5,      // min employees (when known) for ICP
  scrapeLimit: 1000,       // max companies scraped per run
  concurrency: 8,          // parallel Playwright contexts
  poolTtlDays: 30,         // candidate-pool refresh interval
};
function loadDiscoveryConfig() {
  // loadJsonFile returns the default if the file doesn't exist; spread it
  // over our defaults so missing keys still get sane values.
  return { ...DISCOVERY_CONFIG_DEFAULTS, ...loadJsonFile(DISCOVERY_CONFIG_FILE, {}) };
}
function saveDiscoveryConfig(config) {
  const dir = path.dirname(DISCOVERY_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DISCOVERY_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// GET /api/discovery/config — return current agent settings
app.get("/api/discovery/config", authMiddleware, (req, res) => {
  res.json(loadDiscoveryConfig());
});

// PUT /api/discovery/config — partial update; whitelisted keys + value
// clamps so a bad input can't break the agent.
app.put("/api/discovery/config", authMiddleware, (req, res) => {
  try {
    const current = loadDiscoveryConfig();
    const body = req.body || {};
    const clamp = (v, lo, hi, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(lo, Math.min(hi, Math.round(n)));
    };
    const updated = {
      ...current,
      ...(body.enabled !== undefined && { enabled: !!body.enabled }),
      ...(body.minEmployees !== undefined && { minEmployees: clamp(body.minEmployees, 0, 1000, current.minEmployees) }),
      ...(body.icpMinAds !== undefined && { icpMinAds: clamp(body.icpMinAds, 0, 100, current.icpMinAds) }),
      ...(body.icpMinEmployees !== undefined && { icpMinEmployees: clamp(body.icpMinEmployees, 0, 1000, current.icpMinEmployees) }),
      ...(body.scrapeLimit !== undefined && { scrapeLimit: clamp(body.scrapeLimit, 10, 5000, current.scrapeLimit) }),
      ...(body.concurrency !== undefined && { concurrency: clamp(body.concurrency, 1, 16, current.concurrency) }),
      ...(body.poolTtlDays !== undefined && { poolTtlDays: clamp(body.poolTtlDays, 1, 90, current.poolTtlDays) }),
    };
    saveDiscoveryConfig(updated);
    res.json({ ok: true, config: updated, appliesAt: "next run" });
  } catch (e) {
    console.error("[discovery/config] save failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/discovery/summary — top-line stats for the Discovery header
app.get("/api/discovery/summary", authMiddleware, (req, res) => {
  const s = loadDiscoveryState();
  const companies = s.companies || {};
  let totalActiveAdvertisers = 0;
  let totalChecked = 0;
  let icpQualified = 0;
  let pendingPushToCloudTalk = 0;
  for (const cvr of Object.keys(companies)) {
    const c = companies[cvr];
    if (c?.ads) totalChecked++;
    if (c?.ads?.verdict === true) totalActiveAdvertisers++;
    if (c?.icpFit) {
      icpQualified++;
      // Pending = ICP-fit, not already pushed, not already in Twenty.
      if (!c.pushed_to_cloudtalk_at && !c.twenty_opportunity_id) pendingPushToCloudTalk++;
    }
  }
  res.json({
    lastRunStartedAt: s.lastRunStartedAt || null,
    lastRunCompletedAt: s.lastRunCompletedAt || null,
    candidatePoolSize: s.candidatePoolSize || 0,
    scrapedThisRun: s.scrapedThisRun || 0,
    okThisRun: s.ok || 0,
    failThisRun: s.fail || 0,
    withAdsThisRun: s.withAds || 0,
    totalChecked,
    totalActiveAdvertisers,
    icpQualified,
    pendingPushToCloudTalk,
    nextRunAt: nextDailyRunTime(),
  });
});

// Returns the next 06:00 or 12:00 Europe/Copenhagen run as ISO. Not perfect
// for DST edge cases — good enough for "om N timer" headline copy.
function nextDailyRunTime() {
  const now = new Date();
  // Copenhagen is UTC+1 (CET, winter) or UTC+2 (CEST, summer). Approximate via
  // both candidates: 06:00 local ≈ 04:00 UTC (CEST) / 05:00 UTC (CET);
  // 12:00 local ≈ 10:00 UTC (CEST) / 11:00 UTC (CET). For headline copy the
  // CEST values are good enough year-round (off by 1h in winter, harmless).
  const hoursUtc = [4, 10];
  for (const h of hoursUtc) {
    const c = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0));
    if (c > now) return c.toISOString();
  }
  // Past noon — next run is tomorrow at 04:00 UTC (06:00 Copenhagen)
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 4, 0, 0)).toISOString();
}

// GET /api/discovery/companies — filterable, paginated list. Query params:
//   tab=ads|all|new          ads=only verdict:true (default), all=everything checked, new=flipped to true recently
//   industry=412000          industry code prefix match (e.g. "41" matches all construction)
//   city=Aalborg             substring match on city (case-insensitive)
//   empMin / empMax          employee count bounds
//   minAds                   minimum matched ad count
//   q                        substring match on name (case-insensitive)
//   sort=ads|emp|name        default: ads (descending)
//   limit / offset           pagination (default 100 / 0)
app.get("/api/discovery/companies", authMiddleware, (req, res) => {
  const s = loadDiscoveryState();
  const companies = Object.values(s.companies || {});
  const { tab = "ads", industry = "", city = "", empMin, empMax, minAds, q = "", sort = "ads", source = "" } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;

  let rows = companies.filter((c) => c && c.cvr);
  if (tab === "ads") rows = rows.filter((c) => c.ads?.verdict === true);
  else if (tab === "icp") {
    // ICP-qualified leads that haven't yet been pushed downstream.
    rows = rows.filter((c) => c.icpFit && !c.pushed_to_cloudtalk_at && !c.twenty_opportunity_id);
  }
  else if (tab === "new") {
    const sevenDaysAgo = Date.now() - 7 * 86400_000;
    rows = rows.filter((c) => c.ads?.verdict === true && c.ads?.checkedAt && new Date(c.ads.checkedAt).getTime() >= sevenDaysAgo);
  }
  // Source filter — Dashboard's source-tabs map (meta/maps/tech/csv...) to
  // the lead's `source` tag. Existing pool entries don't carry an explicit
  // source field — they all came from the CVR-walk + Meta scraper, so we
  // treat undefined as 'meta-scraper'. New leads from Google Maps / Tech
  // Stack / CSV scrapers will carry their own source tag and surface under
  // their respective tabs once those agents start writing to the pool.
  if (source) {
    rows = rows.filter((c) => (c.source || "meta-scraper") === source);
  }
  if (industry) rows = rows.filter((c) => String(c.industry || "").startsWith(industry));
  if (city) {
    const needle = String(city).toLowerCase();
    rows = rows.filter((c) => String(c.city || "").toLowerCase().includes(needle));
  }
  if (empMin) rows = rows.filter((c) => (c.employees || 0) >= Number(empMin));
  if (empMax) rows = rows.filter((c) => (c.employees || 0) <= Number(empMax));
  if (minAds) rows = rows.filter((c) => (c.ads?.matched || 0) >= Number(minAds));
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((c) => String(c.name || "").toLowerCase().includes(needle));
  }
  if (sort === "ads") rows.sort((a, b) => (b.ads?.matched || 0) - (a.ads?.matched || 0));
  else if (sort === "emp") rows.sort((a, b) => (b.employees || 0) - (a.employees || 0));
  else if (sort === "name") rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  res.json({ total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) });
});

// GET /api/discovery/lookalikes — content-based recommender. Scores every
// candidate in state.json against the caller's own leads (and optionally a
// specific list) and returns the top matches that aren't already claimed.
//
// Signal mix (heuristic, will iterate):
//   - 2-digit DB07 match     +30  · exact 6-digit match adds +20 more
//   - Employee band overlap  +15  · (band = log2 buckets of headcount)
//   - Postal code prefix     +10  · first 2 digits match
//   - City exact (lowercased)+5
//   - Running ads bonus      +20  · if candidate has verdict:true
//   - Already-in-leads       skip · don't recommend something already added
app.get("/api/discovery/lookalikes", authMiddleware, (req, res) => {
  const userData = loadUserData(req.userId);
  const myLeads = userData?.leads || [];
  const listId = req.query.list || null;
  const seed = listId ? myLeads.filter((l) => l.listId === listId) : myLeads;
  if (seed.length === 0) return res.json({ rows: [], reason: "no leads to seed from" });

  // Build profile vectors from the seed leads.
  const seedIndustries = new Map();    // 2-digit prefix → count
  const seedIndustries6 = new Map();   // full 6-digit → count
  const seedZipPrefixes = new Map();   // 2-digit zip prefix → count
  const seedCities = new Map();        // city → count
  const seedEmpBands = new Map();      // log2 band → count
  const candidatesById = (loadDiscoveryState().companies || {});
  let withAdsCount = 0;
  for (const l of seed) {
    const ic = String(l.ic || l.industry || "");
    if (ic) {
      seedIndustries.set(ic.slice(0, 2), (seedIndustries.get(ic.slice(0, 2)) || 0) + 1);
      if (ic.length >= 6) seedIndustries6.set(ic.slice(0, 6), (seedIndustries6.get(ic.slice(0, 6)) || 0) + 1);
    }
    const zip = String(l.zip || "");
    if (zip.length >= 2) seedZipPrefixes.set(zip.slice(0, 2), (seedZipPrefixes.get(zip.slice(0, 2)) || 0) + 1);
    const city = String(l.city || "").toLowerCase().trim();
    if (city) seedCities.set(city, (seedCities.get(city) || 0) + 1);
    const emp = Number(l.emp || l.employees || 0);
    if (emp > 0) {
      const band = Math.floor(Math.log2(emp + 1));
      seedEmpBands.set(band, (seedEmpBands.get(band) || 0) + 1);
    }
    // Cross-reference state.json — does this seed lead have active Meta ads?
    const matched = l.cvr ? candidatesById[l.cvr] : null;
    if (matched?.ads?.verdict === true) withAdsCount++;
  }

  const claimed = new Set(myLeads.map((l) => l.cvr));
  const candidates = Object.values(candidatesById);

  // Max-possible score with the current signal weights — used to normalise
  // _score → percentage on the frontend. If we ever add/remove signals,
  // update this number to match.
  const MAX_SCORE = 30 + 20 + 10 + 5 + 15 + 20; // 100

  const scored = [];
  for (const c of candidates) {
    if (!c?.cvr || claimed.has(c.cvr)) continue;
    let score = 0;
    const reasons = []; // human-readable hints — fed to the UI's "why this match?"
    const ic = String(c.industry || "");
    const ic2 = ic.slice(0, 2);
    if (seedIndustries.has(ic2)) { score += 30; reasons.push("branche"); }
    if (ic.length >= 6 && seedIndustries6.has(ic.slice(0, 6))) { score += 20; reasons.push("eksakt branche"); }
    const zip2 = String(c.zip || "").slice(0, 2);
    if (zip2 && seedZipPrefixes.has(zip2)) { score += 10; reasons.push("region"); }
    const city = String(c.city || "").toLowerCase().trim();
    if (city && seedCities.has(city)) { score += 5; reasons.push("by"); }
    const emp = Number(c.employees || 0);
    if (emp > 0) {
      const band = Math.floor(Math.log2(emp + 1));
      if (seedEmpBands.has(band)) { score += 15; reasons.push("størrelse"); }
    }
    if (c.ads?.verdict === true) { score += 20; reasons.push("ads"); }
    if (score > 0) scored.push({ ...c, _score: score, _scorePct: Math.round((score / MAX_SCORE) * 100), _reasons: reasons });
  }
  scored.sort((a, b) => b._score - a._score);

  // Optional server-side breadth filter. Until we tune the floor per-customer
  // these defaults track the client-side heuristic — they're meant to keep
  // request payloads small for strict/balanced, big for broad.
  const breadth = String(req.query.breadth || "balanced");
  const top = scored[0]?._score || 0;
  let filtered = scored;
  if (breadth === "strict") filtered = scored.filter(r => r._score >= top * 0.7);
  else if (breadth === "balanced") filtered = scored.filter(r => r._score >= top * 0.35);

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({
    seedSize: seed.length,
    listId,
    breadth,
    maxScore: MAX_SCORE,
    total: filtered.length,
    rows: filtered.slice(0, limit),
    profile: {
      topIndustries: [...seedIndustries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      topZipPrefixes: [...seedZipPrefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      topCities: [...seedCities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      topEmpBands: [...seedEmpBands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      adsAsSeed: withAdsCount,
      seedCount: seed.length,
    },
  });
});

// GET /api/discovery/flips?days=7 — concatenated flip log entries for the
// "Nye annoncører" tab. Each Cloud Run Job pass appends to flips_<date>.jsonl
// in /data/discovery/. We just merge the last N days.
app.get("/api/discovery/flips", authMiddleware, (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 30);
  const dir = path.join(DATA_DIR, "discovery");
  const out = [];
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => /^flips_\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      const cutoff = Date.now() - days * 86400_000;
      for (const f of files) {
        // File-name date is YYYY-MM-DD — quick window filter so we don't
        // open files we'd just throw away.
        const m = f.match(/flips_(\d{4}-\d{2}-\d{2})\.jsonl/);
        if (!m) continue;
        if (new Date(m[1] + "T00:00:00Z").getTime() < cutoff - 86400_000) continue;
        const raw = fs.readFileSync(path.join(dir, f), "utf-8").trim().split(/\r?\n/).filter(Boolean);
        for (const line of raw) {
          try {
            const entry = JSON.parse(line);
            if (new Date(entry.at).getTime() >= cutoff) out.push(entry);
          } catch (_) {}
        }
      }
    }
  } catch (e) { console.error("[discovery] flips read:", e.message); }
  out.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ days, count: out.length, flips: out });
});

// POST /api/discovery/run — trigger the lead-discovery Cloud Run Job on
// demand. The main service's runtime SA already has roles/run.invoker on
// the Job (granted by setup-discovery-scheduler.sh so Cloud Scheduler can
// fire it) — we reuse the same auth path by fetching an OAuth token from
// the Cloud Run instance's metadata server.
const DISCOVERY_JOB_RUN_URL =
  "https://europe-west1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/vedio-444210/jobs/lead-discovery:run";

async function getInstanceOauthToken() {
  // Available inside Cloud Run / Cloud Functions / GCE; absent on dev laptops.
  const r = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  ).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json();
  return j.access_token || null;
}

app.post("/api/discovery/run", authMiddleware, async (req, res) => {
  try {
    const token = await getInstanceOauthToken();
    if (!token) {
      // Local dev — no metadata server. Don't pretend the Job started.
      return res.status(503).json({ error: "Cloud Run metadata token unavailable (kører lokalt?)" });
    }
    // Allow callers to override env (e.g. force pool refresh from the UI).
    const overrides = (req.body && req.body.overrides) || null;
    const body = overrides
      ? { overrides: { containerOverrides: [{ env: Object.entries(overrides).map(([name, value]) => ({ name, value: String(value) })) }] } }
      : {};
    const r = await fetch(DISCOVERY_JOB_RUN_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error("[discovery/run] Cloud Run API error:", r.status, text.slice(0, 400));
      return res.status(502).json({ error: `Cloud Run ${r.status}: ${text.slice(0, 200)}` });
    }
    // Parse just enough to surface the execution name for the toast.
    let executionName = null;
    try { executionName = JSON.parse(text).metadata?.name || null; } catch (_) {}
    res.json({ ok: true, executionName });
  } catch (e) {
    console.error("[discovery/run] failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Leads ─────────────────────────────────────────────────────────────────────

// Get all users' claimed CVRs (for showing owner avatars on search results)
app.get("/api/leads/owners", authMiddleware, (req, res) => {
  const users = loadJsonFile(USERS_FILE, []);
  const owners = {}; // { cvr: [{id, name, color, avatar}] }
  for (const u of users) {
    const ud = loadUserData(u.id);
    for (const lead of (ud.leads || [])) {
      if (!owners[lead.cvr]) owners[lead.cvr] = [];
      owners[lead.cvr].push({ id: u.id, name: u.name, color: u.color || '#8258a8', avatar: u.avatar || null });
    }
  }
  res.json(owners);
});

app.get("/api/leads", authMiddleware, (req, res) => res.json(loadUserData(req.userId)));

app.post("/api/leads", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const { company, listId, source } = req.body;
  if (!company?.cvr) return res.status(400).json({ error: "Mangler CVR" });
  if (d.leads.find((l) => l.cvr === company.cvr)) return res.status(409).json({ error: "Lead findes allerede" });
  // Source attribution — preserved so the Autodialer can prioritise by
  // origin (META Scraper > Look-alike > Maps > Tech Stack > CSV > manual).
  // Falls back to "manual" so legacy callers still work.
  d.leads.push({
    ...company,
    listId: listId || "ungrouped",
    source: source || company.source || "manual",
    addedAt: new Date().toISOString(),
  });
  saveUserData(req.userId, d);
  res.json({ ok: true });
});

// POST /api/leads/promote — bulk-promote CVRs from the Discovery pool
// (state.json) into the caller's leads list. Used by the ICP-klar review
// queue on Dashboard. Carries source attribution + adds to a specified
// list (default ungrouped). Skips CVRs already in the user's leads.
app.post("/api/leads/promote", authMiddleware, (req, res) => {
  const cvrs = Array.isArray(req.body?.cvrs) ? req.body.cvrs.filter(Boolean) : [];
  if (cvrs.length === 0) return res.status(400).json({ error: "cvrs[] mangler" });
  if (cvrs.length > 500) return res.status(413).json({ error: "Max 500 leads pr. promote-batch" });
  const listId = req.body?.listId || "ungrouped";
  const d = loadUserData(req.userId);
  const existing = new Set(d.leads.map((l) => l.cvr));
  const pool = loadDiscoveryState().companies || {};
  const now = new Date().toISOString();
  let promoted = 0;
  let skippedDup = 0;
  let skippedNotInPool = 0;
  for (const cvr of cvrs) {
    if (existing.has(cvr)) { skippedDup++; continue; }
    const c = pool[cvr];
    if (!c) { skippedNotInPool++; continue; }
    // Inherit pre-enriched contacts from the cron-built pool cache so the
    // lead lands in user.leads already call-ready (no per-row "Berig med
    // Kaspr" click needed if the cron has touched it).
    const primaryPhone = c.phone || (Array.isArray(c.contacts) ? (c.contacts.find(x => x.phone) || {}).phone : null) || "";
    d.leads.push({
      name: c.name,
      cvr: c.cvr,
      ic: c.industry,
      ind: c.industryName,
      city: c.city,
      zip: c.zip,
      emp: c.employees,
      web: c.website || c.web || "",
      phone: primaryPhone,
      // Source preserved — Discovery pool entries default to meta-scraper.
      source: c.source || "meta-scraper",
      icpFit: c.icpFit || false,
      adsMatched: c.ads?.matched || 0,
      // Kaspr enrichment carried over from the pool (if the cron has
      // already touched this CVR)
      contacts: Array.isArray(c.contacts) ? c.contacts : undefined,
      kaspr_enriched_at: c.kaspr_enriched_at || undefined,
      listId,
      addedAt: now,
      promotedFromReviewQueue: true,
    });
    existing.add(cvr);
    promoted++;
  }
  saveUserData(req.userId, d);
  res.json({ ok: true, promoted, skippedDup, skippedNotInPool });
});

// GET /api/discovery/review-queue — ICP-klar leads from state.json that
// haven't yet been promoted into the user's leads list. Drives the
// "Review queue" UX on Dashboard / Autodialer that lets the SDR bulk-
// approve ICP-fit discoveries.
app.get("/api/discovery/review-queue", authMiddleware, (req, res) => {
  const ud = loadUserData(req.userId);
  const claimed = new Set((ud.leads || []).map((l) => l.cvr));
  const pool = loadDiscoveryState().companies || {};
  const source = String(req.query.source || "");
  const rows = [];
  for (const cvr of Object.keys(pool)) {
    const c = pool[cvr];
    if (!c?.icpFit) continue;
    if (claimed.has(cvr)) continue;
    if (c.pushed_to_cloudtalk_at || c.twenty_opportunity_id) continue;
    if (source && (c.source || "meta-scraper") !== source) continue;
    rows.push(c);
  }
  // Highest priority first — most ads suggests heaviest advertiser.
  rows.sort((a, b) => (b.ads?.matched || 0) - (a.ads?.matched || 0));
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ total: rows.length, rows: rows.slice(0, limit) });
});

// POST /api/leads/import — bulk-import a CSV-derived list of companies.
//
// Body: { rows: [{ name, cvr?, website?, phone?, email?, source? }, ...], listId? }
// Per row:
//   - If `cvr` is present (8 digits) → fetch enrichment from Datafordeler
//   - Else try exact-name match in Datafordeler. If found → enrich. If not
//     → still create the lead with whatever fields the CSV gave us, flagged
//     as `unmatched: true` so the UI can offer manual CVR fill-in later.
//
// Source defaults to "csv". Source preserved on the lead so we know which
// channel surfaced it (sales-navigator / apollo / partner-list / etc).
app.post("/api/leads/import", authMiddleware, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || rows.length === 0) return res.status(400).json({ error: "rows[] mangler" });
  if (rows.length > 5000) return res.status(413).json({ error: "Max 5000 rækker pr. import" });
  const listId = req.body.listId || "ungrouped";
  const d = loadUserData(req.userId);
  const existing = new Set(d.leads.map((l) => l.cvr));
  const now = new Date().toISOString();

  const stats = { imported: 0, alreadyExists: 0, matched: 0, unmatched: 0, errors: 0, details: [] };

  // Cap concurrent Datafordeler lookups so we don't hammer the API for big imports.
  const CONC = 4;
  const queue = [...rows];
  const workers = Array.from({ length: CONC }, async () => {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) break;
      try {
        const name = String(row.name || row.company || row["Company Name"] || row["Account Name"] || "").trim();
        const cvrRaw = String(row.cvr || row.CVR || "").replace(/\D/g, "");
        if (!name && !cvrRaw) { stats.errors++; stats.details.push({ row, reason: "no name or CVR" }); continue; }

        let company = null;
        if (cvrRaw && /^\d{8}$/.test(cvrRaw)) {
          // Try CVR lookup directly.
          try { company = await lookupDatafordeler(cvrRaw); } catch (_) {}
        }
        if (!company && name) {
          // Best-effort exact-name match (a few variants for the common A/S / ApS suffix dance).
          const variants = [name, `${name} A/S`, `${name} ApS`, name.toUpperCase(), `${name.toUpperCase()} A/S`];
          for (const v of variants) {
            try {
              const r = await dfGqlFetch(
                `{ CVR_Navn(first: 3, where: { vaerdi: { eq: "${v.replace(/"/g, '\\"')}" } }) { edges { node { CVREnhedsId vaerdi } } } }`,
              );
              const hit = r?.CVR_Navn?.edges?.[0]?.node;
              if (hit) {
                // Get CVR number from enhedsId
                const r2 = await dfGqlFetch(
                  `{ CVR_Virksomhed(first: 1, where: { id: { eq: "${hit.CVREnhedsId}" } }) { edges { node { CVRNummer } } } }`,
                );
                const cvrNr = r2?.CVR_Virksomhed?.edges?.[0]?.node?.CVRNummer;
                if (cvrNr) { company = await lookupDatafordeler(String(cvrNr)).catch(() => null); }
              }
              if (company) break;
            } catch (_) {}
          }
        }

        if (company) {
          if (existing.has(company.cvr)) { stats.alreadyExists++; continue; }
          d.leads.push({
            ...company,
            // CSV-provided fields override Datafordeler ones (the user knows their leads).
            web: row.website || row.URL || row.domain || company.web,
            ph: row.phone || company.ph,
            em: row.email || company.em,
            listId,
            addedAt: now,
            source: row.source || "csv",
          });
          existing.add(company.cvr);
          stats.imported++;
          stats.matched++;
        } else {
          // Unmatched — still keep the row so the SDR can act on it (Kaspr lookup
          // by name etc.). Generate a synthetic key so we don't collide with real CVRs.
          const syntheticCvr = "csv-" + (cvrRaw || name.replace(/\s+/g, "-")).slice(0, 40);
          if (existing.has(syntheticCvr)) { stats.alreadyExists++; continue; }
          d.leads.push({
            cvr: syntheticCvr,
            name,
            web: row.website || row.URL || row.domain || "",
            ph: row.phone || "",
            em: row.email || "",
            city: row.city || "",
            ind: row.industry || "",
            unmatched: true,
            listId,
            addedAt: now,
            source: row.source || "csv",
          });
          existing.add(syntheticCvr);
          stats.imported++;
          stats.unmatched++;
        }
      } catch (e) {
        stats.errors++;
        stats.details.push({ row, reason: e.message });
      }
    }
  });
  await Promise.all(workers);

  saveUserData(req.userId, d);
  // Trim details to avoid blowing up the response
  stats.details = stats.details.slice(0, 20);
  res.json(stats);
});

app.delete("/api/leads/:cvr", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  d.leads = d.leads.filter((l) => l.cvr !== req.params.cvr);
  saveUserData(req.userId, d);
  res.json({ ok: true });
});

app.patch("/api/leads/:cvr", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const lead = d.leads.find((l) => l.cvr === req.params.cvr);
  if (!lead) return res.status(404).json({ error: "Lead ikke fundet" });
  Object.assign(lead, req.body);
  saveUserData(req.userId, d);
  res.json({ ok: true });
});

// ── ICP / Pipeline / Notes / Tags / Followup ──────────────────────────────────
app.patch("/api/meta/:cvr", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const { cvr } = req.params;
  const { icpScore, pipeline, pipelines: newPipelines, note, tags, followup, contacts, deal, history } = req.body;
  if (icpScore !== undefined) { d.icpScores = d.icpScores || {}; d.icpScores[cvr] = icpScore; }
  if (pipeline !== undefined) { d.pipeline = d.pipeline || {}; d.pipeline[cvr] = pipeline; }
  if (newPipelines !== undefined) { d.pipelines = newPipelines; }
  if (note !== undefined) { d.notes = d.notes || {}; d.notes[cvr] = note; }
  if (tags !== undefined) { d.tags = d.tags || {}; d.tags[cvr] = tags; }
  if (followup !== undefined) { d.followup = d.followup || {}; d.followup[cvr] = followup; }
  if (contacts !== undefined) { d.contacts = d.contacts || {}; d.contacts[cvr] = contacts; }
  if (deal !== undefined) { d.deal = d.deal || {}; d.deal[cvr] = deal; }
  if (history !== undefined) { d.history = d.history || {}; d.history[cvr] = history; }
  saveUserData(req.userId, d);
  res.json({ ok: true });
});

// ── Cross-user pipeline push (SDR → AE) ───────────────────────────────────────
// When an SDR books a meeting, push the lead into every AE user's pipeline.
app.post("/api/pipeline-push", authMiddleware, (req, res) => {
  const { cvr, company, aeStage } = req.body;
  if (!cvr || !aeStage) return res.status(400).json({ error: "cvr og aeStage er påkrævet" });
  const users = loadUsers();
  const aeUsers = users.filter(u => u.role === "AE");
  aeUsers.forEach(aeUser => {
    const d = loadUserData(aeUser.id);
    // Add lead to AE's leads list if not already there
    if (company && !d.leads.find(l => l.cvr === cvr)) {
      d.leads.push({ ...company, addedAt: new Date().toISOString(), listId: "ungrouped" });
    }
    // Set AE pipeline stage
    ensurePipelines(d);
    d.pipelines.ae[cvr] = aeStage;
    d.pipeline = d.pipeline || {};
    d.pipeline[cvr] = aeStage;
    saveUserData(aeUser.id, d);
  });
  res.json({ ok: true, pushedTo: aeUsers.map(u => u.name) });
});

// ── Lister ────────────────────────────────────────────────────────────────────
app.post("/api/lists", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Navn mangler" });
  const list = { id: "list_" + Date.now(), name: name.trim(), createdAt: new Date().toISOString() };
  d.lists = d.lists || [{ id: "all", name: "Alle leads" }];
  d.lists.push(list);
  saveUserData(req.userId, d);
  res.json(list);
});

app.delete("/api/lists/:id", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  d.lists = (d.lists || []).filter((l) => l.id !== req.params.id);
  d.leads = (d.leads || []).map((l) => (l.listId === req.params.id ? { ...l, listId: "ungrouped" } : l));
  saveUserData(req.userId, d);
  res.json({ ok: true });
});

// ── n8n webhook proxy ─────────────────────────────────────────────────────────
app.post("/api/webhook/n8n", async (req, res) => {
  const webhookUrl = req.body.webhookUrl || process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) return res.status(400).json({ error: "Ingen webhook URL konfigureret" });
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body.payload),
    });
    res.json({ ok: true, status: r.status });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Default call scripts ──────────────────────────────────────────────────────
const DEFAULT_SCRIPTS = [
  {
    id: "script_cold",
    name: "Kold opkald",
    text: `Hej [navn], mit navn er [dit navn] fra Vedio. Har du 2 minutter til en hurtig snak?

Vi hjælper B2B-virksomheder med at finde, berige og bearbejde leads automatisk via CVR-data og AI.

Må jeg spørge — bruger I i dag et system til at finde nye kunder, eller er det mere manuelt?

Hvad er den største udfordring ved jeres nuværende lead-proces? Tid, kvalitet, opfølgning?

Det vi ser mange opleve er netop det — vi automatiserer hele prospecting-delen, så I kan fokusere på selve salget.

Ville det give mening at sætte 30 min af til en demo, så I kan se det i praksis? Hvad passer dig bedst — tirsdag eller onsdag?`,
    steps: []
  },
  {
    id: "script_followup",
    name: "Opfølgning",
    text: `Hej [navn], det er [dit navn] fra Vedio igen. Vi talte for [X dage] siden — har du haft tid til at tænke over det?

Jeg husker du nævnte [pain] som den største udfordring. Er det stadig aktuelt?

Siden vi talte har vi hjulpet en virksomhed i [deres branche] med netop det — de oplevede [resultat].

Er der noget der mangler for at I kan tage en beslutning? Hvem else skal med i loopet?

Lad os sætte en demo i kalenderen — hvornår passer det dig?`,
    steps: []
  }
];

// ── Generic CRUD factory for array collections ────────────────────────────────
// Registers GET / POST / PATCH /:id / DELETE /:id routes for a user-data field.
//   route      — URL segment, e.g. "calls"
//   field      — key in the user-data object, e.g. "callLog"
//   idPrefix   — prefix for generated IDs, e.g. "call_"
//   defaults   — extra fields merged into POST body before req.body
//   postPush   — use push() instead of unshift() on POST (default: false)
//   getInit    — optional fn(d, userId) called before GET response (for seeding)
function registerCrud(route, field, idPrefix, { defaults = {}, postPush = false, getInit = null } = {}) {
  app.get(`/api/${route}`, authMiddleware, (req, res) => {
    const d = loadUserData(req.userId);
    if (getInit) getInit(d, req.userId);
    res.json(d[field] || []);
  });

  app.post(`/api/${route}`, authMiddleware, (req, res) => {
    const d = loadUserData(req.userId);
    if (!d[field]) d[field] = [];
    const item = { id: idPrefix + Date.now(), createdAt: new Date().toISOString(), ...defaults, ...req.body };
    postPush ? d[field].push(item) : d[field].unshift(item);
    saveUserData(req.userId, d);
    res.json(item);
  });

  app.patch(`/api/${route}/:id`, authMiddleware, (req, res) => {
    const d = loadUserData(req.userId);
    const arr = d[field] || [];
    const idx = arr.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Ikke fundet" });
    arr[idx] = { ...arr[idx], ...req.body };
    d[field] = arr;
    saveUserData(req.userId, d);
    res.json(arr[idx]);
  });

  app.delete(`/api/${route}/:id`, authMiddleware, (req, res) => {
    const d = loadUserData(req.userId);
    d[field] = (d[field] || []).filter(x => x.id !== req.params.id);
    saveUserData(req.userId, d);
    res.json({ ok: true });
  });
}

// ── Calls / Demos / Scripts ───────────────────────────────────────────────────
registerCrud("calls",   "callLog",     "call_");
registerCrud("demos",   "demoLog",     "demo_",   { defaults: { status: "scheduled" } });
registerCrud("scripts", "callScripts", "script_", {
  defaults:  { steps: [] },
  postPush:  true,
  getInit:   (d, userId) => {
    if (!d.callScripts || d.callScripts.length === 0) {
      d.callScripts = JSON.parse(JSON.stringify(DEFAULT_SCRIPTS));
      saveUserData(userId, d);
    }
  },
});

// ── AI Analysis (calls + demos) ───────────────────────────────────────────────
app.post("/api/analyze", authMiddleware, async (req, res) => {
  const { type, notes, duration, outcome, companyName, contactName, pains, solutions } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Return basic rule-based analysis if no API key
    const score = outcome === "interested" || outcome === "booked" ? 8 :
                  outcome === "callback" ? 6 :
                  outcome === "not-interested" ? 4 : 5;
    return res.json({
      score,
      summary: `${type === "call" ? "Opkald" : "Demo"} afsluttet med udfald: ${outcome || "ukendt"}.`,
      strengths: ["God forberedelse", "Klart kommunikeret"],
      improvements: ["Husk at stille åbne spørgsmål", "Sæt altid en konkret næste dato"],
      nextStep: outcome === "callback" ? "Ring igen om 2-3 dage" : "Opfølg via email inden 24 timer"
    });
  }
  try {
    const prompt = type === "call"
      ? `Analyser dette salgsopkald og giv konkret feedback på dansk.\n\nVirksomhed: ${companyName || "Ukendt"}\nKontakt: ${contactName || "Ukendt"}\nVarighed: ${Math.floor((duration||0)/60)} min\nUdfald: ${outcome || "ukendt"}\nNotater:\n${notes || "(ingen notater)"}\n\nGiv:\n1. Score 1-10\n2. Hvad gik godt (2-3 punkter)\n3. Hvad kan forbedres (2-3 punkter)\n4. Anbefalet næste skridt\nSvar som JSON: {score, summary, strengths:[], improvements:[], nextStep}`
      : `Analyser denne demo og giv feedback på dansk.\n\nVirksomhed: ${companyName || "Ukendt"}\nKontakt: ${contactName || "Ukendt"}\nSmerter: ${(pains||[]).join(", ") || "(ingen)"}\nLøsninger: ${(solutions||[]).join(", ") || "(ingen)"}\nNotater: ${notes || "(ingen)"}\n\nGiv:\n1. Score 1-10\n2. Hvad gik godt\n3. Hvad kan forbedres\n4. Næste skridt for at lukke dealen\nSvar som JSON: {score, summary, strengths:[], improvements:[], nextStep}`;

    const analysis = await callAnthropic(apiKey, prompt, 512);
    res.json(analysis || { score: 5, summary: "AI-analyse ikke tilgængelig.", strengths: [], improvements: [], nextStep: "" });
  } catch (err) {
    res.json({ score: 5, summary: "AI-analyse ikke tilgængelig.", strengths: [], improvements: [], nextStep: "" });
  }
});

// ── Revenue Intelligence AI ───────────────────────────────────────────────────
app.post("/api/revenue-intelligence", authMiddleware, async (req, res) => {
  const { activeDeals, wonDeals, lostDeals, hotDeals, icpStats, actStats, topIndustries } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const insights = [];
    if (hotDeals?.length) insights.push(`🔥 ${hotDeals[0]?.name} ser mest lovende ud — prioritér opfølgning nu.`);
    if (icpStats?.best) insights.push(`🏆 ICP ${icpStats.best}★ har den højeste win rate — fokusér prospektering her.`);
    if (actStats?.topType) insights.push(`📞 ${actStats.topType} er den aktivitet der korrelerer mest med wins — book flere.`);
    if ((lostDeals||0) > (wonDeals||0)) insights.push(`⚠️ Tabet/vundet ratio er negativ — undersøg kvalificeringsprocessen.`);
    return res.json({
      signal: insights.length ? insights.join(" ") : "Tilføj flere deals og aktiviteter for at generere indsigter.",
      actions: ["Sørg for at alle aktive deals har et næste skridt planlagt","Prioritér deals med høj ICP-score og seneste aktivitet","Book et møde med de varmeste deals denne uge"],
      strategy: "Fokusér på kvalitet frem for kvantitet — færre, bedre kvalificerede leads lukker hurtigere."
    });
  }
  try {
    const prompt = `Du er en erfaren B2B revenue intelligence-rådgiver. Analyser nedenstående salgsdata og giv konkrete, handlingsorienterede indsigter på dansk.\n\nPipeline-data:\n- Aktive deals: ${activeDeals}\n- Vundne deals: ${wonDeals}\n- Tabte deals: ${lostDeals}\n- Varmeste deals: ${hotDeals?.map(d=>`${d.name} (${d.stage}, ${d.prob}% sandsynlighed)`).join(", ")||"ingen"}\n- Bedste ICP-niveau: ${icpStats?.best?icpStats.best+"★ med "+icpStats.bestRate+"% win rate":"utilstrækkelig data"}\n- Top-branche: ${topIndustries?.[0]||"ukendt"}\n- Mest effektiv aktivitet: ${actStats?.topType||"ukendt"}\n\nGiv:\n1. Ét kort overordnet revenue signal (2 sætninger max)\n2. Tre konkrete prioriterede handlinger sælgeren bør tage NU\n3. Én strategisk anbefaling til pipeline-opbygning\n\nSvar KUN som JSON: {"signal":"...","actions":["...","...","..."],"strategy":"..."}`;
    const result = await callAnthropic(apiKey, prompt, 600);
    res.json(result || { signal: "AI ikke tilgængelig.", actions: [], strategy: "" });
  } catch(err) {
    res.json({ signal: "AI ikke tilgængelig.", actions: [], strategy: "" });
  }
});

// ── Deal Risk AI Analysis ─────────────────────────────────────────────────────
app.post("/api/deals/risk", authMiddleware, async (req, res) => {
  const { cvr, companyName, stage, staleDays, hasNextStep, missingData, contactName, mrr, arr, plan } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const suggestions = [];
    if (!hasNextStep) suggestions.push("Book en konkret opfølgning med en fast dato");
    if (staleDays > 7) suggestions.push(`Send en check-in email — ${staleDays} dage siden sidst aktivitet`);
    if ((missingData||[]).includes("Ingen kontaktperson")) suggestions.push("Find og registrér en kontaktperson for virksomheden");
    if (!mrr && !arr) suggestions.push("Aftal og registrér deal-størrelsen (MRR/ARR) under Deal-fanen");
    if (!plan) suggestions.push("Afklar hvilken Vedio-plan kunden skal have");
    return res.json({
      summary: `Deal med ${companyName||"virksomheden"} kræver opmærksomhed: ${suggestions.length} risikofaktorer identificeret.`,
      suggestions: suggestions.length ? suggestions : ["Dealen ser sund ud — fortsæt fremgangen!"],
      nextStep: suggestions[0] || "Fortsæt som planlagt"
    });
  }
  try {
    const missingStr = (missingData||[]).join(", ") || "Ingen";
    const prompt = `Du er en senior B2B sales coach. Analyser dette deal og giv konkrete handlinger på dansk.

Virksomhed: ${companyName||"Ukendt"}
Pipeline-fase: ${stage||"Ukendt"}
Dage siden sidste aktivitet: ${staleDays}
Har næste skridt planlagt: ${hasNextStep?"Ja":"Nej"}
Kontaktperson: ${contactName||"Ikke registreret"}
MRR: ${mrr?mrr+" kr.":"Ikke angivet"}
ARR: ${arr?arr+" kr.":"Ikke angivet"}
Plan: ${plan||"Ikke valgt"}
Manglende data: ${missingStr}

Giv:
1. En kort situationsanalyse (max 2 sætninger)
2. Top 3 konkrete handlinger sælgeren bør tage nu (prioriteret)
3. Det vigtigste næste skridt

Svar KUN som JSON: {"summary":"...","suggestions":["...","...","..."],"nextStep":"..."}`;
    const analysis = await callAnthropic(apiKey, prompt, 600);
    res.json(analysis || { summary: "AI-analyse ikke tilgængelig.", suggestions: [], nextStep: "" });
  } catch (err) {
    res.json({ summary: "AI-analyse ikke tilgængelig.", suggestions: [], nextStep: "" });
  }
});

// ── Twilio ────────────────────────────────────────────────────────────────────
app.get("/api/twilio/status", authMiddleware, (req, res) => {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  const appSid= process.env.TWILIO_TWIML_APP_SID;
  const configured = !!(sid && token && from);
  const ready      = !!(configured && appSid);
  res.json({ configured, ready, from: from || null, hasAppSid: !!appSid });
});

// Browser capability token — lets the browser place outbound calls via Twilio Voice JS SDK
app.get("/api/twilio/token", authMiddleware, async (req, res) => {
  const sid    = process.env.TWILIO_ACCOUNT_SID;
  const token  = process.env.TWILIO_AUTH_TOKEN;
  const appSid = process.env.TWILIO_TWIML_APP_SID;
  if (!sid || !token || !appSid) {
    return res.status(503).json({ error: "Twilio ikke konfigureret" });
  }
  try {
    // Dynamically require twilio only if credentials are present (optional dependency)
    const twilio = require("twilio");
    const AccessToken    = twilio.jwt.AccessToken;
    const VoiceGrant     = AccessToken.VoiceGrant;
    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: false });
    const accessToken = new AccessToken(sid, token, process.env.TWILIO_API_KEY || token, {
      identity: req.userId,
      ttl: 3600
    });
    accessToken.addGrant(voiceGrant);
    res.json({ token: accessToken.toJwt(), from: process.env.TWILIO_FROM_NUMBER });
  } catch (err) {
    res.status(500).json({ error: "Kunne ikke generere token: " + err.message });
  }
});

// TwiML webhook — Twilio calls this to get instructions when a browser places a call
app.post("/api/twilio/voice", (req, res) => {
  const to   = req.body.To   || req.query.To;
  const from = process.env.TWILIO_FROM_NUMBER;
  res.type("text/xml");
  if (to) {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${from}">
    <Number>${to}</Number>
  </Dial>
</Response>`);
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="da-DK">Intet nummer angivet.</Say></Response>`);
  }
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get("/api/status", async (req, res) => {
  const hasDatafordeler = !!process.env.DATAFORDELER_KEY;
  const users = loadUsers();
  // Check outbound IP
  let outboundIp = '';
  try { const r = await fetch('https://api.ipify.org?format=json'); const d = await r.json(); outboundIp = d.ip; } catch(e) {}
  // Quick Datafordeler connectivity test
  let dfStatus = 'not configured';
  if (hasDatafordeler) {
    try {
      await dfGqlFetch('{ CVR_Virksomhed(first: 1, where: { CVRNummer: { eq: 10150817 } }) { edges { node { id } } } }');
      dfStatus = 'connected';
    } catch(e) { dfStatus = 'error: ' + e.message.substring(0, 100); }
  }
  res.json({
    status: "ok",
    provider: "datafordeler",
    hasDatafordeler,
    datafordelerStatus: dfStatus,
    outboundIp,
    userCount: users.length,
    version: "2.2.0",
    auth: true,
  });
});

// ── Gmail Integration ─────────────────────────────────────────────────────────
const GMAIL_CONFIG_FILE = path.join(DATA_DIR, "gmail_oauth.json");

function loadGmailConfig() {
  try { if (fs.existsSync(GMAIL_CONFIG_FILE)) return JSON.parse(fs.readFileSync(GMAIL_CONFIG_FILE, "utf-8")); } catch (e) {}
  // Fall back to env vars for backwards-compatibility
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/mail/callback" };
  }
  return null;
}

function saveGmailConfig(cfg) {
  fs.writeFileSync(GMAIL_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function makeOAuth2Client() {
  const { google } = require("googleapis");
  const cfg = loadGmailConfig();
  if (!cfg) throw new Error("Gmail OAuth ikke konfigureret");
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri || "http://localhost:3000/api/mail/callback");
}

async function getGmailClient(userId) {
  const { google } = require("googleapis");
  const d = loadUserData(userId);
  if (!d.gmailTokens) throw new Error("Gmail ikke forbundet");
  const auth = makeOAuth2Client();
  auth.setCredentials(d.gmailTokens);
  // Auto-refresh token if expired
  auth.on("tokens", (tokens) => {
    if (tokens.refresh_token) d.gmailTokens.refresh_token = tokens.refresh_token;
    d.gmailTokens.access_token  = tokens.access_token;
    d.gmailTokens.expiry_date   = tokens.expiry_date;
    saveUserData(userId, d);
  });
  return google.gmail({ version: "v1", auth });
}

function decodeMailBody(payload) {
  const decode = (data) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  if (payload.body && payload.body.data) return { html: false, content: decode(payload.body.data) };
  if (payload.parts) {
    const html = payload.parts.find(p => p.mimeType === "text/html");
    const plain = payload.parts.find(p => p.mimeType === "text/plain");
    const recurse = (parts) => {
      for (const p of parts) {
        if (p.mimeType === "text/html" && p.body?.data) return { html: true, content: decode(p.body.data) };
        if (p.parts) { const r = recurse(p.parts); if (r) return r; }
      }
      return null;
    };
    const deep = recurse(payload.parts);
    if (deep) return deep;
    if (html?.body?.data) return { html: true, content: decode(html.body.data) };
    if (plain?.body?.data) return { html: false, content: decode(plain.body.data) };
  }
  return { html: false, content: "" };
}

// Gmail config (admin saves Client ID + Secret via UI)
app.get("/api/mail/config", authMiddleware, (req, res) => {
  const cfg = loadGmailConfig();
  res.json({ configured: !!cfg, redirectUri: cfg?.redirectUri || `http://localhost:${PORT}/api/mail/callback` });
});

app.post("/api/mail/config", authMiddleware, (req, res) => {
  const { clientId, clientSecret, redirectUri } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: "clientId og clientSecret er påkrævet" });
  const cfg = { clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri: (redirectUri || `http://localhost:${PORT}/api/mail/callback`).trim() };
  saveGmailConfig(cfg);
  res.json({ ok: true, redirectUri: cfg.redirectUri });
});

app.delete("/api/mail/config", authMiddleware, (req, res) => {
  try { if (fs.existsSync(GMAIL_CONFIG_FILE)) fs.unlinkSync(GMAIL_CONFIG_FILE); } catch (e) {}
  res.json({ ok: true });
});

// Gmail status
app.get("/api/mail/status", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const cfg = loadGmailConfig();
  if (!cfg) return res.json({ configured: false, connected: false, email: null });
  if (!d.gmailTokens) return res.json({ configured: true, connected: false, email: null });
  res.json({ configured: true, connected: true, email: d.gmailEmail || null });
});

// Gmail OAuth URL
app.get("/api/mail/auth-url", authMiddleware, (req, res) => {
  if (!loadGmailConfig()) return res.status(503).json({ error: "Google OAuth ikke konfigureret" });
  const auth = makeOAuth2Client();
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/calendar"],
    state: req.headers.authorization?.replace("Bearer ", "").trim(),
  });
  res.json({ url });
});

// Gmail OAuth callback
app.get("/api/mail/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send("Mangler kode fra Google");
  const userId = state ? sessions.get(state) : null;
  if (!userId) return res.status(401).send("Session udløbet — log ind igen og forbind Gmail");
  try {
    const auth = makeOAuth2Client();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);
    // Get user email
    const { google } = require("googleapis");
    const oauth2 = google.oauth2({ version: "v2", auth });
    const info = await oauth2.userinfo.get();
    const d = loadUserData(userId);
    d.gmailTokens = tokens;
    d.gmailEmail  = info.data.email;
    saveUserData(userId, d);
    res.redirect("/?view=mail&gmailConnected=1");
  } catch (err) {
    res.status(500).send("Kunne ikke forbinde Gmail: " + err.message);
  }
});

// Gmail disconnect
app.delete("/api/mail/disconnect", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  delete d.gmailTokens;
  delete d.gmailEmail;
  saveUserData(req.userId, d);
  res.json({ ok: true });
});

// List messages
app.get("/api/mail/messages", authMiddleware, async (req, res) => {
  try {
    const gmail = await getGmailClient(req.userId);
    const { q = "in:inbox", pageToken, maxResults = 25 } = req.query;
    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: Number(maxResults), pageToken: pageToken || undefined });
    const ids = (list.data.messages || []).map(m => m.id);
    if (!ids.length) return res.json({ messages: [], nextPageToken: null });
    // Fetch metadata for each message in parallel
    const messages = await Promise.all(ids.map(id =>
      gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] })
        .then(r => {
          const h = {};
          (r.data.payload?.headers || []).forEach(x => { h[x.name] = x.value; });
          return { id, threadId: r.data.threadId, snippet: r.data.snippet, labelIds: r.data.labelIds || [], from: h.From || "", to: h.To || "", subject: h.Subject || "(Intet emne)", date: h.Date || "", unread: (r.data.labelIds||[]).includes("UNREAD") };
        })
    ));
    res.json({ messages, nextPageToken: list.data.nextPageToken || null });
  } catch (err) {
    res.status(err.message === "Gmail ikke forbundet" ? 401 : 500).json({ error: err.message });
  }
});

// Get full message
app.get("/api/mail/messages/:id", authMiddleware, async (req, res) => {
  try {
    const gmail = await getGmailClient(req.userId);
    const r = await gmail.users.messages.get({ userId: "me", id: req.params.id, format: "full" });
    const h = {};
    (r.data.payload?.headers || []).forEach(x => { h[x.name] = x.value; });
    const body = decodeMailBody(r.data.payload);
    // Mark as read
    if ((r.data.labelIds||[]).includes("UNREAD")) {
      await gmail.users.messages.modify({ userId: "me", id: req.params.id, requestBody: { removeLabelIds: ["UNREAD"] } }).catch(() => {});
    }
    res.json({ id: r.data.id, threadId: r.data.threadId, from: h.From||"", to: h.To||"", subject: h.Subject||"(Intet emne)", date: h.Date||"", body: body.content, isHtml: body.html, labelIds: r.data.labelIds||[] });
  } catch (err) {
    res.status(err.message === "Gmail ikke forbundet" ? 401 : 500).json({ error: err.message });
  }
});

// Send message
app.post("/api/mail/send", authMiddleware, async (req, res) => {
  try {
    const gmail = await getGmailClient(req.userId);
    const { to, subject, body, threadId, replyTo } = req.body;
    const d = loadUserData(req.userId);
    const from = d.gmailEmail || "me";
    let raw = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", body].join("\r\n");
    if (replyTo) raw = `In-Reply-To: ${replyTo}\r\nReferences: ${replyTo}\r\n` + raw;
    const encoded = Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const params = { userId: "me", requestBody: { raw: encoded } };
    if (threadId) params.requestBody.threadId = threadId;
    const r = await gmail.users.messages.send(params);
    res.json({ id: r.data.id, threadId: r.data.threadId });
  } catch (err) {
    res.status(err.message === "Gmail ikke forbundet" ? 401 : 500).json({ error: err.message });
  }
});

// Trash message
app.delete("/api/mail/messages/:id", authMiddleware, async (req, res) => {
  try {
    const gmail = await getGmailClient(req.userId);
    await gmail.users.messages.trash({ userId: "me", id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar Integration ───────────────────────────────────────────────
async function getCalendarClient(userId) {
  const { google } = require("googleapis");
  const d = loadUserData(userId);
  if (!d.gmailTokens) throw new Error("Google ikke forbundet — forbind via Mail-indstillinger");
  const auth = makeOAuth2Client();
  auth.setCredentials(d.gmailTokens);
  auth.on("tokens", (tokens) => {
    if (tokens.refresh_token) d.gmailTokens.refresh_token = tokens.refresh_token;
    d.gmailTokens.access_token = tokens.access_token;
    d.gmailTokens.expiry_date  = tokens.expiry_date;
    saveUserData(userId, d);
  });
  return google.calendar({ version: "v3", auth });
}

// Calendar status
app.get("/api/calendar/status", authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const oauthConfigured = !!loadGmailConfig();
  const connected = !!(d.gmailTokens);
  res.json({ oauthConfigured, connected, email: d.gmailEmail || null });
});

// List user calendars
app.get("/api/calendar/list", authMiddleware, async (req, res) => {
  try {
    const cal = await getCalendarClient(req.userId);
    const r = await cal.calendarList.list({ maxResults: 20 });
    res.json(r.data.items || []);
  } catch (err) {
    res.status(err.message.includes("ikke forbundet") ? 401 : 500).json({ error: err.message });
  }
});

// List events
app.get("/api/calendar/events", authMiddleware, async (req, res) => {
  try {
    const cal = await getCalendarClient(req.userId);
    const { timeMin, timeMax, calendarId = "primary", maxResults = 100 } = req.query;
    const r = await cal.events.list({
      calendarId,
      timeMin: timeMin || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      timeMax: timeMax || new Date(new Date().getFullYear(), new Date().getMonth() + 2, 0).toISOString(),
      maxResults: Number(maxResults),
      singleEvents: true,
      orderBy: "startTime",
    });
    res.json(r.data.items || []);
  } catch (err) {
    res.status(err.message.includes("ikke forbundet") ? 401 : 500).json({ error: err.message });
  }
});

// Create event
app.post("/api/calendar/events", authMiddleware, async (req, res) => {
  try {
    const cal = await getCalendarClient(req.userId);
    const { title, start, end, description, location, calendarId = "primary", allDay } = req.body;
    const event = {
      summary: title,
      description: description || "",
      location: location || "",
      start: allDay ? { date: start } : { dateTime: start, timeZone: "Europe/Copenhagen" },
      end:   allDay ? { date: end   } : { dateTime: end,   timeZone: "Europe/Copenhagen" },
    };
    const r = await cal.events.insert({ calendarId, requestBody: event });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update event
app.patch("/api/calendar/events/:id", authMiddleware, async (req, res) => {
  try {
    const cal = await getCalendarClient(req.userId);
    const { calendarId = "primary", ...body } = req.body;
    const existing = await cal.events.get({ calendarId, eventId: req.params.id });
    const allDay = !!body.allDay;
    const updated = { ...existing.data,
      summary: body.title || existing.data.summary,
      description: body.description ?? existing.data.description,
      start: allDay ? { date: body.start } : { dateTime: body.start, timeZone: "Europe/Copenhagen" },
      end:   allDay ? { date: body.end   } : { dateTime: body.end,   timeZone: "Europe/Copenhagen" },
    };
    const r = await cal.events.update({ calendarId, eventId: req.params.id, requestBody: updated });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete event
app.delete("/api/calendar/events/:id", authMiddleware, async (req, res) => {
  try {
    const cal = await getCalendarClient(req.userId);
    const calendarId = req.query.calendarId || "primary";
    await cal.events.delete({ calendarId, eventId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GEMINI AI ENRICHMENT ──────────────────────────────────────────────────────
// ICP (Ideal Customer Profile) definition — sales team should customize these values
// to match target market segments, company sizes, and geographic preferences.
const ICP_DEFINITION = {
  industry_fit: {
    max: 25,
    ideal: ['Manufacturing', 'Logistics', 'Professional Services', 'Construction', 'Wholesale'],
    description: 'Target industries for our solution'
  },
  company_size: {
    max: 25,
    ideal_min: 20, ideal_max: 500,
    description: 'Ideal employee count range'
  },
  company_maturity: {
    max: 15,
    ideal_min_years: 3, ideal_max_years: 25,
    description: 'Years in operation sweet spot'
  },
  geography: {
    max: 15,
    ideal_regions: ['Jylland', 'Sjælland metro'],
    description: 'Priority geographic areas'
  },
  growth_signals: {
    max: 20,
    signals: ['increasing employees', 'multiple P-units', 'recent changes'],
    description: 'Positive growth indicators'
  }
};

// ── Enrichment DB (JSON file + 5min hot cache) ──────────────────────────────
const ENRICHMENTS_FILE = path.join(DATA_DIR, 'data_enrichments.json');
const ENRICH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days before re-enriching
const ENRICH_HOT_TTL = 5 * 60 * 1000; // 5 min in-memory hot cache

// ── ICP Settings (persisted to file) ─────────────────────────────────────────
const ICP_FILE = path.join(DATA_DIR, 'data_icp.json');
let _icpCache = null;
let _icpCacheTs = 0;
const ICP_CACHE_TTL = 5 * 60 * 1000; // 5 min cache

function getIcpSettings() {
  if (_icpCache && Date.now() - _icpCacheTs < ICP_CACHE_TTL) return _icpCache;
  const saved = loadJsonFile(ICP_FILE, null);
  if (saved) { _icpCache = saved; _icpCacheTs = Date.now(); return saved; }
  // Return defaults
  return {
    name: 'Default ICP',
    description: 'B2B companies in Denmark',
    version: 'v1',
    criteria: {
      industry_fit: { weight: 25, ideal: 'Manufacturing, Logistics, Professional Services, Construction, Wholesale', avoid: 'Holdings, shell companies, sole proprietors' },
      company_size: { weight: 25, ideal: '20-500 employees', avoid: 'Micro companies under 5 employees' },
      company_maturity: { weight: 15, ideal: '3-25 years old', avoid: 'Startups under 1 year, very old stagnant companies' },
      geography: { weight: 15, ideal: 'Jylland and Sjælland metro areas', avoid: 'Remote islands' },
      growth_signals: { weight: 20, ideal: 'Increasing employees, multiple P-units, recent changes', avoid: 'Declining revenue, layoffs' }
    }
  };
}

function saveIcpSettings(data) {
  _icpCache = data;
  _icpCacheTs = Date.now();
  try { fs.writeFileSync(ICP_FILE, JSON.stringify(data, null, 2)); } catch(e) { console.error('[icp] Save failed:', e.message); }
}

const _enrichHot = new Map();

function loadEnrichments() { return loadJsonFile(ENRICHMENTS_FILE, {}); }
function saveEnrichments(data) { try { fs.writeFileSync(ENRICHMENTS_FILE, JSON.stringify(data, null, 2)); } catch(e) { console.error('[enrich] Save failed:', e.message); } }

function enrichDbGet(cvr) {
  // Hot cache first
  const hot = _enrichHot.get(cvr);
  if (hot && Date.now() - hot.ts < ENRICH_HOT_TTL) return hot.data;
  // File DB
  const db = loadEnrichments();
  const entry = db[cvr];
  if (!entry) return null;
  // Cache in hot
  _enrichHot.set(cvr, { data: entry, ts: Date.now() });
  return entry;
}

function enrichDbSet(cvr, profile, score) {
  const db = loadEnrichments();
  const entry = {
    cvr_number: cvr,
    profile_data: profile || null,
    score_data: score || null,
    enriched_at: new Date().toISOString(),
    icp_version: getIcpSettings().version
  };
  db[cvr] = entry;
  saveEnrichments(db);
  _enrichHot.set(cvr, { data: entry, ts: Date.now() });
  return entry;
}

function enrichIsStale(entry) {
  if (!entry?.enriched_at) return true;
  return Date.now() - new Date(entry.enriched_at).getTime() > ENRICH_MAX_AGE;
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  // Debug: log raw response structure
  const candidate = data.candidates?.[0];
  if (!candidate) { console.error('[gemini] No candidates in response:', JSON.stringify(data).substring(0, 500)); throw new Error('Gemini returned no candidates'); }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') { console.error('[gemini] Finish reason:', candidate.finishReason); }
  const parts = candidate.content?.parts || [];
  console.log(`[gemini] Got ${parts.length} parts, types: ${parts.map(p => p.thought ? 'thought' : 'text').join(',')}`);
  // Concatenate non-thought text parts
  let text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
  if (!text) text = parts.map(p => p.text || '').join('\n');
  console.log(`[gemini] Text length: ${text.length}, first 200: ${text.substring(0, 200)}`);
  // Strip markdown fences
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // Extract JSON object even if surrounded by extra text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Gemini response');
  try { return JSON.parse(jsonMatch[0]); }
  catch(e) {
    let fixed = jsonMatch[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    return JSON.parse(fixed);
  }
}

function buildProfilePrompt(c) {
  return `You are a B2B sales intelligence analyst. Analyze this Danish company and return ONLY valid JSON (no markdown, no backticks).

Company data:
- Name: ${c.name || c.cvr_number || ''}
- CVR: ${c.cvr_number || c.cvr || ''}
- Legal form: ${c.legal_form || c.form || ''}
- Industry code: ${c.industry_code || c.industryCode || ''}
- Industry: ${c.industry_description || c.industry || ''}
- Municipality: ${c.municipality || c.city || ''}
- Address: ${c.address || ''}
- Founded: ${c.founded_date || c.founded || ''}
- Employees: ${c.employee_interval || c.employees || ''}
- P-units: ${c.p_units || ''}
- Status: ${c.status || 'active'}
- Revenue: ${c.financials?.revenue || c.revenue || ''}
- Gross profit: ${c.financials?.grossProfit || c.grossProfit || ''}
- Equity: ${c.financials?.equity || c.equity || ''}

Return this exact JSON structure:
{
  "summary": "2-3 sentence company description in English",
  "industry_vertical": "one of: Manufacturing, Logistics, Professional Services, Construction, Wholesale, Retail, IT/Tech, Healthcare, Finance, Other",
  "estimated_revenue_bracket": "one of: Micro, Small, Medium, Large, Unknown",
  "key_facts": ["fact1", "fact2", "fact3"],
  "potential_pain_points": ["pain1", "pain2"],
  "conversation_starters": ["opener1", "opener2"]
}`;
}

function buildScorePrompt(c) {
  return `You are a B2B lead scoring analyst. Score this Danish company against the ICP criteria below. Return ONLY valid JSON (no markdown, no backticks).

Company data:
- Name: ${c.name || c.cvr_number || ''}
- CVR: ${c.cvr_number || c.cvr || ''}
- Legal form: ${c.legal_form || c.form || ''}
- Industry code: ${c.industry_code || c.industryCode || ''}
- Industry: ${c.industry_description || c.industry || ''}
- Municipality: ${c.municipality || c.city || ''}
- Address: ${c.address || ''}
- Founded: ${c.founded_date || c.founded || ''}
- Employees: ${c.employee_interval || c.employees || ''}
- P-units: ${c.p_units || ''}
- Status: ${c.status || 'active'}
- Revenue: ${c.financials?.revenue || c.revenue || ''}

ICP Criteria:
${Object.entries(getIcpSettings().criteria).map(([k, v], i) => `${i+1}. ${k.replace(/_/g,' ')} (max ${v.weight}): Ideal: ${v.ideal}. Avoid: ${v.avoid || 'N/A'}`).join('\n')}

Grading: A+ = 85-100, A = 70-84, B = 50-69, C = 30-49, D = 0-29

Return this exact JSON structure:
{
  "total_score": 75,
  "grade": "A",
  "criteria_scores": {
${Object.entries(getIcpSettings().criteria).map(([k, v]) => `    "${k}": { "score": 0, "max": ${v.weight}, "reason": "one sentence" }`).join(',\n')}
  },
  "recommendation": "HOT or WARM or COLD",
  "next_action": "one sentence telling the sales rep what to do"
}`;
}

// ── CUSTOMERS (Won/Closed deals for AI discovery) ────────────────────────────

// Helper: look up company data from leads or Datafordeler
async function resolveCompany(cvr, userId) {
  const d = loadUserData(userId);
  const fromLeads = d.leads.find(l => l.cvr === cvr);
  if (fromLeads) return fromLeads;
  // Try Datafordeler lookup
  try { return await lookupDatafordeler(cvr); } catch(e) { return null; }
}

// POST /api/customers — add a won customer
app.post('/api/customers', authMiddleware, async (req, res) => {
  try {
    const { cvr_number, notes } = req.body;
    if (!cvr_number) return res.status(400).json({ error: 'Missing cvr_number' });
    const d = loadUserData(req.userId);
    if (!d.customers) d.customers = [];
    if (d.customers.find(c => c.cvr_number === cvr_number)) return res.status(409).json({ error: 'Kunde allerede tilføjet' });
    const company = await resolveCompany(cvr_number, req.userId);
    const customer = {
      id: 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      user_id: req.userId,
      cvr_number,
      company_name: company?.name || '',
      industry_code: company?.industryCode || company?.ic || null,
      industry_description: company?.industry || company?.ind || null,
      employee_interval: company?.employees || company?.emps || null,
      municipality: company?.city || null,
      founded_date: company?.founded || company?.yr || null,
      p_units: null,
      notes: notes || null,
      added_at: new Date().toISOString()
    };
    d.customers.push(customer);
    saveUserData(req.userId, d);
    res.json(customer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/customers — list all customers for current user
app.get('/api/customers', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const customers = d.customers || [];
  res.json({ customers, total: customers.length });
});

// DELETE /api/customers/:id — remove a customer
app.delete('/api/customers/:id', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  if (!d.customers) d.customers = [];
  const before = d.customers.length;
  d.customers = d.customers.filter(c => c.id !== req.params.id);
  if (d.customers.length === before) return res.status(404).json({ error: 'Kunde ikke fundet' });
  saveUserData(req.userId, d);
  res.json({ ok: true });
});

// POST /api/customers/bulk — bulk import by CVR numbers
app.post('/api/customers/bulk', authMiddleware, async (req, res) => {
  try {
    const cvrs = req.body.cvr_numbers || [];
    if (!cvrs.length) return res.status(400).json({ error: 'No CVR numbers provided' });
    const d = loadUserData(req.userId);
    if (!d.customers) d.customers = [];
    let added = 0, skipped = 0;
    const errors = [];
    for (const cvr of cvrs) {
      if (d.customers.find(c => c.cvr_number === cvr)) { skipped++; continue; }
      try {
        const company = await resolveCompany(cvr, req.userId);
        d.customers.push({
          id: 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          user_id: req.userId, cvr_number: cvr,
          company_name: company?.name || '', industry_code: company?.industryCode || company?.ic || null,
          industry_description: company?.industry || company?.ind || null,
          employee_interval: company?.employees || company?.emps || null,
          municipality: company?.city || null, founded_date: company?.founded || company?.yr || null,
          p_units: null, notes: null, added_at: new Date().toISOString()
        });
        added++;
      } catch(e) { errors.push({ cvr, error: e.message }); }
    }
    saveUserData(req.userId, d);
    res.json({ added, skipped, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/customers/stats — summary stats
app.get('/api/customers/stats', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const customers = d.customers || [];
  if (!customers.length) return res.json({ total_customers: 0, top_industries: [], avg_employee_range: '', top_municipalities: [] });
  // Count industries
  const indCount = {};
  customers.forEach(c => { if (c.industry_description) indCount[c.industry_description] = (indCount[c.industry_description] || 0) + 1; });
  const top_industries = Object.entries(indCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
  // Count municipalities
  const munCount = {};
  customers.forEach(c => { if (c.municipality) munCount[c.municipality] = (munCount[c.municipality] || 0) + 1; });
  const top_municipalities = Object.entries(munCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
  // Most common employee interval
  const empCount = {};
  customers.forEach(c => { if (c.employee_interval) empCount[c.employee_interval] = (empCount[c.employee_interval] || 0) + 1; });
  const avg_employee_range = Object.entries(empCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  res.json({ total_customers: customers.length, top_industries, avg_employee_range, top_municipalities });
});

// ── DISCOVERY (AI lead discovery agent) ──────────────────────────────────────

// Pattern extraction: analyzes won customers to find the "winning pattern"
async function generatePattern(userId, forceRefresh = false) {
  const d = loadUserData(userId);
  const customers = d.customers || [];
  if (customers.length < 5) throw new Error('Tilføj mindst 5 vundne kunder for pålidelig mønsteranalyse (har ' + customers.length + ')');

  // Check for recent pattern (< 7 days)
  if (!d.discovery_patterns) d.discovery_patterns = [];
  const latest = d.discovery_patterns.sort((a, b) => b.version - a.version)[0];
  if (latest && latest.status === 'ready' && !forceRefresh) {
    const age = Date.now() - new Date(latest.created_at).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) return latest;
  }

  const newVersion = latest ? latest.version + 1 : 1;
  const patternId = 'pat_' + Date.now();
  const pattern = {
    id: patternId, user_id: userId, version: newVersion,
    customer_count: customers.length, pattern_data: null, sql_filters: null,
    created_at: new Date().toISOString(), status: 'generating'
  };
  d.discovery_patterns.push(pattern);
  saveUserData(userId, d);

  try {
    const customerBlock = customers.map((c, i) => `
Customer ${i + 1}:
- CVR: ${c.cvr_number}
- Name: ${c.company_name || 'Unknown'}
- Industry code: ${c.industry_code || 'N/A'}
- Industry: ${c.industry_description || 'N/A'}
- Municipality: ${c.municipality || 'N/A'}
- Employees: ${c.employee_interval || 'N/A'}
- Founded: ${c.founded_date || 'N/A'}
- P-units: ${c.p_units || 'N/A'}
- Notes: ${c.notes || 'None'}`).join('\n');

    const prompt = `You are a B2B sales pattern analyst specializing in Danish companies. Below are ${customers.length} companies that are all won/closed customers of a Danish B2B company. Your job is to find the common patterns — what makes these companies similar? What traits do they share?

## Customer data:
${customerBlock}

## Analyze and return ONLY valid JSON (no markdown, no backticks):
{
  "summary": "2-3 sentence description of what the ideal customer looks like, based on these examples",
  "common_industries": ["list of 6-digit industry codes (branchekoder) that appear in 20%+ of customers"],
  "common_industry_labels": ["human-readable Danish names for those industry codes"],
  "employee_range": {
    "min": "the smallest employee interval that appears commonly (e.g. '10-19')",
    "max": "the largest employee interval that appears commonly (e.g. '50-99')"
  },
  "preferred_municipalities": ["municipalities where 15%+ of customers are located"],
  "age_range_years": { "min": 3, "max": 25 },
  "min_p_units": 1,
  "common_legal_forms": ["A/S", "ApS"],
  "key_traits": ["3-5 specific patterns you noticed"],
  "avoid_signals": ["3-5 traits that NONE of these companies have, which should be exclusion filters"]
}

Be specific with the industry codes — use the exact branchekoder from the data. Base everything on the actual data provided, not assumptions.`;

    const patternData = await callGemini(prompt);

    // Generate sql_filters from the pattern
    const sqlFilters = translatePatternToQuery(patternData, customers.map(c => c.cvr_number));

    // Update pattern
    const d2 = loadUserData(userId);
    const pat = d2.discovery_patterns.find(p => p.id === patternId);
    if (pat) {
      pat.pattern_data = patternData;
      pat.sql_filters = sqlFilters;
      pat.status = 'ready';
      saveUserData(userId, d2);
    }
    return { ...pat };
  } catch (e) {
    const d2 = loadUserData(userId);
    const pat = d2.discovery_patterns.find(p => p.id === patternId);
    if (pat) { pat.status = 'failed'; pat.error = e.message; saveUserData(userId, d2); }
    throw e;
  }
}

// Translate pattern_data into structured query filters for Datafordeler
function translatePatternToQuery(patternData, excludeCvrs = []) {
  const pd = patternData || {};

  // Map employee range strings to sorted numeric thresholds for filtering
  const empIntervals = [];
  const empMap = { '1-4': 1, '5-9': 5, '10-19': 10, '20-49': 20, '50-99': 50, '100-199': 100, '200-499': 200, '500-999': 500, '1000+': 1000 };
  const minEmp = empMap[pd.employee_range?.min] || 0;
  const maxEmp = empMap[pd.employee_range?.max] || 10000;
  for (const [label, val] of Object.entries(empMap)) {
    if (val >= minEmp && val <= maxEmp) empIntervals.push(label);
  }

  // Calculate founded year range
  const currentYear = new Date().getFullYear();
  const minFoundedYear = pd.age_range_years?.max ? currentYear - pd.age_range_years.max : 1990;
  const maxFoundedYear = pd.age_range_years?.min ? currentYear - pd.age_range_years.min : currentYear;

  return {
    industry_codes: pd.common_industries || [],
    employee_intervals: empIntervals,
    municipalities: pd.preferred_municipalities || [],
    min_founded_year: minFoundedYear,
    max_founded_year: maxFoundedYear,
    legal_forms: pd.common_legal_forms || ['A/S', 'ApS'],
    exclude_status: ['OPHOERT', 'UNDER_KONKURS', 'UNDER_FRIVILLIG_LIKVIDATION', 'UNDER_TVANGSOPLØSNING'],
    min_p_units: pd.min_p_units || 0,
    exclude_cvrs: excludeCvrs,
    // Datafordeler-specific: branche codes to query
    datafordeler_branche_codes: pd.common_industries || [],
    // Soft preferences (used for scoring boost, not hard filters)
    preferred_municipalities: pd.preferred_municipalities || [],
    key_traits: pd.key_traits || [],
    avoid_signals: pd.avoid_signals || []
  };
}

// POST /api/discovery/pattern — generate or return cached pattern
app.post('/api/discovery/pattern', authMiddleware, async (req, res) => {
  try {
    const pattern = await generatePattern(req.userId, false);
    res.json(pattern);
  } catch (e) {
    console.error('[discovery/pattern]', e.message);
    res.status(e.message.includes('mindst 5') ? 400 : 500).json({ error: e.message });
  }
});

// POST /api/discovery/pattern/refresh — force regeneration
app.post('/api/discovery/pattern/refresh', authMiddleware, async (req, res) => {
  try {
    const pattern = await generatePattern(req.userId, true);
    res.json(pattern);
  } catch (e) {
    console.error('[discovery/pattern/refresh]', e.message);
    res.status(e.message.includes('mindst 5') ? 400 : 500).json({ error: e.message });
  }
});

// GET /api/discovery/pattern — get current pattern
app.get('/api/discovery/pattern', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const patterns = (d.discovery_patterns || []).filter(p => p.status === 'ready').sort((a, b) => b.version - a.version);
  if (!patterns.length) return res.status(404).json({ error: 'Intet mønster genereret endnu' });
  res.json(patterns[0]);
});

// ── DISCOVERY WORKER (background processing) ────────────────────────────────
const _activeDiscoveryRuns = new Map(); // userId → runId (prevent concurrent runs)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callGeminiWithRetry(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await callGemini(prompt); }
    catch (e) {
      if (e.message?.includes('429') || e.message?.includes('rate')) {
        const wait = Math.pow(2, i) * 5000;
        console.log(`[discovery] Rate limited, backing off ${wait}ms...`);
        await sleep(wait);
      } else throw e;
    }
  }
  throw new Error('Gemini rate limit exceeded after retries');
}

// The main discovery loop — runs in background, doesn't block Express
async function runDiscovery(userId) {
  console.log(`[discovery] Starting for user ${userId}`);
  const d = loadUserData(userId);

  // Step 1: Load pattern
  const patterns = (d.discovery_patterns || []).filter(p => p.status === 'ready').sort((a, b) => b.version - a.version);
  if (!patterns.length) throw new Error('Generer et mønster først (POST /api/discovery/pattern)');
  const pattern = patterns[0];
  const pd = pattern.pattern_data;
  const customers = d.customers || [];

  // Step 2: Create run
  const runId = 'run_' + Date.now();
  if (!d.discovery_runs) d.discovery_runs = [];
  if (!d.discovery_results) d.discovery_results = [];
  const run = {
    id: runId, user_id: userId, pattern_id: pattern.id,
    status: 'filtering', total_candidates: 0, scored_count: 0, results_count: 0,
    started_at: new Date().toISOString(), completed_at: null, created_at: new Date().toISOString(), error_message: null
  };
  d.discovery_runs.push(run);
  saveUserData(userId, d);
  _activeDiscoveryRuns.set(userId, runId);

  try {
    // Step 3: Pre-filter candidates via Datafordeler
    console.log(`[discovery] Filtering candidates with ${(pd.common_industries || []).length} industry codes`);
    const filters = pattern.sql_filters || translatePatternToQuery(pd, customers.map(c => c.cvr_number));
    const codes = filters.datafordeler_branche_codes || filters.industry_codes || [];
    let candidates = [];

    for (const code of codes.slice(0, 10)) { // Max 10 codes
      try {
        const searchResult = await searchDatafordeler(code, { _size: 200, _from: 0 });
        if (searchResult.companies) candidates.push(...searchResult.companies);
      } catch(e) { console.log(`[discovery] Code ${code} failed:`, e.message); }
    }

    // Deduplicate and exclude existing customers + already-discovered (last 30 days)
    const customerCvrs = new Set(customers.map(c => c.cvr_number));
    const recentResults = (d.discovery_results || []).filter(r => {
      const age = Date.now() - new Date(r.created_at).getTime();
      return age < 30 * 24 * 60 * 60 * 1000;
    });
    const recentCvrs = new Set(recentResults.map(r => r.cvr_number));
    candidates = [...new Map(candidates.map(c => [c.cvr, c])).values()]
      .filter(c => !customerCvrs.has(c.cvr) && !recentCvrs.has(c.cvr));

    console.log(`[discovery] ${candidates.length} candidates after dedup/exclusion`);

    // Update run
    let d2 = loadUserData(userId);
    let runRef = d2.discovery_runs.find(r => r.id === runId);
    if (runRef) { runRef.total_candidates = candidates.length; runRef.status = 'scoring'; }
    saveUserData(userId, d2);

    // Step 4: Score candidates with Gemini
    const customerSummary = customers.slice(0, 15).map(c =>
      `- ${c.company_name || c.cvr_number} (${c.industry_description || 'N/A'}, ${c.municipality || 'N/A'}, ${c.employee_interval || 'N/A'})`
    ).join('\n');

    let scored = 0, failed = 0, saved = 0;
    const BATCH_SIZE = 5;

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      // Check if cancelled
      if (_activeDiscoveryRuns.get(userId) !== runId) {
        console.log(`[discovery] Run ${runId} cancelled`);
        break;
      }

      const batch = candidates.slice(i, i + BATCH_SIZE);
      console.log(`[discovery] Scoring batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(candidates.length/BATCH_SIZE)} (${batch.length} candidates)`);

      const batchResults = await Promise.all(batch.map(async c => {
        try {
          const prompt = `You are a B2B lookalike scoring engine. A sales team's won customers have this pattern:

## Winning pattern:
${pd.summary || 'No summary'}
Key traits: ${(pd.key_traits || []).join(', ')}
Common industries: ${(pd.common_industry_labels || []).join(', ')}
Typical size: ${pd.employee_range?.min || '?'} to ${pd.employee_range?.max || '?'} employees
Typical location: ${(pd.preferred_municipalities || []).join(', ')}

## Existing customers:
${customerSummary}

## Candidate company to evaluate:
- CVR: ${c.cvr}
- Name: ${c.name}
- Industry: ${c.industryCode || ''} — ${c.industry || ''}
- Employees: ${c.employees || c.employeeCount || ''}
- Municipality: ${c.city || ''}
- Founded: ${c.founded || ''}
- Legal form: ${c.form || ''}
- Status: ${c.status || 'active'}

## Score this candidate. Return ONLY valid JSON:
{
  "match_score": 0,
  "most_similar_to": "name of most similar customer",
  "most_similar_cvr": "CVR of that customer",
  "match_reasons": ["reason1", "reason2", "reason3"],
  "recommendation": "STRONG_MATCH or MODERATE_MATCH or WEAK_MATCH or NO_MATCH"
}
Be strict: only score above 70 if the company genuinely matches multiple key traits.`;
          const result = await callGeminiWithRetry(prompt);
          return { candidate: c, score: result };
        } catch(e) {
          console.log(`[discovery] Failed to score ${c.cvr}:`, e.message);
          failed++;
          return null;
        }
      }));

      // Save results with score >= 60
      d2 = loadUserData(userId);
      for (const br of batchResults) {
        if (!br || !br.score?.match_score) continue;
        scored++;
        if (br.score.match_score >= 60) {
          const resultId = 'dr_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
          d2.discovery_results.push({
            id: resultId, run_id: runId, user_id: userId,
            cvr_number: br.candidate.cvr, company_name: br.candidate.name,
            company_data: br.candidate, match_score: br.score.match_score,
            most_similar_to: br.score.most_similar_cvr || '', most_similar_name: br.score.most_similar_to || '',
            match_reasons: br.score.match_reasons || [], enrichment_id: null,
            feedback: null, feedback_reason: null, feedback_at: null,
            created_at: new Date().toISOString()
          });
          saved++;
        }
      }

      runRef = d2.discovery_runs.find(r => r.id === runId);
      if (runRef) {
        runRef.scored_count = scored;
        runRef.results_count = saved;
      }
      saveUserData(userId, d2);

      // Check failure threshold
      if (failed > candidates.length * 0.2) {
        throw new Error(`Too many failures: ${failed}/${scored + failed} candidates failed`);
      }

      // Rate limit delay
      if (i + BATCH_SIZE < candidates.length) await sleep(2000);
    }

    // Step 5: Complete
    d2 = loadUserData(userId);
    runRef = d2.discovery_runs.find(r => r.id === runId);
    if (runRef && runRef.status !== 'cancelled') {
      runRef.status = 'completed';
      runRef.completed_at = new Date().toISOString();
      runRef.results_count = (d2.discovery_results || []).filter(r => r.run_id === runId).length;
    }
    saveUserData(userId, d2);
    console.log(`[discovery] Completed: ${scored} scored, ${saved} saved, ${failed} failed`);

  } catch(e) {
    console.error(`[discovery] Run ${runId} failed:`, e.message);
    const d2 = loadUserData(userId);
    const runRef = d2.discovery_runs.find(r => r.id === runId);
    if (runRef) { runRef.status = 'failed'; runRef.error_message = e.message; runRef.completed_at = new Date().toISOString(); }
    saveUserData(userId, d2);
  } finally {
    if (_activeDiscoveryRuns.get(userId) === runId) _activeDiscoveryRuns.delete(userId);
  }
}

// POST /api/discovery/run — start a new discovery run (background)
app.post('/api/discovery/run', authMiddleware, (req, res) => {
  const activeRunId = _activeDiscoveryRuns.get(req.userId);
  if (activeRunId) return res.status(409).json({ error: 'Discovery kører allerede', run_id: activeRunId });
  // Start in background (don't await)
  const runPromise = runDiscovery(req.userId).catch(e => console.error('[discovery] Unhandled:', e.message));
  // Return immediately
  setTimeout(() => {
    const d = loadUserData(req.userId);
    const latest = (d.discovery_runs || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    res.json({ run_id: latest?.id || 'unknown', status: latest?.status || 'queued' });
  }, 500);
});

// GET /api/discovery/run/current — latest run with progress
app.get('/api/discovery/run/current', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const runs = (d.discovery_runs || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!runs.length) return res.status(404).json({ error: 'Ingen discovery runs' });
  const run = runs[0];
  res.json({ ...run, progress_pct: run.total_candidates > 0 ? Math.round(run.scored_count / run.total_candidates * 100) : 0 });
});

// POST /api/discovery/run/:id/cancel — cancel a running discovery
app.post('/api/discovery/run/:id/cancel', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const run = (d.discovery_runs || []).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Run ikke fundet' });
  if (!['queued', 'filtering', 'scoring'].includes(run.status)) return res.status(400).json({ error: 'Run er ikke aktiv' });
  run.status = 'cancelled'; run.completed_at = new Date().toISOString();
  saveUserData(req.userId, d);
  _activeDiscoveryRuns.delete(req.userId);
  res.json({ ok: true, status: 'cancelled' });
});

// GET /api/discovery/results — sorted results with filters
app.get('/api/discovery/results', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  let results = d.discovery_results || [];
  const minScore = Number(req.query.min_score) || 60;
  const feedbackFilter = req.query.feedback; // null, 'approved', 'rejected'
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  results = results.filter(r => r.match_score >= minScore);
  if (feedbackFilter === 'null' || feedbackFilter === undefined) results = results.filter(r => !r.feedback);
  else if (feedbackFilter === 'approved') results = results.filter(r => r.feedback === 'approved');
  else if (feedbackFilter === 'rejected') results = results.filter(r => r.feedback === 'rejected');
  else if (feedbackFilter === 'all') { /* no filter */ }

  results.sort((a, b) => b.match_score - a.match_score);
  const total = results.length;
  results = results.slice(offset, offset + limit);

  // Attach enrichment data if available
  const enrichments = loadEnrichments();
  results = results.map(r => {
    const enr = enrichments[r.cvr_number];
    return { ...r, enrichment: enr ? { grade: enr.score_data?.grade, total_score: enr.score_data?.total_score, summary: enr.profile_data?.summary } : null };
  });

  res.json({ results, total, offset, limit });
});

// POST /api/discovery/results/:id/feedback — approve/reject with auto-add to leads
app.post('/api/discovery/results/:id/feedback', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  if (!d.discovery_results) d.discovery_results = [];
  const result = d.discovery_results.find(r => r.id === req.params.id);
  if (!result) return res.status(404).json({ error: 'Resultat ikke fundet' });
  result.feedback = req.body.feedback || null;
  result.feedback_reason = req.body.reason || null;
  result.feedback_at = new Date().toISOString();
  // Auto-add to leads on approval
  if (req.body.feedback === 'approved' && result.company_data) {
    if (!d.leads.find(l => l.cvr === result.cvr_number)) {
      // Ensure "AI-discovered leads" list exists
      if (!d.lists.find(l => l.name === 'AI-discovered leads')) {
        d.lists.push({ id: 'ai_discovered', name: 'AI-discovered leads' });
      }
      d.leads.push({ ...result.company_data, cvr: result.cvr_number, name: result.company_name, listId: 'ai_discovered', addedAt: new Date().toISOString() });
    }
  }
  saveUserData(req.userId, d);
  // Auto-trigger feedback analysis every 10th feedback
  const totalFeedback = d.discovery_results.filter(r => r.feedback).length;
  if (totalFeedback > 0 && totalFeedback % 10 === 0) {
    analyzeFeedback(req.userId).then(analysis => {
      if (analysis && analysis.status !== 'insufficient_data') {
        const d2 = loadUserData(req.userId);
        d2._pendingFeedbackAnalysis = analysis;
        d2._pendingFeedbackAnalysis.analyzed_at = new Date().toISOString();
        saveUserData(req.userId, d2);
        console.log(`[feedback] Auto-analysis triggered for ${req.userId} after ${totalFeedback} feedbacks`);
      }
    }).catch(e => console.error('[feedback] Auto-analysis failed:', e.message));
  }
  res.json(result);
});

// ── FEEDBACK LEARNING SYSTEM ─────────────────────────────────────────────────

async function analyzeFeedback(userId) {
  const d = loadUserData(userId);
  const results = (d.discovery_results || []).filter(r => r.feedback);
  const approved = results.filter(r => r.feedback === 'approved');
  const rejected = results.filter(r => r.feedback === 'rejected');
  const total = approved.length + rejected.length;

  if (total < 10) return { status: 'insufficient_data', message: `Godkend eller afvis mindst 10 leads for feedback-analyse (har ${total})`, total_feedback: total };

  // Get current pattern
  const patterns = (d.discovery_patterns || []).filter(p => p.status === 'ready').sort((a, b) => b.version - a.version);
  const currentPattern = patterns[0]?.pattern_data || {};

  const approvedBlock = approved.slice(-30).map(r => {
    const cd = r.company_data || {};
    return `- ${r.company_name} | Industry: ${cd.industry || 'N/A'} | City: ${cd.city || 'N/A'} | Employees: ${cd.employees || 'N/A'} | Score: ${r.match_score} | Reasons: ${(r.match_reasons || []).join(', ')}`;
  }).join('\n');

  const rejectedBlock = rejected.slice(-30).map(r => {
    const cd = r.company_data || {};
    return `- ${r.company_name} | Industry: ${cd.industry || 'N/A'} | City: ${cd.city || 'N/A'} | Employees: ${cd.employees || 'N/A'} | Score: ${r.match_score} | Rejection reason: ${r.feedback_reason || 'Not specified'}`;
  }).join('\n');

  const prompt = `You are analyzing sales rep feedback on AI-discovered leads to improve future discovery accuracy.

## Approved leads (${approved.length} — the rep liked these):
${approvedBlock || 'None yet'}

## Rejected leads (${rejected.length} — the rep didn't want these):
${rejectedBlock || 'None yet'}

## Current winning pattern:
Summary: ${currentPattern.summary || 'N/A'}
Key traits: ${(currentPattern.key_traits || []).join(', ')}
Common industries: ${(currentPattern.common_industry_labels || []).join(', ')}
Employee range: ${currentPattern.employee_range?.min || '?'} to ${currentPattern.employee_range?.max || '?'}
Preferred municipalities: ${(currentPattern.preferred_municipalities || []).join(', ')}

## Based on this feedback, suggest refinements. Return ONLY valid JSON:
{
  "pattern_adjustments": {
    "add_industries": ["industry codes from approved leads not in current pattern"],
    "remove_industries": ["industry codes appearing mostly in rejected leads"],
    "adjust_employee_range": null,
    "add_municipalities": ["new municipalities from approved leads"],
    "remove_municipalities": ["municipalities appearing mostly in rejected"],
    "new_key_traits": ["traits common in approved leads"],
    "new_avoid_signals": ["traits common in rejected leads"]
  },
  "confidence": "high or medium or low",
  "summary": "1-2 sentence summary of what the feedback tells us"
}
Only suggest changes supported by at least 3 data points. Don't over-correct from 1-2 rejections. Be conservative.`;

  try {
    const analysis = await callGemini(prompt);
    return { ...analysis, status: 'ready', total_approved: approved.length, total_rejected: rejected.length, analyzed_at: new Date().toISOString() };
  } catch(e) {
    console.error('[feedback] Analysis failed:', e.message);
    throw e;
  }
}

async function applyFeedbackToPattern(userId) {
  const d = loadUserData(userId);
  const analysis = d._pendingFeedbackAnalysis || await analyzeFeedback(userId);
  if (!analysis || analysis.status === 'insufficient_data') return analysis;

  const adj = analysis.pattern_adjustments || {};
  const patterns = (d.discovery_patterns || []).filter(p => p.status === 'ready').sort((a, b) => b.version - a.version);
  if (!patterns.length) throw new Error('Intet mønster at opdatere');
  const current = JSON.parse(JSON.stringify(patterns[0])); // deep copy
  const pd = current.pattern_data;
  const changes = [];

  // Add industries (never remove unless high confidence + 50%+ rejections)
  if (adj.add_industries?.length) {
    pd.common_industries = [...new Set([...(pd.common_industries || []), ...adj.add_industries])];
    changes.push(`Tilføjet ${adj.add_industries.length} branchekoder`);
  }
  if (adj.remove_industries?.length && analysis.confidence === 'high') {
    pd.common_industries = (pd.common_industries || []).filter(c => !adj.remove_industries.includes(c));
    changes.push(`Fjernet ${adj.remove_industries.length} branchekoder`);
  }

  // Expand employee range
  if (adj.adjust_employee_range) {
    if (adj.adjust_employee_range.min) pd.employee_range = { ...pd.employee_range, min: adj.adjust_employee_range.min };
    if (adj.adjust_employee_range.max) pd.employee_range = { ...pd.employee_range, max: adj.adjust_employee_range.max };
    changes.push('Justeret medarbejderinterval');
  }

  // Add municipalities
  if (adj.add_municipalities?.length) {
    pd.preferred_municipalities = [...new Set([...(pd.preferred_municipalities || []), ...adj.add_municipalities])];
    changes.push(`Tilføjet ${adj.add_municipalities.length} kommuner`);
  }

  // Append traits and avoid signals
  if (adj.new_key_traits?.length) {
    pd.key_traits = [...new Set([...(pd.key_traits || []), ...adj.new_key_traits])];
    changes.push(`Tilføjet ${adj.new_key_traits.length} nye mønstre`);
  }
  if (adj.new_avoid_signals?.length) {
    pd.avoid_signals = [...new Set([...(pd.avoid_signals || []), ...adj.new_avoid_signals])];
    changes.push(`Tilføjet ${adj.new_avoid_signals.length} undgå-signaler`);
  }

  // Save new pattern version
  const newVersion = current.version + 1;
  const newPattern = {
    id: 'pat_' + Date.now(), user_id: userId, version: newVersion,
    customer_count: current.customer_count, pattern_data: pd,
    sql_filters: translatePatternToQuery(pd, (d.customers || []).map(c => c.cvr_number)),
    created_at: new Date().toISOString(), status: 'ready'
  };
  d.discovery_patterns.push(newPattern);
  delete d._pendingFeedbackAnalysis;
  saveUserData(userId, d);

  console.log(`[feedback] Applied ${changes.length} adjustments → pattern v${newVersion}`);
  return { pattern: newPattern, changes, analysis_summary: analysis.summary, confidence: analysis.confidence };
}

// GET /api/discovery/feedback/analysis
app.get('/api/discovery/feedback/analysis', authMiddleware, async (req, res) => {
  try {
    const d = loadUserData(req.userId);
    // Return pending analysis if available
    if (d._pendingFeedbackAnalysis) return res.json(d._pendingFeedbackAnalysis);
    const analysis = await analyzeFeedback(req.userId);
    res.json(analysis);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/discovery/feedback/apply
app.post('/api/discovery/feedback/apply', authMiddleware, async (req, res) => {
  try {
    const result = await applyFeedbackToPattern(req.userId);
    if (result.status === 'insufficient_data') return res.status(400).json(result);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/discovery/feedback/stats
app.get('/api/discovery/feedback/stats', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const results = d.discovery_results || [];
  const approved = results.filter(r => r.feedback === 'approved');
  const rejected = results.filter(r => r.feedback === 'rejected');
  const total = approved.length + rejected.length;

  // Top rejection reasons
  const reasonCount = {};
  rejected.forEach(r => { const reason = r.feedback_reason || 'Ikke angivet'; reasonCount[reason] = (reasonCount[reason] || 0) + 1; });
  const top_rejection_reasons = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r]) => r);

  res.json({
    total_approved: approved.length,
    total_rejected: rejected.length,
    approval_rate: total > 0 ? Math.round(approved.length / total * 100) : 0,
    top_rejection_reasons,
    avg_approved_score: approved.length > 0 ? Math.round(approved.reduce((s, r) => s + (r.match_score || 0), 0) / approved.length) : 0,
    avg_rejected_score: rejected.length > 0 ? Math.round(rejected.reduce((s, r) => s + (r.match_score || 0), 0) / rejected.length) : 0,
    pending_adjustments: !!d._pendingFeedbackAnalysis,
    last_analysis_at: d._pendingFeedbackAnalysis?.analyzed_at || null
  });
});

// GET /api/discovery/patterns — get all patterns for current user
app.get('/api/discovery/patterns', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const patterns = (d.discovery_patterns || []).sort((a, b) => b.version - a.version);
  res.json({ patterns, latest: patterns[0] || null });
});

// GET /api/discovery/runs — list runs for current user
app.get('/api/discovery/runs', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  res.json({ runs: d.discovery_runs || [] });
});

// GET /api/discovery/runs/:id — get a specific run with its results
app.get('/api/discovery/runs/:id', authMiddleware, (req, res) => {
  const d = loadUserData(req.userId);
  const run = (d.discovery_runs || []).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Run ikke fundet' });
  const results = (d.discovery_results || []).filter(r => r.run_id === req.params.id);
  res.json({ run, results });
});

// ── ICP Settings API ─────────────────────────────────────────────────────────
app.get('/api/settings/icp', authMiddleware, (req, res) => {
  res.json(getIcpSettings());
});

app.put('/api/settings/icp', authMiddleware, (req, res) => {
  const data = req.body;
  if (!data.criteria) return res.status(400).json({ error: 'Missing criteria' });
  const weights = Object.values(data.criteria).reduce((sum, c) => sum + (c.weight || 0), 0);
  if (weights !== 100) return res.status(400).json({ error: `Weights must sum to 100 (currently ${weights})` });
  // Increment version
  const current = getIcpSettings();
  const vNum = parseInt((current.version || 'v0').replace('v', '')) + 1;
  data.version = 'v' + vNum;
  data.updated_at = new Date().toISOString();
  saveIcpSettings(data);
  console.log(`[icp] Updated to ${data.version}: ${data.name}`);
  res.json(data);
});

// GET /api/enrich/status?cvrs=123,456 — batch check enrichment status
app.get('/api/enrich/status', authMiddleware, (req, res) => {
  const cvrs = (req.query.cvrs || '').split(',').filter(Boolean);
  if (!cvrs.length) return res.json({});
  const result = {};
  for (const cvr of cvrs) {
    const entry = enrichDbGet(cvr);
    if (entry && entry.score_data) {
      result[cvr] = { grade: entry.score_data.grade, total_score: entry.score_data.total_score, recommendation: entry.score_data.recommendation, enriched_at: entry.enriched_at };
    } else {
      result[cvr] = null;
    }
  }
  res.json(result);
});

// GET /api/enrich/:cvr — get stored enrichment or 404
app.get('/api/enrich/:cvr', authMiddleware, (req, res) => {
  const entry = enrichDbGet(req.params.cvr);
  if (!entry) return res.status(404).json({ error: 'Not enriched' });
  res.json({ profile: entry.profile_data, score: entry.score_data, enriched_at: entry.enriched_at, icp_version: entry.icp_version });
});

// POST /api/enrich/profile
app.post('/api/enrich/profile', authMiddleware, async (req, res) => {
  try {
    const c = req.body.companyData || req.body;
    const cvr = c.cvr_number || c.cvr;
    if (!cvr) return res.status(400).json({ error: 'Missing CVR' });
    const existing = enrichDbGet(cvr);
    if (existing?.profile_data && !enrichIsStale(existing)) return res.json(existing.profile_data);
    const result = await callGemini(buildProfilePrompt(c));
    enrichDbSet(cvr, result, existing?.score_data || null);
    res.json(result);
  } catch (e) {
    console.error('[enrich/profile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/enrich/score
app.post('/api/enrich/score', authMiddleware, async (req, res) => {
  try {
    const c = req.body.companyData || req.body;
    const cvr = c.cvr_number || c.cvr;
    if (!cvr) return res.status(400).json({ error: 'Missing CVR' });
    const existing = enrichDbGet(cvr);
    if (existing?.score_data && !enrichIsStale(existing)) return res.json(existing.score_data);
    const result = await callGemini(buildScorePrompt(c));
    enrichDbSet(cvr, existing?.profile_data || null, result);
    res.json(result);
  } catch (e) {
    console.error('[enrich/score]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/enrich/full — runs profile + score in parallel
app.post('/api/enrich/full', authMiddleware, async (req, res) => {
  try {
    const c = req.body.companyData || req.body;
    const cvr = c.cvr_number || c.cvr;
    if (!cvr) return res.status(400).json({ error: 'Missing CVR' });
    const existing = enrichDbGet(cvr);
    if (existing?.profile_data && existing?.score_data && !enrichIsStale(existing)) {
      return res.json({ profile: existing.profile_data, score: existing.score_data });
    }
    const needProfile = !existing?.profile_data || enrichIsStale(existing);
    const needScore = !existing?.score_data || enrichIsStale(existing);
    const [profile, score] = await Promise.all([
      needProfile ? callGemini(buildProfilePrompt(c)) : existing.profile_data,
      needScore ? callGemini(buildScorePrompt(c)) : existing.score_data
    ]);
    enrichDbSet(cvr, profile, score);
    res.json({ profile, score });
  } catch (e) {
    console.error('[enrich/full]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/enrich/batch — score up to 20 companies with concurrency limit of 5
app.post('/api/enrich/batch', authMiddleware, async (req, res) => {
  try {
    const companies = req.body.companies || [];
    if (!companies.length) return res.status(400).json({ error: 'No companies provided' });
    if (companies.length > 20) return res.status(400).json({ error: 'Max 20 companies per batch' });
    const results = [];
    for (let i = 0; i < companies.length; i += 5) {
      const batch = companies.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map(async c => {
        const cvr = c.cvr_number || c.cvr;
        const existing = enrichDbGet(cvr);
        if (existing?.score_data && !enrichIsStale(existing)) return { cvr_number: cvr, ...existing.score_data };
        try {
          const score = await callGemini(buildScorePrompt(c));
          enrichDbSet(cvr, existing?.profile_data || null, score);
          return { cvr_number: cvr, ...score };
        } catch (e) {
          return { cvr_number: cvr, error: e.message };
        }
      }));
      results.push(...batchResults);
    }
    res.json({ results });
  } catch (e) {
    console.error('[enrich/batch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── TECH STACK SCANNER ──────────────────────────────────────────────────
// POST /api/scrape/tech-stack { domains: ['foo.dk', 'bar.com', ...] }
// Probes each domain (https first, http fallback), pulls headers + a small
// slice of HTML, and matches against a signature table for common D2C/B2B
// platforms. No external API keys — works today.
//
// The signatures are intentionally conservative — we'd rather miss a
// detection than mislabel a non-Shopify site as Shopify. Each rule is a
// pair: (regex on combined headers+body OR explicit header check). If
// multiple sigs match we return them all so the SDR can filter.
const TECH_STACK_SIGNATURES = [
  // ── E-commerce platforms (the most valuable signal for D2C ICPs) ──
  { name: "Shopify", test: (h, b, url) => /\.myshopify\.com|shopify\.com\/s\/|cdn\.shopify\.com/i.test(b) || /^shopify/i.test(h["x-shopid"]||"") || /shopify/i.test(h["x-shopify-stage"]||"") || /shopify/i.test(h["server"]||"") },
  { name: "WooCommerce", test: (h, b) => /woocommerce|wc-ajax|wc_add_to_cart/i.test(b) },
  { name: "Magento", test: (h, b) => /magento|\/mage\/|Mage\.Cookies/i.test(b) || /magento/i.test(h["x-magento-cache-debug"]||"") },
  { name: "BigCommerce", test: (h, b) => /bigcommerce\.com|bc-sf-filter/i.test(b) },
  { name: "Squarespace", test: (h, b) => /squarespace|static1\.squarespace|sqsp/i.test(b) || /squarespace/i.test(h["server"]||"") },
  { name: "Wix", test: (h, b) => /wix\.com|wixstatic|wixsite/i.test(b) || /wix/i.test(h["x-wix-request-id"]||"") },
  { name: "Webflow", test: (h, b) => /webflow\.com|wf-loaded|webflow\.js/i.test(b) || /webflow/i.test(h["x-served-by"]||"") },
  // ── CMS ──
  { name: "WordPress", test: (h, b) => /wp-content\/|wp-includes\/|wordpress/i.test(b) },
  { name: "Drupal", test: (h, b) => /drupal\.js|sites\/all\/|drupal-settings/i.test(b) || /drupal/i.test(h["x-generator"]||"") },
  // ── Marketing automation / email ──
  { name: "HubSpot", test: (h, b) => /js\.hs-scripts\.com|hubspot|hsforms|_hsq/i.test(b) },
  { name: "Klaviyo", test: (h, b) => /klaviyo|static\.klaviyo|a\.klaviyo/i.test(b) },
  { name: "Mailchimp", test: (h, b) => /mailchimp|chimpstatic|mc-validate/i.test(b) },
  { name: "ActiveCampaign", test: (h, b) => /activecampaign|trackcmp/i.test(b) },
  { name: "Pardot", test: (h, b) => /pardot|pi\.pardot/i.test(b) },
  // ── Analytics / tracking ──
  { name: "GA4", test: (h, b) => /gtag\(['"]config['"],\s*['"]G-/i.test(b) || /googletagmanager\.com\/gtag\/js\?id=G-/i.test(b) },
  { name: "Meta Pixel", test: (h, b) => /fbq\(|connect\.facebook\.net\/.+\/fbevents/i.test(b) },
  { name: "TikTok Pixel", test: (h, b) => /analytics\.tiktok\.com|ttq\.track/i.test(b) },
  { name: "Google Tag Manager", test: (h, b) => /googletagmanager\.com\/gtm\.js/i.test(b) },
  { name: "Hotjar", test: (h, b) => /static\.hotjar|hjid/i.test(b) },
  // ── Frameworks / infra (less ICP-relevant but useful for tech-buyer segmentation) ──
  { name: "Next.js", test: (h, b) => /_next\/static|__NEXT_DATA__/i.test(b) || /next/i.test(h["x-powered-by"]||"") },
  { name: "Nuxt", test: (h, b) => /__NUXT__|_nuxt\//i.test(b) },
  { name: "React", test: (h, b) => /<div[^>]+id=['"]?(root|app|__next)['"]?[^>]*><\/div>.*react/i.test(b) },
  { name: "Cloudflare", test: (h) => /cloudflare/i.test(h["server"]||"") || !!h["cf-ray"] },
  { name: "Vercel", test: (h) => /vercel/i.test(h["server"]||"") || !!h["x-vercel-id"] },
];

function detectTechSignatures(headers, body, url) {
  const out = [];
  // Normalise header keys to lowercase so signature checks don't have to
  // worry about casing.
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = String(v);
  for (const sig of TECH_STACK_SIGNATURES) {
    try {
      if (sig.test(h, body || "", url || "")) out.push(sig.name);
    } catch { /* one bad regex shouldn't kill the whole scan */ }
  }
  return out;
}

function normaliseDomain(raw) {
  // Strip protocol, path, trailing slash. Accept "https://foo.dk/bar" or "foo.dk".
  let d = String(raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return d;
}

async function probeDomain(domain, timeoutMs = 8000) {
  const tryFetch = async (proto) => {
    const url = `${proto}://${domain}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; VedioLeadsBot/1.0)" },
      });
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      // Cap the body at 256 KB — signatures usually appear in <head> or
      // first few KB of <body>, no need to slurp megabytes.
      const text = (await r.text()).slice(0, 256 * 1024);
      return { ok: true, statusCode: r.status, finalUrl: r.url, headers, body: text };
    } catch (e) {
      return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
    } finally { clearTimeout(t); }
  };
  // HTTPS first — that's the modern default and where the rich
  // signatures live (CSP headers, etc.). Fall back to HTTP only on TLS
  // failure or DNS-level errors.
  let res = await tryFetch("https");
  if (!res.ok) res = await tryFetch("http");
  return res;
}

// ─── TECH STACK DISCOVERY AGENT ─────────────────────────────────────────
// True discovery channel — walks the CVR pool (state.json), guesses each
// candidate's website, probes for tech signatures, returns matches.
//
// Why this works without buying BuiltWith/Wappalyzer access:
// - State.json already has ~100k DK companies indexed by industry
// - Most DK companies follow predictable domain patterns: "brand.dk",
//   "brand-shop.dk", "[name].com". Brand-name slug guess covers 40–60%
//   of e-commerce SMBs in the pool
// - Existing META scraper has already given many of them a `brandName`,
//   which is the cleaner-than-legal-name signal for guesses
//
// Tradeoffs we accept:
// - Match rate is heuristic — we won't find brands whose domains don't
//   follow the patterns. Acceptable for an agent that runs in seconds
//   on demand; a future enhancement could plug in a paid tech-fingerprint
//   API for full coverage
// - We don't write back to state.json on every match (cross-user shared
//   data). Instead we return matches to the UI and the SDR pushes them
//   to their own leads via the existing promote flow with source=tech-stack

function guessDomainsForCompany(c) {
  // Generate up to 4 plausible domain guesses from the company name +
  // brandName. Strips legal suffixes, normalises Danish chars, drops
  // punctuation, then tries common TLD + sub-name patterns.
  const sources = [];
  if (c.brandName) sources.push(c.brandName);
  if (c.name && c.name !== c.brandName) sources.push(c.name);
  const seen = new Set();
  const out = [];
  const norm = (s) => String(s || "")
    .toLowerCase()
    .replace(/\s+(aps|a\/s|i\/s|p\/s|k\/s|ivs|holding|group)\b.*$/i, "")
    .replace(/[æ]/g, "ae")
    .replace(/[ø]/g, "oe")
    .replace(/[å]/g, "aa")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  for (const src of sources) {
    const base = norm(src);
    if (!base || base.length < 2 || base.length > 30) continue;
    for (const d of [`${base}.dk`, `${base}.com`]) {
      if (!seen.has(d)) { seen.add(d); out.push(d); }
    }
  }
  return out;
}

app.post("/api/scrape/tech-stack/discover", authMiddleware, async (req, res) => {
  try {
    const signatures = Array.isArray(req.body?.signatures) ? req.body.signatures : [];
    const negate = Array.isArray(req.body?.negate) ? req.body.negate : [];
    const industries = Array.isArray(req.body?.industries) ? req.body.industries : [];
    const cityFilter = String(req.body?.city || "").toLowerCase().trim();
    const limit = Math.max(20, Math.min(500, Number(req.body?.limit) || 100));
    if (!signatures.length && !negate.length) return res.status(400).json({ error: "Vælg en mission med mindst én signatur" });

    // Build candidate set from state.json — companies with verdict-true
    // ads are highest signal (they're already real businesses) but we
    // also include unverified to broaden discovery.
    const pool = Object.values(loadDiscoveryState().companies || {});
    let candidates = pool.filter((c) => c?.cvr && c.status === "aktiv");
    if (industries.length) {
      candidates = candidates.filter((c) => {
        const ic = String(c.industry || "");
        return industries.some((prefix) => ic.startsWith(prefix));
      });
    }
    if (cityFilter) {
      candidates = candidates.filter((c) => String(c.city || "").toLowerCase().includes(cityFilter));
    }
    // Prioritise: active advertisers first (likely to have websites),
    // then companies with brandName (means META scraper has seen them).
    candidates.sort((a, b) => {
      const aS = (a.ads?.verdict === true ? 2 : 0) + (a.brandName ? 1 : 0);
      const bS = (b.ads?.verdict === true ? 2 : 0) + (b.brandName ? 1 : 0);
      return bS - aS;
    });
    candidates = candidates.slice(0, limit);

    // Concurrent probe with the same helper used by the existing endpoint.
    const CONC = 8;
    const queue = [...candidates];
    const matches = [];
    const stats = { scanned: 0, dnsHit: 0, signatureHit: 0 };
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        if (!c) break;
        stats.scanned++;
        const guesses = guessDomainsForCompany(c);
        let hitDomain = null;
        let hitSigs = [];
        let hitStatus = null;
        for (const d of guesses) {
          const p = await probeDomain(d, 5000);
          if (!p.ok) continue;
          stats.dnsHit++;
          const sigs = detectTechSignatures(p.headers, p.body, p.finalUrl);
          // Mission filter — at least one target signature must match,
          // and no negate signature may match.
          if (negate.length && negate.some((n) => sigs.includes(n))) continue;
          const targetMatch = signatures.length ? signatures.some((s) => sigs.includes(s)) : true;
          if (targetMatch) {
            hitDomain = d; hitSigs = sigs; hitStatus = p.statusCode;
            break;
          }
        }
        if (hitDomain) {
          stats.signatureHit++;
          matches.push({
            cvr: c.cvr,
            name: c.name,
            brandName: c.brandName || null,
            industry: c.industry,
            city: c.city,
            employees: c.employees,
            domain: hitDomain,
            statusCode: hitStatus,
            signatures: hitSigs,
            ads: c.ads || null,
            icpFit: !!c.icpFit,
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, candidates.length) }, worker));
    matches.sort((a, b) => (b.ads?.matched || 0) - (a.ads?.matched || 0));
    res.json({ matches, stats, candidatesConsidered: candidates.length });
  } catch (e) {
    console.error("[tech-stack/discover]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/scrape/tech-stack", authMiddleware, async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.domains) ? req.body.domains : [];
    const domains = raw.map(normaliseDomain).filter(d => d && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d));
    if (!domains.length) return res.status(400).json({ error: "Ingen gyldige domæner" });
    if (domains.length > 100) return res.status(400).json({ error: "Max 100 domæner pr. skan" });

    // Concurrency 6 — keeps us under most rate-limiters while finishing
    // 100 domains in ~30s on average.
    const CONC = 6;
    const queue = [...domains];
    const results = new Array(domains.length);
    const idxMap = new Map(); domains.forEach((d, i) => idxMap.set(d, i));

    async function worker() {
      while (queue.length) {
        const d = queue.shift();
        const i = idxMap.get(d);
        const p = await probeDomain(d);
        if (!p.ok) {
          results[i] = { domain: d, error: p.error };
        } else {
          results[i] = {
            domain: d,
            statusCode: p.statusCode,
            finalUrl: p.finalUrl,
            signatures: detectTechSignatures(p.headers, p.body, p.finalUrl),
          };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, domains.length) }, worker));
    res.json({ results });
  } catch (e) {
    console.error("[scrape/tech-stack]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── MAPS SCRAPER (OpenStreetMap Overpass) ──────────────────────────────
// OSM Overpass is a free, no-API-key alternative to Google Places. DK
// coverage is solid — Danish businesses are tagged with shop=*, amenity=*,
// office=*, craft=* etc. Each match includes name, address (street +
// housenumber + postcode), contact:phone/website if the OSM contributor
// added them. We cross-match to CVR via Datafordeler the same way the
// Google Places path did, so downstream consumers don't care which
// backend produced the results.
//
// Why OSM over Google Places:
// - Free, no rate-limit billing surprises (fair-use ~1GB/month is plenty)
// - No API key to provision in Secret Manager
// - Open data — no ToS gotchas about caching results
// - DK community has tagged most physical-location businesses already
//
// Tradeoffs we accept:
// - Coverage is lower than Google for online-only businesses without
//   physical addresses (digital agencies, consultancies). The Tech Stack
//   Scanner + META Scraper better serve that segment anyway.
// - Slower per-request (1–5s typical) — but a single query returns
//   hundreds of POIs vs Google's 20/page → fewer requests overall.

const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Category id → OSM tag pairs. Each category may map to multiple tags
// (e.g. "frisør" covers both shop=hairdresser and shop=beauty).
const OSM_CATEGORY_TAGS = {
  restaurant: [["amenity","restaurant"],["amenity","fast_food"]],
  cafe:       [["amenity","cafe"]],
  frisor:     [["shop","hairdresser"],["shop","beauty"]],
  advokat:    [["office","lawyer"]],
  revisor:    [["office","accountant"]],
  "tandlæge": [["amenity","dentist"],["healthcare","dentist"]],
  fysio:      [["healthcare","physiotherapist"]],
  butik:      [["shop","clothes"],["shop","shoes"],["shop","jewelry"],["shop","mall"],["shop","department_store"],["shop","gift"]],
  auto:       [["shop","car_repair"],["shop","car"]],
  tomrer:     [["craft","carpenter"]],
  el:         [["craft","electrician"]],
  vvs:        [["craft","plumber"]],
};

function buildOsmQuery({ category, city, cities, q, limit = 100 }) {
  // Area clause: Danish municipalities show up in OSM under three naming
  // patterns depending on grammar — "Aarhus", "Aarhus Kommune", and
  // "Københavns Kommune" (genitive). Union all three for every requested
  // city so we can batch multiple cities into a single Overpass call —
  // Overpass fair-use is ~2 concurrent requests, so firing 10 city
  // queries serially gets throttled. One big union query side-steps that.
  // Fallback to all-of-Denmark when no city is given.
  const cityList = Array.isArray(cities) && cities.length
    ? cities
    : (city ? [city] : []);
  const safeCity = s => String(s).replace(/["\\]/g, "");
  let areaClause;
  if (cityList.length) {
    const areaParts = [];
    for (const c of cityList) {
      const s = safeCity(c);
      if (!s) continue;
      areaParts.push(`area["name"="${s}"];`);
      areaParts.push(`area["name"="${s} Kommune"];`);
      areaParts.push(`area["name"="${s}s Kommune"];`);
    }
    areaClause = `(${areaParts.join("")})->.a;`;
  } else {
    areaClause = `area["ISO3166-1"="DK"][admin_level=2]->.a;`;
  }
  // Build inner element queries from category tags. Always query both
  // node + way (POIs come in both representations).
  const parts = [];
  const tagsForCat = OSM_CATEGORY_TAGS[category] || [];
  for (const [k, v] of tagsForCat) {
    parts.push(`node["${k}"="${v}"](area.a);`);
    parts.push(`way["${k}"="${v}"](area.a);`);
  }
  // Free-text query — search by business name (case-insensitive regex)
  // restricted to elements that look like businesses (anything with a
  // shop, amenity, office, healthcare, or craft tag).
  if (q && !tagsForCat.length) {
    const safeQ = String(q).replace(/["\\]/g, "");
    for (const t of ["shop","amenity","office","healthcare","craft"]) {
      parts.push(`node["name"~"${safeQ}",i]["${t}"](area.a);`);
      parts.push(`way["name"~"${safeQ}",i]["${t}"](area.a);`);
    }
  }
  if (parts.length === 0) return null;
  // out body center N — N caps the result count per element type. We
  // multiply by 2 since we ask for both nodes and ways.
  return `[out:json][timeout:30];${areaClause}(${parts.join("")});out body center ${limit * 2};`;
}

function parseOsmElement(el) {
  const tags = el.tags || {};
  if (!tags.name) return null;
  const street = tags["addr:street"] || "";
  const housenumber = tags["addr:housenumber"] || "";
  const postcode = tags["addr:postcode"] || "";
  const cityName = tags["addr:city"] || "";
  const address = [
    [street, housenumber].filter(Boolean).join(" "),
    [postcode, cityName].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  // Pull category back out of the tags so the UI can label it.
  let categoryLabel = "";
  for (const k of ["amenity","shop","office","craft","healthcare"]) {
    if (tags[k]) { categoryLabel = `${k}=${tags[k]}`; break; }
  }
  return {
    name: tags.name,
    address: address || cityName || "",
    city: cityName,
    phone: tags["contact:phone"] || tags["phone"] || "",
    website: tags["contact:website"] || tags["website"] || "",
    email: tags["contact:email"] || tags["email"] || "",
    placeId: `osm_${el.type}_${el.id}`,
    osmCategory: categoryLabel,
  };
}

app.get("/api/scrape/google-maps/status", authMiddleware, (req, res) => {
  // OSM is free + key-less so we report configured=true unconditionally.
  // Surfacing the backend name lets the UI show "Powered by OSM" in the
  // status card instead of the legacy "not configured" warning.
  res.json({ configured: true, backend: "openstreetmap" });
});

app.post("/api/scrape/google-maps", authMiddleware, async (req, res) => {
  try {
    const q = String(req.body?.q || "").trim();
    const city = String(req.body?.city || "").trim();
    const cities = Array.isArray(req.body?.cities) ? req.body.cities.filter(Boolean) : null;
    const category = String(req.body?.category || "").trim();
    // Higher cap since we now batch all cities in one query (10 cities × 50
    // = up to 500 candidates).
    const limit = Math.max(10, Math.min(500, parseInt(req.body?.limit || 200, 10)));
    if (!q && !category) return res.status(400).json({ error: "Indtast en søgeterm eller vælg en kategori" });

    const query = buildOsmQuery({ category, city, cities, q, limit });
    if (!query) return res.status(400).json({ error: "Ukendt kategori — vælg en preset eller indtast søgeterm" });

    // Overpass requires Accept: application/json (otherwise returns
    // 406 Not Acceptable with an HTML error page), plus a User-Agent for
    // fair-use accounting. Query goes in a `data` form field.
    const r = await fetch(OSM_OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "VedioLeads/1.0 (lead generation; contact: noreply@vedio.dk)",
      },
      body: "data=" + encodeURIComponent(query),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(502).json({ error: `OSM Overpass: ${r.status} ${text.slice(0, 200)}` });
    }
    const data = await r.json();
    const elements = data.elements || [];
    // Parse → deduplicate by name+city (same business often appears as
    // both a node and a way) → cap.
    const seen = new Set();
    const parsed = [];
    for (const el of elements) {
      const p = parseOsmElement(el);
      if (!p) continue;
      const key = `${p.name.toLowerCase()}|${(p.city || "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(p);
      if (parsed.length >= limit) break;
    }

    // CVR cross-match — parallel workers so a batch of 200 results
    // doesn't time out. 6-way concurrency mirrors Datafordeler's
    // tolerance and the same pattern we use for the tech-stack agent.
    const stripSuffix = s => String(s||"").toLowerCase().replace(/\s+(aps|a\/s|i\/s|p\/s|k\/s|ivs|holding)\b.*$/i,"").trim();
    const out = new Array(parsed.length);
    const queue = parsed.map((p, i) => ({ p, i }));
    async function cvrWorker() {
      while (queue.length) {
        const { p, i } = queue.shift();
        let cvr = null;
        try {
          const filters = { _from: 0, _size: 5 };
          if (p.city) filters.city = p.city;
          else if (city) filters.city = city;
          const matches = await searchDatafordeler(p.name, filters);
          const rows = (matches && (matches.companies || matches.results || matches.rows)) || [];
          const target = stripSuffix(p.name);
          const hit = rows.find(c => stripSuffix(c.name) === target);
          if (hit && hit.cvr) cvr = hit.cvr;
        } catch { /* keep cvr=null */ }
        out[i] = { ...p, cvr };
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, parsed.length) }, cvrWorker));
    res.json({ results: out, backend: "openstreetmap", scanned: elements.length, candidateCount: parsed.length });
  } catch (e) {
    console.error("[scrape/google-maps]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── APOLLO.IO B2B ENRICHMENT (Phase B replacement) ─────────────────────
// Apollo replaces the Kaspr integration after Kaspr's API turned out to
// be per-LinkedIn-slug instead of per-company. Apollo's mixed_people
// search takes a company domain or name and returns a list of people
// with phone + email + title + LinkedIn URL — exactly the shape we need
// for autonomous enrichment.
//
// Required env: APOLLO_API_KEY (mounted from Secret Manager: apollo-api-key)
//
// API docs: https://api.apollo.io/v1/
// Key endpoint: POST /v1/mixed_people/search

const APOLLO_API_BASE = "https://api.apollo.io/v1";

// Decision-maker titles we care about for cold outbound. Apollo lets us
// filter people-search by title so we don't waste credits revealing
// every employee at a 50-person company.
const APOLLO_TARGET_TITLES = [
  "CEO", "Founder", "Owner", "Co-Founder", "Managing Director",
  "Director", "Head of", "VP", "Vice President",
  "Marketing", "Sales", "CMO", "CRO", "COO",
];

function isApolloConfigured() {
  const k = process.env.APOLLO_API_KEY || "";
  // Reject empty + the deploy-time placeholder. Real Apollo keys are
  // 40+ char alphanumeric.
  return k.length > 10 && !/^PLACEHOLDER/i.test(k);
}

async function enrichWithApollo({ name, domain }) {
  const cleanDomain = String(domain || "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim();
  const body = {
    page: 1,
    per_page: 10,
    person_titles: APOLLO_TARGET_TITLES,
  };
  // Prefer domain when we have it (higher match rate); fall back to name.
  if (cleanDomain) body.q_organization_domains = cleanDomain;
  else if (name) body.q_organization_name = name;
  else throw new Error("Need company name or domain");

  const r = await fetch(`${APOLLO_API_BASE}/mixed_people/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Apollo ${r.status}: ${text.slice(0, 200)}`);
  }
  const d = await r.json();
  const people = d.people || d.contacts || [];
  // Apollo's response: people[] with first_name, last_name, name, title,
  // phone_numbers[{sanitized_number, raw_number}], email, linkedin_url,
  // organization{phone}.
  return people.slice(0, 10).map((p) => {
    const phoneObj = (p.phone_numbers && p.phone_numbers[0]) || {};
    return {
      name: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || "—",
      title: p.title || "",
      phone: phoneObj.sanitized_number || phoneObj.raw_number || p.organization?.phone || "",
      email: p.email || "",
      linkedin: p.linkedin_url || "",
    };
  }).filter((c) => c.name !== "—");
}

app.get("/api/apollo/status", authMiddleware, (req, res) => {
  res.json({ configured: isApolloConfigured(), provider: "apollo.io" });
});

app.post("/api/apollo/enrich/:cvr", authMiddleware, async (req, res) => {
  if (!isApolloConfigured()) {
    return res.status(503).json({ error: "Apollo ikke konfigureret — tilføj APOLLO_API_KEY i Secret Manager", configured: false });
  }
  const cvr = req.params.cvr;
  const ud = loadUserData(req.userId);
  const lead = ud.leads.find((l) => l.cvr === cvr);
  if (!lead) return res.status(404).json({ error: "Lead ikke fundet" });

  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const fresh = lead.apollo_enriched_at && (Date.now() - new Date(lead.apollo_enriched_at).getTime()) < FRESH_MS;
  if (fresh && !req.query.force) {
    return res.json({ ok: true, cached: "user", contacts: lead.contacts || [] });
  }
  // Pool-level cache (cron writes here too)
  const pool = loadDiscoveryState().companies || {};
  const poolEntry = pool[cvr];
  if (poolEntry?.apollo_enriched_at && (Date.now() - new Date(poolEntry.apollo_enriched_at).getTime()) < FRESH_MS && !req.query.force) {
    lead.contacts = poolEntry.contacts || [];
    lead.apollo_enriched_at = poolEntry.apollo_enriched_at;
    const primaryPhone = (lead.contacts.find((c) => c.phone) || {}).phone;
    if (primaryPhone && !lead.phone) lead.phone = primaryPhone;
    saveUserData(req.userId, ud);
    return res.json({ ok: true, cached: "pool", contacts: lead.contacts });
  }
  try {
    const contacts = await enrichWithApollo({
      name: lead.name,
      domain: lead.web || lead.website,
    });
    lead.contacts = contacts;
    lead.apollo_enriched_at = new Date().toISOString();
    const primaryPhone = (contacts.find((c) => c.phone) || {}).phone;
    if (primaryPhone && !lead.phone) lead.phone = primaryPhone;
    saveUserData(req.userId, ud);
    // Write-through to state.json so the pool cache benefits
    if (poolEntry) {
      poolEntry.contacts = contacts;
      poolEntry.apollo_enriched_at = lead.apollo_enriched_at;
      try {
        const state = loadDiscoveryState();
        state.companies[cvr] = poolEntry;
        fs.writeFileSync(DISCOVERY_STATE_FILE, JSON.stringify(state, null, 2));
      } catch (e) { console.warn("[apollo] state.json write-through failed:", e.message); }
    }
    res.json({ ok: true, cached: false, contacts });
  } catch (e) {
    console.error("[apollo/enrich]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// Apollo auto-enrichment cron — same pattern as the Kaspr attempt, but
// with the right API shape. Called by Cloud Scheduler at /api/cron/apollo-enrich.
// Walks ICP-klar pool entries without recent enrichment, batches them
// at 1 req/s to respect Apollo's rate limits.
app.post("/api/cron/apollo-enrich", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isApolloConfigured()) {
    return res.status(503).json({ error: "Apollo not configured" });
  }
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const state = loadDiscoveryState();
  state.companies = state.companies || {};
  const candidates = Object.values(state.companies)
    .filter((c) => c?.icpFit)
    .filter((c) => !c.apollo_enriched_at || (now - new Date(c.apollo_enriched_at).getTime()) > FRESH_MS)
    .sort((a, b) => (b.ads?.matched || 0) - (a.ads?.matched || 0))
    .slice(0, limit);

  const stats = { considered: candidates.length, enriched: 0, withContacts: 0, errors: 0 };
  for (const c of candidates) {
    try {
      const contacts = await enrichWithApollo({
        name: c.name,
        domain: c.website || c.web,
      });
      c.contacts = contacts;
      c.apollo_enriched_at = new Date().toISOString();
      stats.enriched++;
      if (contacts.length > 0) stats.withContacts++;
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {
      console.warn("[apollo-cron]", c.cvr, e.message);
      stats.errors++;
      // Cache the failure so we don't keep retrying broken CVRs every tick
      c.apollo_enriched_at = new Date().toISOString();
      c.contacts = [];
    }
  }
  try {
    fs.writeFileSync(DISCOVERY_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    return res.status(500).json({ error: "state.json write failed: " + e.message, stats });
  }
  console.log("[apollo-cron] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// ─── KASPR ENRICHMENT (Phase B) ─────────────────────────────────────────
// Turns CVR+company-name into decision-maker contacts (phone + email +
// LinkedIn). Without this, ~70% of META-discovered leads have no phone
// and can't be dialed — Kaspr is the "make a lead callable" layer.
//
// Required env: KASPR_API_KEY (mounted from Secret Manager: kaspr-api-key)
//
// Endpoint shape note: Kaspr's API has evolved over time. The integration
// below targets their v2 People/Company search endpoints. If the response
// shape differs from what we map below, only the parsing block in
// /api/kaspr/enrich/:cvr needs to change.

const KASPR_API_BASE = "https://api.kaspr.io/api/v2";
function isKasprConfigured() { return !!process.env.KASPR_API_KEY; }

app.get("/api/kaspr/status", authMiddleware, (req, res) => {
  res.json({ configured: isKasprConfigured() });
});

// Shared Kaspr enrichment helper — used by both the per-lead endpoint
// (user-triggered) and the cron endpoint (auto-enrichment). Takes a
// company shape and returns the parsed contacts[]. Throws on hard error,
// returns [] for empty match.
async function enrichWithKaspr({ name, domain, website, country = "DK" }) {
  const cleanDomain = (domain || website || "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim();
  const payload = {
    country,
    ...(cleanDomain ? { domain: cleanDomain } : {}),
    ...(name ? { company_name: name } : {}),
    limit: 10,
  };
  const r = await fetch(`${KASPR_API_BASE}/contacts/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.KASPR_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Kaspr ${r.status}: ${text.slice(0, 200)}`);
  }
  const d = await r.json();
  const rawContacts = d.contacts || d.data || d.results || [];
  return rawContacts.slice(0, 10).map((c) => ({
    name: c.full_name || `${c.first_name || ""} ${c.last_name || ""}`.trim() || "—",
    title: c.job_title || c.title || "",
    phone: c.direct_phone || c.mobile_phone || c.phone || c.work_phone || "",
    email: c.work_email || c.email || "",
    linkedin: c.linkedin_url || c.linkedin || "",
  })).filter((c) => c.name !== "—");
}

app.post("/api/kaspr/enrich/:cvr", authMiddleware, async (req, res) => {
  if (!isKasprConfigured()) {
    return res.status(503).json({ error: "Kaspr ikke konfigureret — tilføj KASPR_API_KEY i Secret Manager", configured: false });
  }
  const cvr = req.params.cvr;
  const ud = loadUserData(req.userId);
  const lead = ud.leads.find((l) => l.cvr === cvr);
  if (!lead) return res.status(404).json({ error: "Lead ikke fundet" });
  // Cache check 1: user-level cache on the lead itself (30-day freshness)
  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const fresh = lead.kaspr_enriched_at && (Date.now() - new Date(lead.kaspr_enriched_at).getTime()) < FRESH_MS;
  if (fresh && !req.query.force) {
    return res.json({ ok: true, cached: "user", contacts: lead.contacts || [] });
  }
  // Cache check 2: pool-level cache on state.json (populated by the cron).
  // If the cron has already enriched this CVR, copy the cached contacts
  // onto the user's lead — no Kaspr API call needed.
  const pool = loadDiscoveryState().companies || {};
  const poolEntry = pool[cvr];
  if (poolEntry && poolEntry.kaspr_enriched_at && (Date.now() - new Date(poolEntry.kaspr_enriched_at).getTime()) < FRESH_MS && !req.query.force) {
    lead.contacts = poolEntry.contacts || [];
    lead.kaspr_enriched_at = poolEntry.kaspr_enriched_at;
    const primaryPhone = (lead.contacts.find((c) => c.phone) || {}).phone;
    if (primaryPhone && !lead.phone) lead.phone = primaryPhone;
    saveUserData(req.userId, ud);
    return res.json({ ok: true, cached: "pool", contacts: lead.contacts });
  }
  // Cache miss → real Kaspr API call.
  try {
    const contacts = await enrichWithKaspr({
      name: lead.name,
      domain: lead.web || lead.website,
    });
    lead.contacts = contacts;
    lead.kaspr_enriched_at = new Date().toISOString();
    const primaryPhone = (contacts.find((c) => c.phone) || {}).phone;
    if (primaryPhone && !lead.phone) lead.phone = primaryPhone;
    saveUserData(req.userId, ud);
    // Also write-through to state.json's pool entry so other users
    // benefit + the cron doesn't re-enrich this CVR.
    if (poolEntry) {
      poolEntry.contacts = contacts;
      poolEntry.kaspr_enriched_at = lead.kaspr_enriched_at;
      try {
        const state = loadDiscoveryState();
        state.companies[cvr] = poolEntry;
        fs.writeFileSync(DISCOVERY_STATE_FILE, JSON.stringify(state, null, 2));
      } catch (e) { console.warn("[kaspr] state.json write-through failed:", e.message); }
    }
    res.json({ ok: true, cached: false, contacts });
  } catch (e) {
    console.error("[kaspr/enrich]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Kaspr auto-enrichment cron ─────────────────────────────────────────
// Called by Cloud Scheduler (or any external scheduler) every 30 min.
// Walks state.json for ICP-klar companies that don't have contacts yet,
// enriches up to LIMIT per run, saves into the pool. SDR's Review Queue
// then shows leads with contacts already attached.
//
// Auth: X-Cron-Secret header must match env CRON_SECRET. Set up via:
//   gcloud secrets versions access latest --secret=CRON_SECRET
// Cloud Scheduler job:
//   gcloud scheduler jobs create http kaspr-enrich \
//     --schedule="*/30 * * * *" --time-zone="Europe/Copenhagen" \
//     --uri="https://leads-723660132735.europe-west1.run.app/api/cron/kaspr-enrich" \
//     --http-method=POST \
//     --headers="X-Cron-Secret=<the-secret>"
app.post("/api/cron/kaspr-enrich", async (req, res) => {
  // Auth — shared-secret pattern, no user session needed.
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isKasprConfigured()) {
    return res.status(503).json({ error: "Kaspr not configured" });
  }
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const state = loadDiscoveryState();
  state.companies = state.companies || {};
  // Pick the ICP-klar companies that aren't enriched yet (or are stale).
  // Sort by ad-count desc so high-signal leads get enriched first.
  const candidates = Object.values(state.companies)
    .filter((c) => c?.icpFit)
    .filter((c) => !c.kaspr_enriched_at || (now - new Date(c.kaspr_enriched_at).getTime()) > FRESH_MS)
    .sort((a, b) => (b.ads?.matched || 0) - (a.ads?.matched || 0))
    .slice(0, limit);

  const stats = { considered: candidates.length, enriched: 0, withContacts: 0, errors: 0 };
  // 1 req/s rate limit — Kaspr's docs recommend ≤2 RPS; we stay below.
  for (const c of candidates) {
    try {
      const contacts = await enrichWithKaspr({
        name: c.name,
        domain: c.website || c.web,
      });
      c.contacts = contacts;
      c.kaspr_enriched_at = new Date().toISOString();
      stats.enriched++;
      if (contacts.length > 0) stats.withContacts++;
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {
      console.warn("[kaspr-cron]", c.cvr, e.message);
      stats.errors++;
      // Mark with the timestamp so we don't keep retrying broken CVRs
      // on every cron tick. Empty contacts is a valid cache state.
      c.kaspr_enriched_at = new Date().toISOString();
      c.contacts = [];
    }
  }
  // Persist the updated state.json
  try {
    fs.writeFileSync(DISCOVERY_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    return res.status(500).json({ error: "state.json write failed: " + e.message, stats });
  }
  console.log("[kaspr-cron] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// ─── CLOUDTALK (Phase C) ────────────────────────────────────────────────
// Outbound call + SMS via CloudTalk's REST API. Auth is HTTP Basic with
// API_KEY_ID:API_KEY_SECRET. The agent's CloudTalk app receives the call
// when /calls/create.json fires — SDR talks → CloudTalk fires the
// /webhook with call_ended event → we record the call on the lead.
//
// Required env (from Secret Manager):
//   CLOUDTALK_API_KEY_ID        — secret: cloudtalk-api-key-id
//   CLOUDTALK_API_KEY_SECRET    — secret: cloudtalk-api-key-secret
//   CLOUDTALK_AGENT_ID          — set after SDR is onboarded in CloudTalk
//                                 (their dashboard → Agents → ID column)
//   CLOUDTALK_WEBHOOK_TOKEN     — optional shared secret for webhook auth

const CLOUDTALK_API_BASE = "https://my.cloudtalk.io/api";
function isCloudTalkConfigured() {
  return !!(process.env.CLOUDTALK_API_KEY_ID && process.env.CLOUDTALK_API_KEY_SECRET);
}
function isCloudTalkReady() {
  return isCloudTalkConfigured() && !!process.env.CLOUDTALK_AGENT_ID;
}
function cloudTalkAuthHeader() {
  const creds = `${process.env.CLOUDTALK_API_KEY_ID}:${process.env.CLOUDTALK_API_KEY_SECRET}`;
  return "Basic " + Buffer.from(creds).toString("base64");
}

app.get("/api/cloudtalk/status", authMiddleware, (req, res) => {
  res.json({
    configured: isCloudTalkConfigured(),
    ready: isCloudTalkReady(),
    needsAgentId: isCloudTalkConfigured() && !process.env.CLOUDTALK_AGENT_ID,
  });
});

app.post("/api/cloudtalk/call", authMiddleware, async (req, res) => {
  if (!isCloudTalkReady()) {
    // 503 with a clear message so the frontend can fall back to tel: link.
    return res.status(503).json({
      error: isCloudTalkConfigured()
        ? "CloudTalk mangler CLOUDTALK_AGENT_ID — venter på DK-nummer + agent-onboarding"
        : "CloudTalk ikke konfigureret",
      configured: isCloudTalkConfigured(),
      ready: false,
    });
  }
  const { cvr, phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone mangler" });
  try {
    const r = await fetch(`${CLOUDTALK_API_BASE}/calls/create.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": cloudTalkAuthHeader(),
      },
      body: JSON.stringify({
        agent_id: Number(process.env.CLOUDTALK_AGENT_ID),
        callee_number: String(phone).replace(/\s+/g, ""),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: `CloudTalk: ${r.status} ${JSON.stringify(d).slice(0, 200)}` });
    }
    // Persist call init on the lead so the webhook can match call_ended.
    if (cvr) {
      const ud = loadUserData(req.userId);
      const lead = (ud.leads || []).find((l) => l.cvr === cvr);
      if (lead) {
        lead.lastCallAt = new Date().toISOString();
        lead.lastCloudTalkCallId = d.call_id || d.data?.call_id || d.id || null;
        saveUserData(req.userId, ud);
      }
    }
    res.json({ ok: true, callId: d.call_id || d.data?.call_id || d.id || null });
  } catch (e) {
    console.error("[cloudtalk/call]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/cloudtalk/sms", authMiddleware, async (req, res) => {
  if (!isCloudTalkConfigured()) {
    return res.status(503).json({ error: "CloudTalk ikke konfigureret", configured: false });
  }
  const { cvr, phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ error: "phone + message kræves" });
  try {
    const r = await fetch(`${CLOUDTALK_API_BASE}/sms/send.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": cloudTalkAuthHeader(),
      },
      body: JSON.stringify({
        agent_id: process.env.CLOUDTALK_AGENT_ID ? Number(process.env.CLOUDTALK_AGENT_ID) : undefined,
        to_number: String(phone).replace(/\s+/g, ""),
        text: String(message).slice(0, 480), // CloudTalk SMS cap
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: `CloudTalk SMS: ${r.status} ${JSON.stringify(d).slice(0, 200)}` });
    }
    if (cvr) {
      const ud = loadUserData(req.userId);
      const lead = (ud.leads || []).find((l) => l.cvr === cvr);
      if (lead) {
        lead.last_sms_at = new Date().toISOString();
        saveUserData(req.userId, ud);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[cloudtalk/sms]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// CloudTalk webhook receiver — configure this URL in CloudTalk dashboard:
//   Settings → Webhooks → "Call ended" event →
//   https://leads-723660132735.europe-west1.run.app/api/cloudtalk/webhook
// Optional auth via shared secret in CLOUDTALK_WEBHOOK_TOKEN.
app.post("/api/cloudtalk/webhook", express.json({ type: "*/*" }), (req, res) => {
  // Webhook signature verification (CloudTalk includes a token or HMAC
  // header — confirm exact mechanism in their docs, then validate here).
  const expectedToken = process.env.CLOUDTALK_WEBHOOK_TOKEN;
  if (expectedToken && req.headers["x-cloudtalk-token"] !== expectedToken) {
    return res.status(401).json({ error: "Invalid webhook token" });
  }
  try {
    const evt = req.body || {};
    console.log("[cloudtalk-webhook]", evt.event || "unknown", "call_id=", evt.call_id || evt.id || "?");
    // Match the event back to a lead by CloudTalk call_id and persist
    // the disposition/duration.
    const callId = evt.call_id || evt.id;
    if (callId) {
      // Scan all users' leads for the matching call (cheap with current scale)
      const fs = require("fs");
      const path = require("path");
      const usersDir = path.join(DATA_DIR, "users");
      if (fs.existsSync(usersDir)) {
        for (const f of fs.readdirSync(usersDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            const userData = JSON.parse(fs.readFileSync(path.join(usersDir, f), "utf8"));
            const lead = (userData.leads || []).find((l) => String(l.lastCloudTalkCallId) === String(callId));
            if (lead) {
              lead.lastCallEndedAt = new Date().toISOString();
              lead.lastCallDuration = evt.talking_time_seconds || evt.duration || null;
              lead.lastCallRecordingUrl = evt.recording_url || null;
              fs.writeFileSync(path.join(usersDir, f), JSON.stringify(userData, null, 2));
              break;
            }
          } catch { /* skip malformed user files */ }
        }
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error("[cloudtalk-webhook]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── TWENTY CRM PUSH (Phase D stub) ─────────────────────────────────────
// When the cockpit dispositions a lead as "Interesseret", we want an
// Opportunity created in Twenty CRM automatically. Until TWENTY_API_TOKEN
// + TWENTY_WORKSPACE_URL are in Secret Manager, these endpoints return
// "not configured" so the cockpit can call them safely — the day the
// creds drop in, nothing else changes.
app.get("/api/twenty/status", authMiddleware, (req, res) => {
  res.json({
    configured: !!(process.env.TWENTY_API_TOKEN && process.env.TWENTY_WORKSPACE_URL),
    workspaceUrl: process.env.TWENTY_WORKSPACE_URL || null,
  });
});

app.post("/api/twenty/push", authMiddleware, async (req, res) => {
  const { cvr, notes, callDuration, disposition } = req.body || {};
  if (!cvr) return res.status(400).json({ error: "cvr mangler" });

  // Configuration check — if creds aren't set, mark the lead as "queued
  // for Twenty" so we can replay later, and return a soft-503 so the
  // cockpit shows a "kommer i Phase D" hint instead of crashing.
  if (!process.env.TWENTY_API_TOKEN || !process.env.TWENTY_WORKSPACE_URL) {
    try {
      const d = loadUserData(req.userId);
      const lead = (d.leads || []).find((l) => l.cvr === cvr);
      if (lead) {
        lead.twenty_queued_at = new Date().toISOString();
        lead.twenty_queued_notes = notes || "";
        lead.twenty_queued_disposition = disposition || "interested";
        saveUserData(req.userId, d);
      }
    } catch { /* non-fatal */ }
    return res.status(503).json({
      error: "Twenty ikke konfigureret endnu — leadet er køet til auto-push når Phase D går live.",
      configured: false,
      queued: true,
    });
  }

  // Real Twenty API call (placeholder — will fill in once endpoint shape
  // is confirmed against the Twenty workspace's GraphQL API).
  try {
    const d = loadUserData(req.userId);
    const lead = (d.leads || []).find((l) => l.cvr === cvr);
    if (!lead) return res.status(404).json({ error: "Lead ikke fundet" });

    // TODO: Replace with real Twenty GraphQL mutation. The endpoint will
    // look something like:
    //   POST {workspaceUrl}/graphql
    //   { query: "mutation createOpportunity(...) { ... }", variables: {...} }
    // Shape isn't worth speculating about until we have the real schema.
    const stubResponse = {
      id: `placeholder_${Date.now()}`,
      url: `${process.env.TWENTY_WORKSPACE_URL}/objects/opportunities/placeholder_${Date.now()}`,
    };

    lead.twenty_opportunity_id = stubResponse.id;
    lead.twenty_pushed_at = new Date().toISOString();
    lead.twenty_url = stubResponse.url;
    saveUserData(req.userId, d);
    res.json({ ok: true, opportunity: stubResponse });
  } catch (e) {
    console.error("[twenty/push]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎯 Vedio Sales kører på http://localhost:${PORT}`);
  console.log(`📡 CVR-provider: datafordeler`);
  console.log(`💾 Data gemmes i: ${DATA_FILE}`);
  if (process.env.CLEARBIT_KEY) console.log("✨ Clearbit enrichment: aktiveret");
  if (process.env.N8N_WEBHOOK_URL) console.log("⚡ n8n webhook: konfigureret");
  if (process.env.TWILIO_ACCOUNT_SID) console.log(`📞 Twilio dialer: konfigureret (${process.env.TWILIO_FROM_NUMBER||'intet nummer'})`);
  else console.log("📞 Twilio dialer: ikke konfigureret (tilføj TWILIO_* i .env for at aktivere browser-opkald)");
  console.log(`🔑 Datafordeler GraphQL: ${process.env.DATAFORDELER_KEY ? "API-nøgle konfigureret" : "⚠️  DATAFORDELER_KEY mangler i .env"}`);
  console.log(`🤖 Gemini AI enrichment: ${process.env.GEMINI_API_KEY ? "konfigureret" : "⚠️  GEMINI_API_KEY mangler"}`);
  if (loadGmailConfig()) console.log("📧 Gmail OAuth: konfigureret");
  else console.log("📧 Gmail OAuth: ikke konfigureret (opsæt via Indstillinger → Gmail)");
  console.log("\nStop med Ctrl+C\n");

  // Pre-warm cache for common industry codes in background
  if (process.env.DATAFORDELER_KEY) {
    // Pre-warm: fetch IDs only (fast) for top industry codes, enrichment happens on-demand
    const PREWARM_CODES = [
      '691000','741100','692000','741200','620100','621000','620200','622000',
      '412000','432100','453100','432200','453300','433200','454200',
      '561010','561020','563000','551000','551010',
      '702000','702200','681000','682040','683110',
      '494100','731000','711100','711210','812100','862100','960210',
      '641900','451120','452010','471900','461900',
    ];
    setTimeout(async () => {
      console.log(`[prewarm] Pre-fetching IDs for ${PREWARM_CODES.length} industry codes...`);
      let totalIds = 0;
      for (const code of PREWARM_CODES) {
        if (loadCachedIndustry(code)) continue; // already has enriched data
        try {
          // Only fetch IDs (1 page = 1000), store in memory cache for when user searches
          const r = await dfGqlFetch(`{ CVR_Branche(first: 1000, where: { vaerdi: { eq: "${code}" } }) { edges { node { CVREnhedsId } } } }`);
          const ids = (r?.CVR_Branche?.edges || []).map(e => e.node.CVREnhedsId);
          if (ids.length > 0) {
            cacheSet(`df-ids-code:${code}`, ids);
            totalIds += ids.length;
          }
          await new Promise(r => setTimeout(r, 200));
        } catch(e) { /* skip silently */ }
      }
      console.log(`[prewarm] ✅ ${totalIds} company IDs pre-fetched across ${PREWARM_CODES.length} codes`);
    }, 3000);
  }
});
