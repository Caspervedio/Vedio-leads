require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DATA_FILE = path.join(DATA_DIR, "data.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

app.use(cors());
app.use(express.json());
// Never cache the SPA shell (index.html) — it's a single-page app, so a
// stale shell means the browser runs old in-memory JS after a deploy.
// no-store guarantees a normal refresh always pulls the latest build.
// (Hashed/static assets below can still be cached by the browser.)
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.set("Cache-Control", "no-store, must-revalidate");
  }
  next();
});
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

// ── Activity log ────────────────────────────────────────────────────────
// Append-only feed of system events (imports, promotions, enrichment,
// calls, scraper runs) so the user can see what the machine is doing.
// Ring buffer: keeps the last 400 events in activity.json.
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
function logActivity(type, message, meta) {
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8")); } catch {}
    if (!Array.isArray(log)) log = [];
    log.push({ at: new Date().toISOString(), type, message, meta: meta || null });
    if (log.length > 400) log = log.slice(-400);
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(log));
  } catch (e) { console.warn("[activity]", e.message); }
}

// Free/personal email providers — we can't derive a company from these,
// so CSV people-rows with these domains skip Apollo enrichment.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com","googlemail.com","hotmail.com","hotmail.dk","hotmail.co.uk","outlook.com","outlook.dk",
  "live.com","live.dk","yahoo.com","yahoo.dk","yahoo.co.uk","icloud.com","me.com","mac.com","msn.com",
  "aol.com","protonmail.com","proton.me","gmx.com","gmx.de","mail.com","mail.dk","webspeed.dk","stofanet.dk",
  "post.tele.dk","privat.dk","email.dk","yahoo.de","mailbox.org","fastmail.com",
]);
function businessDomainFromEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return "";
  const d = e.split("@")[1].trim();
  if (!d || FREE_EMAIL_DOMAINS.has(d)) return "";
  return d;
}

// Active callers — only these user IDs are in the call rotation (default
// Nicolas/u1). Imports/manual-adds by a non-caller (e.g. admin) route to
// the first active caller so uploaded leads land in the dialing queue.
function getActiveCallerIds() {
  return (process.env.AUTODIALER_USER_IDS || "u1").split(",").map((s) => s.trim()).filter(Boolean);
}
function routeToCallerId(reqUserId) {
  const callers = getActiveCallerIds();
  return callers.includes(reqUserId) ? reqUserId : (callers[0] || reqUserId);
}

// ── User auth ─────────────────────────────────────────────────────────────────
// PR7 (2026-06-11): Switched to STATELESS SIGNED TOKENS. Each token is
// `v1.<base64url-payload>.<base64url-hmac-sha256>` — server verifies the
// HMAC against SESSION_SECRET, no lookup required. Survives:
//   · Cloud Run cold-start (no need to load sessions.json from GCS Fuse)
//   · Mid-deploy session-issuance race (no in-flight write to lose)
//   · Multi-instance scaling
//
// Casper kept hitting "logged out on refresh" because the previous Map-
// based approach lost sessions when Cloud Run instances died before the
// fsync'd disk write committed. Signed tokens make the server stateless
// for auth — same approach JWT uses minus the spec overhead.
//
// Token lifetime: 30 days from issuance. Token doesn't slide on activity
// to keep it simple; user re-logs in once a month worst case.
//
// Legacy Map still loads from disk so tokens issued BEFORE this commit
// keep working until they expire naturally. New logins issue signed.
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.CRON_SECRET || "dev-only-rotate-in-prod";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function signSessionToken(userId) {
  const payload = JSON.stringify({ u: userId, iat: Date.now() });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  return `v1.${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string" || !token.startsWith("v1.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payloadB64 = parts[1];
  const sig = parts[2];
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
  // Constant-time compare to defeat timing attacks
  if (sig.length !== expected.length) return null;
  let bad = 0;
  for (let i = 0; i < sig.length; i++) bad |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (bad !== 0) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.u || !payload.iat) return null;
    if (Date.now() - payload.iat > SESSION_LIFETIME_MS) return null;
    return payload.u;
  } catch { return null; }
}

const sessions = new Map(); // token -> userId  (legacy — kept for in-flight old tokens)
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function _loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) || {};
    const now = Date.now();
    let loaded = 0, pruned = 0;
    for (const [token, entry] of Object.entries(raw)) {
      const userId = typeof entry === "string" ? entry : entry?.userId;
      const lastSeen = typeof entry === "object" ? (entry.lastSeenAt || entry.createdAt) : null;
      if (!userId) continue;
      if (lastSeen && (now - new Date(lastSeen).getTime()) > SESSION_TTL_MS) { pruned++; continue; }
      sessions.set(token, userId);
      loaded++;
    }
    if (loaded || pruned) console.log(`[sessions] loaded ${loaded} sessions from disk, pruned ${pruned} expired`);
  } catch (e) { console.warn("[sessions] load failed:", e.message); }
}

// Disk write with explicit fsync. GCS Fuse buffers writes in memory and
// flushes lazily to Cloud Storage — without fsync, the buffer can sit in
// the dying Cloud Run instance and never reach GCS. Result: every deploy
// silently loses any session created in the last few seconds, and the
// SDR sees "Ikke logget ind" on next refresh.
//
// fsync forces the Fuse layer to push the buffer to GCS before returning.
// Slightly slower (50-200ms) but the durability is what we actually need.
function _writeSessionsSync() {
  try {
    const out = {};
    const now = new Date().toISOString();
    for (const [token, userId] of sessions.entries()) {
      out[token] = { userId, lastSeenAt: now };
    }
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const fd = fs.openSync(SESSIONS_FILE, "w");
    try {
      fs.writeSync(fd, JSON.stringify(out));
      try { fs.fsyncSync(fd); } catch (_) { /* fsync unsupported on some FSes — best-effort */ }
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) { console.warn("[sessions] save failed:", e.message); }
}

// Debounce wrapper for high-frequency updates (e.g. lastSeenAt bumps on
// repeated /api/auth/me calls). NEW sessions skip the debounce entirely
// and write synchronously — see the sessions.set wrapper below.
let _sessionsSaveTimer = null;
function _saveSessionsToDisk() {
  if (_sessionsSaveTimer) return;
  _sessionsSaveTimer = setTimeout(() => {
    _sessionsSaveTimer = null;
    _writeSessionsSync();
  }, 250); // tight throttle — we want sessions durable fast
}

// Wrap the Map's set/delete so disk mirror happens automatically.
// New sessions (login flows) write SYNCHRONOUSLY with fsync — we never
// want to lose a fresh login to a Cloud Run cold-restart that happens
// within the debounce window.
const _origSessionsSet = sessions.set.bind(sessions);
const _origSessionsDelete = sessions.delete.bind(sessions);
const _origSessionsHas = sessions.has.bind(sessions);
sessions.set = function(token, userId) {
  const isNew = !_origSessionsHas(token);
  const r = _origSessionsSet(token, userId);
  if (isNew) {
    _writeSessionsSync(); // durable immediately
  } else {
    _saveSessionsToDisk(); // debounced (just refreshing lastSeenAt)
  }
  return r;
};
sessions.delete = function(token) {
  const r = _origSessionsDelete(token);
  _writeSessionsSync(); // explicit logout — durable immediately
  return r;
};

// Load existing sessions at boot — must happen before authMiddleware
// starts serving requests.
_loadSessionsFromDisk();

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
  if (!token) return res.status(401).json({ error: "Ikke logget ind" });
  // PR7: try signed-token format first (stateless, survives deploys).
  const signedUserId = verifySessionToken(token);
  if (signedUserId) {
    req.userId = signedUserId;
    return next();
  }
  // Fall back to legacy session Map for tokens issued before this commit.
  // Those will work until they expire naturally — new logins issue signed.
  if (sessions.has(token)) {
    req.userId = sessions.get(token);
    return next();
  }
  return res.status(401).json({ error: "Ikke logget ind" });
}

// ── In-memory cache ──────────────────────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutter

// ── Datafordeler API-nøgle (query parameter) ──────────────────────────────────
function getDfGqlUrl() {
  const key = process.env.DATAFORDELER_KEY;
  if (!key) throw new Error("DATAFORDELER_KEY mangler i .env");
  // 2026-06-02: Datafordeler deprecated /CVR/v1 — it returns silent 404
  // for all POSTs even with a valid IP-whitelisted API key. The new
  // endpoint /CVR/v2 is a drop-in replacement (same schema names:
  // CVR_Branche, CVR_Virksomhed, CVR_Navn, CVR_Adressering, CVR_Telefonnummer,
  // CVR_Beskaeftigelse, etc). Confirmed working with same DATAFORDELER_KEY.
  return `https://graphql.datafordeler.dk/CVR/v2?apiKey=${encodeURIComponent(key)}`;
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
  // PR7: issue stateless signed token. No Map lookup needed on subsequent
  // requests — every Cloud Run instance can verify the HMAC independently.
  // Token expires 30 days from now (inactive-timeout behavior).
  const token = signSessionToken(user.id);
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

    // PR7: signed token (stateless, survives deploys)
    const token = signSessionToken(user.id);
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

// ── LIST BUILDER ──────────────────────────────────────────────────────
// Pulls a curated DK company list from Datafordeler by industry +
// city/postcode + employee range. Wraps the existing GraphQL walkers
// (CVR_Branche → CVR_Virksomhed → CVR_Navn/CVR_Adressering/CVR_Beskaeftigelse/
// CVR_Telefonnummer) into one endpoint that returns a ready-to-display list.
//
// Use case: "Build me all DK bakeries in Aarhus with 5-20 employees" →
// gives operator a list they can review and bulk-push to the autodialer
// (where the same Apollo enrich + Meta verify gates apply as for the
// daily discovery crons).

// Curated industry presets with friendly Danish labels. UI shows the label,
// passes the DB07 codes. Each preset is a small bundle of related codes so
// the operator doesn't have to know DB07. (We have ~700 DB07 codes total —
// only the most-common SMB categories are surfaced here.)
const LIST_BUILDER_INDUSTRIES = [
  { id: "restaurant",   label: "Restauranter & cafeer", codes: ["561010", "561020", "563000", "563010"] },
  { id: "bakery",       label: "Bagerier & konditori",  codes: ["107110", "472100"] },
  { id: "hotel",        label: "Hoteller & kroer",      codes: ["551000", "551010", "551020", "551110", "551120"] },
  { id: "frisor",       label: "Frisør & beauty",       codes: ["960210", "960220", "960400"] },
  { id: "fitness",      label: "Fitness & wellness",    codes: ["931100", "931200", "931300", "961040"] },
  { id: "tandlaege",    label: "Tandlæger & klinikker", codes: ["862100", "862200", "869020"] },
  { id: "fysio",        label: "Fysioterapi & sundhed", codes: ["869090", "869900"] },
  { id: "butik",        label: "Detailbutikker (tøj/sko/smykker)", codes: ["477110", "477120", "477210", "477300", "477500"] },
  { id: "moebler",      label: "Møbler & interiør",     codes: ["475100", "477820", "310900"] },
  { id: "ecommerce",    label: "E-commerce / web-shop", codes: ["478910", "478990"] },
  { id: "it",           label: "IT/software/webbureau", codes: ["620100", "620200", "621000", "622000", "631100"] },
  { id: "marketing",    label: "Reklame, marketing, design", codes: ["731000", "733000", "741010"] },
  { id: "consulting",   label: "Konsulent & rådgivning", codes: ["702000", "702200", "702100"] },
  { id: "haandvaerk",   label: "Tømrer/murer/maler/el/VVS", codes: ["412000", "432100", "432200", "433100", "433200", "433410"] },
  { id: "auto",         label: "Auto (værksted/handel)", codes: ["451120", "452010"] },
  { id: "transport",    label: "Transport & logistik",   codes: ["494100", "493900", "522900"] },
  { id: "advokat",      label: "Advokater, jura",       codes: ["691000"] },
  { id: "revisor",      label: "Revisorer & regnskab",  codes: ["692000"] },
  { id: "ejendom",      label: "Ejendomsmæglere",       codes: ["683110", "683210"] },
  { id: "rejse",        label: "Rejsebureauer & oplevelse", codes: ["791100", "791200"] },
];

app.get("/api/list-builder/industries", authMiddleware, (req, res) => {
  res.json(LIST_BUILDER_INDUSTRIES);
});

// POST /api/list-builder/search
// Body: {
//   industries: ["restaurant","bakery"]   // preset ids OR raw DB07 codes
//   city: "Aarhus"                          // optional, exact match (case-insensitive)
//   zipPrefix: "8"                          // optional, e.g. "8" matches all Aarhus postcodes
//   employeesMin: 5 employeesMax: 20        // optional, applied AFTER fetch
//   limit: 200                              // max companies to fetch (default 200, cap 1000)
// }
app.post("/api/list-builder/search", authMiddleware, async (req, res) => {
  const body = req.body || {};
  const requested = Array.isArray(body.industries) ? body.industries : [];
  if (!requested.length) return res.status(400).json({ error: "Vælg mindst en branche" });

  // Resolve preset ids → DB07 codes (passthrough raw codes too)
  const codes = new Set();
  for (const item of requested) {
    const preset = LIST_BUILDER_INDUSTRIES.find((p) => p.id === item);
    if (preset) preset.codes.forEach((c) => codes.add(c));
    else if (/^\d{6}$/.test(String(item))) codes.add(String(item));
  }
  if (codes.size === 0) return res.status(400).json({ error: "Ingen gyldige branchekoder" });

  // Normalize city input to match Datafordeler's storage convention.
  // DF stores "Århus C", "Århus N", "Århus V" etc — user typically types
  // "Aarhus". The Danish ligature Aa ↔ Å are equivalent; same for ø/oe
  // and æ/ae. We normalize BOTH sides for substring matching.
  const normaliseCity = (s) => String(s || "")
    .toLowerCase()
    .replace(/å/g, "aa")
    .replace(/ø/g, "oe")
    .replace(/æ/g, "ae")
    .trim();
  const cityFilter = normaliseCity(body.city);
  const zipPrefix = String(body.zipPrefix || "").trim();
  const empMin = body.employeesMin != null ? Number(body.employeesMin) : null;
  const empMax = body.employeesMax != null ? Number(body.employeesMax) : null;
  const LIMIT = Math.max(10, Math.min(1000, Number(body.limit) || 200));

  const stats = { codesScanned: 0, idsFound: 0, enriched: 0, returned: 0 };
  const allIds = new Set();

  // 1. Fetch all enheds IDs for each industry code (paginated up to 3 pages × 1000)
  for (const code of [...codes]) {
    stats.codesScanned++;
    let cursor = null;
    for (let p = 0; p < 3; p++) {
      try {
        const afterClause = cursor ? `, after: "${cursor}"` : "";
        const r = await dfGqlFetch(
          `{ CVR_Branche(first: 1000${afterClause}, where: { vaerdi: { eq: "${code}" } }) { pageInfo { hasNextPage endCursor } edges { node { CVREnhedsId } } } }`,
        );
        const d = r?.CVR_Branche;
        for (const e of (d?.edges || [])) allIds.add(e.node.CVREnhedsId);
        if (!d?.pageInfo?.hasNextPage) break;
        cursor = d.pageInfo.endCursor;
        if (allIds.size >= LIMIT * 5) break; // cap fetch — filters reduce after
      } catch (e) {
        console.warn("[list-builder] code", code, "page", p, ":", e.message);
        break;
      }
    }
  }
  stats.idsFound = allIds.size;
  if (allIds.size === 0) {
    return res.json({ ok: true, stats, companies: [] });
  }

  // 2. Enrich in batches of 100 — names, addresses, employees, phones, status
  const ids = [...allIds].slice(0, LIMIT * 5); // hard cap on enrichment
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const navnMap = new Map(), adrMap = new Map(), tlfMap = new Map();
  const beskMap = new Map(), vrkMap = new Map(), brancheMap = new Map();
  for (const batch of chunk(ids, 100)) {
    const idList = batch.map((id) => `"${id}"`).join(",");
    const w = `CVREnhedsId: { in: [${idList}] }`;
    const sz = batch.length;
    try {
      const [rN, rA, rT, rBe, rV, rB] = await Promise.all([
        dfGqlFetch(`{ CVR_Navn(first: ${sz * 6}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
        dfGqlFetch(`{ CVR_Adressering(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId CVRAdresse_postnummer CVRAdresse_postdistrikt CVRAdresse_vejnavn CVRAdresse_husnummerFra } } } }`),
        dfGqlFetch(`{ CVR_Telefonnummer(first: ${sz * 3}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
        dfGqlFetch(`{ CVR_Beskaeftigelse(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId antal intervalFra intervalTil } } } }`),
        dfGqlFetch(`{ CVR_Virksomhed(first: ${sz}, where: { id: { in: [${idList}] } }) { edges { node { id CVRNummer status virksomhedStartdato } } } }`),
        dfGqlFetch(`{ CVR_Branche(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi vaerdiTekst } } } }`),
      ]);
      for (const e of rN?.CVR_Navn?.edges || []) {
        if (!navnMap.has(e.node.CVREnhedsId)) navnMap.set(e.node.CVREnhedsId, []);
        navnMap.get(e.node.CVREnhedsId).push(e.node.vaerdi);
      }
      for (const e of rA?.CVR_Adressering?.edges || []) adrMap.set(e.node.CVREnhedsId, e.node);
      for (const e of rT?.CVR_Telefonnummer?.edges || []) {
        const v = String(e.node.vaerdi || "").trim();
        if (v) tlfMap.set(e.node.CVREnhedsId, v);
      }
      for (const e of rBe?.CVR_Beskaeftigelse?.edges || []) beskMap.set(e.node.CVREnhedsId, e.node);
      for (const e of rV?.CVR_Virksomhed?.edges || []) vrkMap.set(e.node.id, e.node);
      for (const e of rB?.CVR_Branche?.edges || []) brancheMap.set(e.node.CVREnhedsId, e.node);
    } catch (e) {
      console.warn("[list-builder] enrich batch failed:", e.message);
    }
  }
  stats.enriched = vrkMap.size;

  // 3. Build company objects + apply filters
  const out = [];
  for (const eid of ids) {
    const vrk = vrkMap.get(eid);
    if (!vrk) continue;
    if (vrk.status !== "aktiv") continue;
    const names = navnMap.get(eid) || [];
    const adr = adrMap.get(eid) || {};
    const besk = beskMap.get(eid) || {};
    const br = brancheMap.get(eid) || {};
    const cityRaw = String(adr.CVRAdresse_postdistrikt || "");
    const cityNormalised = normaliseCity(cityRaw);
    const zip = String(adr.CVRAdresse_postnummer || "");
    // Bidirectional Aa↔Å match — "aarhus" matches "Århus C"
    if (cityFilter && !cityNormalised.includes(cityFilter)) continue;
    if (zipPrefix && !zip.startsWith(zipPrefix)) continue;
    const employees = besk.antal ?? besk.intervalFra ?? null;
    // Only filter when we KNOW the employee count. Unknown employee data is
    // very common in DK (small businesses don't always report headcount to
    // CVR). Including those leads is the right default — the SDR can still
    // see and assess them. Was previously dropping unknown-emp leads which
    // killed all small businesses (frisør salons, etc) from results.
    if (empMin != null && employees != null && employees < empMin) continue;
    if (empMax != null && employees != null && employees > empMax) continue;
    out.push({
      cvr: String(vrk.CVRNummer || ""),
      enhedsId: eid,
      name: names[names.length - 1] || `CVR ${vrk.CVRNummer}`,
      status: vrk.status,
      founded: vrk.virksomhedStartdato || "",
      address: [adr.CVRAdresse_vejnavn, adr.CVRAdresse_husnummerFra].filter(Boolean).join(" "),
      city: adr.CVRAdresse_postdistrikt || "",
      zip,
      phone: tlfMap.get(eid) || "",
      employees,
      employeesInterval: besk.intervalFra != null && besk.intervalTil != null ? `${besk.intervalFra}-${besk.intervalTil}` : "",
      industry: br.vaerdiTekst || "",
      industryCode: String(br.vaerdi || ""),
    });
    if (out.length >= LIMIT) break;
  }
  stats.returned = out.length;
  res.json({ ok: true, stats, companies: out });
});

// POST /api/list-builder/add-to-dialer
// Body: { cvrs: ["12345678", ...], verifyMeta: true }
// Bulk-promote a curated list to u1's dialer with the same gates the
// daily discovery crons use: Apollo enrich → DK + 5-50 emp → optional
// live Meta Ad Library verify. Existing leads (matched by cvr) skipped.
app.post("/api/list-builder/add-to-dialer", authMiddleware, async (req, res) => {
  const body = req.body || {};
  const cvrs = Array.isArray(body.cvrs) ? body.cvrs.map(String).filter((c) => /^\d{8}$/.test(c)) : [];
  const verifyMeta = body.verifyMeta !== false; // default true
  if (cvrs.length === 0) return res.status(400).json({ error: "Ingen CVR-numre angivet" });

  const TARGET_USER = req.userId || "u1";
  const stats = { requested: cvrs.length, added: 0, alreadyExists: 0, errors: 0, parkedNoMeta: 0 };

  const ud = loadUserData(TARGET_USER);
  if (!ud.leads) ud.leads = [];
  const existingByCvr = new Set(ud.leads.map((l) => l.cvr));

  // Resolve each CVR via Datafordeler in parallel-ish (3-way concurrency)
  const queue = [...cvrs];
  const candidates = [];
  async function worker() {
    while (queue.length) {
      const cvr = queue.shift();
      if (existingByCvr.has(cvr)) { stats.alreadyExists++; continue; }
      try {
        const c = await lookupDatafordeler(cvr);
        if (!c) { stats.errors++; continue; }
        candidates.push(c);
      } catch (e) { stats.errors++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, cvrs.length) }, worker));

  // Optional live-Meta verify so we don't pollute the dialer
  let verifyMap = new Map();
  if (verifyMeta && process.env.APIFY_API_TOKEN && candidates.length > 0) {
    try {
      const startUrls = candidates.map((c) => ({
        url: buildAdsLibraryUrl(brandForMetaAdsSearch(c.name)),
        _cvr: c.cvr,
      }));
      const items = await apifyVerifyMetaAds(startUrls);
      const urlToCvr = new Map(startUrls.map((s) => [s.url, s._cvr]));
      const byUrl = new Map();
      for (const it of items) {
        const u = it.inputUrl;
        if (!byUrl.has(u)) byUrl.set(u, []);
        byUrl.get(u).push(it);
      }
      const checkedAt = new Date().toISOString();
      for (const [url, group] of byUrl) {
        const cvr = urlToCvr.get(url);
        if (!cvr) continue;
        const c = classifyAdActivity(group);
        verifyMap.set(cvr, { active: c.recent90d > 0, activeNow: c.activeNow, recent90d: c.recent90d, totalCount: c.total, checkedAt });
      }
    } catch (e) {
      console.warn("[list-builder] verify failed:", e.message);
    }
  }

  // Append leads
  const checkedAt = new Date().toISOString();
  for (const c of candidates) {
    const verify = verifyMap.get(c.cvr);
    const hasPhone = !!(c.phone || "").toString().trim();
    if (verifyMeta && verify && !verify.active) { stats.parkedNoMeta++; continue; }
    ud.leads.push({
      cvr: c.cvr,
      name: c.name,
      addr: c.address || "",
      zip: c.zip || "",
      city: c.city || "",
      ph: c.phone || "",
      em: c.email || "",
      web: "",
      ind: c.industry || "",
      ic: c.industryCode || "",
      emp: c.employees || "",
      emps: typeof c.employeeCount === "number" ? c.employeeCount : null,
      st: c.status || "aktiv",
      yr: c.founded || "",
      form: c.form || "",
      eq: c.equity || 0, res: c.result || 0, omsaetning: c.revenue || 0,
      source: "list-builder",
      icpFit: !!(verify && verify.active),
      meta_advertiser: !!(verify && verify.active),
      ad_signals: verify && verify.active ? ["Meta Ad Library (live)"] : [],
      meta_verified_active: verify ? verify.active : null,
      meta_verified_at: verify ? verify.checkedAt : null,
      meta_live_ad_count: verify ? verify.totalCount : null,
      apollo_enrichment_pending: isApolloConfigured(),
      apollo_enriched_at: null,
      phone_missing: !hasPhone,
      discovered_at: checkedAt,
      pushed_to_cloudtalk_at: null, twenty_opportunity_id: null,
    });
    stats.added++;
  }
  saveUserData(TARGET_USER, ud);
  logActivity(
    "list-builder",
    `Liste-builder: ${stats.added} leads tilføjet · ${stats.parkedNoMeta} ikke i Meta · ${stats.alreadyExists} eksisterede allerede`,
    { stats, userId: TARGET_USER },
  );
  res.json({ ok: true, stats });
});

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
const DISCOVERY_POOL_FILE = path.join(DATA_DIR, "discovery", "pool.json");

function loadDiscoveryState() {
  return loadJsonFile(DISCOVERY_STATE_FILE, { companies: {} });
}

// Deep reserve — the full Datafordeler candidate pool (~100k companies in
// target industries). state.json only holds companies the Meta scraper has
// processed; with the scraper IP-blocked it no longer grows, so the
// autodialer pulls from pool.json directly to keep daily volume flowing.
// Cached in memory (file is ~25MB, rebuilt ~weekly) and reloaded on mtime
// change so a fresh Datafordeler walk is picked up without a redeploy.
let _poolCandCache = null;
let _poolCandMtime = 0;
function loadDiscoveryPoolCandidates() {
  try {
    const st = fs.statSync(DISCOVERY_POOL_FILE);
    if (!_poolCandCache || st.mtimeMs !== _poolCandMtime) {
      const j = JSON.parse(fs.readFileSync(DISCOVERY_POOL_FILE, "utf8"));
      _poolCandCache = Array.isArray(j.candidates) ? j.candidates : [];
      _poolCandMtime = st.mtimeMs;
    }
    return _poolCandCache;
  } catch {
    return [];
  }
}

// Agent runtime config — the discover-ads.js Cloud Run Job reads this on
// startup, falls back to env-var defaults if missing. Keeps the SDR in
// control of the knobs without redeploying.
const DISCOVERY_CONFIG_DEFAULTS = {
  enabled: true,           // master switch — UI toggle flips this; worker exits early when false
  minEmployees: 3,         // tier-1 gate (confirmed headcount)
  maxEmployees: 250,       // SMB ceiling — DK SMB threshold, filters out enterprises
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
      // maxEmployees: 0 = no upper bound. Filters out large groups so the
      // pool focuses on SMBs.
      ...(body.maxEmployees !== undefined && { maxEmployees: clamp(body.maxEmployees, 0, 100000, current.maxEmployees || 0) }),
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

// GET /api/discovery/pipeline-status — real-time view of the 7 active
// discovery crons. Replaces the legacy "Auto-pipeline" widget which was
// hardcoded to the old single-job system (lead-discovery-daily, PAUSED).
// Returns per-source: schedule (CPH), last-run timestamp, next-run
// timestamp, leads-added-today, plus an aggregate total-today.
app.get("/api/discovery/pipeline-status", authMiddleware, (req, res) => {
  // Source catalog — kept in code so adding a new cron requires a deploy
  // anyway (cron config + endpoint + state file all live in code).
  // schedule = array of {hour, minute} in Europe/Copenhagen, weekday-only.
  const SOURCES = [
    {
      id: "meta-ads-discover",
      label: "Meta Ad Library",
      icon: "📣",
      runs: [{ h: 8,  m: 0  }],
      stateFile: "meta_ads_discover.json",
      sourcePrefix: "meta-ads-discover",
    },
    {
      id: "tech-discover",
      label: "Apollo tech-stack",
      icon: "🛠",
      runs: [{ h: 9,  m: 0  }],
      stateFile: "apollo_tech_discover.json",
      sourcePrefix: "tech-discover",
    },
    {
      id: "branche-walk",
      label: "Branche-walk (CVR)",
      icon: "🇩🇰",
      runs: [{ h: 9, m: 30 }, { h: 11, m: 30 }, { h: 13, m: 0 }, { h: 15, m: 0 }],
      stateFile: "branche_walk_discover.json",
      sourcePrefix: "branche-walk",
    },
    {
      id: "gmaps-discover",
      label: "Google Maps (OSM)",
      icon: "📍",
      runs: [{ h: 10, m: 0 }],
      stateFile: "gmaps_discover.json",
      sourcePrefix: "gmaps-discover",
    },
    {
      id: "linkedin-ads-discover",
      label: "LinkedIn Ads",
      icon: "💼",
      runs: [{ h: 11, m: 0 }],
      stateFile: "linkedin_discover.json",
      sourcePrefix: "linkedin-ads-discover",
    },
    {
      id: "recover-phones",
      label: "Phone recovery",
      icon: "📞",
      runs: [{ h: 12, m: 0 }],
      stateFile: null, // no state file; we infer from activity log instead
      sourcePrefix: null, // activates EXISTING leads, doesn't add new ones
    },
  ];

  // ─── Helpers ────────────────────────────────────────────────────────
  const cphNow = new Date();
  // Compute today's date in CPH so the "leads added today" window aligns
  // with the SDR's wall-clock midnight, not UTC midnight.
  const cphDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(cphNow);
  const startOfCphDayUtc = new Date(`${cphDateStr}T00:00:00+02:00`).getTime();
  // DST handles itself — June is +02:00. For year-round correctness we'd
  // need a tz library, but this dashboard only needs to be roughly right.

  // Compute next-run timestamp for a list of run-times (HH:MM), Mon-Fri.
  // Returns ISO UTC string. Uses parts in CPH to avoid DST drift.
  function nextRunISO(runs) {
    if (!Array.isArray(runs) || runs.length === 0) return null;
    // Convert current time to CPH wall-clock parts.
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Copenhagen",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      weekday: "short",
    });
    const parts = fmt.formatToParts(cphNow);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const cphHour = parseInt(get("hour"), 10);
    const cphMin  = parseInt(get("minute"), 10);
    const cphDay  = get("weekday"); // Mon/Tue/...
    const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
    let dow = dayMap[cphDay] ?? 1;
    // Find the next run today that's after the current CPH time.
    const sortedRuns = [...runs].sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m));
    let candidate = null;
    if (dow >= 1 && dow <= 5) {
      for (const r of sortedRuns) {
        if (r.h > cphHour || (r.h === cphHour && r.m > cphMin)) {
          candidate = { dayOffset: 0, h: r.h, m: r.m };
          break;
        }
      }
    }
    if (!candidate) {
      // No more today → next weekday's earliest run
      const first = sortedRuns[0];
      let offset = 1;
      let newDow = (dow + 1) % 7;
      while (newDow < 1 || newDow > 5) { offset++; newDow = (newDow + 1) % 7; }
      candidate = { dayOffset: offset, h: first.h, m: first.m };
    }
    const nextDate = new Date(cphNow);
    nextDate.setDate(nextDate.getDate() + candidate.dayOffset);
    // Build CPH wall-clock date-string + parse as CPH-relative ISO.
    const yyyy = nextDate.getFullYear();
    const mm = String(nextDate.getMonth() + 1).padStart(2, "0");
    const dd = String(nextDate.getDate()).padStart(2, "0");
    const hh = String(candidate.h).padStart(2, "0");
    const min = String(candidate.m).padStart(2, "0");
    // Note: hardcodes +02:00 (summer time). Off by 1h in winter — but
    // the widget shows relative "om N min", which compensates within 60s.
    const isoCph = `${yyyy}-${mm}-${dd}T${hh}:${min}:00+02:00`;
    return new Date(isoCph).toISOString();
  }

  function loadStateLastRun(filename) {
    if (!filename) return null;
    try {
      const fp = path.join(DATA_DIR, "discovery", filename);
      if (!fs.existsSync(fp)) return null;
      const s = JSON.parse(fs.readFileSync(fp, "utf8"));
      return s.lastRunAt || null;
    } catch { return null; }
  }

  // Walk every user's leads ONCE, computing all three today-metrics in
  // a single pass: leadsTodayBySource (raw scrapes), phonesRecoveredToday
  // (phone-recovery cron hits), and icpKlarToday (passed the drain ICP
  // gate AND callable in the autodialer queue). Single pass keeps the
  // dashboard render fast even with 1500+ leads in the file.
  const leadsTodayBySource = {};
  let phonesRecoveredToday = 0;
  let icpKlarToday = 0; // PR1: leads discovered today that survived to be callable

  // The cockpit/autodialer queue filter — keep in sync with
  // renderAutodialerPage() in index.html. If a lead matches this, it's
  // sitting in the SDR's active queue right now.
  const isCallable = (l) =>
    l.lastAction !== "not-relevant" &&
    l.phone_missing !== true &&
    l.apollo_enrichment_pending !== true &&
    l.meta_verified_active !== false &&
    l.icpFit === true;

  try {
    if (fs.existsSync(DATA_DIR)) {
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
        try {
          const ud = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
          for (const l of (ud.leads || [])) {
            // discovered today → count by source + check ICP-klar
            const disc = l.discovered_at || l.addedAt;
            if (disc) {
              const t = new Date(disc).getTime();
              if (!isNaN(t) && t >= startOfCphDayUtc) {
                const src = String(l.source || "");
                if (src) leadsTodayBySource[src] = (leadsTodayBySource[src] || 0) + 1;
                if (isCallable(l)) icpKlarToday++;
              }
            }
            // Phone recovery happens INDEPENDENTLY of discovery date
            const recTs = l.phone_research_at || l.phone_recovered_at;
            if (recTs) {
              const t = new Date(recTs).getTime();
              if (!isNaN(t) && t >= startOfCphDayUtc) phonesRecoveredToday++;
            }
          }
        } catch {}
      }
    }
  } catch {}

  // Build per-source response. Sum leads_today by matching prefix.
  let totalToday = 0;
  const sources = SOURCES.map((src) => {
    let leadsToday = 0;
    if (src.id === "recover-phones") {
      leadsToday = phonesRecoveredToday; // semantically "phones recovered"
    } else if (src.sourcePrefix) {
      for (const [k, v] of Object.entries(leadsTodayBySource)) {
        if (k === src.sourcePrefix || k.startsWith(src.sourcePrefix + "-")) leadsToday += v;
      }
    }
    if (src.id !== "recover-phones") totalToday += leadsToday;
    return {
      id: src.id,
      label: src.label,
      icon: src.icon,
      runs: src.runs.map((r) => `${String(r.h).padStart(2, "0")}:${String(r.m).padStart(2, "0")}`),
      lastRunAt: loadStateLastRun(src.stateFile),
      nextRunAt: nextRunISO(src.runs),
      leadsToday,
      isPhoneRecovery: src.id === "recover-phones",
    };
  });

  // Apollo credit-exhaustion banner — set by any discovery endpoint that
  // hits Apollo's 422 "insufficient credits". Frontend reads this to swap
  // the "0 leads i dag" silent zero for a red "⚠ Apollo brugt op" banner
  // with a link to app.apollo.io/upgrade.
  const apolloStatus = loadApolloStatus();
  res.json({
    ok: true,
    today: cphDateStr,
    totalLeadsToday: totalToday,    // raw scrapes today (incl. archived)
    icpKlarToday,                   // PR1: actually callable in autodialer
    phonesRecoveredToday,
    sources,
    apolloStatus,
  });
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

app.get("/api/leads", authMiddleware, (req, res) => {
  // Admin oversight view — admin sees EVERY SDR's leads, each tagged with
  // its owner (_owner / _ownerName) so the list/autodialer can show whose
  // lead is whose. SDRs only ever see their own. Admin's view is read-
  // oriented: dispositions admin makes write to admin's own file (it does
  // not mutate the SDR's queue), so the SDRs' working queues stay intact.
  if (req.userId === "admin") {
    const own = loadUserData("admin");
    const users = loadUsers();
    const nameById = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const merged = [];
    if (fs.existsSync(DATA_DIR)) {
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
        const uid = f.slice("data_".length, -".json".length);
        // Include EVERY SDR's leads — including admin's own (e.g. CSV
        // imports uploaded while logged in as admin). They were previously
        // excluded, which made admin's own imports invisible.
        try {
          const ud = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
          for (const l of ud.leads || []) {
            merged.push({ ...l, _owner: uid, _ownerName: nameById[uid] || (uid === "admin" ? "Admin" : uid) });
          }
        } catch { /* skip malformed user file */ }
      }
    }
    return res.json({
      ...own,
      leads: merged,
      lists: own.lists && own.lists.length ? own.lists : [{ id: "all", name: "Alle leads" }],
      _adminView: true,
    });
  }
  res.json(loadUserData(req.userId));
});

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
    // Apollo enrichment fires below — flag so the UI shows a spinner
    // until contacts/socials/talking points populate.
    apollo_enrichment_pending: isApolloConfigured(),
  });
  saveUserData(req.userId, d);
  // Fire Apollo enrichment async — same flow as /promote so any lead
  // landing in user.leads gets the same treatment.
  if (isApolloConfigured()) {
    enrichUserLeadsViaApolloAsync(req.userId, [company.cvr]).catch((e) =>
      console.warn("[manual-add enrich] failed:", company.cvr, e.message)
    );
  }
  res.json({ ok: true });
});

// ─── Broadened-ICP queue qualification ───────────────────────────────
// Decides whether a discovery-pool company is eligible for auto-promotion
// into an SDR's queue. The pool is already pre-filtered to target DB07
// industries, so industry is implicit. We require:
//   - active CVR (status 'aktiv', or unknown which we allow)
//   - not confirmed-tiny: employees >= 3, or unknown size (lean e-commerce
//     often reports 0/null but still advertises + buys video)
function queueQualifies(c) {
  if (!c || !c.cvr) return false;
  if (c.status && c.status !== "aktiv") return false;
  const emp = c.employees;
  if (typeof emp === "number" && emp > 0 && emp < 3) return false;
  return true;
}
// Ranking score — confirmed ad-runners float to the top so the ads signal
// still dominates when it's available; broadened leads backfill below.
function queueScore(c) {
  let s = 0;
  if (c.icpFit) s += 100000;                       // confirmed ad-runner
  s += Math.min(c.ads?.matched || 0, 100) * 100;   // more ads = stronger
  if (c.phone) s += 500;                           // has a switchboard already
  if (typeof c.employees === "number") s += Math.min(c.employees, 300);
  return s;
}

// POST /api/leads/promote — bulk-promote CVRs from the Discovery pool
// (state.json) into the caller's leads list. Used by the ICP-klar review
// queue on Dashboard. Carries source attribution + adds to a specified
// list (default ungrouped). Skips CVRs already in the user's leads.
// Fire-and-forget async Apollo enrichment for a set of CVRs. Safe to
// call without awaiting — failures are logged + the lead just stays
// with whatever data Datafordeler+pool already provided. Used by both
// the promote endpoint and the autodialer-maintain cron.
//
// Concurrency 5 so 30 leads finish in ~6s without slamming Apollo's
// rate limit. Skips CVRs already enriched in the last 30 days.
// FRUGAL ENRICHMENT POLICY (June 2026):
//   1. Datafordeler-first phone resolution (FREE). If CVR registry has a
//      switchboard, accept it as the call number and skip Apollo entirely.
//   2. Apollo people/match (1 credit each, LIMIT=1) ONLY when:
//        (a) lead has no phone after Datafordeler attempt, OR
//        (b) caller explicitly invoked /api/apollo/enrich/:cvr?force=1
//   3. Decision-maker name+title (Apollo /match metadata) is fetched
//      ON-DEMAND from cockpit via the "Find beslutningstager" button
//      — not pre-fetched at promote time.
//
// Why this matters: ~70% of DK SMBs have a Datafordeler switchboard.
// Pre-Apollo we burned 2 credits on every one of those 70 for contact info
// the SDR mostly doesn't need at queue-fill time. Now those 70 leads cost
// 0 credits and only the ~30 phone-missing leads + ~10 cockpit-clicks/day
// burn credits.
async function enrichUserLeadsViaApolloAsync(userId, cvrs, opts = {}) {
  if (!isApolloConfigured()) return;
  const force = !!opts.force; // skip frugal skip when user clicked the button
  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const queue = [...cvrs];
  let capReached = false; // shared flag — short-circuits remaining workers
  async function worker() {
    while (queue.length && !capReached) {
      const cvr = queue.shift();
      try {
        const ud = loadUserData(userId);
        const lead = (ud.leads || []).find((l) => l.cvr === cvr);
        if (!lead) continue;
        // Skip if recently enriched (unless forced)
        if (!force && lead.apollo_enriched_at && (now - new Date(lead.apollo_enriched_at).getTime()) < FRESH_MS) continue;

        // STEP 0 (frugal) — Datafordeler phone-first. Try CVR registry
        // before spending any Apollo credits. ~70% hit rate on DK SMBs.
        let dfPhone = "";
        if (!lead.phone && /^\d{8}$/.test(String(cvr))) {
          try {
            const df = await lookupDatafordeler(String(cvr));
            dfPhone = df?.ph || df?.phone || "";
          } catch (_) { /* registry miss */ }
        }

        // STEP 0.5 (PR2) — ICP GATE. Discovery endpoints save raw leads
        // with icpFit unset; drain verifies them HERE before the lead
        // becomes callable. Three outcomes:
        //   • Apollo doesn't find the company → archive ("ikke fundet")
        //   • Found but fails 1-15 emp / 2-15M DKK rev / DK gate → archive
        //   • Pass → set icpFit=true + populate org data, continue to STEP 1
        // Cost: 1-2 credits per raw lead (find + enrich). Skipped when
        // force=true (SDR clicked "Find beslutningstager" — they want
        // contacts regardless of ICP).
        const needsIcpVerify = lead.icpFit !== true;
        if (needsIcpVerify && !force) {
          let domain = String(lead.web || lead.website || "")
            .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
          if (!domain && lead.name) {
            const found = await apolloFindCompany({ name: lead.name });
            if (found && found.domain) {
              domain = found.domain;
              // Stash on lead so future drains skip this lookup.
              const udd = loadUserData(userId);
              const ldd = (udd.leads || []).find((l) => l.cvr === cvr);
              if (ldd) { ldd.web = domain; ldd.apollo_company_id = found.id; saveUserData(userId, udd); }
            }
          }
          if (!domain) {
            // Apollo doesn't have this advertiser. THREE outcomes:
            //
            // 1. Verified-advertising source (meta_verified_active OR
            //    linkedin_advertiser): RECOVER. These leads ARE advertising
            //    by source guarantee — Apollo's name index just doesn't
            //    have them. Route to "Mangler nummer" research bucket so
            //    the nightly recover-phones cron can try Datafordeler
            //    name search + Apify SERP + Lusha. Many will flip back to
            //    callable within 24h. Casper called this "spill" — leads
            //    we lose because we didn't try hard enough to find them.
            //
            // 2. Branche-walk leads: shouldn't hit this code path anymore
            //    (Datafordeler-direct, skips drain). But keep the
            //    handling defensive.
            //
            // 3. Other (gmaps without ad signals, etc.): archive — low
            //    value to keep researching.
            const udx = loadUserData(userId);
            const lx = (udx.leads || []).find((l) => l.cvr === cvr);
            if (!lx) { continue; }
            // PR7: widened to catch recently-paused Meta advertisers too.
            // After PR4 tightened meta_verified_active to "currently
            // running RIGHT NOW", recently-paused leads (recent90d > 0
            // but activeNow = 0) had meta_verified_active=false and
            // failed this check — 16 of today's 21 archives were such
            // leads ("Apollo: ikke fundet" + meta_ads_recent90d > 0).
            // Now they route to spill-recovery research bucket.
            const verifiedAdvertising =
              lx.meta_verified_active === true ||
              lx.meta_advertiser === true ||
              lx.linkedin_advertiser === true ||
              (Number(lx.meta_ads_recent90d) || 0) > 0;
            if (verifiedAdvertising) {
              // SPILL RECOVERY: keep the lead, mark for phone research.
              // Recover-phones cron (12:00 CPH daily) will try to find a
              // real CVR + phone via free sources.
              lx.apollo_enrichment_pending = false;
              lx.apollo_enrichment_deferred = true;
              lx.phone_missing = true;
              lx.needs_research = true; // breadcrumb for the bucket UI
              saveUserData(userId, udx);
              logActivity("research-queued", `🔍 Sat til research (ej i Apollo): ${lx.name}`, { cvr, userId, source: lx.source });
            } else {
              lx.lastAction = "not-relevant";
              lx.lastDispositionAt = new Date().toISOString();
              lx.archived_reason = "Apollo: ikke fundet i database";
              lx.apollo_enrichment_pending = false;
              saveUserData(userId, udx);
              logActivity("icp-fail", `✕ Auto-arkiveret (ej i Apollo): ${lx.name}`, { cvr, userId });
            }
            continue;
          }
          const orgEnrich = await apolloOrgEnrich(domain);
          if (!orgEnrich) {
            const udx = loadUserData(userId);
            const lx = (udx.leads || []).find((l) => l.cvr === cvr);
            if (lx) {
              lx.lastAction = "not-relevant";
              lx.lastDispositionAt = new Date().toISOString();
              lx.archived_reason = "Apollo: ingen org-data tilgængelig";
              lx.apollo_enrichment_pending = false;
              saveUserData(userId, udx);
            }
            continue;
          }
          if (!passesIcpGate(orgEnrich, orgEnrich.estimatedEmployees || lead.emp)) {
            const empN = orgEnrich.estimatedEmployees || lead.emp || "?";
            const revM = orgEnrich.annualRevenue
              ? Math.round((orgEnrich.annualRevenue / 1e6) * 10) / 10 + "M"
              : "?";
            const reason = orgEnrich.country && orgEnrich.country !== "Denmark"
              ? `Apollo ICP: udenfor DK (${orgEnrich.country})`
              : `Apollo ICP: ${empN} emp, ${revM} DKK rev`;
            const udx = loadUserData(userId);
            const lx = (udx.leads || []).find((l) => l.cvr === cvr);
            if (lx) {
              lx.lastAction = "not-relevant";
              lx.lastDispositionAt = new Date().toISOString();
              lx.archived_reason = reason;
              lx.apollo_company = orgEnrich;
              lx.apollo_enriched_at = new Date().toISOString();
              lx.apollo_enrichment_pending = false;
              saveUserData(userId, udx);
              logActivity("icp-fail", `✕ Auto-arkiveret (ICP-fail): ${lx.name} — ${reason}`, { cvr, userId });
            }
            continue;
          }
          // PR3 (2026-06-10): Marketing-active gate now only fires for
          // a narrow case. After branche-walk went Datafordeler-direct
          // (skips drain entirely), and after we saw gmaps leads get
          // killed too aggressively (locale DK SMBs that don't have
          // Apollo metaAdvertiser=true even though they may well
          // advertise), this gate became counterproductive — we lost
          // ~70% of gmaps leads to it.
          //
          // Currently NO source needs the gate, because:
          //   - meta-ads + linkedin-ads: verified advertising by source
          //   - gmaps: relaxed (was too aggressive)
          //   - branche-walk: skips drain entirely (Datafordeler-direct)
          //
          // Keep the structure so we can re-introduce per-source rules
          // later if quality slips.
          const sourceStr = String(lead.source || "");
          const needsMarketingCheck = false; // disabled (was: branche-walk + gmaps)
          if (needsMarketingCheck && !orgEnrich.metaAdvertiser) {
            const udx = loadUserData(userId);
            const lx = (udx.leads || []).find((l) => l.cvr === cvr);
            if (lx) {
              lx.lastAction = "not-relevant";
              lx.lastDispositionAt = new Date().toISOString();
              lx.archived_reason = "Ikke marketing-aktiv (ingen Meta/marketing-tech)";
              lx.apollo_company = orgEnrich;
              lx.apollo_enriched_at = new Date().toISOString();
              lx.apollo_enrichment_pending = false;
              saveUserData(userId, udx);
              logActivity("icp-fail", `✕ Auto-arkiveret (ej marketing-aktiv): ${lx.name}`, { cvr, userId });
            }
            continue;
          }
          // ICP-pass — promote to icpFit + populate org data. Lead now
          // eligible for the cockpit queue. Falls through to STEP 1/2.
          const udx = loadUserData(userId);
          const lx = (udx.leads || []).find((l) => l.cvr === cvr);
          if (lx) {
            lx.icpFit = true;
            lx.apollo_company = orgEnrich;
            if (!lx.web) lx.web = domain;
            if (!lx.ind) lx.ind = orgEnrich.industry || "";
            if (!lx.emp && orgEnrich.estimatedEmployees) lx.emp = String(orgEnrich.estimatedEmployees);
            if (!lx.emps) lx.emps = orgEnrich.estimatedEmployees || null;
            if (!lx.omsaetning) lx.omsaetning = orgEnrich.annualRevenue || 0;
            if (orgEnrich.metaAdvertiser) lx.meta_advertiser = true;
            saveUserData(userId, udx);
            Object.assign(lead, lx);
          }
        }

        // STEP 1 (frugal skip) — if we already have a phone (Datafordeler
        // either now or from earlier scrape) AND this is the auto-drain
        // path (not user-forced), DON'T burn Apollo credits. Mark the
        // lead callable + leave contacts empty. SDR can click "Find
        // beslutningstager" in cockpit to fetch on-demand.
        const phoneAvailable = lead.phone || dfPhone;
        if (phoneAvailable && !force) {
          const ud2 = loadUserData(userId);
          const lead2 = (ud2.leads || []).find((l) => l.cvr === cvr);
          if (!lead2) continue;
          if (!lead2.phone) lead2.phone = dfPhone;
          lead2.phone_missing = false;
          lead2.apollo_enrichment_pending = false; // stop drain re-picking
          lead2.apollo_enrichment_deferred = true; // signal: contacts unfetched, fetch on cockpit-open
          saveUserData(userId, ud2);
          continue;
        }

        // STEP 2 — phone-missing OR force=true: spend Apollo credits.
        const { contacts, company } = await enrichWithApollo({ name: lead.name, domain: lead.web || lead.website });
        // Re-load (state could have shifted between worker iterations)
        const ud2 = loadUserData(userId);
        const lead2 = (ud2.leads || []).find((l) => l.cvr === cvr);
        if (!lead2) continue;
        lead2.contacts = contacts;
        lead2.apollo_company = company || null;
        lead2.apollo_enriched_at = new Date().toISOString();
        lead2.apollo_enrichment_pending = false;
        lead2.apollo_enrichment_deferred = false; // we just fetched contacts
        // Meta-advertiser signal (our ICP) — pulled free from Apollo's tech
        // stack. meta_advertiser=true means they run Meta ad campaigns.
        lead2.meta_advertiser = !!(company && company.metaAdvertiser);
        lead2.ad_signals = (company && company.metaAdSignals) || [];
        if (lead2.meta_advertiser) {
          logActivity("advertiser", `🎯 Annoncør fundet: ${lead2.name} (${(lead2.ad_signals || []).join(", ")})`, { cvr, userId });
        }
        // Phone priority: Apollo direct dial > Datafordeler switchboard >
        // Apollo org switchboard.
        const directDial = (contacts.find((c) => c.phone) || {}).phone;
        if (directDial) lead2.phone = directDial;
        else if (!lead2.phone && dfPhone) lead2.phone = dfPhone;
        else if (!lead2.phone && company?.phone) lead2.phone = company.phone;
        lead2.phone_missing = !lead2.phone;
        saveUserData(userId, ud2);
      } catch (e) {
        if (e && e.code === "APOLLO_CAP_REACHED") {
          // Daily cap hit mid-batch — signal sibling workers to stop
          // processing further. Remaining queued CVRs stay pending and
          // will be picked up by tomorrow's drain-enrichment.
          capReached = true;
          console.warn(`[apollo/promote-enrich] daily cap reached at ${e.spent}/${e.cap} — stopping batch (${queue.length} CVRs deferred to tomorrow)`);
          // Re-queue this CVR for tomorrow
          queue.unshift(cvr);
          return;
        }
        if (e && e.code === "APOLLO_CREDITS_EXHAUSTED") {
          // Account-level credit exhaustion. Same break-out behaviour as
          // the daily cap, but stays exhausted until Casper tops up.
          capReached = true;
          console.error(`[apollo/promote-enrich] Apollo credits exhausted — stopping batch (${queue.length} CVRs deferred until refill)`);
          queue.unshift(cvr);
          return;
        }
        console.warn("[apollo/promote-enrich]", cvr, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));
}

app.post("/api/leads/promote", authMiddleware, async (req, res) => {
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
  const newCvrs = [];
  for (const cvr of cvrs) {
    if (existing.has(cvr)) { skippedDup++; continue; }
    const c = pool[cvr];
    if (!c) { skippedNotInPool++; continue; }
    // Datafordeler switchboard (from the discovery scrape) takes precedence;
    // Apollo contacts (filled by post-promote enrichment) layer on top.
    const primaryPhone = c.phone || "";
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
      source: c.source || "meta-scraper",
      icpFit: c.icpFit || false,
      adsMatched: c.ads?.matched || 0,
      // Apollo enrichment will be filled in async by enrichUserLeadsViaApolloAsync
      // below. Lead lands in user.leads immediately so the SDR sees it; contacts
      // populate within seconds.
      apollo_enrichment_pending: isApolloConfigured(),
      listId,
      addedAt: now,
      promotedFromReviewQueue: true,
    });
    existing.add(cvr);
    promoted++;
    newCvrs.push(cvr);
  }
  saveUserData(req.userId, d);
  // Fire Apollo enrichment async — response returns immediately. SDR sees
  // leads in queue right away; contacts populate as enrichment completes
  // (polled by the frontend or visible on next page-load).
  if (newCvrs.length > 0 && isApolloConfigured()) {
    enrichUserLeadsViaApolloAsync(req.userId, newCvrs).catch((e) =>
      console.warn("[promote-enrich] batch failed:", e.message)
    );
  }
  res.json({
    ok: true,
    promoted,
    skippedDup,
    skippedNotInPool,
    enrichmentQueued: newCvrs.length,
    apolloConfigured: isApolloConfigured(),
  });
});

// Autodialer auto-maintain — keeps the SDR's active queue at the target
// size. Daily 08:00 CET cron promotes top-N ICP-klar leads from the
// Review Queue, then fires Apollo enrichment for each.
//
// "Actionable" = not called today, not archived, callback_at not in the
// future. We exclude leads with future callbacks because they'll come
// back on schedule.
app.post("/api/cron/autodialer-maintain", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  const targetSize = Math.max(5, Math.min(200, Number(req.query.target) || 30));
  const stats = { usersProcessed: 0, totalPromoted: 0, totalEnrichmentQueued: 0 };

  // Active callers — ONLY these user IDs receive auto-promoted leads.
  // Currently just Nicolas (u1). Victor (u2) and Admin are excluded from
  // the call rotation so leads aren't duplicated across SDRs (every lead
  // belongs to exactly one caller). To add an SDR, append their id here
  // (or set AUTODIALER_USER_IDS="u1,u2" in the env to override without a
  // code change).
  const ACTIVE_CALLER_IDS = (process.env.AUTODIALER_USER_IDS || "u1")
    .split(",").map((s) => s.trim()).filter(Boolean);

  // User data is stored as DATA_DIR/data_<userId>.json (not in a subdir).
  // Walk DATA_DIR and pick out the data_<id>.json files.
  if (!fs.existsSync(DATA_DIR)) {
    return res.json({ ok: true, stats, note: "no DATA_DIR" });
  }
  const pool = loadDiscoveryState().companies || {};
  const now = Date.now();
  // Max-employees cap from the Meta-scrape config (0 = no cap). Applied to
  // auto-promotion too so the setting actually limits incoming lead size
  // (the scraper that normally enforces it is IP-blocked).
  const maxEmp = Number(loadDiscoveryConfig().maxEmployees) || 0;
  const underMaxEmp = (c) => !(maxEmp > 0 && typeof c.employees === "number" && c.employees > maxEmp);

  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.startsWith("data_") || !f.endsWith(".json")) continue;
    // Skip system files like data.json, data_admin.json (admin is just legacy)
    if (f === "data.json") continue;
    const userId = f.slice("data_".length, -".json".length);
    if (!userId) continue;
    // Only auto-promote to active callers (currently just Nicolas / u1).
    if (!ACTIVE_CALLER_IDS.includes(userId)) continue;
    try {
      const ud = loadUserData(userId);
      const leads = ud.leads || [];
      // Count "actionable" leads — must match what the cockpit/queue treats
      // as DIALABLE so the target reflects real callable volume, not total
      // queue size. A lead with no phone or still enriching is NOT callable,
      // so it doesn't count toward the target (it lives in its own bucket).
      const actionable = leads.filter((l) => {
        if (l.lastAction === "not-relevant") return false;        // archived
        if (l.phone_missing === true) return false;               // no number → Mangler nummer
        // Hard Meta-ad filter: Apollo's metaAdvertiser pixel-signal lags
        // reality by 30-90d. Leads with meta_verified_active===false
        // (Apollo flagged BUT Meta Ad Library shows 0 current DK ads at
        // discovery time) go to the "Måske relevant" bucket instead.
        // null = unverified (CSV / Apify path / pre-verify backfill) →
        // pass through (Apify path has its own verdict guard).
        if (l.meta_verified_active === false) return false;
        // Enrichment-pending no longer gates dialing when a phone exists.
        // The phone is what makes a lead actionable; decision-maker contacts
        // (email, title, LinkedIn from Apollo people/match) are async and
        // arrive within minutes-to-hours of discovery — Nicolas can dial
        // the switchboard and ask for the right person while enrichment
        // completes in the background.
        if (l.apollo_enrichment_pending === true && !(l.ph || l.phone)) return false;
        if (l.callback_at && new Date(l.callback_at).getTime() > now) return false; // scheduled later
        if (l.lastCallAt && (now - new Date(l.lastCallAt).getTime()) < 24*60*60*1000) return false; // called today
        return true;
      });
      const claimed = new Set(leads.map((l) => l.cvr));
      const candidates = [];

      // TIER 1 — ALWAYS push unclaimed ICP-klar (confirmed Meta advertisers
      // from the scraper) regardless of queue size. These are the highest-
      // value leads we generate and must never sit unclaimed. Capped per
      // run so a sudden scraper hot streak doesn't flood the queue.
      const ICP_PUSH_CAP = 50;
      const icpKlar = Object.values(pool)
        .filter((c) => c?.icpFit && c.cvr && !claimed.has(c.cvr))
        .filter((c) => !c.pushed_to_cloudtalk_at && !c.twenty_opportunity_id)
        .filter((c) => underMaxEmp(c))
        .sort((a, b) => (b.ads?.matched || 0) - (a.ads?.matched || 0))
        .slice(0, ICP_PUSH_CAP);
      for (const c of icpKlar) { candidates.push(c); claimed.add(c.cvr); }
      const icpPushed = icpKlar.length;

      // STRICT MODE — only promote confirmed Meta advertisers (icpFit). The
      // broadened tier + deep reserve are SKIPPED in normal operation.
      //
      // SAFETY FLOOR — if the SDR's dialable count drops below
      // MIN_DIALABLE_FLOOR (default 40), strict mode TEMPORARILY allows the
      // broadened tier in — JUST enough to refill the floor. Keeps quality
      // on a normal day, prevents starvation on a bad-scraper day.
      //
      // STRICT_ADVERTISER_MODE=false disables strict entirely (legacy
      // volume-favoring behavior with full broadened + 100k reserve).
      const STRICT_MODE = process.env.STRICT_ADVERTISER_MODE !== "false";
      const MIN_DIALABLE_FLOOR = Math.max(0, Number(process.env.MIN_DIALABLE_FLOOR) || 40);
      let broadenedNeed = 0;
      let broadenedReason = "";
      const PER_RUN_CAP = 50;
      if (!STRICT_MODE) {
      // Legacy: fill toward the full target.
      const dialableShortfall = Math.max(0, targetSize - actionable.length - icpPushed);
      broadenedNeed = Math.min(dialableShortfall * 3, PER_RUN_CAP);
      broadenedReason = broadenedNeed > 0 ? "volume-target" : "";
      } else {
      // Strict + safety: refill ONLY toward the floor, not the full target.
      const floorShortfall = Math.max(0, MIN_DIALABLE_FLOOR - actionable.length - icpPushed);
      if (floorShortfall > 0) {
        broadenedNeed = Math.min(floorShortfall * 3, PER_RUN_CAP);
        broadenedReason = "safety-floor";
      }
      }
      if (broadenedNeed > 0) {
        const broadened = Object.values(pool)
          .filter((c) => queueQualifies(c) && underMaxEmp(c) && !claimed.has(c.cvr))
          .filter((c) => !c.pushed_to_cloudtalk_at && !c.twenty_opportunity_id)
          .sort((a, b) => queueScore(b) - queueScore(a))
          .slice(0, broadenedNeed);
        for (const c of broadened) {
          c._safetyFloor = (broadenedReason === "safety-floor"); // tag for promote loop
          candidates.push(c); claimed.add(c.cvr);
        }
      }
      // DEEP RESERVE — if state.json doesn't have enough unclaimed
      // qualifiers (it no longer grows while the scraper is IP-blocked),
      // backfill from the full ~100k Datafordeler candidate pool so daily
      // volume never runs dry. Every pool entry is already industry-filtered
      // (target DB07 codes) and active.
      const totalCap = icpPushed + broadenedNeed;
      if (broadenedNeed > 0 && candidates.length < totalCap) {
        const seen = new Set([...claimed]);
        const reserve = loadDiscoveryPoolCandidates();
        const eligible = (c) => c && c.cvr && !seen.has(c.cvr) &&
          (!c.status || c.status === "aktiv") &&
          !(typeof c.employees === "number" && c.employees > 0 && c.employees < 3) &&
          underMaxEmp(c);
        const tier1 = (c) => typeof c.employees === "number" && c.employees >= 3;
        for (const c of reserve) {
          if (candidates.length >= totalCap) break;
          if (!eligible(c) || !tier1(c)) continue;
          c._safetyFloor = (broadenedReason === "safety-floor");
          seen.add(c.cvr); candidates.push(c);
        }
        for (const c of reserve) {
          if (candidates.length >= totalCap) break;
          if (!eligible(c) || tier1(c)) continue;
          c._safetyFloor = (broadenedReason === "safety-floor");
          seen.add(c.cvr); candidates.push(c);
        }
      }
      const shortfall = candidates.length;
      const safetyFloorCount = candidates.filter((c) => c._safetyFloor).length;

      // Promote them inline (mirrors /api/leads/promote logic)
      const nowIso = new Date().toISOString();
      const newCvrs = [];
      for (const c of candidates) {
        ud.leads.push({
          name: c.name,
          cvr: c.cvr,
          ic: c.industry,
          ind: c.industryName,
          city: c.city,
          zip: c.zip,
          emp: c.employees,
          web: c.website || c.web || "",
          phone: c.phone || "",
          source: c.source || "meta-scraper",
          icpFit: c.icpFit || false,
          adsMatched: c.ads?.matched || 0,
          apollo_enrichment_pending: isApolloConfigured(),
          listId: "ungrouped",
          addedAt: nowIso,
          promotedFromReviewQueue: true,
          promotedByCron: true,
          // Safety-floor leads aren't confirmed advertisers — flagged so the
          // SDR + activity log can tell which are quality vs supply-fillers.
          safety_floor: c._safetyFloor === true,
        });
        newCvrs.push(c.cvr);
      }
      saveUserData(userId, ud);
      stats.totalPromoted += newCvrs.length;
      // Fire Apollo enrichment for the batch
      if (newCvrs.length > 0 && isApolloConfigured()) {
        enrichUserLeadsViaApolloAsync(userId, newCvrs).catch((e) =>
          console.warn("[autodialer-maintain]", userId, e.message)
        );
        stats.totalEnrichmentQueued += newCvrs.length;
      }
      stats.usersProcessed++;
      if (newCvrs.length > 0) {
        const icpNote = icpPushed > 0 ? ` · 🎯 ${icpPushed} bekræftede annoncører` : "";
        const safetyNote = safetyFloorCount > 0 ? ` · ⚠ ${safetyFloorCount} fra safety-floor (queue under gulv)` : "";
        logActivity("promote", `Autodialer påfyldt: ${newCvrs.length} nye leads til ${userId}${icpNote}${safetyNote}`, {
          userId, icpKlar: icpPushed, safetyFloor: safetyFloorCount,
        });
      }
      console.log("[autodialer-maintain] user", userId, "promoted", newCvrs.length, "(icp-klar:", icpPushed, ") target", targetSize);
    } catch (e) {
      console.warn("[autodialer-maintain]", userId, e.message);
    }
  }
  res.json({ ok: true, stats });
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

// ─── CSV column auto-parser ──────────────────────────────────────────
// Map arbitrary CSV headers to our internal schema. Supports Danish AND
// English headers. Each rule is { matchers: regex[], canonical: string }.
// First-match wins per canonical key (so "company" beats "name" if both
// appear, in declared order).
//
// Why both header heuristics + content patterns:
//   1. Header match handles 90% of cases — most CSVs have descriptive names
//   2. Content patterns rescue unlabeled columns or generic headers like
//      "Column1", "field_2", etc. (CVR=8 digits, phone=+45..., URL, email)
//
// The auto-mapper is run BEFORE the existing import loop so the rest of
// the code just sees normalized {name, cvr, website, phone, email, ...}.
const CSV_HEADER_RULES = [
  { canonical: "name",     matchers: [/^(name|company( ?name)?|account ?name|virksomhed(?:snavn)?|firma(?:navn)?|brand|kunde)$/i] },
  { canonical: "cvr",      matchers: [/^(cvr(?:[-_ ]?n(?:umme)?r)?|cvrnr|organi[sz]ation ?number|vat ?(?:nr|number|id)?|cvrtal)$/i] },
  { canonical: "phone",    matchers: [/^(phone( ?number)?|tel(?:efon)?|mobile|mobil(?:nummer)?|switchboard|nummer|telephone|tlf(?:[-_ ]?nr)?)$/i] },
  { canonical: "email",    matchers: [/^(e[-_ ]?mail( ?address)?|mail( ?address)?|kontakt[-_ ]?email|e[-_ ]?mailadresse)$/i] },
  { canonical: "website",  matchers: [/^(website|url|domain|dom[aæ]ne|web(?:site|adresse)?|site|hjemmeside|homepage)$/i] },
  { canonical: "industry", matchers: [/^(industry|branche|sector|sektor|category|kategori)$/i] },
  { canonical: "city",     matchers: [/^(city|by|town|sted)$/i] },
  { canonical: "country",  matchers: [/^(country|land)$/i] },
  { canonical: "source",   matchers: [/^(source|kilde|origin|channel)$/i] },
];
function detectCanonicalFromHeader(header) {
  const h = String(header || "").trim().toLowerCase();
  if (!h) return null;
  for (const rule of CSV_HEADER_RULES) {
    if (rule.matchers.some((re) => re.test(h))) return rule.canonical;
  }
  return null;
}
// Content-pattern fallback — given a sample of column values, guess what
// it is. Higher specificity wins (CVR=8 digits is more specific than
// "looks numeric"). Returns the canonical key or null.
function detectCanonicalFromContent(sampleValues) {
  const sample = (sampleValues || []).filter((v) => v != null && String(v).trim() !== "").slice(0, 20);
  if (sample.length === 0) return null;
  const looksLike = (re) => sample.filter((v) => re.test(String(v).trim())).length / sample.length;
  // CVR — 8 digits, Danish company numbers
  if (looksLike(/^\d{8}$/) >= 0.7) return "cvr";
  // Email — has @
  if (looksLike(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) >= 0.7) return "email";
  // Phone — Danish formats: +45 12 34 56 78, 12345678, 0045 ..., (+45) ...
  if (looksLike(/^[+()0-9\s\-]{7,18}$/) >= 0.7) return "phone";
  // URL — http(s):// or starts with www. or contains a dot-tld
  if (looksLike(/^(https?:\/\/|www\.)/i) >= 0.5 || looksLike(/\.[a-z]{2,6}(\/|$)/i) >= 0.7) return "website";
  return null;
}
// Normalize a single raw CSV row using header → canonical mapping.
// Returns { name, cvr, phone, email, website, industry, city, country, source }.
function normalizeCsvRow(rawRow, headerMap) {
  const out = {};
  for (const [origHeader, canonical] of Object.entries(headerMap)) {
    if (!canonical) continue;
    const v = rawRow[origHeader];
    if (v == null || String(v).trim() === "") continue;
    // For multi-source headers (e.g. two "phone"-like columns), prefer the
    // first non-empty value (header rules are declared in priority order).
    if (out[canonical]) continue;
    out[canonical] = String(v).trim();
  }
  // Normalize CVR to digits-only
  if (out.cvr) out.cvr = out.cvr.replace(/\D/g, "");
  // Normalize phone — strip spaces, keep + and digits
  if (out.phone) out.phone = out.phone.replace(/[^\d+]/g, "");
  // Normalize website — add https:// if missing scheme but starts with www. or contains a dot
  if (out.website && !/^https?:\/\//i.test(out.website)) {
    if (/^www\./i.test(out.website) || /\.[a-z]{2,6}(\/|$)/i.test(out.website)) {
      out.website = "https://" + out.website.replace(/^\/+/, "");
    }
  }
  return out;
}
// Build the header→canonical map for a batch of rows. Combines header
// keyword detection + content sampling.
function buildHeaderMap(rows) {
  if (!rows || rows.length === 0) return {};
  const headers = Object.keys(rows[0] || {});
  const map = {};
  const used = new Set();
  // Pass 1 — header keyword match
  for (const h of headers) {
    const can = detectCanonicalFromHeader(h);
    if (can && !used.has(can)) {
      map[h] = can;
      used.add(can);
    }
  }
  // Pass 2 — content sampling for remaining unmapped headers
  for (const h of headers) {
    if (map[h]) continue;
    const sample = rows.slice(0, 30).map((r) => r[h]);
    const can = detectCanonicalFromContent(sample);
    if (can && !used.has(can)) {
      map[h] = can;
      used.add(can);
    }
  }
  return map;
}

// POST /api/leads/import — bulk-import a CSV-derived list of companies.
//
// Body: { rows: [{ raw CSV row }, ...], listId? }
// Rows can have ANY column names — the auto-parser maps them to internal
// schema using header heuristics (Danish + English) and content patterns
// (CVR=8 digits, phone=+45..., URL, email). Per matched row:
//   - If `cvr` is present (8 digits) → fetch enrichment from Datafordeler
//   - Else try exact-name match in Datafordeler. If found → enrich. If not
//     → still create the lead with whatever fields the CSV gave us, flagged
//     as `unmatched: true` so the UI can offer manual CVR fill-in later.
//
// Source defaults to "csv". Source preserved on the lead so we know which
// channel surfaced it (sales-navigator / apollo / partner-list / etc).
// POST /api/leads/scan-advertisers — pre-import advertiser scan. Takes a
// BATCH of parsed rows, derives the company from each business email, and
// runs the FREE Apollo org-check (no contact reveal → no credits) to flag
// Meta advertisers. Stateless: the frontend calls this repeatedly for
// batches so it can show live progress, then decides what to import.
app.post("/api/leads/scan-advertisers", authMiddleware, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 40) : [];
  const apollo = isApolloConfigured();
  const out = [];
  for (const row of rows) {
    const email = row.email || row.em || "";
    const domain = (row.website || businessDomainFromEmail(email) || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    let isAdvertiser = false, adSignals = [], companyName = "";
    if (apollo && domain) {
      try {
        const org = await apolloOrgEnrich(domain);
        if (org) { companyName = org.name || ""; isAdvertiser = !!org.metaAdvertiser; adSignals = org.metaAdSignals || []; }
      } catch {}
      await new Promise((r) => setTimeout(r, 180)); // gentle on Apollo
    }
    out.push({
      key: email || row.name || "", name: row.name || "", email, phone: row.phone || "",
      domain, companyName, isAdvertiser, adSignals, hasCompany: !!domain,
    });
  }
  res.json({ results: out });
});

app.post("/api/leads/import", authMiddleware, async (req, res) => {
  const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rawRows || rawRows.length === 0) return res.status(400).json({ error: "rows[] mangler" });
  if (rawRows.length > 5000) return res.status(413).json({ error: "Max 5000 rækker pr. import" });
  // Auto-parse: detect which column is name/cvr/phone/email/website even
  // when headers vary across sources (HubSpot, Apollo, LinkedIn export,
  // Salesforce, manual spreadsheets in Danish or English). The mapper
  // returns a {originalHeader: canonicalKey} map. Rows are normalized
  // before the existing import loop runs.
  const headerMap = buildHeaderMap(rawRows);
  const rows = rawRows.map((r) => {
    const normalized = normalizeCsvRow(r, headerMap);
    // Carry original row + any pre-import advertiser-scan results so the
    // loop can honor them (set meta_advertiser without re-checking).
    return { ...normalized, _raw: r, _scanned: r._scanned === true, _advertiser: r._advertiser === true, _adSignals: Array.isArray(r._adSignals) ? r._adSignals : [] };
  });
  const listId = req.body.listId || "ungrouped";
  // Route imports to the active caller (Nicolas/u1) so uploaded leads land
  // in the dialing queue even when uploaded as admin (Option A).
  const targetUserId = routeToCallerId(req.userId);
  const d = loadUserData(targetUserId);
  const existing = new Set(d.leads.map((l) => l.cvr));
  const now = new Date().toISOString();

  const stats = {
    imported: 0, alreadyExists: 0, matched: 0, unmatched: 0, errors: 0, details: [],
    routedTo: targetUserId,
    // Report the detected header map so the UI can show "We mapped these
    // columns: name→Company Name, cvr→CVR Number, …" — gives confidence
    // and surfaces mapping mistakes early.
    detectedHeaders: headerMap,
  };

  // Cap concurrent Datafordeler lookups so we don't hammer the API for big imports.
  const CONC = 4;
  const queue = [...rows];
  const workers = Array.from({ length: CONC }, async () => {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) break;
      try {
        // After normalization, `row` carries canonical keys directly.
        // Fall back to the raw row for any field the mapper missed.
        const name = String(row.name || row._raw?.name || row._raw?.company || row._raw?.["Company Name"] || row._raw?.["Account Name"] || "").trim();
        const cvrRaw = String(row.cvr || row._raw?.cvr || row._raw?.CVR || "").replace(/\D/g, "");
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
          // Phone: CSV value wins, else Datafordeler. Store as `phone`
          // (what the autodialer/cockpit read) AND `ph` (legacy detail view).
          const csvPhone = (row.phone || company.phone || company.ph || "").replace(/[^\d+]/g, "");
          d.leads.push({
            ...company,
            // CSV-provided fields override Datafordeler ones (the user knows their leads).
            web: row.website || row.URL || row.domain || company.web,
            phone: csvPhone,
            ph: csvPhone,
            em: row.email || company.em,
            listId,
            addedAt: now,
            source: row.source || "csv",
            phone_missing: !csvPhone,
            apollo_enrichment_pending: isApolloConfigured(),
          });
          existing.add(company.cvr);
          stats.imported++;
          stats.matched++;
          // Track matched CVRs to fire Apollo enrichment in a single batch
          // at the end (post-worker, post-save) for efficiency.
          if (!stats._matchedCvrs) stats._matchedCvrs = [];
          stats._matchedCvrs.push(company.cvr);
        } else {
          // Unmatched — still keep the row so the SDR can act on it (Kaspr lookup
          // by name etc.). Generate a synthetic key so we don't collide with real CVRs.
          const syntheticCvr = "csv-" + (cvrRaw || name.replace(/\s+/g, "-")).slice(0, 40);
          if (existing.has(syntheticCvr)) { stats.alreadyExists++; continue; }
          // People/lead lists (name + phone, no CVR) land here. Store the
          // phone as `phone` so the autodialer can dial it immediately —
          // these are often the BEST leads (inbound form submissions).
          const csvPhone = (row.phone || "").replace(/[^\d+]/g, "");
          // Derive the company from a BUSINESS email domain so Apollo can
          // enrich it + flag Meta advertisers. Personal emails are skipped.
          const bizDomain = businessDomainFromEmail(row.email);
          const web = row.website || row.URL || row.domain || bizDomain || "";
          // If the row was already scanned for ads pre-import (the new
          // upload flow), honor that result — no re-check. Otherwise flag
          // business-email rows for the free background ads-check.
          const preScanned = row._scanned === true;
          const wantAdsCheck = !preScanned && isApolloConfigured() && !!bizDomain;
          const lead = {
            cvr: syntheticCvr,
            name,
            web,
            phone: csvPhone,
            ph: csvPhone,
            em: row.email || "",
            city: row.city || "",
            ind: row.industry || "",
            unmatched: true,
            phone_missing: !csvPhone,
            ads_check_pending: wantAdsCheck,
            listId,
            addedAt: now,
            source: row.source || "csv",
          };
          if (preScanned) {
            lead.meta_advertiser = row._advertiser === true;
            lead.ad_signals = Array.isArray(row._adSignals) ? row._adSignals : [];
            lead.ads_checked_at = now;
          }
          d.leads.push(lead);
          existing.add(syntheticCvr);
          stats.imported++;
          stats.unmatched++;
          if (wantAdsCheck) stats.adsCheckQueued = (stats.adsCheckQueued || 0) + 1;
          if (preScanned && lead.meta_advertiser) stats.advertisers = (stats.advertisers || 0) + 1;
        }
      } catch (e) {
        stats.errors++;
        stats.details.push({ row, reason: e.message });
      }
    }
  });
  await Promise.all(workers);

  saveUserData(targetUserId, d);
  // Full Apollo enrichment (contacts + phone, costs ~1 credit each) ONLY
  // for CVR-matched companies — they have no contact yet. CSV people-rows
  // get the cheap org-only ads check instead (see ads_check_pending).
  const cvrsToEnrich = stats._matchedCvrs || [];
  delete stats._matchedCvrs;
  if (cvrsToEnrich.length > 0 && isApolloConfigured()) {
    enrichUserLeadsViaApolloAsync(targetUserId, cvrsToEnrich).catch((e) =>
      console.warn("[csv-import enrich] batch failed:", e.message)
    );
    stats.enrichmentQueued = cvrsToEnrich.length;
  }
  // Trim details to avoid blowing up the response
  stats.details = stats.details.slice(0, 20);
  logActivity("csv-import", `CSV-import → ${targetUserId}: ${stats.imported} leads (${stats.matched} CVR-match, ${stats.unmatched} uden) · ${stats.adsCheckQueued || 0} til gratis ads-tjek`, { userId: targetUserId });
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
  // Capture state we'll log AFTER the merge.
  const prevAction = lead.lastAction;
  const prevCallbackAt = lead.callback_at;
  const prevPhone = lead.phone || lead.ph || "";
  Object.assign(lead, req.body);
  saveUserData(req.userId, d);
  // Log disposition changes + callback scheduling so admin's activity feed
  // captures every SDR action (calls, dispositions, follow-ups, edits).
  try {
    const labels = {
      "interested": "✓ Interesseret",
      "follow-up": "📅 Follow-up",
      "no-answer": "✕ Ingen svar",
      "not-relevant": "– Ikke relevant",
      "sms": "💬 SMS",
    };
    if (req.body.lastAction && req.body.lastAction !== prevAction && labels[req.body.lastAction]) {
      logActivity("disposition", `${labels[req.body.lastAction]} — ${lead.name || lead.cvr} (${req.userId})`, {
        userId: req.userId, cvr: lead.cvr, action: req.body.lastAction,
      });
    }
    if (req.body.callback_at && req.body.callback_at !== prevCallbackAt) {
      const when = new Date(req.body.callback_at);
      const whenTxt = isNaN(when.getTime()) ? req.body.callback_at : when.toLocaleString("da-DK", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      logActivity("callback", `📅 Callback planlagt ${whenTxt} — ${lead.name || lead.cvr} (${req.userId})`, {
        userId: req.userId, cvr: lead.cvr, callbackAt: req.body.callback_at,
      });
    }
    if (req.body.phone !== undefined && (req.body.phone || "").replace(/\D/g, "") !== String(prevPhone).replace(/\D/g, "")) {
      logActivity("phone-edit", `✎ Nummer rettet på ${lead.name || lead.cvr} (${req.userId})`, {
        userId: req.userId, cvr: lead.cvr, newPhone: req.body.phone,
      });
    }
  } catch (e) { /* logging is never fatal */ }
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
  const enrichTargets = []; // [{userId, cvr}] for batched enrichment after
  aeUsers.forEach(aeUser => {
    const d = loadUserData(aeUser.id);
    // Add lead to AE's leads list if not already there
    if (company && !d.leads.find(l => l.cvr === cvr)) {
      d.leads.push({
        ...company,
        addedAt: new Date().toISOString(),
        listId: "ungrouped",
        apollo_enrichment_pending: isApolloConfigured(),
      });
      enrichTargets.push(aeUser.id);
    }
    // Set AE pipeline stage
    ensurePipelines(d);
    d.pipelines.ae[cvr] = aeStage;
    d.pipeline = d.pipeline || {};
    d.pipeline[cvr] = aeStage;
    saveUserData(aeUser.id, d);
  });
  // Fire Apollo enrichment for each AE that got a fresh lead. Per-user
  // because enrichUserLeadsViaApolloAsync writes into the user's data file.
  if (isApolloConfigured() && enrichTargets.length > 0) {
    for (const uid of enrichTargets) {
      enrichUserLeadsViaApolloAsync(uid, [cvr]).catch((e) =>
        console.warn("[pipeline-push enrich]", uid, cvr, e.message)
      );
    }
  }
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
  let approvedCvr = null;
  if (req.body.feedback === 'approved' && result.company_data) {
    if (!d.leads.find(l => l.cvr === result.cvr_number)) {
      // Ensure "AI-discovered leads" list exists
      if (!d.lists.find(l => l.name === 'AI-discovered leads')) {
        d.lists.push({ id: 'ai_discovered', name: 'AI-discovered leads' });
      }
      d.leads.push({
        ...result.company_data,
        cvr: result.cvr_number,
        name: result.company_name,
        listId: 'ai_discovered',
        addedAt: new Date().toISOString(),
        apollo_enrichment_pending: isApolloConfigured(),
      });
      approvedCvr = result.cvr_number;
    }
  }
  saveUserData(req.userId, d);
  // Fire Apollo enrichment for the freshly-approved lead so the SDR
  // sees decision-makers, talking points and direct dials when they
  // open it.
  if (approvedCvr && isApolloConfigured()) {
    enrichUserLeadsViaApolloAsync(req.userId, [approvedCvr]).catch((e) =>
      console.warn("[ai-discovered enrich]", approvedCvr, e.message)
    );
  }
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

// Overpass public mirrors — failover in order. overpass-api.de is the
// canonical instance but is heavily rate-limited and frequently returns
// 504 during peak hours. kumi.systems is a well-maintained German mirror
// with looser limits. coffee is a third-party that we keep as last resort.
const OSM_OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const OSM_OVERPASS_URL = OSM_OVERPASS_MIRRORS[0]; // legacy callers still hit primary

// Try each mirror in order, retrying once per mirror on transient
// errors (502/503/504/network). Returns the first successful response
// body parsed as JSON, or throws if all mirrors fail.
async function fetchOverpass(overpassQuery, opts = {}) {
  const maxAttempts = opts.maxAttempts || 2; // per-mirror
  const timeoutMs   = opts.timeoutMs   || 60000;
  let lastErr = null;
  for (const url of OSM_OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "VedioLeads/1.0 (sales-prospecting)",
          },
          body: "data=" + encodeURIComponent(overpassQuery),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (r.ok) return await r.json();
        // Transient 5xx — retry once on same mirror, then move on
        if ([502, 503, 504].includes(r.status) && attempt < maxAttempts) {
          await new Promise((res) => setTimeout(res, 1500 * attempt));
          continue;
        }
        lastErr = new Error(`OSM ${url.split("/")[2]} → ${r.status}`);
        break; // fall through to next mirror
      } catch (e) {
        clearTimeout(t);
        lastErr = new Error(`OSM ${url.split("/")[2]} → ${e.message}`);
        if (attempt < maxAttempts) {
          await new Promise((res) => setTimeout(res, 1500 * attempt));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error("OSM: all mirrors failed");
}

// Category id → OSM tag pairs. Each category may map to multiple tags
// (e.g. "frisør" covers both shop=hairdresser and shop=beauty).
// IMPORTANT: every category referenced in GMAPS_DISCOVER_QUERIES MUST
// have an entry here, otherwise buildOsmQuery returns null and the
// Overpass endpoint returns 400 (body=data=null). Was the root cause
// of the silent gmaps-discover failure observed on 2026-06-08.
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
  // 2026-06-08 — added for the wider gmaps category rotation in
  // GMAPS_DISCOVER_QUERIES. Each maps to the standard OSM tag for
  // that DK business type (verified against OSM Wiki).
  "skønhedsklinik": [["shop","beauty"],["shop","cosmetics"],["healthcare","clinic"]],
  "fysioterapi":    [["healthcare","physiotherapist"]],
  "optiker":        [["shop","optician"],["healthcare","optometrist"]],
  "juveler":        [["shop","jewelry"]],
  "ejendomsmægler": [["office","estate_agent"]],
  "arkitekt":       [["office","architect"]],
  "vinforhandler":  [["shop","wine"],["shop","alcohol"]],
  "blomster":       [["shop","florist"]],
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
  // timeout=90 = Overpass query timeout (server-side execution cap).
  // Was 30 → too tight at peak hours; bumped to give the engine more
  // room before it 504s, especially when the primary mirror is slow.
  return `[out:json][timeout:90];${areaClause}(${parts.join("")});out body center ${limit * 2};`;
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

// Apollo enrichment is a TWO-STEP chain:
//
//   1. api_search → returns obfuscated identities (first name + title +
//      Apollo person id) + has_email / has_direct_phone flags. Free.
//   2. /people/match with the id + reveal_personal_emails:true → returns
//      real name, work email (verified), title, LinkedIn URL. Synchronous.
//      Phone reveal requires reveal_phone_number:true + a webhook_url —
//      Apollo posts the phone back async. That's a separate feature we
//      can add later; for now emails + LinkedIn cover most outbound flows.
//
// Credit usage: api_search is free for matched query rows; /match charges
// 1 credit per call (email reveal). Phone reveal would charge ~5 credits
// + require the webhook. With Basic plan's 500 credits/month that's ~500
// enrichments — enough for our 30/day target.

// People per company to enrich via /people/match (1 credit each). Was 5
// for the original Kaspr replacement (full contact card with VPs+managers);
// dropped to 2 because Vedio's outbound only needs the decision-maker pair
// (typically CEO/Founder + Marketing/eComm Lead). At 60-130 fresh leads/day
// Apollo enrichment is the dominant credit cost (1 credit per /match call).
// LIMIT=1 means we fetch just the single highest-seniority decision-maker
// per company — usually founder/CEO/owner thanks to the seniority filter
// ("c_suite, founder, owner, vp, director, head, manager" — sorted in that
// priority order by Apollo). The SDR almost always wants just one name
// to ask for when calling; the second contact is rarely actioned and
// doubles the credit cost. Drop to 1 unless you upgrade the plan.
//
// COST MATH at LIMIT=1, frugal pipeline:
//   - Phone-already-known leads (~70% via Datafordeler switchboard): 0 credits
//   - Phone-missing leads (~30%): 1 credit each via Apollo
//   - On-demand "Find beslutningstager" clicks in cockpit: 1 credit each
//   => 100 leads/day × 30% × 1 cr = 30 cr/day = ~900 cr/mo baseline
//      + ~10-20 cockpit reveals/day = ~300 cr/mo top-up
//      ≈ 1,200 cr/mo on a 4,000 cr Apollo Pro plan, with headroom.
const APOLLO_SEARCH_LIMIT = 1;
const APOLLO_MATCH_DELAY_MS = 300; // throttle between /match calls

// ─── APOLLO DAILY CREDIT CAP ─────────────────────────────────────────────
// Apollo plan = 2,000 credits/month, used Mon-Fri only (~22 working days).
// 2,000 / 22 ≈ 91 cr/day budget. Set hard cap at 100/day with a small
// safety buffer; on a typical day we expect ~55-75 burned (30 drain
// enrichments + 25 cockpit reveals + 0-20 spikes). Cap exists to prevent
// a runaway loop or an unusually busy cockpit day from draining the
// monthly budget mid-week.
//
// Counter file: /data/discovery/apollo_spend.json
// Reset: at the first call of a new Europe/Copenhagen calendar day.
// Enforcement points:
//   - apolloMatchPerson() — throws CAP_REACHED before the API call
//   - drain-enrichment cron — bails the worker loop when cap is hit
//   - /api/apollo/enrich/:cvr — returns 429 to the cockpit button
// PR3 (2026-06-10): bumped 300 → 400. Now that branche-walk goes
// Datafordeler-direct (no Apollo at discovery), the drain has more
// budget headroom for meta-ads/gmaps/linkedin volume. 400/day × 22 =
// 8,800/month — inside Apollo Pro's 10k allowance with ~1,200/mo left
// for cockpit "Find beslutningstager" people-match reveals (~55/day).
// Was 300 (PR2) which left ~14 callable/day from meta-ads — too tight.
const APOLLO_DAILY_CAP = 400;
const APOLLO_SPEND_FILE = path.join(DATA_DIR, "discovery", "apollo_spend.json");

function _cphDateStr(d = new Date()) {
  // YYYY-MM-DD in Europe/Copenhagen — stable across UTC midnight.
  // Intl.DateTimeFormat handles DST transitions correctly.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const dd = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${dd}`;
}

function loadApolloSpend() {
  const today = _cphDateStr();
  try {
    if (fs.existsSync(APOLLO_SPEND_FILE)) {
      const s = JSON.parse(fs.readFileSync(APOLLO_SPEND_FILE, "utf8"));
      if (s.date === today) return { date: today, spent: s.spent || 0, history: s.history || {} };
      // Day rolled over — archive yesterday's count, reset today's.
      const history = s.history || {};
      if (s.date) history[s.date] = s.spent || 0;
      // Cap history to 60 days
      const days = Object.keys(history).sort();
      while (days.length > 60) delete history[days.shift()];
      return { date: today, spent: 0, history };
    }
  } catch (e) { console.warn("[apollo-spend] load:", e.message); }
  return { date: today, spent: 0, history: {} };
}

function saveApolloSpend(state) {
  try {
    fs.mkdirSync(path.dirname(APOLLO_SPEND_FILE), { recursive: true });
    fs.writeFileSync(APOLLO_SPEND_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.warn("[apollo-spend] save:", e.message); }
}

function getApolloSpendToday() {
  const s = loadApolloSpend();
  return { date: s.date, spent: s.spent, cap: APOLLO_DAILY_CAP, remaining: Math.max(0, APOLLO_DAILY_CAP - s.spent), history: s.history };
}

function incrementApolloSpend(n = 1) {
  const s = loadApolloSpend();
  s.spent = (s.spent || 0) + n;
  saveApolloSpend(s);
  return s.spent;
}

// Sentinel thrown by apolloMatchPerson when the daily cap is reached.
// Callers should catch this specifically and break out of their loops
// rather than treating it as a transient error.
class ApolloCapReachedError extends Error {
  constructor(spent, cap) {
    super(`Apollo daily cap reached: ${spent}/${cap} credits used today`);
    this.code = "APOLLO_CAP_REACHED";
    this.spent = spent;
    this.cap = cap;
  }
}

// Sentinel thrown when Apollo itself returns "insufficient credits" (422).
// This is Apollo's account-level credit allowance running out, NOT our
// internal daily cap. Different from ApolloCapReachedError because the
// fix is "top up Apollo subscription," not "wait for tomorrow's reset."
//
// Callers MUST catch this specifically: break the loop immediately (every
// subsequent call would also 422), log at ERROR severity so it surfaces
// in Cloud Logging alerts, and persist the exhausted state so the
// Discovery widget can show a red "Apollo brugt op" banner instead of
// the misleading "0 leads i dag" silent zero.
class ApolloCreditExhaustedError extends Error {
  constructor(detail) {
    super(`Apollo credits exhausted: ${detail || "insufficient credits"}`);
    this.code = "APOLLO_CREDITS_EXHAUSTED";
    this.detail = detail;
  }
}

// Returns true if Apollo's HTTP response indicates the account's monthly
// credit allowance has run out. Apollo returns 422 with a body containing
// "insufficient credits" (sometimes with HTML upgrade link) — match the
// English phrase, not the upgrade link which can change.
function isApolloCreditExhaustedResponse(status, text) {
  if (status !== 422) return false;
  return /insufficient\s+credits/i.test(String(text || ""));
}

// Persistent flag the Discovery widget reads to show the "Apollo blokeret"
// banner. Lives next to apollo_spend.json. Set by any of the 6 discovery
// endpoints when they hit a 422; cleared on the next successful Apollo
// call. So the banner appears within seconds of credit exhaustion and
// disappears within seconds of Casper topping up the subscription.
const APOLLO_STATUS_FILE = path.join(DATA_DIR, "discovery", "apollo_status.json");
function loadApolloStatus() {
  try {
    if (fs.existsSync(APOLLO_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(APOLLO_STATUS_FILE, "utf8"));
    }
  } catch (_) { /* fall through */ }
  return { exhausted: false, since: null, detail: null, lastChecked: null };
}
function setApolloExhausted(detail) {
  try {
    fs.mkdirSync(path.dirname(APOLLO_STATUS_FILE), { recursive: true });
    const prev = loadApolloStatus();
    const next = {
      exhausted: true,
      since: prev.exhausted && prev.since ? prev.since : new Date().toISOString(),
      detail: detail || "Apollo returned 422 'insufficient credits'",
      lastChecked: new Date().toISOString(),
    };
    fs.writeFileSync(APOLLO_STATUS_FILE, JSON.stringify(next, null, 2));
    if (!prev.exhausted) {
      // Log loudly the FIRST time we detect exhaustion — subsequent hits
      // within the same outage just bump lastChecked and stay silent.
      console.error(`[apollo-status] CREDITS EXHAUSTED — Casper must top up at app.apollo.io. Detail: ${detail || ""}`);
    }
  } catch (e) { console.warn("[apollo-status] save failed:", e.message); }
}
function clearApolloExhausted() {
  try {
    const prev = loadApolloStatus();
    if (!prev.exhausted) return; // nothing to clear
    fs.mkdirSync(path.dirname(APOLLO_STATUS_FILE), { recursive: true });
    fs.writeFileSync(APOLLO_STATUS_FILE, JSON.stringify({
      exhausted: false, since: null, detail: null, lastChecked: new Date().toISOString(),
    }, null, 2));
    console.log("[apollo-status] credits restored — banner cleared");
  } catch (_) { /* logging is never fatal */ }
}

// Strip Danish legal suffixes + simple-strip Danish characters for
// Apollo's name matching. Apollo stores names without legal forms
// ("FDM TRAVEL" not "FDM TRAVEL A/S") and its search is ASCII-leaning:
// "Søstrene Grene" → 0, "Sostrene Grene" → ✓ (ø→o, not the formal ø→oe).
// Live-tested against multiple DK brands.
function normaliseCompanyName(name) {
  return String(name || "")
    .replace(/\s+(aps|a\/s|i\/s|p\/s|k\/s|ivs|holding|group|gruppen)\b.*$/i, "")
    .replace(/[æÆ]/g, "a")
    .replace(/[øØ]/g, "o")
    .replace(/[åÅ]/g, "a")
    .trim();
}

// Step 1a — when we don't have a domain, find the company in Apollo by name
// + location:Denmark, get back the domain + org_id. Cheap (1 free API call).
async function apolloFindCompany({ name }) {
  const cleanName = normaliseCompanyName(name);
  if (!cleanName) return null;
  // PR2: pre-flight cap check. Without this, drain could keep calling
  // Apollo all day without ever tripping the cap (which was only
  // incremented by apolloMatchPerson before). Throws the typed sentinel
  // so callers break out of their loop cleanly.
  const spendState = loadApolloSpend();
  if (spendState.spent >= APOLLO_DAILY_CAP) {
    throw new ApolloCapReachedError(spendState.spent, APOLLO_DAILY_CAP);
  }
  const r = await fetch(`${APOLLO_API_BASE}/mixed_companies/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify({
      page: 1,
      per_page: 3,
      q_organization_name: cleanName,
      organization_locations: ["Denmark"],
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    if (isApolloCreditExhaustedResponse(r.status, text)) {
      setApolloExhausted(text.slice(0, 200));
      throw new ApolloCreditExhaustedError(text.slice(0, 200));
    }
    throw new Error(`Apollo company search ${r.status}: ${text.slice(0, 200)}`);
  }
  clearApolloExhausted();
  // Apollo counts this against the monthly allowance — bump our counter.
  incrementApolloSpend(1);
  const d = await r.json();
  const orgs = d.organizations || d.accounts || [];
  // Prefer DK orgs with a website
  const best = orgs.find((o) => o.website_url) || orgs[0] || null;
  if (!best) return null;
  return {
    id: best.id,
    name: best.name,
    domain: String(best.website_url || best.primary_domain || "")
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim(),
  };
}

async function apolloSearchPeople({ name, domain, organizationId }) {
  const body = {
    page: 1,
    per_page: APOLLO_SEARCH_LIMIT,
    person_seniorities: ["c_suite", "founder", "owner", "vp", "director", "head", "manager"],
  };
  // Precision order: organization_id (Apollo's exact match) > domain > name.
  if (organizationId) body.organization_ids = [organizationId];
  else if (domain) body.q_organization_domains_list = [domain];
  else if (name) body.q_organization_name = normaliseCompanyName(name);
  else throw new Error("Need organizationId, domain, or name");

  const r = await fetch(`${APOLLO_API_BASE}/mixed_people/api_search`, {
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
    if (isApolloCreditExhaustedResponse(r.status, text)) {
      setApolloExhausted(text.slice(0, 200));
      throw new ApolloCreditExhaustedError(text.slice(0, 200));
    }
    throw new Error(`Apollo people search ${r.status}: ${text.slice(0, 200)}`);
  }
  clearApolloExhausted();
  const d = await r.json();
  return d.people || [];
}

async function apolloMatchPerson(personId) {
  // Pre-flight cap check — never make the API call (and burn the credit)
  // if today's budget is already spent. Throws a typed sentinel so the
  // caller can break cleanly instead of treating it as a transient err.
  const spendState = loadApolloSpend();
  if (spendState.spent >= APOLLO_DAILY_CAP) {
    throw new ApolloCapReachedError(spendState.spent, APOLLO_DAILY_CAP);
  }

  const r = await fetch(`${APOLLO_API_BASE}/people/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify({
      id: personId,
      reveal_personal_emails: true,
      // 2026-06-08 — phone reveal disabled. Apollo's API requires a
      // webhook_url for reveal_phone_number because it's an async
      // operation — phone numbers Apollo hasn't pre-cached take seconds
      // to minutes to look up from third-party sources and are POSTed
      // back to the supplied webhook. Until we wire /api/apollo/phone-
      // reveal-webhook with signature verification + lead-stamping, we
      // skip the reveal flag and rely on whatever phones Apollo has
      // already cached in phone_numbers[] (typically 30-50% of contacts).
      // reveal_phone_number: true,  // requires webhook — see TODO
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    if (isApolloCreditExhaustedResponse(r.status, text)) {
      setApolloExhausted(text.slice(0, 200));
      throw new ApolloCreditExhaustedError(text.slice(0, 200));
    }
    throw new Error(`Apollo match ${r.status}: ${text.slice(0, 200)}`);
  }
  clearApolloExhausted();
  const d = await r.json();
  // Increment AFTER a successful response — failed calls don't count
  // against the budget (Apollo doesn't bill on errors either).
  incrementApolloSpend(1);
  return d.person || null;
}

// Map Apollo's people/match response → our normalised contact shape.
// Captures all the high-signal fields Apollo returns for free (same
// 1 credit/match call) so the SDR sees richer context per decision-maker.
// Apollo phone_numbers[] uses these `type` values; rank them so the
// SDR sees the most useful phone first. Direct/mobile beat switchboards.
// Type → priority weight (higher = better)
const APOLLO_PHONE_TYPE_RANK = {
  "mobile":        100,
  "work_direct":   90,
  "direct":        85,
  "work":          70,
  "main":          50,
  "home_phone":    20,
  "":              10,
};
function _rankApolloPhone(ph) {
  const t = String(ph.type || "").toLowerCase();
  return APOLLO_PHONE_TYPE_RANK[t] != null ? APOLLO_PHONE_TYPE_RANK[t] : 30;
}
// Human-readable Danish label for a phone type.
function _labelApolloPhone(type) {
  const t = String(type || "").toLowerCase();
  return ({
    "mobile":      "Mobil",
    "work_direct": "Direct dial",
    "direct":      "Direct dial",
    "work":        "Arbejde",
    "main":        "Switchboard",
    "home_phone":  "Privat",
  })[t] || (t ? t : "Telefon");
}

function mapApolloPersonToContact(p, fallbackTitle) {
  if (!p) return null;
  // Surface ALL phones the match response contains (not just the first).
  // Apollo often returns 2-4 phones per contact with type labels — mobile,
  // direct dial, work, main switchboard. Sort by usefulness so the SDR
  // can dial the highest-quality one first.
  const phonesRaw = Array.isArray(p.phone_numbers) ? p.phone_numbers : [];
  const phones = phonesRaw
    .map((ph) => ({
      number: ph.sanitized_number || ph.raw_number || "",
      type: String(ph.type || "").toLowerCase(),
      typeLabel: _labelApolloPhone(ph.type),
      status: String(ph.status || "").toLowerCase(),
      dncStatus: ph.dnc_status || null,
      position: ph.position || 0,
    }))
    .filter((p) => p.number)
    // De-dup on number — Apollo sometimes returns the same number twice
    .filter((p, i, arr) => arr.findIndex((x) => x.number === p.number) === i)
    .sort((a, b) => _rankApolloPhone(b) - _rankApolloPhone(a));
  // Primary phone = the highest-ranked one (mobile > direct > work > main).
  const primary = phones[0] || {};
  // Employment history → keep just title + company name + dates for brevity.
  const employmentHistory = (p.employment_history || []).slice(0, 5).map((e) => ({
    title: e.title || "",
    org: e.organization_name || "",
    start: e.start_date || "",
    end: e.end_date || "",
    current: !!e.current,
  }));
  return {
    name: p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || "—",
    title: p.title || fallbackTitle || "",
    phone: primary.number || "",             // best dial-able number
    phoneType: primary.type || "",            // "mobile" | "direct" | "work" | …
    phoneTypeLabel: primary.typeLabel || "",  // Danish label
    phones,                                   // ALL phones with type metadata
    email: p.email || (p.personal_emails && p.personal_emails[0]) || "",
    emailStatus: p.email_status || "",
    emailCatchall: !!p.email_domain_catchall,
    personalEmails: p.personal_emails || [],
    linkedin: p.linkedin_url || "",
    // High-signal extras (no extra credit cost):
    seniority: p.seniority || "",
    departments: p.departments || [],
    headline: p.headline || "",
    photoUrl: p.photo_url || "",
    timeZone: p.time_zone || "",
    location: p.formatted_address || p.city || p.state || p.country || "",
    employmentHistory,
    apolloPersonId: p.id || null,
  };
}

// Map Apollo's organization object → our companyMeta shape. Apollo gives
// us 59 org fields; we keep the ones useful for cold-call context and
// ICP qualification. Costs zero extra credits — it rides along with
// every people/match response.
// Meta-advertiser detection from Apollo's technology stack. Distinguishes
// ACTIVE advertising tech (Pixel, Ads Manager, Custom Audiences — these
// mean they run/track ad campaigns) from mere social presence (a plain
// Facebook page or Login button, which any company might have). Only the
// "active" markers count toward metaAdvertiser — that's the real signal
// that this company spends on Meta ads (our ICP).
const META_AD_ACTIVE_RE = /meta ads|facebook pixel|facebook custom audiences|facebook conversion|facebook advertis|facebook ads|meta pixel|facebook business/i;
const META_AD_SOCIAL_RE = /^(facebook|facebook login|facebook widget|facebook connect|instagram)$/i;
function detectMetaAdvertiser(technologyNamesFull) {
  const all = Array.isArray(technologyNamesFull) ? technologyNamesFull.map(String) : [];
  const active = all.filter((t) => META_AD_ACTIVE_RE.test(t));
  const social = all.filter((t) => META_AD_SOCIAL_RE.test(t.trim()));
  return {
    metaAdvertiser: active.length > 0,        // true = spends on Meta ads (ICP)
    metaAdSignals: active,                     // e.g. ["Meta Ads Manager","Facebook Pixel"]
    metaSocialOnly: active.length === 0 && social.length > 0, // has FB page but no ad tech
  };
}

function mapApolloOrganization(org) {
  if (!org || typeof org !== "object") return null;
  const adDetect = detectMetaAdvertiser(org.technology_names || []);
  return {
    apolloId: org.id || null,
    name: org.name || "",
    domain: org.primary_domain || (org.website_url || "").replace(/^https?:\/\/|^www\./g, "").replace(/\/.*$/, ""),
    websiteUrl: org.website_url || "",
    phone: org.sanitized_phone || org.phone || "",
    annualRevenue: org.annual_revenue || null,
    annualRevenuePrinted: org.annual_revenue_printed || "",
    estimatedEmployees: org.estimated_num_employees || null,
    foundedYear: org.founded_year || null,
    industry: org.industry || "",
    secondaryIndustries: org.secondary_industries || [],
    keywords: (org.keywords || []).slice(0, 12),
    shortDescription: org.short_description || "",
    growth6Mo: org.organization_headcount_six_month_growth || null,
    growth12Mo: org.organization_headcount_twelve_month_growth || null,
    growth24Mo: org.organization_headcount_twenty_four_month_growth || null,
    technologyNames: (org.technology_names || []).slice(0, 20),
    // Meta-advertiser signal (our ICP) — derived from the FULL tech list.
    metaAdvertiser: adDetect.metaAdvertiser,
    metaAdSignals: adDetect.metaAdSignals,
    metaSocialOnly: adDetect.metaSocialOnly,
    latestFundingDate: org.latest_funding_round_date || null,
    latestFundingStage: org.latest_funding_stage || "",
    totalFundingPrinted: org.total_funding_printed || "",
    publiclyTradedExchange: org.publicly_traded_exchange || "",
    publiclyTradedSymbol: org.publicly_traded_symbol || "",
    logoUrl: org.logo_url || "",
    linkedinUrl: org.linkedin_url || "",
    twitterUrl: org.twitter_url || "",
    facebookUrl: org.facebook_url || "",
    alexaRanking: org.alexa_ranking || null,
    numSuborganizations: org.num_suborganizations || 0,
    rawAddress: org.raw_address || "",
    city: org.city || "",
    country: org.country || "",
  };
}

// LIGHTWEIGHT advertiser check — Apollo organization enrichment by domain.
// Returns ONLY company/tech data (incl. Meta-advertiser signal). Does NOT
// reveal any contact emails/phones, so it consumes no contact credits.
// Used for CSV people-leads where we already have the contact and only
// need the ICP/ads signal.
async function apolloOrgEnrich(domain) {
  const d = String(domain || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
  if (!d) return null;
  // PR2: pre-flight cap check (same rationale as apolloFindCompany).
  const spendState = loadApolloSpend();
  if (spendState.spent >= APOLLO_DAILY_CAP) {
    throw new ApolloCapReachedError(spendState.spent, APOLLO_DAILY_CAP);
  }
  const r = await fetch(`https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(d)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": process.env.APOLLO_API_KEY },
  });
  if (!r.ok) {
    // 422 'insufficient credits' = Apollo account is exhausted. Throw the
    // typed sentinel so discovery loops break out instantly instead of
    // silently returning null 150 more times. Other non-OKs (network blips,
    // domain-not-found, etc) still return null — those are normal misses.
    const text = await r.text().catch(() => "");
    if (isApolloCreditExhaustedResponse(r.status, text)) {
      setApolloExhausted(text.slice(0, 200));
      throw new ApolloCreditExhaustedError(text.slice(0, 200));
    }
    return null;
  }
  clearApolloExhausted();
  // Apollo counts this against the monthly allowance — bump our counter.
  incrementApolloSpend(1);
  const j = await r.json().catch(() => ({}));
  return j.organization ? mapApolloOrganization(j.organization) : null;
}

async function enrichWithApollo({ name, domain }) {
  // STEP 1 — resolve to Apollo's organization_id. ~70% hit rate boost
  // for DK SMBs vs name-only people search.
  let orgId = null;
  let resolvedDomain = String(domain || "")
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
  if (!resolvedDomain && name) {
    try {
      const found = await apolloFindCompany({ name });
      if (found) {
        orgId = found.id;
        resolvedDomain = found.domain || resolvedDomain;
      }
    } catch (e) {
      console.warn("[apollo/findCompany]", name, e.message);
    }
  }

  // STEP 2 — search decision-makers at the resolved company
  const searchResults = await apolloSearchPeople({
    name,
    domain: resolvedDomain,
    organizationId: orgId,
  });
  if (!searchResults.length) return { contacts: [], company: null };

  // STEP 3 — enrich each (1 credit per match). Side benefit: each
  // /match response includes the FULL organization object — we capture
  // that for free on the first successful match.
  const contacts = [];
  let company = null;
  for (const sr of searchResults.slice(0, APOLLO_SEARCH_LIMIT)) {
    if (sr.has_email === false && sr.has_direct_phone === false) continue;
    if (!sr.id) continue;
    try {
      const p = await apolloMatchPerson(sr.id);
      if (!p) continue;
      const contact = mapApolloPersonToContact(p, sr.title);
      if (contact && contact.name !== "—") contacts.push(contact);
      // Capture organization data from the first match that has it
      if (!company && p.organization) {
        company = mapApolloOrganization(p.organization);
      }
      await new Promise((r) => setTimeout(r, APOLLO_MATCH_DELAY_MS));
    } catch (e) {
      // Re-throw cap-reached so the outer caller can break the batch
      // cleanly. Other errors are per-person — log and continue.
      if (e && e.code === "APOLLO_CAP_REACHED") throw e;
      console.warn("[apollo/match]", sr.id, e.message);
    }
  }
  const filteredContacts = contacts.filter((c) => c.email || c.phone || c.linkedin);
  return { contacts: filteredContacts, company };
}

app.get("/api/apollo/status", authMiddleware, (req, res) => {
  res.json({ configured: isApolloConfigured(), provider: "apollo.io" });
});

// Persistent 30-day cache for LinkedIn URL → lookup result. Same URL
// looked up twice within 30 days serves from cache — no Apollo bill,
// no Apify scrape. Important because the SDR will often re-research
// a lead and we don't want every cockpit click to burn a credit.
const LINKEDIN_LOOKUP_CACHE_FILE = path.join(DATA_DIR, "discovery", "linkedin_lookup_cache.json");
const LINKEDIN_LOOKUP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function _loadLinkedinLookupCache() {
  try {
    if (fs.existsSync(LINKEDIN_LOOKUP_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(LINKEDIN_LOOKUP_CACHE_FILE, "utf8")) || {};
    }
  } catch {}
  return {};
}
function _saveLinkedinLookupCache(cache) {
  try {
    fs.mkdirSync(path.dirname(LINKEDIN_LOOKUP_CACHE_FILE), { recursive: true });
    // GC entries older than TTL while we're saving
    const now = Date.now();
    for (const [k, v] of Object.entries(cache)) {
      if (!v?.cachedAt || (now - new Date(v.cachedAt).getTime()) > LINKEDIN_LOOKUP_CACHE_TTL_MS) {
        delete cache[k];
      }
    }
    fs.writeFileSync(LINKEDIN_LOOKUP_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) { console.warn("[linkedin-cache] save:", e.message); }
}
function _normaliseLinkedinUrl(u) {
  // Strip trailing slash, query string, and protocol so http/https variants
  // hit the same cache key.
  return String(u || "").trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .replace(/\?.*$/, "")
    .toLowerCase();
}

// POST /api/apollo/lookup-linkedin — SalesQL-style "paste a LinkedIn URL,
// get the contact's direct dial" lookup. The bookmarklet in /public/
// triggers this with the current LinkedIn profile URL pre-filled.
//
// Cost model:
//   - 30-day cache HIT  →  free (returns stored result)
//   - Apollo match      →  1 credit per fresh lookup
//   - Apify fallback    →  ~$0.01 per scrape, ONLY when phone is missing
//
// Apify-fallback trigger was changed 2026-06-08 from "Apollo returned
// a stub (no name/title)" to "Apollo returned no phone" — the user's
// actionable field is the phone, not the name.
// ─── Lusha — primary phone-reveal source ────────────────────────────────
// Apollo's DK SMB phone DB is patchy — for Danish contacts it frequently
// returns US/foreign numbers. Lusha is EU-native and has much better
// DK SMB direct dial coverage (verified by user test 2026-06-08).
//
// We use Lusha for PHONE REVEALS specifically. Apollo stays for:
//   - Discovery pipeline (12 daily crons)
//   - Org enrichment / ICP gating
//   - Decision-maker name search
//   - Cached email + phone data (free, returned with /people/match)
//
// Cost model: ~1 credit per successful person lookup (returns all
// phones + emails). Premium plan $79/mo gets ~960 credits. Self-imposed
// daily cap protects against runaway burn.

const LUSHA_API_BASE = "https://api.lusha.com";
const LUSHA_DAILY_CAP = 60;
const LUSHA_SPEND_FILE = path.join(DATA_DIR, "discovery", "lusha_spend.json");

function isLushaConfigured() {
  return !!process.env.LUSHA_API_KEY;
}

// ─── Source categorization ────────────────────────────────────────────
// Two top-level lead lists: "DK e-commerce SMBs" and "DK service businesses".
// Every lead carries source_category derived from its origin source + (for
// branche-walk) the DB07 industry code. New sources map by source prefix.
//
// Returns "ecom" | "service" | "unknown". Use "unknown" sparingly so the
// dual-list UI always has a definite home for each lead.
const BRANCHE_WALK_ECOM_CODES = new Set([
  "477110", // Tøjbutik
  "477210", // Skobutik
  "475100", // Møbler
  "479110", // Detailhandel internet
  "478990", // Anden detailhandel
  "477800", // Optikere
  "475250", // Belysning
  "475440", // Glas/keramik
  "476420", // Sport
  "476500", // Spil/legetøj
  "477630", // Blomster
  "477640", // Dyr/foder
  "477990", // Anden detail
]);
const BRANCHE_WALK_SERVICE_CODES = new Set([
  "731000", // Marketing-bureau
  "741010", // Design/web
  "683210", // Ejendomsmægler
  "791100", // Rejsebureau
  "563000", // Caféer/cafeterier
  "742010", // Fotograf-erhverv
  "961040", // Wellness/skønhed
]);

function deriveSourceCategory(source, brancheCode) {
  if (brancheCode) {
    if (BRANCHE_WALK_ECOM_CODES.has(String(brancheCode))) return "ecom";
    if (BRANCHE_WALK_SERVICE_CODES.has(String(brancheCode))) return "service";
  }
  const s = String(source || "").toLowerCase();
  if (s.startsWith("storeleads"))         return "ecom";
  if (s.startsWith("meta-ads-discover"))  return "ecom";
  if (s.startsWith("linkedin-ads-disc"))  return "service"; // LinkedIn ads skew B2B-service
  if (s.startsWith("gmaps-discover"))     return "service"; // local-business heavy
  if (s.startsWith("tech-discover"))      return "ecom";
  if (s.startsWith("branche-walk-")) {
    const code = s.replace(/^branche-walk-/, "");
    if (BRANCHE_WALK_ECOM_CODES.has(code))    return "ecom";
    if (BRANCHE_WALK_SERVICE_CODES.has(code)) return "service";
  }
  return "unknown";
}

// ─── Full Enrich (B2B contact enrichment) ─────────────────────────────
// Replaces Lusha + Apollo as primary phone-reveal source. Better DK SMB
// coverage according to Nicolas + the reference setup — claimed ~80%
// direct-dial hit rate from a LinkedIn URL.
//
// Async bulk endpoint: POST returns {id, status:"IN_PROGRESS"}, then poll
// GET /api/v2/contact/enrich/bulk/{id} until status === "COMPLETED".
// Most jobs finish in 30-90s. Credits charged only when results found:
// 10/mobile, 3/personal email, 1/work email.
//
// PR10. Smoke-test endpoint: /api/fullenrich/test
const FULLENRICH_API_BASE = "https://api.fullenrich.com";
const FULLENRICH_DAILY_CREDIT_CAP = 500; // ~50 phone reveals/day
const FULLENRICH_SPEND_FILE = path.join(DATA_DIR, "discovery", "fullenrich_spend.json");
const FULLENRICH_POLL_INTERVAL_MS = 5000;
const FULLENRICH_POLL_TIMEOUT_MS  = 180_000; // 3 min sync cap

function isFullEnrichConfigured() {
  return !!process.env.FULLENRICH_API_KEY;
}

function loadFullEnrichSpend() {
  const today = _cphDateStr();
  try {
    if (fs.existsSync(FULLENRICH_SPEND_FILE)) {
      const s = JSON.parse(fs.readFileSync(FULLENRICH_SPEND_FILE, "utf8"));
      if (s.date === today) return s;
      // New day — roll history and reset
      const history = s.history || {};
      history[s.date] = s.spent;
      return { date: today, spent: 0, history };
    }
  } catch (_) {}
  return { date: today, spent: 0, history: {} };
}

function saveFullEnrichSpend(state) {
  fs.mkdirSync(path.dirname(FULLENRICH_SPEND_FILE), { recursive: true });
  fs.writeFileSync(FULLENRICH_SPEND_FILE, JSON.stringify(state, null, 2));
}

function consumeFullEnrichCredits(credits) {
  const state = loadFullEnrichSpend();
  state.spent = (state.spent || 0) + Math.max(0, Number(credits) || 0);
  saveFullEnrichSpend(state);
  return state;
}

// Submit a bulk enrichment. contacts = [{first_name, last_name, domain,
// company_name, linkedin_url, custom: {cvr, ...}}]. Returns the job id.
async function fullEnrichSubmitBatch(contacts, opts = {}) {
  if (!isFullEnrichConfigured()) throw new Error("Full Enrich not configured");
  const spend = loadFullEnrichSpend();
  if (spend.spent >= FULLENRICH_DAILY_CREDIT_CAP) {
    const err = new Error(`Full Enrich daily cap reached: ${spend.spent}/${FULLENRICH_DAILY_CREDIT_CAP}`);
    err.code = "FULLENRICH_CAP_REACHED";
    throw err;
  }
  const body = {
    name: opts.name || `vedio-leads-${Date.now()}`,
    data: contacts,
  };
  // Skip invalid contacts rather than blocking the whole batch
  const url = `${FULLENRICH_API_BASE}/api/v2/contact/enrich/bulk?silentFail=true`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.FULLENRICH_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Full Enrich submit ${r.status}: ${t.slice(0, 300)}`);
  }
  const d = await r.json();
  return d.id || d.enrichment_id || null;
}

// Poll a job until completed or timeout. Returns the full response object.
async function fullEnrichWaitForResult(jobId, opts = {}) {
  if (!isFullEnrichConfigured()) throw new Error("Full Enrich not configured");
  const start = Date.now();
  const timeout = opts.timeoutMs || FULLENRICH_POLL_TIMEOUT_MS;
  const interval = opts.intervalMs || FULLENRICH_POLL_INTERVAL_MS;
  while (Date.now() - start < timeout) {
    const r = await fetch(
      `${FULLENRICH_API_BASE}/api/v2/contact/enrich/bulk/${encodeURIComponent(jobId)}`,
      { headers: { "Authorization": `Bearer ${process.env.FULLENRICH_API_KEY}` } },
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Full Enrich poll ${r.status}: ${t.slice(0, 300)}`);
    }
    const d = await r.json();
    const status = String(d.status || "").toUpperCase();
    if (status === "COMPLETED" || status === "FINISHED" || status === "DONE") {
      // Stamp spent credits if reported
      if (d.cost && typeof d.cost.credits === "number") {
        consumeFullEnrichCredits(d.cost.credits);
      }
      return d;
    }
    if (status === "FAILED" || status === "ERROR") {
      throw new Error(`Full Enrich job ${jobId} ended ${status}`);
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(`Full Enrich job ${jobId} did not complete within ${timeout}ms`);
}

// Convenience: synchronously enrich a single contact (submit + poll).
// Returns the contact_info object from the response data[0], or null.
async function fullEnrichLookupOne(contact, opts = {}) {
  const jobId = await fullEnrichSubmitBatch([contact], { name: opts.name });
  if (!jobId) return null;
  const result = await fullEnrichWaitForResult(jobId, opts);
  const entry = (result.data || [])[0];
  return entry || null;
}

// Smoke-test endpoint — used to verify the API key + understand response
// shape with a known LinkedIn URL or name+company. ?linkedinUrl= OR
// ?firstName= + ?lastName= + ?company= (or ?domain=) required.
app.post("/api/fullenrich/test", authMiddleware, async (req, res) => {
  if (!isFullEnrichConfigured()) {
    return res.status(503).json({ error: "Full Enrich ikke konfigureret — sæt FULLENRICH_API_KEY secret" });
  }
  const li = (req.query.linkedinUrl || req.body?.linkedinUrl || "").toString().trim();
  const first = (req.query.firstName || req.body?.firstName || "").toString().trim();
  const last  = (req.query.lastName  || req.body?.lastName  || "").toString().trim();
  const company = (req.query.company || req.body?.company || "").toString().trim();
  const domain  = (req.query.domain  || req.body?.domain  || "").toString().trim();
  const contact = {};
  if (li) contact.linkedin_url = li;
  if (first) contact.first_name = first;
  if (last)  contact.last_name  = last;
  if (company) contact.company_name = company;
  if (domain)  contact.domain      = domain;
  if (!contact.linkedin_url && !(contact.first_name && contact.last_name && (contact.company_name || contact.domain))) {
    return res.status(400).json({ error: "linkedinUrl OR (firstName+lastName+company|domain) required" });
  }
  try {
    const result = await fullEnrichLookupOne(contact);
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
});

function loadLushaSpend() {
  const today = _cphDateStr();
  try {
    if (fs.existsSync(LUSHA_SPEND_FILE)) {
      const s = JSON.parse(fs.readFileSync(LUSHA_SPEND_FILE, "utf8"));
      if (s.date === today) return { date: today, spent: s.spent || 0, history: s.history || {} };
      const history = s.history || {};
      if (s.date) history[s.date] = s.spent || 0;
      const days = Object.keys(history).sort();
      while (days.length > 60) delete history[days.shift()];
      return { date: today, spent: 0, history };
    }
  } catch (e) { console.warn("[lusha-spend] load:", e.message); }
  return { date: today, spent: 0, history: {} };
}
function saveLushaSpend(state) {
  try {
    fs.mkdirSync(path.dirname(LUSHA_SPEND_FILE), { recursive: true });
    fs.writeFileSync(LUSHA_SPEND_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.warn("[lusha-spend] save:", e.message); }
}
function getLushaSpendToday() {
  const s = loadLushaSpend();
  return { date: s.date, spent: s.spent, cap: LUSHA_DAILY_CAP, remaining: Math.max(0, LUSHA_DAILY_CAP - s.spent), history: s.history };
}
function incrementLushaSpend(n = 1) {
  const s = loadLushaSpend();
  s.spent = (s.spent || 0) + n;
  saveLushaSpend(s);
  return s.spent;
}

// Filter phone array to DK-only (+45). Drops US/foreign HQ numbers
// that Apollo + Lusha both occasionally surface for DK contacts.
// Apollo's stats showed ~60-70% of DK reveals returned non-DK noise.
function filterDkPhones(phones) {
  if (!Array.isArray(phones)) return [];
  return phones.filter((ph) => {
    const num = String(ph.number || "").replace(/[^0-9+]/g, "");
    if (!num) return false;
    // Accept: +45XXXXXXXX, 45XXXXXXXX (10 digits, no +), or bare 8-digit DK
    return num.startsWith("+45") || (num.startsWith("45") && num.length === 10) || /^\d{8}$/.test(num);
  });
}

// Core Lusha person lookup. Lusha's v2 /person endpoint accepts:
//   - email (sufficient on its own)
//   - firstName + lastName + (companies OR companyDomain)
// LinkedIn URL is NOT a valid lookup key on v2/person — Lusha only
// surfaces LinkedIn-URL lookups through their Chrome extension or v1
// enrichment API. So when a caller passes linkedinUrl, we split the
// upstream contact's name and use first/last/company as the lookup.
async function lushaLookupPerson(input) {
  if (!isLushaConfigured()) throw new Error("Lusha not configured");
  // Cap check pre-flight
  const spend = loadLushaSpend();
  if (spend.spent >= LUSHA_DAILY_CAP) {
    const err = new Error(`Lusha daily cap reached: ${spend.spent}/${LUSHA_DAILY_CAP}`);
    err.code = "LUSHA_CAP_REACHED";
    err.spent = spend.spent;
    err.cap = LUSHA_DAILY_CAP;
    throw err;
  }

  // Build the request body — Lusha v2 /person is a BULK endpoint.
  // Schema (from Lusha docs):
  //   {
  //     "contacts": [
  //       {
  //         "contactId": "<our-unique-id>",
  //         "fullName": "First Last",
  //         "email": "...",                    (optional)
  //         "companies": [{ "name": "..." }]   (optional)
  //       }
  //     ]
  //   }
  // We always send exactly 1 contact in the array.
  let fullName = "";
  if (input.fullName) fullName = String(input.fullName).trim();
  else if (input.firstName || input.lastName) fullName = `${input.firstName||""} ${input.lastName||""}`.trim();
  const hasEmail = !!input.email;
  if (!fullName && !hasEmail) return null;

  const contact = { contactId: "1" };
  if (fullName) contact.fullName = fullName;
  if (hasEmail) contact.email = input.email;
  // Lusha requires isCurrent: true to mark the contact's CURRENT
  // employer (the one we want phone for, not historical jobs).
  if (input.companyName) contact.companies = [{ name: input.companyName, isCurrent: true }];
  if (input.companyDomain && !input.companyName) contact.companies = [{ domain: input.companyDomain, isCurrent: true }];

  const body = { contacts: [contact] };

  const r = await fetch(`${LUSHA_API_BASE}/v2/person`, {
    method: "POST",
    headers: {
      "api_key": process.env.LUSHA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    if (r.status === 401) throw new Error("Lusha: invalid API key (check LUSHA_API_KEY secret)");
    if (r.status === 402 || r.status === 403) throw new Error("Lusha: out of credits or plan limit");
    if (r.status === 404) return null;
    throw new Error(`Lusha ${r.status}: ${txt.slice(0, 200)}`);
  }

  const data = await r.json().catch(() => ({}));
  // Bulk response shape: { contacts: { "1": { data: {...} } } }  OR
  //                       { contacts: [{ contactId, data: {...} }] }
  let person = null;
  if (data?.contacts) {
    if (Array.isArray(data.contacts)) {
      person = data.contacts[0]?.data || data.contacts[0] || null;
    } else if (typeof data.contacts === "object") {
      // Object map keyed by contactId
      const firstKey = Object.keys(data.contacts)[0];
      person = data.contacts[firstKey]?.data || data.contacts[firstKey] || null;
    }
  }
  // Some versions return the person directly
  if (!person) person = data?.data || data?.person || null;
  if (!person || (!person.fullName && !person.firstName && !person.name)) return null;

  incrementLushaSpend(1);

  // Normalise to our contact shape
  const rawPhones = person.phoneNumbers || person.phones || [];
  const phones = rawPhones.map((ph) => {
    const num = ph.internationalNumber || ph.number || ph.phone || "";
    const type = String(ph.phoneType || ph.type || "").toLowerCase();
    return {
      number: num,
      type: type === "mobile" ? "mobile" : (type === "direct" ? "direct" : type === "company" ? "main" : type || "mobile"),
      typeLabel: type === "mobile" ? "Mobil (Lusha)" : (type === "direct" ? "Direct dial (Lusha)" : "Lusha"),
      status: "verified",
      source: "lusha",
    };
  });

  const emails = (person.emailAddresses || person.emails || []).map((em) => ({
    address: em.email || em.address || "",
    type: em.emailType || em.type || "work",
  })).filter((e) => e.address);

  return {
    name: person.fullName || `${person.firstName || ""} ${person.lastName || ""}`.trim(),
    firstName: person.firstName || "",
    lastName: person.lastName || "",
    title: person.title || person.position || "",
    headline: person.headline || person.title || "",
    photoUrl: person.profilePicture || person.photo || "",
    linkedinUrl: person.linkedinUrl || input.linkedinUrl || "",
    location: person.location || person.country || "",
    phones,
    email: emails[0]?.address || "",
    emails: emails.map((e) => e.address),
    companyName: person.company?.name || person.companyName || "",
    companyDomain: person.company?.domain || person.companyDomain || "",
    companyIndustry: person.company?.industry || "",
    raw: person,
  };
}

// POST /api/lusha/lookup — frontend wrapper. Accepts:
//   { url: <linkedin> }  → we'll try to extract name from the URL slug
//                           (linkedin.com/in/john-doe-12345 → "John Doe")
//   { firstName, lastName, companyName, companyDomain }
//   { email }
//
// Lusha v2 /person doesn't accept LinkedIn URLs directly — we must
// pass firstName+lastName+company. When all we have is a URL, we
// best-effort parse the slug; for SDR research this is usually enough
// because Nicolas already has the LinkedIn page open and could paste
// the company name into the modal if the slug-parse misses.
app.post("/api/lusha/lookup", authMiddleware, async (req, res) => {
  if (!isLushaConfigured()) {
    return res.status(503).json({ error: "Lusha ikke konfigureret — tilføj LUSHA_API_KEY i Secret Manager", configured: false });
  }
  const body = req.body || {};
  // If a LinkedIn URL was passed, parse the slug for a name hint
  let parsedFirst = "", parsedLast = "";
  const url = String(body.url || body.linkedinUrl || "");
  if (url && !body.firstName && !body.email) {
    // Strip linkedin.com/in/ and trailing slash, then drop the trailing
    // numeric hash that LinkedIn appends.
    const slug = url
      .replace(/^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i, "")
      .replace(/\/.*$/, "")
      .replace(/-+\d+$/, "")
      .trim();
    if (slug) {
      const parts = slug.split(/[-_]/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
      parsedFirst = parts[0] || "";
      parsedLast  = parts.slice(1).join(" ") || "";
    }
  }
  try {
    const result = await lushaLookupPerson({
      email: body.email,
      firstName: body.firstName || parsedFirst,
      lastName:  body.lastName  || parsedLast,
      companyName: body.companyName,
      companyDomain: body.companyDomain,
    });
    if (!result) return res.json({ ok: true, found: false, source: "lusha" });
    // DK-only filter on Lusha phones too — defensive, even though Lusha
    // is generally clean on DK contacts.
    const dkPhones = filterDkPhones(result.phones);
    const droppedNonDk = result.phones.length - dkPhones.length;
    return res.json({
      ok: true,
      found: true,
      source: "lusha",
      contact: { ...result, phones: dkPhones },
      droppedNonDkPhones: droppedNonDk,
      spendAfter: getLushaSpendToday(),
    });
  } catch (e) {
    if (e.code === "LUSHA_CAP_REACHED") {
      return res.status(429).json({
        error: `Lusha dagsbudget brugt op (${e.spent}/${e.cap}). Prøv igen i morgen.`,
        code: "LUSHA_CAP_REACHED",
        spent: e.spent, cap: e.cap,
      });
    }
    console.error("[lusha/lookup]", e.message);
    return res.status(502).json({ error: e.message });
  }
});

// GET /api/lusha/credit-status — admin visibility for the SDR + dashboard
app.get("/api/lusha/credit-status", authMiddleware, (req, res) => {
  res.json({ ok: true, configured: isLushaConfigured(), ...getLushaSpendToday() });
});

// POST /api/cron/lusha-morning-reveal — fires every weekday at 07:30 CPH
// (30 min before Nicolas starts calling). Walks the dialer queue, picks
// the top 50 leads by priority, and reveals direct dials for any that
// have a LinkedIn URL but no DK direct dial yet. By 08:00 the queue is
// pre-loaded with decision-maker phones so Nicolas bypasses gatekeepers
// without lifting a finger.
//
// Cost: ~$0.08/lead × ~30-50 leads/day = ~$2-4/day = ~$40-80/month
// Easily fits inside Lusha Pro ($39/mo, 480 credits = 22/day) or
// Premium ($79/mo, 960 credits = 44/day).
//
// Idempotent — leads with a recently-attempted Lusha lookup (last 30 days)
// are skipped to prevent double-spend.
app.post("/api/cron/lusha-morning-reveal", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isLushaConfigured()) return res.status(503).json({ error: "Lusha not configured" });

  const TARGET_USER = (req.query.userId || "u1").toString();
  const limit = Math.max(5, Math.min(80, Number(req.query.limit) || 50));
  const ud = loadUserData(TARGET_USER);
  const stats = {
    leadsConsidered: 0,
    skippedHasDirect: 0,
    skippedNoLinkedIn: 0,
    skippedRecentlyTried: 0,
    lushaAttempted: 0,
    lushaMatched: 0,
    phonesRevealed: 0,
    capReached: false,
    errors: 0,
  };

  // Score leads same way the cockpit "Prioritet" sort does — info-rich
  // first, then ICP signals. We process from the top.
  const RECENT_LUSHA_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const priority = (l) => {
    let p = 0;
    if (l.phone || l.ph) p += 50000;
    if (l.meta_advertiser) p += 5000;
    if (l.icpFit) p += 1000;
    p += Math.min(l.adsMatched || 0, 100);
    return p;
  };
  const candidates = (ud.leads || [])
    .filter((l) => !l.lastAction || ["follow-up"].includes(l.lastAction)) // not already dispositioned
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, limit);

  for (const lead of candidates) {
    stats.leadsConsidered++;
    // Skip if lead already has a direct DK mobile/direct dial
    const phones = (lead.contacts || []).flatMap((c) => c.phones || []);
    const hasDirect = phones.some((p) => {
      const t = String(p.type || "").toLowerCase();
      return (t === "mobile" || t === "direct" || t === "work_direct") && filterDkPhones([p]).length > 0;
    });
    if (hasDirect) { stats.skippedHasDirect++; continue; }
    // Find LinkedIn URL on any contact
    const contactWithLi = (lead.contacts || []).find((c) => c.linkedin || c.linkedinUrl);
    const liUrl = contactWithLi?.linkedin || contactWithLi?.linkedinUrl;
    if (!liUrl) { stats.skippedNoLinkedIn++; continue; }
    // Skip if Lusha already tried recently
    if (contactWithLi.lastLushaAttemptAt && (now - new Date(contactWithLi.lastLushaAttemptAt).getTime()) < RECENT_LUSHA_MS) {
      stats.skippedRecentlyTried++;
      continue;
    }
    stats.lushaAttempted++;
    try {
      // Lusha v2 /person needs firstName + lastName + company. Pass the
      // contact's name (split if it's a single field) + the lead's
      // company name as the lookup keys.
      const lusha = await lushaLookupPerson({
        firstName: contactWithLi.firstName || (contactWithLi.name || "").split(/\s+/)[0],
        lastName:  contactWithLi.lastName  || (contactWithLi.name || "").split(/\s+/).slice(1).join(" "),
        fullName:  contactWithLi.name,
        email:     contactWithLi.email,
        companyName: lead.name,
        companyDomain: (lead.web || lead.website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
      });
      // Always stamp the attempt timestamp so we don't retry too soon
      contactWithLi.lastLushaAttemptAt = new Date().toISOString();
      if (!lusha) continue;
      stats.lushaMatched++;
      const dkPhones = filterDkPhones(lusha.phones || []);
      if (dkPhones.length === 0) continue;
      // Add the direct dial to the contact's phones[] (in front, so it
      // ranks highest in the cockpit display).
      contactWithLi.phones = contactWithLi.phones || [];
      const existingNumbers = new Set(contactWithLi.phones.map((p) => p.number));
      for (const ph of dkPhones) {
        if (existingNumbers.has(ph.number)) continue;
        contactWithLi.phones.unshift(ph);
        existingNumbers.add(ph.number);
      }
      // If this is the lead's best phone, also promote to lead.phone
      if (!lead.phone || lead.phone === lead.ph) {
        lead.phone = dkPhones[0].number;
        lead.phone_missing = false;
      }
      stats.phonesRevealed++;
      logActivity(
        "phone-revealed",
        `📱 Lusha: ${lusha.name || contactWithLi.name || lead.name} → ${dkPhones[0].number}`,
        { cvr: lead.cvr, source: "lusha-morning-reveal", userId: TARGET_USER },
      );
    } catch (e) {
      if (e.code === "LUSHA_CAP_REACHED") {
        stats.capReached = true;
        break;
      }
      stats.errors++;
      console.warn("[lusha-morning-reveal]", lead.cvr, e.message);
    }
    // Respect rate limits — small breather between calls
    await new Promise((r) => setTimeout(r, 250));
  }

  saveUserData(TARGET_USER, ud);
  console.log("[lusha-morning-reveal] done:", JSON.stringify(stats));
  res.json({ ok: true, stats, spend: getLushaSpendToday() });
});

// POST /api/contact/reveal-direct-dial/:cvr — unified Lusha-first
// reveal for the cockpit "Find beslutningstager" button. Tries Lusha
// using the lead's LinkedIn URL, falls back to Apollo if Lusha doesn't
// find a DK direct dial.
app.post("/api/contact/reveal-direct-dial/:cvr", authMiddleware, async (req, res) => {
  const cvr = req.params.cvr;
  const ud = loadUserData(req.userId);
  const lead = (ud.leads || []).find((l) => l.cvr === cvr);
  if (!lead) return res.status(404).json({ error: "Lead ikke fundet" });

  const contactWithLi = (lead.contacts || []).find((c) => c.linkedin || c.linkedinUrl);
  const liUrl = contactWithLi?.linkedin || contactWithLi?.linkedinUrl;

  // Try Lusha first if we have enough info + Lusha is configured.
  // Lusha v2 /person needs name + company. LinkedIn URL alone won't work.
  if (isLushaConfigured() && contactWithLi && (contactWithLi.name || contactWithLi.email)) {
    try {
      const lusha = await lushaLookupPerson({
        firstName: contactWithLi.firstName || (contactWithLi.name || "").split(/\s+/)[0],
        lastName:  contactWithLi.lastName  || (contactWithLi.name || "").split(/\s+/).slice(1).join(" "),
        fullName:  contactWithLi.name,
        email:     contactWithLi.email,
        companyName: lead.name,
        companyDomain: (lead.web || lead.website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
      });
      const dkPhones = lusha ? filterDkPhones(lusha.phones || []) : [];
      if (dkPhones.length > 0) {
        // Stamp on the contact + lead
        contactWithLi.phones = contactWithLi.phones || [];
        const existing = new Set(contactWithLi.phones.map((p) => p.number));
        for (const ph of dkPhones) {
          if (!existing.has(ph.number)) {
            contactWithLi.phones.unshift(ph);
            existing.add(ph.number);
          }
        }
        contactWithLi.lastLushaAttemptAt = new Date().toISOString();
        if (!lead.phone || lead.phone === lead.ph) {
          lead.phone = dkPhones[0].number;
          lead.phone_missing = false;
        }
        saveUserData(req.userId, ud);
        // Shape matches what cockpit's enrichLeadWithKaspr expects:
        // d.contacts is an array of contact objects.
        const contactsForUI = [{
          name: lusha.name,
          title: lusha.title || lusha.headline || "",
          phone: dkPhones[0]?.number || "",
          phones: dkPhones,
          email: lusha.email || "",
          linkedin: lusha.linkedinUrl || liUrl,
          source: "lusha",
        }];
        return res.json({
          ok: true,
          source: "lusha",
          contacts: contactsForUI,
          phones: dkPhones,
          contact: lusha,
          spendAfter: getLushaSpendToday(),
        });
      }
    } catch (e) {
      if (e.code === "LUSHA_CAP_REACHED") {
        // Surface the cap message but still try Apollo fallback below
        console.warn("[contact/reveal-direct-dial] Lusha cap reached, falling through to Apollo");
      } else {
        console.warn("[contact/reveal-direct-dial] Lusha err:", e.message);
      }
    }
  }

  // Fall back to existing Apollo enrich path
  if (!isApolloConfigured()) {
    return res.status(503).json({ error: "Hverken Lusha eller Apollo gav et nummer." });
  }
  try {
    const { contacts: apolloContacts, company } = await enrichWithApollo({
      name: lead.name,
      domain: lead.web || lead.website,
    });
    lead.contacts = apolloContacts;
    lead.apollo_company = company || lead.apollo_company;
    lead.apollo_enriched_at = new Date().toISOString();
    const directDial = (apolloContacts.find((c) => c.phone) || {}).phone || "";
    if (directDial) {
      lead.phone = directDial;
      lead.phone_missing = false;
    }
    saveUserData(req.userId, ud);
    return res.json({
      ok: true,
      source: "apollo",
      contacts: apolloContacts,
      company,
      phone: directDial || null,
    });
  } catch (e) {
    if (e && e.code === "APOLLO_CAP_REACHED") {
      return res.status(429).json({ error: "Apollo dagsbudget brugt op", code: "APOLLO_CAP_REACHED", spent: e.spent, cap: e.cap });
    }
    return res.status(502).json({ error: e.message });
  }
});

app.post("/api/apollo/lookup-linkedin", authMiddleware, async (req, res) => {
  if (!isApolloConfigured()) {
    return res.status(503).json({ error: "Apollo ikke konfigureret", configured: false });
  }
  const url = String(req.body?.url || req.body?.linkedin_url || "").trim();
  if (!url) return res.status(400).json({ error: "linkedin_url påkrævet" });
  // Validate that it's a LinkedIn URL — Apollo will reject anything else,
  // and we'd rather error early than burn a credit on a malformed lookup.
  if (!/^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(url)) {
    return res.status(400).json({ error: "Indtast et LinkedIn /in/ profil-URL (f.eks. https://www.linkedin.com/in/john-doe-12345)" });
  }
  // 30-day cache check — same URL within window = free, no Apollo bill
  const cacheKey = _normaliseLinkedinUrl(url);
  const force = String(req.query.force || "") === "1";
  if (!force) {
    const cache = _loadLinkedinLookupCache();
    const hit = cache[cacheKey];
    if (hit && hit.cachedAt && (Date.now() - new Date(hit.cachedAt).getTime()) < LINKEDIN_LOOKUP_CACHE_TTL_MS) {
      return res.json({ ...hit.result, cached: true, cachedAt: hit.cachedAt });
    }
  }
  // Daily cap pre-flight — same as everywhere else
  const spendNow = getApolloSpendToday();
  if (spendNow.spent >= APOLLO_DAILY_CAP) {
    return res.status(429).json({
      error: `Apollo dagsbudget brugt op (${spendNow.spent}/${spendNow.cap}). Prøv igen i morgen.`,
      code: "APOLLO_CAP_REACHED",
      spent: spendNow.spent,
      cap: spendNow.cap,
    });
  }
  try {
    // Apollo's /people/match by linkedin_url — accepts the bare URL or
    // a normalised slug. We pass the URL verbatim.
    const r = await fetch(`${APOLLO_API_BASE}/people/match`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.APOLLO_API_KEY,
      },
      body: JSON.stringify({
        linkedin_url: url,
        reveal_personal_emails: true,
        // Phone reveal disabled — requires webhook_url (Apollo async).
        // We surface whatever phones are in the cached phone_numbers[]
        // array, which covers most B2B contacts.
        // reveal_phone_number: true,  // TODO: wire async webhook
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(502).json({ error: `Apollo ${r.status}: ${txt.slice(0, 200)}` });
    }
    const d = await r.json();
    const person = d.person || null;
    if (!person) return res.json({ ok: true, found: false, message: "Apollo har ikke denne person i deres database" });
    // Apollo billed us — increment the daily counter
    incrementApolloSpend(1);
    const contact = mapApolloPersonToContact(person);
    const company = person.organization ? mapApolloOrganization(person.organization) : null;

    // Fallback: if Apollo returned no phone (the field the SDR actually
    // cares about), scrape the LinkedIn public profile via Apify. Apify
    // sometimes finds phones publicly listed on profiles. Apollo's DK
    // SMB phone coverage is sparse, so this fallback fires often.
    // Cost: ~$0.01 per scrape.
    const dataSources = ["apollo"];
    let scrapedCompany = null;
    const hasNoPhone = (contact.phones || []).length === 0;
    if (hasNoPhone) {
      try {
        const scrape = await apifyLinkedinScrape(url);
        if (scrape) {
          // Merge — Apify fills any blank fields
          if ((!contact.name || contact.name === "—") && scrape.name) contact.name = scrape.name;
          if (!contact.title && scrape.title) contact.title = scrape.title;
          if (!contact.headline && scrape.headline) contact.headline = scrape.headline;
          if (!contact.photoUrl && scrape.photoUrl) contact.photoUrl = scrape.photoUrl;
          if (!contact.location && scrape.location) contact.location = scrape.location;
          // Phone — the prize. If LinkedIn profile has one listed, surface it.
          if (scrape.phone && !contact.phones.find((p) => p.number === scrape.phone)) {
            contact.phones.push({ number: scrape.phone, type: "mobile", typeLabel: "Mobil (LinkedIn)", status: "scraped", position: 99 });
            if (!contact.phone) { contact.phone = scrape.phone; contact.phoneType = "mobile"; contact.phoneTypeLabel = "Mobil (LinkedIn)"; }
          }
          if (!company && scrape.currentCompany) {
            scrapedCompany = { name: scrape.currentCompany, source: "linkedin-scrape" };
          }
          dataSources.push("apify-linkedin");
        }
      } catch (e) {
        console.warn("[apollo/lookup-linkedin] apify fallback failed:", e.message);
      }
    }

    const result = {
      ok: true,
      found: true,
      contact,
      company: company || scrapedCompany || null,
      phones: contact?.phones || [],
      directDial: contact?.phones?.find((p) => p.type === "mobile" || p.type === "direct" || p.type === "work_direct")?.number || null,
      sources: dataSources,
      stillNoPhone: (contact.phones || []).length === 0,
      spendAfter: getApolloSpendToday(),
    };
    // Persist to the 30-day cache so re-lookups don't double-bill
    try {
      const cache = _loadLinkedinLookupCache();
      cache[cacheKey] = { result, cachedAt: new Date().toISOString() };
      _saveLinkedinLookupCache(cache);
    } catch {}
    res.json(result);
  } catch (e) {
    console.error("[apollo/lookup-linkedin]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apify LinkedIn Profile Scraper helper — invoked as a fallback when
// Apollo returns a stub for /people/match. Returns the contact's basic
// public-profile data: name, headline, current company, photo, location.
// Cost: ~$0.005-0.02 per scrape, paid via the Apify subscription
// (already provisioned for the gsearch + fb-ads scrapers).
//
// Actor is configurable via env var so we can swap if dev_fusion's
// scraper goes down — LinkedIn aggressively blocks scrapers and actors
// rotate every few months. Fallback default is a well-maintained
// community actor as of June 2026.
const LINKEDIN_SCRAPER_ACTOR = process.env.APIFY_LINKEDIN_ACTOR || "dev_fusion~linkedin-profile-scraper";
async function apifyLinkedinScrape(profileUrl) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return null;
  try {
    // Start the actor run. Most LinkedIn-scraper actors accept this
    // basic input shape; some want { profileUrls: [...] }. We pass
    // both to maximise compatibility across actor variants.
    const input = {
      profileUrls: [profileUrl],
      urls: [profileUrl],
      proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    };
    const startResp = await fetch(
      `https://api.apify.com/v2/acts/${LINKEDIN_SCRAPER_ACTOR}/runs?token=${token}&memory=512&timeout=120`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    );
    if (!startResp.ok) {
      console.warn("[apify-linkedin] start", startResp.status);
      return null;
    }
    const { data: run } = await startResp.json();
    // Poll up to 90s for completion
    const t0 = Date.now();
    let status = run.status;
    let runData = run;
    while (status === "READY" || status === "RUNNING") {
      if (Date.now() - t0 > 90000) {
        console.warn("[apify-linkedin] timeout");
        return null;
      }
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
      if (!poll.ok) continue;
      runData = (await poll.json()).data;
      status = runData.status;
    }
    if (status !== "SUCCEEDED") {
      console.warn("[apify-linkedin] run ended", status);
      return null;
    }
    const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${token}&format=json`);
    if (!itemsResp.ok) return null;
    const items = await itemsResp.json();
    const profile = items?.[0] || null;
    if (!profile) return null;
    // Normalise — different actor variants use different field names.
    // We try the common ones (dev_fusion + voyager + curious_coder).
    return {
      name: profile.fullName || profile.name || `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || "",
      title: profile.headline || profile.position?.title || profile.currentJobTitle || profile.title || "",
      headline: profile.headline || profile.about || profile.summary || "",
      currentCompany: profile.company || profile.currentCompany || profile.position?.companyName || profile.experience?.[0]?.company || "",
      photoUrl: profile.profilePicture || profile.photoUrl || profile.profilePicHighQuality || profile.profile_picture_url || "",
      location: profile.location || profile.addressWithCountry || profile.country || "",
      phone: profile.phone || profile.phoneNumber || profile.contactInfo?.phone || "",
      raw: profile,
    };
  } catch (e) {
    console.warn("[apify-linkedin] error:", e.message);
    return null;
  }
}

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
  // Pool-level cache (cron writes here too) — also free, no credit cost
  const pool = loadDiscoveryState().companies || {};
  const poolEntry = pool[cvr];
  if (poolEntry?.apollo_enriched_at && (Date.now() - new Date(poolEntry.apollo_enriched_at).getTime()) < FRESH_MS && !req.query.force) {
    lead.contacts = poolEntry.contacts || [];
    lead.apollo_company = poolEntry.apollo_company || null;
    lead.apollo_enriched_at = poolEntry.apollo_enriched_at;
    const directDial = (lead.contacts.find((c) => c.phone) || {}).phone;
    if (directDial) lead.phone = directDial;
    else if (!lead.phone && lead.apollo_company?.phone) lead.phone = lead.apollo_company.phone;
    lead.phone_missing = !lead.phone;
    saveUserData(req.userId, ud);
    return res.json({ ok: true, cached: "pool", contacts: lead.contacts, company: lead.apollo_company });
  }
  try {
    const { contacts, company } = await enrichWithApollo({
      name: lead.name,
      domain: lead.web || lead.website,
    });
    lead.contacts = contacts;
    lead.apollo_company = company || null;
    lead.apollo_enriched_at = new Date().toISOString();
    lead.meta_advertiser = !!(company && company.metaAdvertiser);
    lead.ad_signals = (company && company.metaAdSignals) || [];
    const directDial = (contacts.find((c) => c.phone) || {}).phone;
    if (directDial) lead.phone = directDial;
    else if (!lead.phone && company?.phone) lead.phone = company.phone;
    lead.phone_missing = !lead.phone;
    saveUserData(req.userId, ud);
    // Write-through to state.json so the pool cache benefits
    if (poolEntry) {
      poolEntry.contacts = contacts;
      poolEntry.apollo_company = company || null;
      poolEntry.apollo_enriched_at = lead.apollo_enriched_at;
      try {
        const state = loadDiscoveryState();
        state.companies[cvr] = poolEntry;
        fs.writeFileSync(DISCOVERY_STATE_FILE, JSON.stringify(state, null, 2));
      } catch (e) { console.warn("[apollo] state.json write-through failed:", e.message); }
    }
    res.json({ ok: true, cached: false, contacts, company });
  } catch (e) {
    if (e && e.code === "APOLLO_CAP_REACHED") {
      console.warn("[apollo/enrich] cap reached:", e.message);
      return res.status(429).json({
        error: `Apollo dagsbudget brugt op (${e.spent}/${e.cap} credits i dag). Prøv igen i morgen.`,
        code: "APOLLO_CAP_REACHED",
        spent: e.spent,
        cap: e.cap,
      });
    }
    console.error("[apollo/enrich]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/apollo/credit-status — admin/cockpit visibility into today's
// Apollo credit burn. Returns spent/cap/remaining + 7-day history.
// Used by Dashboard widget + cockpit reveal-button to predict whether
// the next click will succeed.
app.get("/api/apollo/credit-status", authMiddleware, (req, res) => {
  const s = getApolloSpendToday();
  // Trim history to last 14 days for the dashboard sparkline
  const hist = s.history || {};
  const days = Object.keys(hist).sort().slice(-14);
  const recentHistory = Object.fromEntries(days.map((d) => [d, hist[d]]));
  res.json({
    ok: true,
    date: s.date,
    spent: s.spent,
    cap: s.cap,
    remaining: s.remaining,
    history: recentHistory,
  });
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
      const { contacts, company } = await enrichWithApollo({
        name: c.name,
        domain: c.website || c.web,
      });
      c.contacts = contacts;
      c.apollo_company = company || null;
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

// POST /api/cron/drain-enrichment — drains apollo_enrichment_pending leads
// in EVERY user's queue, AWAITED within the request.
//
// Why this exists: autodialer-maintain fires enrichUserLeadsViaApolloAsync
// as fire-and-forget. On Cloud Run with min-instances=0, CPU is throttled
// to ~zero once the HTTP response returns, so a large fire-and-forget batch
// (e.g. 61 leads) freezes mid-flight — leads stay pending forever. This
// cron does the enrichment INSIDE the request lifecycle, so CPU stays
// allocated and the work actually completes. Capped per run to stay under
// the Cloud Run request timeout; schedule it every few minutes to drain
// the backlog steadily.
app.post("/api/cron/drain-enrichment", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isApolloConfigured()) {
    return res.status(503).json({ error: "Apollo not configured" });
  }
  // Daily-cap pre-flight. If we've already burned the 100/day budget,
  // bail before even loading the queue. Schedulers still fire — we
  // just return a no-op result. Counter resets at CPH midnight.
  const spendNow = getApolloSpendToday();
  if (spendNow.spent >= APOLLO_DAILY_CAP) {
    return res.json({ ok: true, skipped: "daily-cap-reached", spend: spendNow });
  }
  // Cap total leads processed this run. Each lead ≈ Apollo (1-2s) +
  // Datafordeler phone fallback (~2s); at concurrency 5, 30 leads ≈ 25-35s,
  // comfortably under the 300s request timeout.
  const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 30));
  const stats = { usersProcessed: 0, enriched: 0, perUser: {}, capReachedMidRun: false };
  if (!fs.existsSync(DATA_DIR)) return res.json({ ok: true, stats, note: "no DATA_DIR" });

  let budget = limit;
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (budget <= 0) break;
    if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
    const userId = f.slice("data_".length, -".json".length);
    if (!userId) continue;
    try {
      const ud = loadUserData(userId);
      const pendingCvrs = (ud.leads || [])
        .filter((l) => l.apollo_enrichment_pending === true && l.cvr)
        .slice(0, budget)
        .map((l) => l.cvr);
      if (pendingCvrs.length === 0) continue;
      // AWAITED — runs within the request so Cloud Run keeps CPU on.
      await enrichUserLeadsViaApolloAsync(userId, pendingCvrs);
      stats.enriched += pendingCvrs.length;
      stats.perUser[userId] = pendingCvrs.length;
      stats.usersProcessed++;
      budget -= pendingCvrs.length;
    } catch (e) {
      console.warn("[drain-enrichment]", userId, e.message);
    }
    // Re-check the cap after each user — if a previous user's batch
    // flipped the cap, stop processing further users this run.
    const sp = loadApolloSpend();
    if (sp.spent >= APOLLO_DAILY_CAP) {
      stats.capReachedMidRun = true;
      break;
    }
  }
  // Attach final spend snapshot so the cron caller (and any operator
  // tail'ing logs) can see how much budget is left.
  stats.spend = getApolloSpendToday();
  console.log("[drain-enrichment] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// POST /api/cron/check-advertisers — CHEAP ICP/ads check for leads flagged
// ads_check_pending (CSV people-leads with a business email domain). Uses
// Apollo organization-enrich (company/tech data only — NO contact reveal,
// so NO credits spent) to detect the Meta-advertiser signal. The leads are
// already callable (name+phone from the CSV); this just adds the 🎯 badge.
// Awaited within the request so Cloud Run keeps CPU allocated.
app.post("/api/cron/check-advertisers", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isApolloConfigured()) return res.status(503).json({ error: "Apollo not configured" });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 40));
  const stats = { checked: 0, advertisers: 0, found: 0, perUser: {} };
  if (!fs.existsSync(DATA_DIR)) return res.json({ ok: true, stats, note: "no DATA_DIR" });
  let budget = limit;
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (budget <= 0) break;
    if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
    const userId = f.slice("data_".length, -".json".length);
    if (!userId) continue;
    let changed = false;
    try {
      const ud = loadUserData(userId);
      for (const lead of ud.leads || []) {
        if (budget <= 0) break;
        if (lead.ads_check_pending !== true) continue;
        budget--;
        const domain = lead.web || businessDomainFromEmail(lead.em);
        try {
          const org = domain ? await apolloOrgEnrich(domain) : null;
          lead.ads_check_pending = false;
          lead.ads_checked_at = new Date().toISOString();
          if (org) {
            stats.found++;
            if (!lead.apollo_company) lead.apollo_company = org; // light company data, no contacts
            lead.meta_advertiser = !!org.metaAdvertiser;
            lead.ad_signals = org.metaAdSignals || [];
            if (org.metaAdvertiser) {
              stats.advertisers++;
              logActivity("advertiser", `🎯 Annoncør: ${lead.name} (${(org.metaAdSignals || []).join(", ")})`, { cvr: lead.cvr, userId });
            }
          }
          stats.checked++;
          stats.perUser[userId] = (stats.perUser[userId] || 0) + 1;
          changed = true;
          await new Promise((r) => setTimeout(r, 250)); // gentle on Apollo
        } catch (e) {
          lead.ads_check_pending = false;
          lead.ads_checked_at = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) saveUserData(userId, ud);
    } catch (e) {
      console.warn("[check-advertisers]", userId, e.message);
    }
  }
  logActivity("ads-check", `ICP/ads-tjek: ${stats.checked} tjekket · ${stats.advertisers} annoncører fundet (gratis — ingen Apollo-credits)`, null);
  console.log("[check-advertisers] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// ─── APOLLO DISCOVERY ─────────────────────────────────────────────────
// Parallel lead-discovery source to Apify (the Meta-ads scraper). Where
// Apify finds advertisers by scanning Meta's Ad Library bottom-up (CVR
// pool → who advertises), this path goes top-down via Apollo's company
// database (DK SMB → does Apollo's tech-signal flag them as a Meta
// advertiser?).
//
// Cost model:
//   1. Apollo mixed_companies/search — FREE (returns 25 companies/page,
//      includes domain + employees + industry)
//   2. Apollo organizations/enrich on each domain — FREE (returns
//      metaAdvertiser signal from technologies array)
//   3. Per Apollo-positive lead: people/match (1 credit each, ~5 people)
//      runs ASYNC via the existing drain-enrichment cron — not charged
//      until the lead actually gets enriched
//
// Volume target: ~100-150 candidates scanned per run × ~15-25% Meta
// advertiser hitrate = 15-30 fresh ICP leads/day pushed into the pipeline.
// Combined with Apify's ~5/day, gets us toward the 30/day target.
//
// Deduplication: a state file tracks already-scanned Apollo org_ids so
// we don't pay for the same domain twice. Cron rotates through Apollo's
// result pages by maintaining a pageOffset cursor.

const APOLLO_DISCOVER_STATE_FILE = path.join(DATA_DIR, "discovery", "apollo_discover.json");

// ICP industry keywords — chosen for likelihood of Meta-advertising activity
// among DK SMBs. Apollo's keyword tags are looser than DB07 codes; these
// catch the bulk of e-commerce, services, and SMB consumer brands.
const APOLLO_DISCOVER_KEYWORDS = [
  "e-commerce", "retail", "consumer goods", "apparel", "fashion",
  "beauty", "health and wellness", "fitness", "food and beverage",
  "marketing", "advertising", "design", "interior design",
  "consulting", "saas", "education", "hospitality", "tourism",
];

// Vedio's ICP (tightened 2026-06-02 to premium SMB / founder-led segment):
//   * 1-15 employees: owner-led companies where the founder/CEO takes
//     the call, no procurement layer, single-decision-maker outbound.
//   * 1.5-25M DKK revenue (≈ $215k-3.6M USD): cash-positive enough to
//     afford 10-50k DKK/video, not so big they have an in-house team.
// Loose-end behaviour mirrors employee handling: companies with NO
// revenue data in Apollo are KEPT (not filtered) — most small DK brands
// aren't in Apollo's revenue index. Filter only rejects KNOWN-and-out-of-range.
//
// 2026-06-08 — widened from 1-15 emp / 2-15M DKK → 1-25 emp / 1.5-25M DKK.
// The 1-15 cap excluded most DK DTC brands (lean teams of 15-25 are very
// common), capping daily yield at 15-25 fresh. New range targets 50-60/day
// with same DTC profile (still well below "enterprise" tier).
const APOLLO_DISCOVER_EMPLOYEE_RANGES = ["1,5", "6,10", "11,15", "16,25"];
const APOLLO_DISCOVER_MIN_EMPLOYEES = 1;
const APOLLO_DISCOVER_MAX_EMPLOYEES = 25;
// Apollo returns annualRevenue in USD typically. Convert from DKK at
// ~7.0 DKK/USD: 1.5M DKK → $215k, 25M DKK → $3.6M.
const APOLLO_DISCOVER_MIN_REVENUE_USD = 215000;
const APOLLO_DISCOVER_MAX_REVENUE_USD = 3600000;

// Returns true if a lead PASSES the ICP gate (DK + emp range + revenue range).
// All three checks treat null/unknown as "no info — include". Strict reject
// only when we KNOW a value is out of range.
function passesIcpGate(orgEnrich, fallbackEmp) {
  if (!orgEnrich) return false;
  // Country: Apollo populates this for most orgs; null means unknown — include
  if (orgEnrich.country && orgEnrich.country !== "Denmark") return false;
  // Employees
  const emp = orgEnrich.estimatedEmployees || fallbackEmp;
  if (emp != null && (emp < APOLLO_DISCOVER_MIN_EMPLOYEES || emp > APOLLO_DISCOVER_MAX_EMPLOYEES)) return false;
  // Revenue: Apollo's annualRevenue in USD. Null = unknown → include.
  const rev = orgEnrich.annualRevenue;
  if (rev != null && rev > 0) {
    if (rev < APOLLO_DISCOVER_MIN_REVENUE_USD) return false;
    if (rev > APOLLO_DISCOVER_MAX_REVENUE_USD) return false;
  }
  return true;
}

function loadApolloDiscoverState() {
  try {
    if (fs.existsSync(APOLLO_DISCOVER_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(APOLLO_DISCOVER_STATE_FILE, "utf8"));
    }
  } catch (e) { console.warn("[apollo-discover] state load:", e.message); }
  return { scannedDomains: {}, scannedOrgIds: {}, pageCursor: 1, keywordCursor: 0, lastRunAt: null };
}

function saveApolloDiscoverState(s) {
  fs.mkdirSync(path.dirname(APOLLO_DISCOVER_STATE_FILE), { recursive: true });
  fs.writeFileSync(APOLLO_DISCOVER_STATE_FILE, JSON.stringify(s, null, 2));
}

// Single page of Apollo's company search. Returns orgs[] with name+domain+
// employees+industry. Free — no credits charged. ~25 results per page.
async function apolloSearchAdvertiserCandidates({ page, perPage = 25, employeeRanges, keywords }) {
  const body = {
    page: Math.max(1, page || 1),
    per_page: Math.min(100, perPage),
    organization_locations: ["Denmark"],
    organization_num_employees_ranges: employeeRanges,
  };
  // Mix in keyword filter when provided. Apollo's keyword search is OR
  // across the list — pass one keyword per call to keep result quality up.
  if (keywords && keywords.length) {
    body.q_organization_keyword_tags = keywords;
  }
  const r = await fetch(`${APOLLO_API_BASE}/mixed_companies/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": process.env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Apollo discover-search ${r.status}: ${text.slice(0, 200)}`);
  }
  const d = await r.json();
  const orgs = d.organizations || d.accounts || [];
  return orgs.map((o) => ({
    id: o.id || o.organization_id || null,
    name: o.name || "",
    domain: String(o.website_url || o.primary_domain || "")
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim(),
    employees: o.estimated_num_employees || o.employees || null,
    industry: o.industry || (o.industries && o.industries[0]) || "",
    phone: o.primary_phone?.sanitized_number || o.phone || "",
    linkedin: o.linkedin_url || "",
    city: o.city || o.primary_city || "",
  }));
}

// Push an Apollo-discovered advertiser into u1's leads pipeline. Same shape
// as the META-scraper path so the autodialer/cockpit/drain-enrichment all
// treat it uniformly. Uses synthetic id "apollo-<orgId>" as the cvr (real
// DK CVRs are 8 digits — no collision).
// ── Meta Ad Library live verification helpers (Apify-powered) ─────────
// Strip a company name down to the brand string Meta would actually search
// against. Real-world cases this has to handle, from observed lead data:
//   "Organic Boost A/S"                  → "Organic Boost"  (drop legal suffix)
//   "Stine Goya A/S"                     → "Stine Goya"
//   "GRAFIKR A/S | Shopify Platinum Partner" → "GRAFIKR" (first pipe-segment, then strip A/S)
//   "Butter 🧈 (Acquired by Miro)"       → "Butter"  (parenthetical + emoji)
//   "pej gruppen - scandinavian trend"   → "pej gruppen"  (first dash-segment)
//   "Endomondo | Under Armour …"         → "Endomondo"
//   "Ferm Living ApS"                    → "Ferm Living"
//   "Mobility Denmark"                   → "Mobility Denmark"  (KEEP — Denmark is part of brand)
//   "Granturismo Cars A/S"               → "Granturismo Cars"
// Key design choice: strip legal suffixes only at the END, never mid-name.
// Avoids the bug where "Mobility Denmark" became just "Mobility" — which
// then matched thousands of unrelated ads.
function brandForMetaAdsSearch(name) {
  let s = String(name || "").trim();
  if (!s) return "";
  // 1. Take only the first pipe-separator segment ("Brand | descriptor" → "Brand")
  s = s.split(/\s*\|\s*/)[0].trim();
  // 2. Same for em-dash / en-dash / hyphen with spaces ("Brand - tagline")
  //    Only split when there's whitespace around the dash — hyphenated brand
  //    names like "Coca-Cola" should stay intact.
  s = s.split(/\s+[-–—]\s+/)[0].trim();
  // 3. Drop parentheticals — descriptors, not brand ("Butter (Acquired by …)" → "Butter")
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // 4. Strip legal suffix(es) at the END only (multiple passes for stacked
  //    suffixes like "Foo A/S Holding").
  let prev = "";
  while (prev !== s) {
    prev = s;
    // Only strip FORMAL legal-entity suffixes. Do NOT strip GRUPPEN /
    // HOLDING — those words are often part of the actual brand name
    // ("Aller Gruppen", "Lego Holding"). Risk of false-negatives by
    // keeping them outweighs the noise of including them in search.
    s = s.replace(/[\s,.]+(A\/S|ApS|IVS|I\/S|K\/S|P\/S|S\/A|GmbH|Ltd\.?|Inc\.?|Corp\.?|LLC|S\.?A\.?|N\.?V\.?)\s*$/i, "").trim();
  }
  // 5. Strip emojis that confuse exact-phrase matching
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}]/gu, " ")
       .replace(/\s+/g, " ")
       .trim();
  // 6. Trailing punctuation
  s = s.replace(/[,;:.]+$/, "").trim();
  return s;
}

// Legacy alias — the old name was inaccurate (the function works for any
// lead source, not just Apollo). Keep both bindings so older call sites
// still work if any.
const brandFromApolloName = brandForMetaAdsSearch;

// Derive an Instagram profile URL from a Facebook page URL. Meta links
// the two for business accounts and most use the same handle; if we
// hit the rare exception, the link 404s gracefully. Returns "" when no
// Facebook URL is available.
function instagramFromFacebook(fbUrl) {
  if (!fbUrl) return "";
  const m = String(fbUrl).match(/facebook\.com\/(?:pages\/[^/]+\/)?([^/?#]+)/i);
  if (!m || !m[1]) return "";
  const handle = m[1].replace(/^@/, "");
  // Skip numeric-only IDs (those are Facebook page IDs, not handles)
  if (/^\d+$/.test(handle)) return "";
  return `https://www.instagram.com/${handle}/`;
}

// "Recent" = currently active OR ended within the last 90 days. The
// softer hook ("we noticed you've been advertising recently" vs the
// harder "we see you're advertising right now") converts well, and
// pauses are common — a company that paused last week still has all
// the creative infrastructure + decision-makers + budget intent.
const META_RECENT_WINDOW_DAYS = 90;

function buildAdsLibraryUrl(brand) {
  const params = new URLSearchParams({
    // active_status: "all" — includes both currently-running AND recently-
    // paused. We post-filter by ad endDate to keep only the last 90 days
    // (Meta's Ad Library otherwise shows ads going back ~12 months).
    active_status: "all",
    ad_type: "all",
    country: "DK",
    is_targeted_country: "false",
    media_type: "all",
    search_type: "keyword_exact_phrase",
    q: brand,
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

// Reusable Meta Ad Library verify for any list of candidates with a
// `name` field. Returns the candidates ENRICHED with ad-activity counts,
// dropping ones that have no name-matched ads with recent90d>0 activity.
// Used by branche-walk (PR5), gmaps-discover, and linkedin-ads-discover
// so EVERY new lead in the autodialer has verified Meta-ad proof from
// the last 90 days. Cost: ~$0.025 per candidate verified.
//
// candidates: array of { name, ...extra } objects. Must have `name`.
// keyField: which field to use as the dedup/match key (default 'cvr').
// Returns: { verified: [...candidates with meta_ads_* fields], stats: {...} }
async function verifyCandidatesAgainstMeta(candidates, keyField) {
  keyField = keyField || "cvr";
  const stats = { attempted: 0, verified: 0, noAds: 0, nameMismatch: 0 };
  if (!candidates || candidates.length === 0) return { verified: [], stats };
  if (!process.env.APIFY_API_TOKEN) {
    // No token → can't verify. Conservative: drop all (caller decides
    // whether to fall back). Casper's strict Meta-verify rule means
    // we'd rather skip than save unverified.
    stats.apifyDisabled = true;
    return { verified: [], stats };
  }
  const startUrls = candidates
    .filter((c) => c && c.name && c.name.trim().length >= 3)
    .map((c) => ({
      url: buildAdsLibraryUrl(brandForMetaAdsSearch(c.name)),
      _key: c[keyField] || c.name,
      _cand: c,
    }));
  stats.attempted = startUrls.length;
  if (startUrls.length === 0) return { verified: [], stats };
  let items = null;
  try {
    const token = process.env.APIFY_API_TOKEN;
    const input = {
      startUrls: startUrls.map((s) => ({ url: s.url })),
      onlyTotal: false,
      resultsLimit: 5,
    };
    const startResp = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-ads-scraper/runs?token=${token}&memory=2048&timeout=3600`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    );
    if (!startResp.ok) throw new Error(`Apify start ${startResp.status}: ${(await startResp.text()).slice(0, 300)}`);
    const { data: run } = await startResp.json();
    const t0 = Date.now();
    let status = run.status;
    let runData = run;
    while (status === "READY" || status === "RUNNING") {
      if (Date.now() - t0 > 20 * 60 * 1000) throw new Error("Apify verify timeout");
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
      if (!poll.ok) continue;
      runData = (await poll.json()).data;
      status = runData.status;
    }
    if (status !== "SUCCEEDED") throw new Error(`Apify ended ${status}`);
    const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${token}&format=json`);
    if (!itemsResp.ok) throw new Error(`Apify items fetch ${itemsResp.status}`);
    items = await itemsResp.json();
  } catch (e) {
    stats.apifyError = e.message;
    console.warn("[verifyCandidatesAgainstMeta] Apify failed:", e.message);
    return { verified: [], stats };
  }
  const urlToMeta = new Map(startUrls.map((s) => [s.url, s]));
  const itemsByKey = new Map();
  for (const item of items) {
    const meta = urlToMeta.get(item.inputUrl);
    if (!meta) continue;
    if (!itemsByKey.has(meta._key)) itemsByKey.set(meta._key, []);
    itemsByKey.get(meta._key).push(item);
  }
  const checkedAt = new Date().toISOString();
  const verified = [];
  for (const s of startUrls) {
    const its = itemsByKey.get(s._key) || [];
    if (its.length === 0) { stats.noAds++; continue; }
    const matched = its.filter((it) => {
      const pn = it.pageName || it.snapshot?.pageName || "";
      return advertiserMatchesCompany(pn, s._cand.name);
    });
    if (matched.length === 0) { stats.nameMismatch++; continue; }
    const activity = classifyAdActivity(matched);
    if (activity.recent90d === 0) { stats.noAds++; continue; }
    verified.push({
      ...s._cand,
      meta_ads_active_now: activity.activeNow,
      meta_ads_recent90d: activity.recent90d,
      meta_ads_total: activity.total,
      meta_verified_at: checkedAt,
    });
  }
  stats.verified = verified.length;
  return { verified, stats };
}

// Returns counts for ads: { activeNow, recent90d, total } given the raw
// Apify response items. "recent90d" includes both currently-active ads
// AND ads whose endDateFormatted is within the last 90 days. Used by
// verify-leads + discovery to decide if a lead is "still relevant".
function classifyAdActivity(items) {
  const now = Date.now();
  const cutoffMs = now - META_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  let activeNow = 0, recent90d = 0;
  for (const it of items) {
    const isActive = !!it.isActive;
    if (isActive) { activeNow++; recent90d++; continue; }
    const endStr = it.endDateFormatted || it.endDate || it.availability?.end || "";
    if (!endStr) continue;
    const endMs = new Date(endStr).getTime();
    if (!isNaN(endMs) && endMs >= cutoffMs) recent90d++;
  }
  return { activeNow, recent90d, total: items.length };
}

// Batch-verify a list of advertiser candidates via Apify's facebook-ads-
// scraper. Uses onlyTotal:true so each URL returns 1 dataset item with
// totalCount (cheap — ~$0.005/result on BRONZE tier). Async-start + poll
// pattern so we don't hit the 5-min sync timeout for large batches.
async function apifyVerifyMetaAds(startUrls) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN not configured");
  if (!startUrls || startUrls.length === 0) return [];
  // resultsLimit:5 (not onlyTotal:true anymore) — we now need per-ad
  // date + isActive fields to apply the 90-day recent-activity window.
  // Cost: 5 ad-results/lead × $0.005 = $0.025/lead (was $0.005). Roughly
  // 5x more expensive but unlocks "recently paused" leads which roughly
  // doubles the addressable pool. Net pool-per-dollar is positive.
  const input = {
    startUrls: startUrls.map((s) => ({ url: s.url })),
    onlyTotal: false,
    resultsLimit: 5,
  };
  // Start async
  const startResp = await fetch(
    `https://api.apify.com/v2/acts/apify~facebook-ads-scraper/runs?token=${token}&memory=1024&timeout=1800`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!startResp.ok) {
    const body = await startResp.text();
    throw new Error(`Apify verify start ${startResp.status}: ${body.slice(0, 300)}`);
  }
  const { data: run } = await startResp.json();
  // Poll for completion — 200 URLs typically finishes in 60-180s.
  const t0 = Date.now();
  const MAX_WAIT_MS = 20 * 60 * 1000;
  let status = run.status;
  let runData = run;
  while (status === "READY" || status === "RUNNING") {
    if (Date.now() - t0 > MAX_WAIT_MS) {
      throw new Error(`Apify verify timeout after ${(MAX_WAIT_MS / 60000).toFixed(0)}min`);
    }
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
    if (!poll.ok) continue;
    runData = (await poll.json()).data;
    status = runData.status;
  }
  if (status !== "SUCCEEDED") {
    throw new Error(`Apify verify ended with status ${status}`);
  }
  // Fetch dataset items
  const itemsResp = await fetch(
    `https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${token}&format=json`,
  );
  if (!itemsResp.ok) throw new Error(`Apify verify dataset fetch ${itemsResp.status}`);
  return itemsResp.json();
}

function appendApolloLeadToUser(userId, org, orgEnrich, verifyResult) {
  // verifyResult: optional { active: boolean, totalCount: number, checkedAt: iso }
  // from a live Meta Ad Library check (Apify). When undefined the lead is
  // appended with meta_verified_active=null (the maybe-relevant verification
  // never ran or was skipped). The autodialer pre-flight gate excludes leads
  // with meta_verified_active===false from the dialable queue and routes
  // them to the "Måske relevant" filter bucket instead.
  const ud = loadUserData(userId);
  if (!ud.leads) ud.leads = [];
  const syntheticCvr = `apollo-${org.id}`;
  // Dedupe — skip if we already have this org under either id form
  if (ud.leads.some((l) => l.cvr === syntheticCvr)) return false;
  if (org.domain && ud.leads.some((l) => (l.web || "").toLowerCase() === org.domain.toLowerCase())) return false;
  // Every apollo-discover lead gets flagged for async decision-maker
  // enrichment (Apollo people/match — ~5 credits/lead for ~5 contacts
  // with email, title, LinkedIn). The drain-enrichment cron (every 5 min)
  // picks them up in batches of 30 and fills the contacts in the background.
  // Phone-having leads are STILL immediately dialable — the autodialer
  // pre-flight gate now allows apollo_enrichment_pending=true when a
  // phone is present, so Nicolas dials the switchboard while enrichment
  // completes in parallel. Phone-missing leads stay parked until drain
  // either finds a direct phone or gives up.
  const hasPhone = !!(org.phone || "").toString().trim();
  ud.leads.push({
    cvr: syntheticCvr,
    name: org.name,
    addr: "",
    zip: "",
    city: org.city,
    ph: org.phone || "",
    em: "",
    web: org.domain,
    ind: org.industry,
    ic: "",
    emp: typeof org.employees === "number" ? String(org.employees) : "",
    emps: org.employees || null,
    st: "aktiv",
    yr: "",
    form: "",
    eq: 0,
    res: 0,
    omsaetning: 0,
    // Discovery metadata
    source: "apollo-discover",
    icpFit: true,
    meta_advertiser: !!(orgEnrich && orgEnrich.metaAdvertiser),
    ad_signals: orgEnrich?.metaAdSignals || [],
    // Live Meta Ad Library verification result. true = confirmed running
    // active ads in DK right now; false = Apollo flagged the pixel but
    // Meta Ad Library shows zero current ads (autodialer skips these,
    // they live in the "Måske relevant" bucket); null = not yet verified.
    meta_verified_active: verifyResult ? verifyResult.active : null,
    meta_verified_at: verifyResult ? verifyResult.checkedAt : null,
    meta_live_ad_count: verifyResult ? verifyResult.totalCount : null,
    apollo_company: orgEnrich || null,
    apollo_enrichment_pending: isApolloConfigured(),
    apollo_enriched_at: null,
    phone_missing: !hasPhone,
    discovered_at: new Date().toISOString(),
    // Pipeline state
    pushed_to_cloudtalk_at: null,
    twenty_opportunity_id: null,
  });
  saveUserData(userId, ud);
  return true;
}

app.post("/api/cron/apollo-discover", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isApolloConfigured()) return res.status(503).json({ error: "Apollo not configured" });

  // Per-run budget. 4 pages × 25 = 100 candidates → ~15-25 expected positives.
  // Capped at 200 candidates to avoid one bad run torching credits.
  const PAGES_PER_RUN = Math.max(1, Math.min(8, Number(req.query.pages) || 4));
  const TARGET_USER = (req.query.userId || "u1").toString();

  const state = loadApolloDiscoverState();
  const stats = {
    pagesScanned: 0,
    candidatesSeen: 0,
    skippedDuplicates: 0,
    skippedOversized: 0,
    enrichmentChecked: 0,
    advertisersFound: 0,
    leadsAppended: 0,
    verified: 0,
    verifiedActive: 0,
    verifiedInactive: 0,
    errors: 0,
    keywordsUsed: [],
  };
  // Buffer of Apollo positives — appended to leads only AFTER batch
  // Meta Ad Library verification so we know whether they go to the
  // dialer queue or the "Måske relevant" bucket.
  const positives = [];

  for (let p = 0; p < PAGES_PER_RUN; p++) {
    // Rotate through keywords + pages so each run scans a different slice
    // of the DK SMB universe. State persists between runs so we don't
    // repeat coverage until we've worked through the matrix.
    const kw = APOLLO_DISCOVER_KEYWORDS[state.keywordCursor % APOLLO_DISCOVER_KEYWORDS.length];
    const page = state.pageCursor;
    stats.keywordsUsed.push(`${kw}#${page}`);

    let candidates = [];
    try {
      candidates = await apolloSearchAdvertiserCandidates({
        page,
        perPage: 25,
        employeeRanges: APOLLO_DISCOVER_EMPLOYEE_RANGES,
        keywords: [kw],
      });
      stats.pagesScanned++;
    } catch (e) {
      console.warn("[apollo-discover] search failed:", e.message);
      stats.errors++;
      // Move cursor forward anyway so we don't loop on the same broken slice.
    }

    // Advance cursor — page+1 within the keyword until we exhaust pages,
    // then switch keyword. Apollo caps at ~10 pages of 25 = 250 results
    // before refusing further pagination on the same query.
    if (candidates.length < 25 || state.pageCursor >= 10) {
      state.pageCursor = 1;
      state.keywordCursor = (state.keywordCursor + 1) % APOLLO_DISCOVER_KEYWORDS.length;
    } else {
      state.pageCursor++;
    }

    // For each candidate: skip if we've already checked the domain, otherwise
    // call apolloOrgEnrich (FREE) to check the metaAdvertiser signal.
    for (const cand of candidates) {
      stats.candidatesSeen++;
      const dKey = (cand.domain || "").toLowerCase();
      if (!dKey || !cand.id) { stats.skippedDuplicates++; continue; }
      if (state.scannedDomains[dKey] || state.scannedOrgIds[cand.id]) {
        stats.skippedDuplicates++;
        continue;
      }
      state.scannedDomains[dKey] = new Date().toISOString();
      state.scannedOrgIds[cand.id] = true;

      let orgEnrich = null;
      try {
        orgEnrich = await apolloOrgEnrich(cand.domain);
        stats.enrichmentChecked++;
        await new Promise((r) => setTimeout(r, 200)); // gentle on Apollo
      } catch (e) {
        if (e && e.code === "APOLLO_CREDITS_EXHAUSTED") {
          console.error("[apollo-discover] Apollo credits exhausted — breaking loop");
          stats.apolloExhausted = true;
          break;
        }
        console.warn("[apollo-discover] org-enrich failed:", cand.domain, e.message);
        stats.errors++;
        continue;
      }

      if (orgEnrich && orgEnrich.metaAdvertiser) {
        // Post-enrich ICP gate (Vedio sweet spot: DK + 1-15 emp + 2-15M
        // DKK revenue). Apollo's search filter is loose so we re-check
        // enrichedEmployees + annualRevenue here. passesIcpGate() handles
        // null fields gracefully (unknown = include).
        const enrichedEmp = orgEnrich.estimatedEmployees || cand.employees;
        if (!passesIcpGate(orgEnrich, enrichedEmp)) {
          stats.skippedOversized = (stats.skippedOversized || 0) + 1;
          continue;
        }
        stats.advertisersFound++;
        // Defer the append. We'll batch-verify all positives against the
        // live Meta Ad Library (Apify onlyTotal:true) in one call, then
        // append in a single pass with the verification result attached.
        // Apollo's metaAdvertiser flag is pixel-based and lags reality by
        // 30-90 days — many "Facebook Custom Audiences" flagged companies
        // stopped advertising months ago but never removed the pixel.
        positives.push({
          cand: {
            ...cand,
            phone: cand.phone || orgEnrich.phone || "",
            employees: enrichedEmp || null,
            industry: cand.industry || orgEnrich.industry || "",
            city: cand.city || orgEnrich.city || "",
          },
          orgEnrich,
        });
      }
    }
  }

  // ── Live Meta Ad Library verification (Apify batch) ─────────────────
  // For each Apollo-flagged positive, query Meta Ad Library to confirm
  // they're CURRENTLY running ads in DK (not just historically had a
  // pixel installed). Active = totalCount > 0 → goes to dialer queue.
  // Inactive = Apollo says yes but Meta says no current ads → routed
  // to the "Måske relevant" bucket via meta_verified_active=false.
  // Cost: ~$0.005 per positive on Apify STARTER BRONZE tier.
  const verifyMap = new Map(); // domain → { active, totalCount, checkedAt }
  if (positives.length > 0 && process.env.APIFY_API_TOKEN) {
    try {
      const startUrls = positives.map((p) => {
        const brand = brandFromApolloName(p.cand.name);
        const url = buildAdsLibraryUrl(brand);
        return { url, _domain: p.cand.domain.toLowerCase(), _brand: brand };
      });
      const items = await apifyVerifyMetaAds(startUrls);
      // Group items by URL → classifyAdActivity gives us {activeNow, recent90d, total}.
      const urlToDomain = new Map(startUrls.map((s) => [s.url, s._domain]));
      const byUrl = new Map();
      for (const it of items) {
        const u = it.inputUrl;
        if (!byUrl.has(u)) byUrl.set(u, []);
        byUrl.get(u).push(it);
      }
      const checkedAt = new Date().toISOString();
      for (const [url, group] of byUrl) {
        const domain = urlToDomain.get(url);
        if (!domain) continue;
        const c = classifyAdActivity(group);
        // "active" now means active OR recently-active within 90 days
        verifyMap.set(domain, { active: c.recent90d > 0, activeNow: c.activeNow, recent90d: c.recent90d, totalCount: c.total, checkedAt });
      }
      stats.verified = verifyMap.size;
      stats.verifiedActive = [...verifyMap.values()].filter((v) => v.active).length;
      stats.verifiedInactive = [...verifyMap.values()].filter((v) => !v.active).length;
    } catch (e) {
      console.warn("[apollo-discover] live Apify verify failed:", e.message);
      stats.errors++;
      // Verification failed but we don't fail the whole run — leads will
      // be appended with meta_verified_active=null (un-verified) and the
      // periodic retroactive cron can pick them up later.
    }
  }

  // ── Append all positives with their verification result ─────────────
  for (const { cand, orgEnrich } of positives) {
    try {
      const verify = verifyMap.get((cand.domain || "").toLowerCase()) || null;
      const added = appendApolloLeadToUser(TARGET_USER, cand, orgEnrich, verify);
      if (added) {
        stats.leadsAppended++;
        // Per-lead activity log entry shows verification status so the
        // SDR can see why a lead went to "Måske relevant" vs the dialer.
        const tag = verify
          ? (verify.active ? "🎯 verificeret aktiv" : "📊 Apollo-signal kun (måske relevant)")
          : "⚠ ikke verificeret";
        logActivity(
          "advertiser",
          `${tag}: ${cand.name} (${(orgEnrich.metaAdSignals || []).join(", ")})`,
          { domain: cand.domain, userId: TARGET_USER, source: "apollo-discover", verifyResult: verify },
        );
      }
    } catch (e) {
      console.warn("[apollo-discover] append failed:", cand.name, e.message);
      stats.errors++;
    }
  }

  state.lastRunAt = new Date().toISOString();
  saveApolloDiscoverState(state);
  logActivity(
    "discovery",
    `Apollo-discover: ${stats.advertisersFound} annoncører fundet · ${stats.verifiedActive || 0} verificeret aktive · ${stats.verifiedInactive || 0} kun-Apollo-signal · ${stats.leadsAppended} tilføjet til ${TARGET_USER}`,
    { stats },
  );
  console.log("[apollo-discover] done:", JSON.stringify(stats));
  res.json({ ok: true, stats, state: { keywordCursor: state.keywordCursor, pageCursor: state.pageCursor } });
});

// ── WEBSITE PHONE SCRAPING ────────────────────────────────────────
// Many DK SMB sites have a phone on /kontakt or /contact page, even when
// Datafordeler + Apollo both lack the number. Direct Node fetch handles
// 90% of cases (no JS rendering needed for a static contact page);
// Apify cheerio-scraper is the fallback for sites that block direct
// fetches via UA filtering or geofencing.

const DK_PHONE_REGEX = /(?:\+?45[\s\-]?)?\b([2-9]\d(?:[\s\-]?\d{2}){3})\b/g;

function normalizeDkPhone(rawDigits) {
  let d = String(rawDigits || "").replace(/\D/g, "");
  // Strip leading 45 country code if present (10-digit form)
  if (d.length === 10 && d.startsWith("45")) d = d.slice(2);
  // Sometimes formatted with 0045 prefix
  if (d.length === 12 && d.startsWith("0045")) d = d.slice(4);
  if (d.length !== 8) return null;
  if (!/^[2-9]/.test(d)) return null; // DK mobile/landline start digits
  return "+45" + d;
}

// Try fetching a single URL and extracting a DK phone. Returns {phone, source}
// or null. tel: href links are the strongest signal — they're machine-tagged
// as phones and rarely false positives. Plain-text regex is fallback.
async function fetchAndExtractPhone(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VedioLeads/1.0; +https://vedio.dk)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    }).finally(() => clearTimeout(timeoutId));
    if (!r.ok) return null;
    const html = await r.text();

    // 1. tel: hrefs — most reliable
    const telMatches = [...html.matchAll(/href=["']tel:([+0-9\s\-().]+)["']/gi)];
    for (const m of telMatches) {
      const phone = normalizeDkPhone(m[1]);
      if (phone) return { phone, source: "tel-link", url };
    }
    // 2. data-phone or itemprop="telephone"
    const microMatches = [...html.matchAll(/(?:data-phone|itemprop="telephone"|class="[^"]*phone[^"]*")[^>]*>([^<]+)</gi)];
    for (const m of microMatches) {
      const phone = normalizeDkPhone(m[1]);
      if (phone) return { phone, source: "microdata", url };
    }
    // 3. Plain-text regex — looser, false positives possible
    // Strip script + style blocks first to avoid matching random 8-digit strings
    const visible = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ");
    const txtMatches = [...visible.matchAll(DK_PHONE_REGEX)];
    for (const m of txtMatches) {
      const phone = normalizeDkPhone(m[1]);
      if (phone) return { phone, source: "text-match", url };
    }
    return null;
  } catch (e) {
    return null; // timeout, DNS fail, refused, etc.
  }
}

// Scrape a company website for a DK phone. Tries /kontakt /contact /om-os
// /about and homepage in order. Returns first hit.
async function scrapeWebsiteForPhone(websiteUrl) {
  if (!websiteUrl) return null;
  let base = String(websiteUrl).trim();
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  base = base.replace(/\/+$/, "");
  // Most DK SMB contact info lives on these paths
  const paths = ["/kontakt", "/contact", "/contact-us", "/om-os", "/about", "/about-us", "/"];
  for (const p of paths) {
    const res = await fetchAndExtractPhone(base + p);
    if (res) return { ...res, path: p };
  }
  return null;
}

app.post("/api/cron/scrape-website-phones", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  const TARGET_USER = (req.query.userId || "u1").toString();
  const LIMIT = Math.max(5, Math.min(100, Number(req.query.limit) || 50));
  const stats = {
    candidates: 0,
    recovered: 0,
    noWebsite: 0,
    noPhoneFound: 0,
    bySource: {},
  };

  const ud = loadUserData(TARGET_USER);
  // Verified-active leads without phones. We try website scraping which
  // works for ~50-70% of DK SMBs that have a /kontakt page.
  const todo = (ud.leads || []).filter((l) =>
    l.lastAction !== "not-relevant" &&
    l.meta_verified_active === true &&
    !((l.ph || "").toString().trim()) &&
    !((l.phone || "").toString().trim())
  ).slice(0, LIMIT);
  stats.candidates = todo.length;

  if (todo.length === 0) {
    return res.json({ ok: true, stats, note: "no phone-missing verified-active leads" });
  }

  // Process in parallel with 5-way concurrency — gentle on origin servers
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const lead = queue.shift();
      const ac = lead.apollo_company || {};
      // Pick the best website URL we know about for this lead
      const websiteUrl = lead.web || ac.websiteUrl || ac.domain || "";
      if (!websiteUrl) {
        stats.noWebsite++;
        continue;
      }
      try {
        const r = await scrapeWebsiteForPhone(websiteUrl);
        if (r && r.phone) {
          // Apply back to user data (re-load to avoid races with concurrent crons)
          const ud2 = loadUserData(TARGET_USER);
          const l2 = (ud2.leads || []).find((x) => x.cvr === lead.cvr);
          if (l2) {
            l2.ph = r.phone;
            l2.phone = r.phone;
            l2.phone_missing = false;
            l2.phone_recovered_at = new Date().toISOString();
            l2.phone_recovered_source = `website:${r.source}`;
            l2.phone_recovered_page = r.url;
            saveUserData(TARGET_USER, ud2);
            stats.recovered++;
            stats.bySource[r.source] = (stats.bySource[r.source] || 0) + 1;
          }
        } else {
          stats.noPhoneFound++;
        }
      } catch (e) { /* swallow per-lead errors */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, todo.length) }, worker));

  logActivity(
    "phone-recovery",
    `Website-scrape: ${stats.recovered}/${stats.candidates} fundet på contact-sider${stats.noWebsite?` (${stats.noWebsite} uden URL)`:''}`,
    { stats, userId: TARGET_USER },
  );
  console.log("[scrape-website-phones] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// ── PHONE RECOVERY for verified-active leads ──────────────────────
// Many Meta-verified leads still land without phone numbers because:
//   * Apollo's org-enrich phone field is empty for ~50% of DK SMBs
//   * Synthetic-CVR leads (apollo-*, tech-*, gmaps-*, meta-*) bypass the
//     Datafordeler switchboard fallback in enrichUserLeadsViaApolloAsync
//     (which only triggers for real 8-digit CVRs)
//
// This endpoint hunts for the missing phones via two free paths:
//   1. Real 8-digit CVR → direct lookupDatafordeler() → CVR_Telefonnummer
//   2. Synthetic CVR → searchDatafordeler() by company name, find a confident
//      match, get its phone
//
// Free pass (no Apollo credits used). If both fail, the lead stays in the
// Mangler-nummer bucket. People-match credit reveal could be a later
// upgrade but that's $$$/lead.
async function tryRecoverPhoneForLead(lead) {
  // Skip recovery entirely if the lead isn't a known DK company. Without
  // this gate, leads like "AT&T" or "Booking.com" (international brands
  // that slipped past meta-ads-discover) would get random numbers attached
  // from Google SERP / name-search collisions.
  if (!hasDkCompanyEvidence(lead) || looksLikeNonDkBrand(lead.name)) {
    return null;
  }

  // PATH 1 — Real DK 8-digit CVR → direct Datafordeler lookup
  if (/^\d{8}$/.test(String(lead.cvr || ""))) {
    try {
      const c = await lookupDatafordeler(String(lead.cvr));
      if (c && c.phone) return { phone: c.phone, source: "df-cvr-lookup" };
    } catch (_) { /* fall through */ }
  }

  const name = (lead.name || "").trim();
  if (!name) return null; // can't search with no name

  // PATH 2 — Datafordeler name search → if match found + has phone, use it
  try {
    const filters = { _from: 0, _size: 5 };
    if (lead.city) filters.city = lead.city;
    const results = await searchDatafordeler(name, filters);
    const rows = (results && (results.companies || results.results || results.rows)) || [];
    if (rows.length) {
      const norm = (s) => String(s || "").toLowerCase()
        .replace(/\b(a\/s|aps|ivs|i\/s|p\/s|k\/s)\b/gi, "")
        .replace(/\s+/g, " ").trim();
      const target = norm(name);
      let best = rows.find((c) => norm(c.name) === target);
      if (!best) best = rows.find((c) => target.length >= 4 && norm(c.name).includes(target));
      if (best && best.cvr) {
        if (best.phone) return { phone: best.phone, source: "df-name-search" };
        try {
          const c = await lookupDatafordeler(String(best.cvr));
          if (c && c.phone) return { phone: c.phone, source: "df-name-lookup", recoveredCvr: best.cvr };
        } catch (_) { /* fall through */ }
      }
    }
    // No DF match → continue to Path 3 (don't return null here)
  } catch (_) { /* fall through to Path 3 */ }

  // PATH 3 — Apify Google SERP scrape. Most reliable for companies not
  // in Datafordeler's phone registry (small brands, religious/cultural
  // orgs, non-CVR-registered orgs). Apify google-search-scraper returns
  // organic snippets that typically contain "Telefon (+45) XX XX XX XX"
  // pulled directly from the company's own /kontakt page or Google
  // Business listing. Cost ~$0.005/lead.
  try {
    const serpResult = await tryGoogleSerpForPhone(name);
    if (serpResult && serpResult.phone) return serpResult;
  } catch (_) { /* SERP failed */ }

  // PATH 4 — Lusha lookup using contact name + lead company. EU-native
  // B2B DB with much better DK SMB direct-dial coverage than Apollo.
  // Costs 1 Lusha credit (~$0.08).
  if (isLushaConfigured()) {
    const contactName = (lead.contacts || []).find((c) => c.name && c.name !== "—");
    if (contactName && lead.name) {
      try {
        const lusha = await lushaLookupPerson({
          firstName: contactName.firstName || (contactName.name || "").split(/\s+/)[0],
          lastName:  contactName.lastName  || (contactName.name || "").split(/\s+/).slice(1).join(" "),
          fullName:  contactName.name,
          email:     contactName.email,
          companyName: lead.name,
          companyDomain: (lead.web || lead.website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
        });
        if (lusha && lusha.phones && lusha.phones.length > 0) {
          const dkPhones = filterDkPhones(lusha.phones);
          if (dkPhones.length > 0) {
            return { phone: dkPhones[0].number, source: "lusha-name-company", lushaContact: lusha };
          }
        }
      } catch (e) {
        if (e.code !== "LUSHA_CAP_REACHED") console.warn("[recover-phones/lusha]", e.message);
      }
    }
  }

  return null;
}

// Apify Google search → DK phone extraction. Returns { phone, source,
// matchedSnippet } on success, null otherwise. We pick the phone that
// appears in the MOST organic-result snippets (most likely to be the
// company's actual main number, not a one-off footnote).
async function tryGoogleSerpForPhone(companyName) {
  if (!process.env.APIFY_API_TOKEN) return null;
  if (!companyName || companyName.length < 3) return null;
  const token = process.env.APIFY_API_TOKEN;
  // Query: brand in quotes (forces exact match) + +45 + telefon (improves
  // chance Google surfaces snippets containing the phone format we want).
  const query = `"${companyName}" +45 telefon`;
  try {
    const r = await fetch(
      `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${token}&memory=1024&timeout=180`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: query,
          resultsPerPage: 8,
          maxPagesPerQuery: 1,
          countryCode: "dk",
          languageCode: "da",
        }),
      },
    );
    if (!r.ok) return null;
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return null;
    const page = items[0];
    // Collect text from organic snippets + knowledge panel + people-also-ask
    const corpus = [];
    for (const o of (page.organicResults || [])) {
      corpus.push(o.title || "", o.description || o.snippet || "");
    }
    const kp = page.knowledgePanel || page.knowledge_panel;
    if (kp && typeof kp === "object") corpus.push(JSON.stringify(kp));
    for (const q of (page.peopleAlsoAsk || [])) corpus.push(q.question || "", q.answer || "");
    const fullText = corpus.join(" \n ");

    // Find DK phone candidates. Pattern matches:
    //   +45 XX XX XX XX  / +45XXXXXXXX  / (+45) XX XX XX XX  /  45XXXXXXXX
    //   plus bare 8-digit when preceded by "tel"/"telefon" within ~10 chars
    const candidates = new Map(); // normalized phone → frequency
    const seenRaw = new Set();
    const phoneRe = /(?:\+?45[\s\-)]*)?(\b[2-9]\d[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2}\b)/g;
    let m;
    while ((m = phoneRe.exec(fullText))) {
      const digits = m[1].replace(/\D/g, "");
      if (digits.length !== 8) continue;
      // Must be a valid DK mobile/landline first digit (2-9)
      if (!/^[2-9]/.test(digits)) continue;
      const normalized = "+45" + digits;
      const rawKey = m[0];
      if (seenRaw.has(rawKey)) continue;
      seenRaw.add(rawKey);
      // To weight "phone near 'telefon' word" higher: check 30 chars before the match
      const start = Math.max(0, m.index - 30);
      const context = fullText.slice(start, m.index + m[0].length).toLowerCase();
      const weight = /(?:telefon|tel\.?|phone|\+45|kontakt)/.test(context) ? 3 : 1;
      candidates.set(normalized, (candidates.get(normalized) || 0) + weight);
    }
    if (candidates.size === 0) return null;
    // Pick the highest-weight candidate
    const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
    const [bestPhone, bestWeight] = ranked[0];
    return {
      phone: bestPhone,
      source: "google-serp",
      weight: bestWeight,
      alternatives: ranked.slice(1, 4).map(([p, w]) => ({ phone: p, weight: w })),
    };
  } catch (e) {
    console.warn("[google-serp]", companyName, e.message);
    return null;
  }
}

app.post("/api/cron/recover-phones", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  const TARGET_USER = (req.query.userId || "u1").toString();
  // Cap at 200/run — Datafordeler tolerates this volume comfortably.
  const LIMIT = Math.max(10, Math.min(500, Number(req.query.limit) || 200));
  const stats = {
    candidates: 0,
    recovered: 0,
    notFound: 0,
    errors: 0,
    bySource: {},
  };

  const ud = loadUserData(TARGET_USER);
  // Target: leads with any verified advertising signal that have no phone
  // and aren't archived. These are "high value but uncallable" — solving the
  // phone gap unlocks immediate dial value.
  //
  // PR6: widened from meta_verified_active===true ONLY (currently-running
  // ads) to ALSO include meta_advertiser=true / linkedin_advertiser=true /
  // meta_ads_recent90d>0. Recently-paused Meta advertisers are still
  // high-value cold-call targets. The old filter eligible only 11 of
  // today's 30 phone-missing leads — the other 19 sat ignored.
  const todo = (ud.leads || []).filter((l) =>
    l.lastAction !== "not-relevant" &&
    (
      l.meta_verified_active === true ||
      l.meta_advertiser === true ||
      l.linkedin_advertiser === true ||
      (Number(l.meta_ads_recent90d) || 0) > 0
    ) &&
    !((l.ph || "").toString().trim()) &&
    !((l.phone || "").toString().trim())
  ).slice(0, LIMIT);
  stats.candidates = todo.length;

  if (todo.length === 0) {
    return res.json({ ok: true, stats, note: "no phone-missing verified-active leads" });
  }

  // Process one at a time (Datafordeler rate limits — gentle is safer than fast)
  for (const lead of todo) {
    try {
      const r = await tryRecoverPhoneForLead(lead);
      if (r && r.phone) {
        // Re-load + apply (state can shift between iterations if other crons fire)
        const ud2 = loadUserData(TARGET_USER);
        const l2 = (ud2.leads || []).find((x) => x.cvr === lead.cvr);
        if (l2) {
          l2.ph = r.phone;
          l2.phone = r.phone; // both fields for downstream compat
          l2.phone_missing = false;
          l2.phone_recovered_at = new Date().toISOString();
          l2.phone_recovered_source = r.source;
          if (r.recoveredCvr) l2.df_cvr_match = r.recoveredCvr;
          saveUserData(TARGET_USER, ud2);
          stats.recovered++;
          stats.bySource[r.source] = (stats.bySource[r.source] || 0) + 1;
        }
      } else {
        stats.notFound++;
      }
      // Gentle Datafordeler rate
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      stats.errors++;
      console.warn("[recover-phones]", lead.cvr, e.message);
    }
  }

  logActivity(
    "phone-recovery",
    `Phone recovery: ${stats.recovered}/${stats.candidates} fundet via Datafordeler${stats.errors?` (${stats.errors} fejl)`:''}`,
    { stats, userId: TARGET_USER },
  );
  console.log("[recover-phones] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// ── LINKEDIN ADS DISCOVERY ────────────────────────────────────────
// Captures B2B SaaS, agencies, consulting, recruiting — segments Meta
// largely misses. Apify's silva95gustavo/linkedin-ad-library-scraper
// returns currently-active LinkedIn ads for a search URL. Same pipeline
// as meta-ads-discover: scrape → unique advertisers → Apollo resolve →
// DK + 5-50 emp filter → append.
//
// LinkedIn's Ad Library doesn't expose a clean "currently running" filter,
// so we accept all results and rely on the company-resolution step for ICP
// quality. Expected yield ~20-40 unique B2B advertisers per run, very
// little overlap with Meta-discovered leads.

const LINKEDIN_DISCOVER_STATE_FILE = path.join(DATA_DIR, "discovery", "linkedin_discover.json");

// Rotation of LinkedIn Ad Library search URLs. Mix of:
//  - country-only (broad DK B2B)
//  - keyword + DK country (industry-specific)
const LINKEDIN_DISCOVER_QUERIES = [
  { label: "DK all",       url: "https://www.linkedin.com/ad-library/search?countries=DK" },
  { label: "saas DK",      url: "https://www.linkedin.com/ad-library/search?countries=DK&keyword=saas" },
  { label: "agency DK",    url: "https://www.linkedin.com/ad-library/search?countries=DK&keyword=agency" },
  { label: "consulting DK",url: "https://www.linkedin.com/ad-library/search?countries=DK&keyword=consulting" },
  { label: "marketing DK", url: "https://www.linkedin.com/ad-library/search?countries=DK&keyword=marketing" },
  { label: "recruiting DK",url: "https://www.linkedin.com/ad-library/search?countries=DK&keyword=recruiting" },
];

function loadLinkedInDiscoverState() {
  try {
    if (fs.existsSync(LINKEDIN_DISCOVER_STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(LINKEDIN_DISCOVER_STATE_FILE, "utf8"));
      return { scannedAdvertisers: {}, queryCursor: 0, lastRunAt: null, ...s };
    }
  } catch (e) { console.warn("[linkedin-discover] state load:", e.message); }
  return { scannedAdvertisers: {}, queryCursor: 0, lastRunAt: null };
}

function saveLinkedInDiscoverState(s) {
  fs.mkdirSync(path.dirname(LINKEDIN_DISCOVER_STATE_FILE), { recursive: true });
  fs.writeFileSync(LINKEDIN_DISCOVER_STATE_FILE, JSON.stringify(s, null, 2));
}

// Adapter: LinkedIn Ad scraper response shapes vary across actor versions.
// Look for common advertiser-name fields and normalize.
function extractLinkedInAdvertiser(item) {
  const name =
    item.advertiserName ||
    item.companyName ||
    item.pageName ||
    item.advertiser ||
    item.company ||
    item.organization ||
    (item.advertiserInfo && (item.advertiserInfo.name || item.advertiserInfo.companyName)) ||
    (item.snapshot && item.snapshot.advertiserName) ||
    null;
  // Company-page URL on LinkedIn (advertiser profile)
  const linkedinUrl =
    item.advertiserUrl ||
    item.advertiserLinkedInUrl ||
    item.companyLinkedInUrl ||
    item.linkedinUrl ||
    item.advertiser_url ||
    (item.advertiserInfo && item.advertiserInfo.url) ||
    null;
  // PR4: the specific AD's URL in LinkedIn Ad Library. SDR can click
  // through and review the actual creative before dialing — same value
  // as the Meta Ad Library badge for Meta leads.
  const adUrl =
    item.url ||
    item.adUrl ||
    item.detailsUrl ||
    item.libraryUrl ||
    item.adLink ||
    (item.adArchiveID ? `https://www.linkedin.com/ad-library/detail/${item.adArchiveID}` : null) ||
    (item.adId ? `https://www.linkedin.com/ad-library/detail/${item.adId}` : null) ||
    null;
  const adId = item.adArchiveID || item.adId || item.id || null;
  return { name, linkedinUrl, adUrl, adId };
}

async function apifyLinkedInAdsScrape({ startUrl, resultsLimit }) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN not configured");
  const input = {
    startUrls: [{ url: startUrl }],
    resultsLimit,
    skipDetails: true,
  };
  const startResp = await fetch(
    `https://api.apify.com/v2/acts/silva95gustavo~linkedin-ad-library-scraper/runs?token=${token}&memory=1024&timeout=1800`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  if (!startResp.ok) throw new Error(`LinkedIn Apify start ${startResp.status}: ${(await startResp.text()).slice(0,300)}`);
  const { data: run } = await startResp.json();
  // Poll
  const t0 = Date.now();
  const MAX_WAIT_MS = 20 * 60 * 1000;
  let status = run.status;
  let runData = run;
  while (status === "READY" || status === "RUNNING") {
    if (Date.now() - t0 > MAX_WAIT_MS) throw new Error("LinkedIn Apify timeout");
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
    if (!poll.ok) continue;
    runData = (await poll.json()).data;
    status = runData.status;
  }
  if (status !== "SUCCEEDED") throw new Error(`LinkedIn Apify ended ${status}`);
  const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${token}&format=json`);
  if (!itemsResp.ok) throw new Error(`LinkedIn dataset fetch ${itemsResp.status}`);
  return itemsResp.json();
}

app.post("/api/cron/linkedin-ads-discover", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!process.env.APIFY_API_TOKEN) return res.status(503).json({ error: "APIFY_API_TOKEN not configured" });

  const RESULTS_LIMIT = Math.max(20, Math.min(300, Number(req.query.limit) || 100));
  const TARGET_USER = (req.query.userId || "u1").toString();
  // Synchronous flow — Cloud Run timeout bumped to 1200s in deploy.yml
  // to fit Apify scrape (~3-5min) + N × DF lookups.
  const state = loadLinkedInDiscoverState();
  const query = LINKEDIN_DISCOVER_QUERIES[state.queryCursor % LINKEDIN_DISCOVER_QUERIES.length];
  state.queryCursor = (state.queryCursor + 1) % LINKEDIN_DISCOVER_QUERIES.length;

  const stats = {
    query: query.label,
    adsScraped: 0,
    uniqueAdvertisers: 0,
    alreadyScanned: 0,
    fresh: 0,
    apolloResolved: 0,
    apolloMisses: 0,
    skippedNotDk: 0,
    skippedSize: 0,
    leadsAppended: 0,
    errors: 0,
  };

  // 1. Scrape LinkedIn ads
  let items = [];
  try {
    items = await apifyLinkedInAdsScrape({ startUrl: query.url, resultsLimit: RESULTS_LIMIT });
  } catch (e) {
    return res.status(502).json({ error: `LinkedIn Apify failed: ${e.message}` });
  }
  stats.adsScraped = items.length;

  // 2. Dedupe to unique advertisers
  const seenThisRun = new Set();
  const fresh = [];
  for (const it of items) {
    const adv = extractLinkedInAdvertiser(it);
    if (!adv.name) continue;
    const key = adv.name.toLowerCase().trim();
    if (seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    if (state.scannedAdvertisers[key]) continue;
    state.scannedAdvertisers[key] = new Date().toISOString();
    fresh.push(adv);
  }
  stats.uniqueAdvertisers = seenThisRun.size;
  stats.alreadyScanned = stats.uniqueAdvertisers - fresh.length;
  stats.fresh = fresh.length;

  // 3. (PR2: lazy-enrich) Save each LinkedIn advertiser as a RAW lead.
  //    No Apollo at discovery — drain-enrichment runs ICP gate + contacts
  //    fetch later, capped at 300/day. LinkedIn ads source by construction
  //    means linkedin_advertiser=true (they're paying for LinkedIn ads,
  //    a strong B2B intent signal that survives the lazy-enrich pivot).
  const checkedAt = new Date().toISOString();
  for (const adv of fresh) {
    if (!adv.name) continue;
    if (looksLikeNonDkBrand(adv.name)) {
      stats.skippedNonDkBrand = (stats.skippedNonDkBrand || 0) + 1;
      continue;
    }
    // DK-verify via Datafordeler — drop if not a registered DK biz
    let df = null;
    try { df = await tryDfVerifyDkCompany(adv.name); } catch (_) {}
    if (!df || !df.cvr || !/^\d{8}$/.test(String(df.cvr))) {
      stats.skippedNotInDf = (stats.skippedNotInDf || 0) + 1;
      continue;
    }
    if (!dfEmpPassesIcp(df)) {
      stats.skippedOverSize = (stats.skippedOverSize || 0) + 1;
      continue;
    }
    try {
      const ud = loadUserData(TARGET_USER);
      if (!ud.leads) ud.leads = [];
      const dupByCvr  = ud.leads.some((l) => l.cvr === df.cvr);
      const dupByName = ud.leads.some(
        (l) => (l.name || "").toLowerCase().trim() === (df.name || adv.name).toLowerCase().trim(),
      );
      if (dupByCvr || dupByName) {
        stats.skippedDuplicates = (stats.skippedDuplicates || 0) + 1;
        continue;
      }
      const phone = df.phone || df.ph || "";
      ud.leads.push({
        ...df,
        listId: "ungrouped",
        addedAt: checkedAt,
        source: "linkedin-ads-discover",
        icpFit: true,
        meta_advertiser: false,
        linkedin_advertiser: true,
        ad_signals: ["LinkedIn Ad Library (live)"],
        meta_verified_active: null,
        meta_verified_at: null,
        meta_live_ad_count: null,
        linkedin_url: adv.linkedinUrl || "",
        linkedin_ad_url: adv.adUrl || "",
        linkedin_ad_id: adv.adId || "",
        apollo_company: null,
        apollo_enrichment_pending: false,
        apollo_enriched_at: null,
        phone: phone,
        ph: phone,
        phone_missing: !phone,
        discovered_at: checkedAt,
        pushed_to_cloudtalk_at: null,
        twenty_opportunity_id: null,
        df_verified_at: checkedAt,
      });
      saveUserData(TARGET_USER, ud);
      stats.rawAppended = (stats.rawAppended || 0) + 1;
      stats.dfVerified = (stats.dfVerified || 0) + 1;
      if (phone) stats.withPhoneAtIntake = (stats.withPhoneAtIntake || 0) + 1;
    } catch (e) { stats.errors++; }
  }

  state.lastRunAt = new Date().toISOString();
  saveLinkedInDiscoverState(state);
  logActivity(
    "discovery",
    `LinkedIn-discover (${query.label}): ${stats.adsScraped} ads · ${stats.fresh} nye · ${stats.rawAppended || 0} råleads gemt · ${stats.dfVerified || 0} DK-verificeret`,
    { stats, userId: TARGET_USER },
  );
  console.log("[linkedin-ads-discover] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// ── GOOGLE MAPS / OSM DAILY DISCOVERY ─────────────────────────────────
// Wraps the existing /api/scrape/google-maps endpoint as a daily cron.
// Iterates a rotation of category+city queries, runs each result through
// the same ICP filter pipeline as ads-first (Apollo resolve → DK + 5-50
// emp → live-Meta verify), appends only the verified-active ICP-fit.
//
// Yield expectation: LOW. OSM data is sparse, many DK local businesses
// don't have CVR matches, and the Meta-advertiser hit rate is lower than
// e-commerce-heavy keyword pulls. Realistic ~3-7 ICP/day. Treat as
// supplementary, not primary.

const GMAPS_DISCOVER_STATE_FILE = path.join(DATA_DIR, "discovery", "gmaps_discover.json");

// Rotation pairs of (category, city). One pair per cron run. Categories
// chosen for plausible Meta-ad activity: local consumer services that
// frequently run Meta promotions (restaurants, beauty, retail).
// Note: mom-and-pop categories (restaurant, cafe, butik) churn through OSM
// but very few have Apollo records — yield is ~0%. Professional services
// + serious retail (clinics, opticians, real estate, jewellery) have
// websites + Apollo coverage. Tilted heavily that way.
const GMAPS_DISCOVER_QUERIES = [
  // Beauty + body clinics (1-15 emp sweet spot, marketing-active)
  { category: "skønhedsklinik", city: "København" },
  { category: "skønhedsklinik", city: "Aarhus"     },
  { category: "fysioterapi",    city: "København" },
  { category: "fysioterapi",    city: "Aarhus"     },
  { category: "tandlæge",       city: "København" },
  { category: "tandlæge",       city: "Aarhus"     },
  // Optics + jewellery (small retail with websites)
  { category: "optiker",        city: "København" },
  { category: "optiker",        city: "Aarhus"     },
  { category: "optiker",        city: "Odense"     },
  { category: "juveler",        city: "København" },
  // Real estate (always has websites, often 5-15 emp)
  { category: "ejendomsmægler", city: "København" },
  { category: "ejendomsmægler", city: "Aarhus"     },
  { category: "ejendomsmægler", city: "Odense"     },
  { category: "ejendomsmægler", city: "Aalborg"    },
  // Professional services
  { category: "advokat",        city: "København" },
  { category: "advokat",        city: "Aarhus"     },
  { category: "revisor",        city: "København" },
  { category: "revisor",        city: "Aarhus"     },
  { category: "arkitekt",       city: "København" },
  // Other Apollo-indexed verticals
  { category: "vinforhandler",  city: "København" },
  { category: "blomster",       city: "København" },
  { category: "frisor",         city: "København" },
  { category: "frisor",         city: "Aarhus"     },
  // Less-scraped cities (less dedupe collisions)
  { category: "skønhedsklinik", city: "Esbjerg"    },
  { category: "ejendomsmægler", city: "Vejle"      },
  // Q2 2026 expansion — more city/category coverage
  { category: "fysioterapi",    city: "Esbjerg"    },
  { category: "fysioterapi",    city: "Odense"     },
  { category: "tandlæge",       city: "Odense"     },
  { category: "tandlæge",       city: "Aalborg"    },
  { category: "advokat",        city: "Odense"     },
  { category: "advokat",        city: "Aalborg"    },
  { category: "revisor",        city: "Odense"     },
  { category: "revisor",        city: "Vejle"      },
  { category: "ejendomsmægler", city: "Randers"    },
  { category: "frisor",         city: "Odense"     },
];

function loadGmapsDiscoverState() {
  try {
    if (fs.existsSync(GMAPS_DISCOVER_STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(GMAPS_DISCOVER_STATE_FILE, "utf8"));
      return { scannedNames: {}, queryCursor: 0, lastRunAt: null, ...s };
    }
  } catch (e) { console.warn("[gmaps-discover] state load:", e.message); }
  return { scannedNames: {}, queryCursor: 0, lastRunAt: null };
}

function saveGmapsDiscoverState(s) {
  fs.mkdirSync(path.dirname(GMAPS_DISCOVER_STATE_FILE), { recursive: true });
  fs.writeFileSync(GMAPS_DISCOVER_STATE_FILE, JSON.stringify(s, null, 2));
}

app.post("/api/cron/gmaps-discover", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isApolloConfigured()) return res.status(503).json({ error: "Apollo not configured" });
  if (!process.env.APIFY_API_TOKEN) return res.status(503).json({ error: "APIFY_API_TOKEN not configured" });

  const TARGET_USER = (req.query.userId || "u1").toString();
  const LIMIT = Math.max(20, Math.min(200, Number(req.query.limit) || 80));
  const state = loadGmapsDiscoverState();
  const query = GMAPS_DISCOVER_QUERIES[state.queryCursor % GMAPS_DISCOVER_QUERIES.length];
  state.queryCursor = (state.queryCursor + 1) % GMAPS_DISCOVER_QUERIES.length;

  const stats = {
    query: `${query.category} / ${query.city}`,
    osmRaw: 0,
    skippedDuplicates: 0,
    apolloResolved: 0,
    apolloMisses: 0,
    skippedNotDk: 0,
    skippedSize: 0,
    verifiedActive: 0,
    verifiedInactive: 0,
    leadsAppended: 0,
    errors: 0,
  };

  // 1. Scrape OSM via the multi-mirror fetcher with retry/backoff.
  // The public Overpass instance frequently returns 504 during peak
  // hours — fetchOverpass falls back to kumi.systems and private.coffee
  // mirrors automatically.
  let parsed = [];
  try {
    const overpass = buildOsmQuery({ category: query.category, city: query.city, limit: LIMIT });
    const data = await fetchOverpass(overpass, { timeoutMs: 60000 });
    const seen = new Set();
    for (const el of data.elements || []) {
      const p = parseOsmElement(el);
      if (!p) continue;
      const key = `${p.name.toLowerCase()}|${(p.city || "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(p);
      if (parsed.length >= LIMIT) break;
    }
    stats.osmRaw = parsed.length;
  } catch (e) {
    return res.status(502).json({ error: `OSM scrape failed: ${e.message}` });
  }

  // 2. (PR6: strict Meta-verify) Filter OSM businesses through Apify
  //    Meta Ad Library BEFORE saving. Same guarantee as branche-walk +
  //    meta-ads-discover: every lead landing in the autodialer has
  //    name-matched ads with recent90d > 0 activity. No Meta presence
  //    → not saved.
  const checkedAt = new Date().toISOString();
  // Dedup OSM candidates first so we don't burn Apify on dupes
  const dedupedParsed = [];
  for (const p of parsed) {
    const key = `${(p.name || "").toLowerCase()}|${(p.city || "").toLowerCase()}`;
    if (state.scannedNames[key]) { stats.skippedDuplicates++; continue; }
    state.scannedNames[key] = checkedAt;
    if (!p.name || p.name.length < 3) continue;
    dedupedParsed.push(p);
  }
  // Batch-verify against Meta Ad Library
  stats.metaVerifyAttempted = dedupedParsed.length;
  const { verified: verifiedParsed, stats: vStats } = await verifyCandidatesAgainstMeta(
    dedupedParsed.map((p) => ({ ...p, _osmKey: `${p.name.toLowerCase()}|${(p.city || "").toLowerCase()}` })),
    "_osmKey",
  );
  stats.metaVerified = verifiedParsed.length;
  stats.metaVerifyNoAds = vStats.noAds || 0;
  stats.metaVerifyNameMismatch = vStats.nameMismatch || 0;
  if (vStats.apifyError) stats.metaVerifyError = vStats.apifyError;
  for (const p of verifiedParsed) {
    try {
      const ud = loadUserData(TARGET_USER);
      if (!ud.leads) ud.leads = [];
      // Synthetic CVR uses a hash of name+city to keep it stable across
      // runs (OSM doesn't give us a persistent business ID).
      const hashSeed = `${p.name}|${p.city || ""}`.toLowerCase();
      let hash = 0;
      for (let i = 0; i < hashSeed.length; i++) hash = ((hash << 5) - hash + hashSeed.charCodeAt(i)) | 0;
      const syntheticCvr = `gmaps-${Math.abs(hash).toString(36)}`;
      const dupByCvr = ud.leads.some((l) => l.cvr === syntheticCvr);
      const dupByName = ud.leads.some(
        (l) => (l.name || "").toLowerCase().trim() === p.name.toLowerCase().trim(),
      );
      if (dupByCvr || dupByName) { stats.skippedDuplicates++; continue; }
      const hasPhone = !!(p.phone || "").toString().trim();
      ud.leads.push({
        cvr: syntheticCvr,
        name: p.name,
        addr: "", zip: "", city: p.city || "", ph: p.phone || "", em: "",
        web: "", ind: query.category, ic: "",
        emp: "", emps: null, st: "aktiv", yr: "", form: "",
        eq: 0, res: 0, omsaetning: 0,
        source: "gmaps-discover",
        icpFit: false, // drain-enrichment sets to true on ICP-pass
        meta_advertiser: false, // drain may set true via Apollo enrich
        ad_signals: [`Google Maps: ${query.category}`],
        meta_verified_active: null, // unknown until Apollo enrich runs
        meta_verified_at: null,
        meta_live_ad_count: null,
        apollo_company: null,
        apollo_enrichment_pending: true, // drain picks this up
        apollo_enriched_at: null,
        phone_missing: !hasPhone,
        discovered_at: checkedAt,
        pushed_to_cloudtalk_at: null, twenty_opportunity_id: null,
      });
      saveUserData(TARGET_USER, ud);
      stats.rawAppended = (stats.rawAppended || 0) + 1;
    } catch (e) { stats.errors++; }
  }

  state.lastRunAt = checkedAt;
  saveGmapsDiscoverState(state);
  logActivity(
    "discovery",
    `Gmaps-discover (${stats.query}): ${stats.osmRaw} OSM · ${stats.rawAppended || 0} råleads gemt (afventer ICP-check via drain)`,
    { stats, userId: TARGET_USER },
  );
  console.log("[gmaps-discover] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// ── TECH-STACK DISCOVERY (Apollo currently_using_any_of_technology_uids) ──
// Different angle from ads-first: instead of looking at WHO is advertising,
// look at WHO has marketing-tech installed (Shopify, Klaviyo, Mailchimp,
// HubSpot, ActiveCampaign). These tools all correlate strongly with "this
// company spends money on marketing" — and the ones using e-commerce
// stacks (Shopify + Klaviyo) almost universally advertise on Meta too.
//
// Same architecture as apollo-discover (search → org-enrich → ICP filter →
// append lead) PLUS the live Meta Ad Library verify step that ads-first
// uses, so the dialer only gets leads that are confirmed currently
// advertising. Otherwise we'd re-introduce the Apollo-lag problem we
// just solved.
//
// Tech rotation: 1 tech per run, cursor in state file. ~50 candidates per
// run × 30-50% Apify-verified active = ~15-25 ICP-fit leads/day.

const TECH_DISCOVER_STATE_FILE = path.join(DATA_DIR, "discovery", "apollo_tech_discover.json");

// Tech UIDs in priority order by ICP relevance. Klaviyo is the strongest
// signal — it's specifically used by e-commerce brands for email marketing
// + retargeting (heavy correlation with Meta ad spend). Shopify is second
// (e-commerce platform). Mailchimp + ActiveCampaign + HubSpot have broader
// usage so signal density is lower.
const TECH_DISCOVER_UIDS = [
  // Email marketing
  "klaviyo",
  "mailchimp",
  "active_campaign",
  "omnisend",
  // CRM / marketing automation
  "hubspot",
  // E-commerce platforms (DTC-friendly)
  "shopify",
  "woocommerce",
  "magento",
  "bigcommerce",
  // Payments (likely on DK DTC sites)
  "stripe",
  "klarna",
  // Reviews / loyalty (only on serious DTC shops)
  "yotpo",
  // DTC support
  "gorgias",
  // Added Q2 2026 — DTC subscription + SMS marketing stack
  "recharge",
  "attentive",
  "postscript",
  "judgeme",
];

function loadTechDiscoverState() {
  try {
    if (fs.existsSync(TECH_DISCOVER_STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(TECH_DISCOVER_STATE_FILE, "utf8"));
      // Backfill missing fields if state from older code
      return { scannedDomains: {}, scannedOrgIds: {}, techCursor: 0, lastRunAt: null, ...s };
    }
  } catch (e) { console.warn("[tech-discover] state load:", e.message); }
  return { scannedDomains: {}, scannedOrgIds: {}, techCursor: 0, lastRunAt: null };
}

function saveTechDiscoverState(s) {
  fs.mkdirSync(path.dirname(TECH_DISCOVER_STATE_FILE), { recursive: true });
  fs.writeFileSync(TECH_DISCOVER_STATE_FILE, JSON.stringify(s, null, 2));
}

async function apolloSearchByTech({ techUid, page = 1, perPage = 25 }) {
  const body = {
    page: Math.max(1, page),
    per_page: Math.min(100, perPage),
    organization_locations: ["Denmark"],
    organization_num_employees_ranges: APOLLO_DISCOVER_EMPLOYEE_RANGES,
    currently_using_any_of_technology_uids: [techUid],
  };
  const r = await fetch(`${APOLLO_API_BASE}/mixed_companies/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": process.env.APOLLO_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    if (isApolloCreditExhaustedResponse(r.status, text)) {
      setApolloExhausted(text.slice(0, 200));
      throw new ApolloCreditExhaustedError(text.slice(0, 200));
    }
    throw new Error(`Apollo tech-search ${r.status}: ${text.slice(0, 200)}`);
  }
  clearApolloExhausted();
  const d = await r.json();
  const orgs = d.organizations || d.accounts || [];
  return orgs.map((o) => ({
    id: o.id || o.organization_id || null,
    name: o.name || "",
    domain: String(o.website_url || o.primary_domain || "")
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim(),
    employees: o.estimated_num_employees || null,
    industry: o.industry || (o.industries && o.industries[0]) || "",
    phone: o.primary_phone?.sanitized_number || o.phone || "",
    city: o.city || "",
  }));
}

app.post("/api/cron/tech-discover", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isApolloConfigured()) return res.status(503).json({ error: "Apollo not configured" });
  if (!process.env.APIFY_API_TOKEN) return res.status(503).json({ error: "APIFY_API_TOKEN not configured" });

  // Per-run cap. 2 pages × 25 = 50 candidates per cycle. With Apify verify
  // cost ($0.005 per candidate) + people-match (2 credits per ICP-fit, async
  // via drain), the per-run hard cost is ~$0.25 + ~30-50 credits.
  const PAGES_PER_RUN = Math.max(1, Math.min(5, Number(req.query.pages) || 2));
  const TARGET_USER = (req.query.userId || "u1").toString();
  const customTech = (req.query.tech || "").toString().trim();
  const state = loadTechDiscoverState();
  const tech = customTech || TECH_DISCOVER_UIDS[state.techCursor % TECH_DISCOVER_UIDS.length];
  if (!customTech) state.techCursor = (state.techCursor + 1) % TECH_DISCOVER_UIDS.length;

  const stats = {
    tech,
    pagesScanned: 0,
    candidatesSeen: 0,
    skippedDuplicates: 0,
    skippedOversized: 0,
    enrichmentChecked: 0,
    candidatesPassedApolloFilter: 0,
    verifiedActive: 0,
    verifiedInactive: 0,
    leadsAppended: 0,
    errors: 0,
  };

  // 1. Scan Apollo by tech — collect candidates, then batch-verify with Apify
  const candidatesPassed = [];
  let apolloExhaustedOuter = false;
  for (let p = 1; p <= PAGES_PER_RUN; p++) {
    let candidates = [];
    try {
      candidates = await apolloSearchByTech({ techUid: tech, page: p, perPage: 25 });
      stats.pagesScanned++;
    } catch (e) {
      if (e && e.code === "APOLLO_CREDITS_EXHAUSTED") {
        console.error("[tech-discover] Apollo credits exhausted on search — breaking outer loop");
        stats.apolloExhausted = true;
        apolloExhaustedOuter = true;
        break;
      }
      console.warn(`[tech-discover] search ${tech}#${p} failed:`, e.message);
      stats.errors++;
      continue;
    }
    if (candidates.length === 0) break;

    for (const cand of candidates) {
      stats.candidatesSeen++;
      const dKey = (cand.domain || "").toLowerCase();
      if (!dKey || !cand.id) { stats.skippedDuplicates++; continue; }
      if (state.scannedDomains[dKey] || state.scannedOrgIds[cand.id]) {
        stats.skippedDuplicates++;
        continue;
      }
      state.scannedDomains[dKey] = new Date().toISOString();
      state.scannedOrgIds[cand.id] = true;

      // Confirm DK + 5-50 emp via org-enrich (search filter is advisory)
      let orgEnrich = null;
      try {
        orgEnrich = await apolloOrgEnrich(cand.domain);
        stats.enrichmentChecked++;
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        if (e && e.code === "APOLLO_CREDITS_EXHAUSTED") {
          console.error("[tech-discover] Apollo credits exhausted — breaking inner loop");
          stats.apolloExhausted = true;
          break;
        }
        stats.errors++;
        continue;
      }
      if (!orgEnrich) continue;
      // ICP gate — DK + 1-15 emp + 2-15M DKK revenue (passesIcpGate handles
      // null fields gracefully: unknown = include).
      const enrichedEmp = orgEnrich.estimatedEmployees || cand.employees;
      if (!passesIcpGate(orgEnrich, enrichedEmp)) {
        if (orgEnrich.country && orgEnrich.country !== "Denmark") stats.skippedNotDk = (stats.skippedNotDk||0)+1;
        else stats.skippedOversized++;
        continue;
      }
      if (!enrichedEmp || enrichedEmp < 5) continue;
      stats.candidatesPassedApolloFilter++;

      candidatesPassed.push({
        cand: {
          ...cand,
          phone: cand.phone || orgEnrich.phone || "",
          employees: enrichedEmp,
          industry: cand.industry || orgEnrich.industry || "",
          city: cand.city || orgEnrich.city || "",
        },
        orgEnrich,
      });
    }
    // If the inner loop set apolloExhausted (via apolloOrgEnrich 422),
    // bail the outer page loop too — every following page would also 422.
    if (stats.apolloExhausted) { apolloExhaustedOuter = true; break; }
  }

  // 2. Batch live-Meta verify the passed candidates — the same step that
  //    keeps quality high in apollo-discover. Tech signal alone isn't proof
  //    of current Meta-ad activity.
  const verifyMap = new Map();
  if (candidatesPassed.length > 0) {
    try {
      const startUrls = candidatesPassed.map(({ cand }) => {
        const brand = brandForMetaAdsSearch(cand.name);
        return { url: buildAdsLibraryUrl(brand), _domain: cand.domain.toLowerCase() };
      });
      const items = await apifyVerifyMetaAds(startUrls);
      const urlToDomain = new Map(startUrls.map((s) => [s.url, s._domain]));
      const byUrl = new Map();
      for (const it of items) {
        const u = it.inputUrl;
        if (!byUrl.has(u)) byUrl.set(u, []);
        byUrl.get(u).push(it);
      }
      const checkedAt = new Date().toISOString();
      for (const [url, group] of byUrl) {
        const domain = urlToDomain.get(url);
        if (!domain) continue;
        const c = classifyAdActivity(group);
        verifyMap.set(domain, { active: c.recent90d > 0, activeNow: c.activeNow, recent90d: c.recent90d, totalCount: c.total, checkedAt });
      }
      stats.verifiedActive = [...verifyMap.values()].filter((v) => v.active).length;
      stats.verifiedInactive = [...verifyMap.values()].filter((v) => !v.active).length;
    } catch (e) {
      console.warn("[tech-discover] Apify verify failed:", e.message);
      stats.errors++;
    }
  }

  // 3. Append verified-active leads
  for (const { cand, orgEnrich } of candidatesPassed) {
    const verify = verifyMap.get((cand.domain || "").toLowerCase());
    if (!verify || !verify.active) continue; // hard gate: must be currently advertising

    try {
      const ud = loadUserData(TARGET_USER);
      if (!ud.leads) ud.leads = [];
      const syntheticCvr = `tech-${cand.id}`;
      const dupByCvr = ud.leads.some((l) => l.cvr === syntheticCvr);
      const dupByDomain = ud.leads.some((l) => (l.web || "").toLowerCase() === cand.domain.toLowerCase());
      const dupByApolloId = ud.leads.some((l) => l.cvr === `apollo-${cand.id}`);
      const dupByMetaId = ud.leads.some((l) => l.meta_page_id && l.web && l.web.toLowerCase() === cand.domain.toLowerCase());
      if (dupByCvr || dupByDomain || dupByApolloId || dupByMetaId) continue;

      const hasPhone = !!(cand.phone || "").toString().trim();
      ud.leads.push({
        cvr: syntheticCvr,
        name: cand.name,
        addr: "",
        zip: "",
        city: cand.city,
        ph: cand.phone || "",
        em: "",
        web: cand.domain,
        ind: cand.industry,
        ic: "",
        emp: typeof cand.employees === "number" ? String(cand.employees) : "",
        emps: cand.employees,
        st: "aktiv",
        yr: "",
        form: "",
        eq: 0, res: 0, omsaetning: 0,
        source: `tech-discover-${tech}`,
        icpFit: true,
        meta_advertiser: true,
        ad_signals: [`Apollo tech: ${tech}`, "Meta Ad Library (live)"],
        meta_verified_active: true,
        meta_verified_at: verify.checkedAt,
        meta_live_ad_count: verify.totalCount,
        apollo_company: orgEnrich,
        apollo_enrichment_pending: isApolloConfigured(),
        apollo_enriched_at: null,
        phone_missing: !hasPhone,
        discovered_at: verify.checkedAt,
        pushed_to_cloudtalk_at: null,
        twenty_opportunity_id: null,
        tech_signal: tech,
      });
      saveUserData(TARGET_USER, ud);
      stats.leadsAppended++;
      logActivity(
        "advertiser",
        `🛠 Tech+ads: ${cand.name} (${tech} + Meta live)`,
        { domain: cand.domain, userId: TARGET_USER, source: `tech-discover-${tech}`, tech },
      );
    } catch (e) {
      stats.errors++;
      console.warn("[tech-discover] append failed:", cand.name, e.message);
    }
  }

  state.lastRunAt = new Date().toISOString();
  saveTechDiscoverState(state);
  logActivity(
    "discovery",
    `Tech-discover (${tech}): ${stats.candidatesSeen} kandidater · ${stats.candidatesPassedApolloFilter} ICP · ${stats.verifiedActive} live · ${stats.leadsAppended} tilføjet`,
    { stats, userId: TARGET_USER },
  );
  console.log("[tech-discover] done:", JSON.stringify(stats));
  res.json({ ok: true, stats, nextTech: TECH_DISCOVER_UIDS[state.techCursor % TECH_DISCOVER_UIDS.length] });
});

// ─── BRANCHE-WALK DISCOVERY ──────────────────────────────────────────────
// 5th discovery source. Walks the DK CVR registry directly via Datafordeler
// by DB07 industry code. Critical property: spends ZERO Apollo /match
// credits at discovery — only the FREE org-enrich call (for revenue ICP
// gate + marketing-tech detection). The Apollo /match credit is deferred
// to cockpit-open via the "Find beslutningstager" button.
//
// Five quality gates (parity with meta-ads-discover's "verified active ad"
// signal):
//   1. DB07 code in DTC-heavy whitelist (consumer-facing industries only)
//   2. Datafordeler status == "aktiv" (filters dissolved/inactive)
//   3. Apollo finds the org (proxies "is this a real business")
//   4. Marketing tech in Apollo's tech stack (proxies "marketing-active")
//   5. passesIcpGate (DK + 1-15 emp + 2-15M DKK revenue)
//
// Rotation: 1 DB07 code per cron run, advancing cursor by 1. 21 codes ×
// 2 cycles/day Mon-Fri = each code hit ~2× per month. Fresh slices.
const BRANCHE_WALK_STATE_FILE = path.join(DATA_DIR, "discovery", "branche_walk_discover.json");
// PR5 (2026-06-11): Tightened to known marketing-buyer industries only.
// Casper saw 155/276 daily leads come from Tandlæger (dentists) — none
// of which run Meta ads. Removed all healthcare + single-person
// service industries that historically don't invest in marketing:
//   - 862100 Tandlæger  (dentists — family practice, low Meta spend)
//   - 869090 Fysioterapi (physiotherapy — small clinics)
//   - 960210 Frisør     (hairdressers — single-chair shops)
//   - 961040 Wellness   (broad/variable, mostly small)
// Result: queue drops from ~155 branche-walk noise → ~50 quality leads
// per day, all from industries that demonstrably advertise.
const BRANCHE_WALK_CODES = [
  // Food + hospitality (high Meta-ad activity, especially restaurants
  // with delivery + cafes/hotels with seasonal campaigns)
  { code: "561010", label: "Restauranter"      },
  { code: "563000", label: "Cafeer"            },
  { code: "472100", label: "Bagerier"          },
  { code: "551110", label: "Hoteller"          },
  // Beauty (commercial-scale clinics only; skipped Frisør + Wellness
  // which skew tiny). Skønhedsklinikker advertise aesthetic treatments.
  { code: "960220", label: "Skønhedsklinik"    },
  // Fitness (commercial gym chains, NOT amateur sports clubs)
  { code: "931300", label: "Fitnesscenter"     },
  // Retail (consumer-facing — heavy paid social)
  { code: "477110", label: "Tøjbutik"          },
  { code: "477210", label: "Skobutik"          },
  { code: "475100", label: "Møbler"            },
  // Removed 477820 (mis-labeled "Interiør"; DB07 477820 is actually
  // "Detailhandel med fotografisk udstyr" → photo studios + film shops.
  // 100 of 101 leads from this code today were small photo studios
  // that don't run Meta ads. Use 4759* if we want real interior shops.)
  // E-commerce — strongest signal in the rotation. Internet retail by
  // definition needs paid acquisition.
  { code: "479110", label: "Detailhandel internet" },
  { code: "478990", label: "Anden detailhandel"    },
  // Pro services with high marketing intent. Marketing-bureau is our
  // own ICP — they sell the service we sell.
  { code: "731000", label: "Marketing-bureau"  },
  { code: "741010", label: "Design/web"        },
  { code: "683210", label: "Ejendomsmægler"    },
  { code: "791100", label: "Rejsebureau"       },
  // Optics — chain stores advertise heavily
  { code: "477800", label: "Optikere"          },
  // Phase 1 expansion (2026-06-16): more ICP-relevant DB07 codes for
  // DK SMBs that buy paid acquisition / video. Each surfaces 500-3000
  // companies in Datafordeler; combined with Meta Ad Library scoring,
  // we get a wider net of marketing-active candidates.
  { code: "475250", label: "Belysning"         },
  { code: "475440", label: "Glas/keramik"      },
  { code: "476420", label: "Sport"             },
  { code: "476500", label: "Spil/legetøj"      },
  { code: "477630", label: "Blomster"          },
  { code: "477640", label: "Dyr/foder"         },
  { code: "477990", label: "Anden detail"      },
  { code: "563000", label: "Caféer/cafeterier" },
  { code: "742010", label: "Fotograf-erhverv"  },
  { code: "961040", label: "Wellness/skønhed"  },
];

// Marketing-tech regex applied to Apollo's technology_names list.
// Presence of ANY of these tools => marketing-active. We're deliberately
// generous here — even basic GA + FB Pixel signals a company that
// invests in funnel measurement, which is our buyer profile.
const MARKETING_TECH_RE = /\b(facebook pixel|meta pixel|meta ads|facebook ads|google ads|google analytics|google tag manager|klaviyo|mailchimp|active.?campaign|hubspot|omnisend|shopify|woocommerce|magento|bigcommerce|stripe|klarna|tiktok pixel|tiktok ads|linkedin insight|hotjar|segment|attentive|gorgias|yotpo)\b/i;

// Non-commercial name patterns. CVR data includes amateur sports clubs,
// church councils, schools, foundations, municipalities — entities that
// have CVR numbers but aren't marketing-buyer companies. Drop them at
// the branche-walk save step so the autodialer queue stays commercial.
// Tested against today's branche-walk run: catches 60 of 80 noise leads
// (BOLDKLUB, FODBOLDFORENING, GOLF UNION, F.F., F.K., etc.) without
// false-positiving on legit company names.
const NON_COMMERCIAL_NAME_RE = /\b(klub|forening|union|stiftelse|fond|menighedsråd|menighed|kirke|kirkeråd|sogn|provsti|skole|skoler|aftenskole|gymnasium|børnehave|vuggestue|sfo|kommune|region|amt|forsamlingshus|idræt|idrætscenter|i\.?f\.|f\.?k\.|b\.?k\.|f\.?f\.|i\.?k\.|b\.?i\.?f\.|elite a\/s)\b/i;

function loadBrancheWalkState() {
  try {
    if (fs.existsSync(BRANCHE_WALK_STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(BRANCHE_WALK_STATE_FILE, "utf8"));
      return { codeCursor: 0, scannedCvrs: {}, lastRunAt: null, ...s };
    }
  } catch (e) { console.warn("[branche-walk] state load:", e.message); }
  return { codeCursor: 0, scannedCvrs: {}, lastRunAt: null };
}

function saveBrancheWalkState(s) {
  fs.mkdirSync(path.dirname(BRANCHE_WALK_STATE_FILE), { recursive: true });
  fs.writeFileSync(BRANCHE_WALK_STATE_FILE, JSON.stringify(s, null, 2));
}

app.post("/api/cron/branche-walk-discover", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isApolloConfigured()) return res.status(503).json({ error: "Apollo not configured" });

  const TARGET_USER = (req.query.userId || "u1").toString();
  // Hard cap on Apollo lookups per run. Apollo find-company match rate
  // for small DK SMBs varies 5-30% by industry (restaurants ~27%,
  // micro-salons ~5%), so we need ~80 lookups to land 5-15 ICP-fit
  // candidates after all gates. Each lookup is ~1s, so 80 × 1s = ~80s
  // per run, well under the 1800s scheduler attempt-deadline.
  const MAX_CANDIDATES_TO_APOLLO = Math.max(20, Math.min(200, Number(req.query.limit) || 120));

  const state = loadBrancheWalkState();
  // Override cursor via ?code=XXXXXX for manual smoke-test runs
  const customCode = String(req.query.code || "").trim();
  const codeEntry = customCode
    ? { code: customCode, label: `manual:${customCode}` }
    : BRANCHE_WALK_CODES[state.codeCursor % BRANCHE_WALK_CODES.length];
  if (!customCode) state.codeCursor = (state.codeCursor + 1) % BRANCHE_WALK_CODES.length;

  const stats = {
    db07: codeEntry.code,
    label: codeEntry.label,
    dfCandidatesRaw: 0,
    dfCandidatesActive: 0,
    skippedDupCvr: 0,
    skippedAlreadyInDialer: 0,
    apolloLookups: 0,
    apolloMatched: 0,
    apolloMatchMissed: 0,
    skippedNoMarketingTech: 0,
    skippedIcpFail: 0,
    leadsAppended: 0,
    errors: 0,
  };
  const checkedAt = new Date().toISOString();

  // ─── STEP 1 — Datafordeler walk by DB07 code ──────────────────────────
  const enhedsIds = new Set();
  let cursor = null;
  for (let p = 0; p < 3; p++) {
    try {
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      const r = await dfGqlFetch(
        `{ CVR_Branche(first: 1000${afterClause}, where: { vaerdi: { eq: "${codeEntry.code}" } }) { pageInfo { hasNextPage endCursor } edges { node { CVREnhedsId } } } }`,
      );
      const d = r?.CVR_Branche;
      for (const e of (d?.edges || [])) enhedsIds.add(e.node.CVREnhedsId);
      if (!d?.pageInfo?.hasNextPage) break;
      cursor = d.pageInfo.endCursor;
    } catch (e) {
      console.warn("[branche-walk] DF walk failed:", e.message);
      stats.errors++;
      break;
    }
  }
  stats.dfCandidatesRaw = enhedsIds.size;
  if (enhedsIds.size === 0) {
    // PR1: save state BEFORE returning. Otherwise the codeCursor advance
    // we did at the top of the handler stays in memory only and never
    // hits disk — next run loads the old cursor and tries the SAME
    // empty branche forever. Today we burned three cron fires looping
    // on code 961040 with "no DF candidates" for exactly this reason.
    saveBrancheWalkState(state);
    console.log("[branche-walk] no DF candidates for", codeEntry.code, "— cursor advanced to next branche");
    return res.json({ ok: true, stats, note: "no DF candidates" });
  }

  // ─── STEP 2 — Enrich DF candidates with name/cvr/phone/employees/status
  const ids = [...enhedsIds].slice(0, MAX_CANDIDATES_TO_APOLLO * 3); // overshoot — many will be filtered
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const navnMap = new Map(), adrMap = new Map(), tlfMap = new Map();
  const beskMap = new Map(), vrkMap = new Map();
  for (const batch of chunk(ids, 100)) {
    const idList = batch.map((id) => `"${id}"`).join(",");
    const w = `CVREnhedsId: { in: [${idList}] }`;
    const sz = batch.length;
    try {
      const [rN, rA, rT, rBe, rV] = await Promise.all([
        dfGqlFetch(`{ CVR_Navn(first: ${sz * 6}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
        dfGqlFetch(`{ CVR_Adressering(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId CVRAdresse_postnummer CVRAdresse_postdistrikt } } } }`),
        dfGqlFetch(`{ CVR_Telefonnummer(first: ${sz * 3}, where: { ${w} }) { edges { node { CVREnhedsId vaerdi } } } }`),
        dfGqlFetch(`{ CVR_Beskaeftigelse(first: ${sz}, where: { ${w} }) { edges { node { CVREnhedsId antal intervalFra intervalTil } } } }`),
        dfGqlFetch(`{ CVR_Virksomhed(first: ${sz}, where: { id: { in: [${idList}] } }) { edges { node { id CVRNummer status } } } }`),
      ]);
      for (const e of rN?.CVR_Navn?.edges || []) {
        if (!navnMap.has(e.node.CVREnhedsId)) navnMap.set(e.node.CVREnhedsId, []);
        navnMap.get(e.node.CVREnhedsId).push(e.node.vaerdi);
      }
      for (const e of rA?.CVR_Adressering?.edges || []) adrMap.set(e.node.CVREnhedsId, e.node);
      for (const e of rT?.CVR_Telefonnummer?.edges || []) {
        const v = String(e.node.vaerdi || "").trim();
        if (v) tlfMap.set(e.node.CVREnhedsId, v);
      }
      for (const e of rBe?.CVR_Beskaeftigelse?.edges || []) beskMap.set(e.node.CVREnhedsId, e.node);
      for (const e of rV?.CVR_Virksomhed?.edges || []) vrkMap.set(e.node.id, e.node);
    } catch (e) {
      console.warn("[branche-walk] DF enrich batch failed:", e.message);
      stats.errors++;
    }
  }

  // ─── STEP 3 — Filter on active + employee range + dedup vs scanned/dialer
  const dialerUd = loadUserData(TARGET_USER);
  const dialerCvrs = new Set((dialerUd.leads || []).map((l) => String(l.cvr)));
  const candidatesForApollo = [];
  for (const eid of ids) {
    const vrk = vrkMap.get(eid);
    if (!vrk) continue;
    if (vrk.status !== "aktiv") continue;
    stats.dfCandidatesActive++;
    const cvr = String(vrk.CVRNummer || "");
    if (!cvr) continue;
    if (state.scannedCvrs[cvr]) { stats.skippedDupCvr++; continue; }
    if (dialerCvrs.has(cvr)) { stats.skippedAlreadyInDialer++; continue; }
    const besk = beskMap.get(eid) || {};
    const employees = besk.antal ?? besk.intervalFra ?? null;
    // Hard employee filter at DF level (1-15) — Apollo's number may
    // differ, but the CVR-reported antal is the trust-anchor for DK.
    if (employees != null && (employees < APOLLO_DISCOVER_MIN_EMPLOYEES || employees > APOLLO_DISCOVER_MAX_EMPLOYEES)) continue;
    const names = navnMap.get(eid) || [];
    const adr = adrMap.get(eid) || {};
    candidatesForApollo.push({
      cvr,
      enhedsId: eid,
      name: names[0] || "",
      city: adr.CVRAdresse_postdistrikt || "",
      zip: adr.CVRAdresse_postnummer || "",
      phone: tlfMap.get(eid) || "",
      employees,
    });
    if (candidatesForApollo.length >= MAX_CANDIDATES_TO_APOLLO) break;
  }

  // ─── STEP 3.5 (PR5: Option B) — Apify Meta Ad Library verify ────────
  // Branche-walk's biggest weakness was "ICP on paper but no ad proof".
  // Casper called it out: 'low quality ones - missing quality check on
  // META ads - no relevant persons connected - no prove that these are
  // ICPs'. Fix: batch-verify each Datafordeler candidate against Meta
  // Ad Library. Keep ONLY ones with name-matched ads in the last 90
  // days. Same quality bar as meta-ads-discover.
  //
  // Cost: ~$0.025/candidate × ~40 candidates/run = ~$1/run × 4 runs/day
  //       = ~$4/day = ~$88/month Apify on top of existing spend.
  //
  // Pre-verify count is captured in stats so we can see verify hit-rate.
  stats.preVerifyCount = candidatesForApollo.length;
  stats.metaVerifyAttempted = 0;
  stats.metaVerified = 0;
  stats.metaVerifyNoAds = 0;
  stats.metaVerifyNameMismatch = 0;
  if (candidatesForApollo.length > 0 && process.env.APIFY_API_TOKEN) {
    const verifyStartUrls = candidatesForApollo.map((cand) => ({
      url: buildAdsLibraryUrl(brandForMetaAdsSearch(cand.name)),
      _cvr: cand.cvr,
      _name: cand.name,
    }));
    stats.metaVerifyAttempted = verifyStartUrls.length;
    let verifyItems = null;
    try {
      const token = process.env.APIFY_API_TOKEN;
      const input = {
        startUrls: verifyStartUrls.map((s) => ({ url: s.url })),
        onlyTotal: false,
        resultsLimit: 5, // need pageNames + dates for name match + 90d check
      };
      const startResp = await fetch(
        `https://api.apify.com/v2/acts/apify~facebook-ads-scraper/runs?token=${token}&memory=2048&timeout=3600`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
      );
      if (!startResp.ok) throw new Error(`Apify start ${startResp.status}: ${(await startResp.text()).slice(0, 300)}`);
      const { data: run } = await startResp.json();
      const t0 = Date.now();
      let status = run.status;
      let runData = run;
      while (status === "READY" || status === "RUNNING") {
        if (Date.now() - t0 > 20 * 60 * 1000) throw new Error("Apify verify timeout");
        await new Promise((r) => setTimeout(r, 5000));
        const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
        if (!poll.ok) continue;
        runData = (await poll.json()).data;
        status = runData.status;
      }
      if (status !== "SUCCEEDED") throw new Error(`Apify ended ${status}`);
      const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${token}&format=json`);
      if (!itemsResp.ok) throw new Error(`Apify items fetch ${itemsResp.status}`);
      verifyItems = await itemsResp.json();
    } catch (e) {
      console.warn("[branche-walk] Meta verify failed — proceeding without filter:", e.message);
      stats.metaVerifyError = e.message;
      // Conservative fallback: when verify fails, SKIP saving this run
      // entirely. Casper picked Option B explicitly because he doesn't
      // want unverified leads polluting the queue. Better 0 leads now
      // than a flood of dentists.
      verifyItems = null;
      candidatesForApollo.length = 0;
    }
    if (verifyItems) {
      // Group items by inputUrl → list, then match per candidate.
      const urlToMeta = new Map(verifyStartUrls.map((s) => [s.url, s]));
      const itemsByCvr = new Map();
      for (const item of verifyItems) {
        const meta = urlToMeta.get(item.inputUrl);
        if (!meta) continue;
        if (!itemsByCvr.has(meta._cvr)) itemsByCvr.set(meta._cvr, []);
        itemsByCvr.get(meta._cvr).push(item);
      }
      const verified = [];
      for (const cand of candidatesForApollo) {
        const items = itemsByCvr.get(cand.cvr) || [];
        if (items.length === 0) { stats.metaVerifyNoAds++; continue; }
        // Filter to ads whose pageName matches the COMPANY (strict — same
        // logic as verify-leads. Defends against Meta keyword hits in
        // unrelated ads' copy.)
        const matched = items.filter((it) => {
          const pn = it.pageName || it.snapshot?.pageName || "";
          return advertiserMatchesCompany(pn, cand.name);
        });
        if (matched.length === 0) { stats.metaVerifyNameMismatch++; continue; }
        const activity = classifyAdActivity(matched);
        if (activity.recent90d === 0) { stats.metaVerifyNoAds++; continue; }
        verified.push({
          ...cand,
          meta_ads_active_now: activity.activeNow,
          meta_ads_recent90d: activity.recent90d,
          meta_ads_total: activity.total,
          meta_verified_at: new Date().toISOString(),
        });
      }
      candidatesForApollo.length = 0;
      candidatesForApollo.push(...verified);
      stats.metaVerified = verified.length;
    }
  }

  // ─── STEP 4 (PR2 + PR5) — Save Meta-verified Datafordeler candidates.
  // After STEP 3.5 these all have meta_ads_recent90d > 0 + name-matched
  // pageName. Real ICP: size + industry + DK + currently advertising.
  // Contacts still fetched on cockpit-open via auto-reveal (Lusha/Apollo).
  // PR3 (2026-06-10): Branche-walk goes Datafordeler-DIRECT.
  // Why: today we got 14 callable / 183 discovered = 8% pass rate
  // because most leads couldn't be ICP-verified against Apollo (76% of
  // archives = "Apollo: ikke fundet"). Branche-walk leads already have
  // CVR + employees + phone from Datafordeler — they're DK SMBs in
  // pre-curated industries by definition. We don't need Apollo's blessing
  // to consider them ICP-fit. Mark icpFit=true at discovery time, skip
  // the drain pipeline entirely. Contacts can be fetched on-demand in
  // the cockpit via "Find beslutningstager" when the SDR actually opens
  // the lead.
  //
  // Cost: every branche-walk lead now lands callable immediately.
  // Saves: 1-2 Apollo credits per branche-walk lead × ~120 leads/day =
  // 120-240 credits/day freed up for meta-ads/gmaps/linkedin drain work.
  // Trade-off: branche-walk leads lack the "currently advertising"
  // signal. The cockpit priority sort handles this — meta_advertiser=true
  // leads float to top; branche-walk leads come second.
  for (const cand of candidatesForApollo) {
    if (!cand.name) continue;
    state.scannedCvrs[cand.cvr] = checkedAt;
    // Quality gate: drop non-commercial entities (sports clubs, churches,
    // schools, foundations etc.) that have CVR numbers but aren't real
    // marketing buyers. Catches the noise that broad DB07 codes pull in.
    if (NON_COMMERCIAL_NAME_RE.test(cand.name)) {
      stats.skippedNonCommercial = (stats.skippedNonCommercial || 0) + 1;
      continue;
    }
    try {
      const ud = loadUserData(TARGET_USER);
      const dupByCvr = (ud.leads || []).some((l) => String(l.cvr) === cand.cvr);
      if (dupByCvr) { stats.skippedAlreadyInDialer++; continue; }
      const phone = cand.phone || "";
      ud.leads.push({
        cvr: cand.cvr,
        name: cand.name,
        addr: "",
        zip: cand.zip,
        city: cand.city,
        ph: phone,
        em: "",
        web: "",
        ind: codeEntry.label,
        ic: codeEntry.code,
        emp: typeof cand.employees === "number" ? String(cand.employees) : "",
        emps: cand.employees || null,
        st: "aktiv",
        yr: "",
        form: "",
        eq: 0,
        res: 0,
        omsaetning: 0,
        source: `branche-walk-${codeEntry.code}`,
        source_label: codeEntry.label,
        source_category: deriveSourceCategory(`branche-walk-${codeEntry.code}`, codeEntry.code),
        // PR5: Datafordeler-direct AND Meta-verified. Real ICP — size +
        // industry + DK + currently advertising on Meta. Same quality
        // bar as meta-ads-discover leads.
        icpFit: true,
        meta_advertiser: true,
        meta_verified_active: cand.meta_ads_active_now > 0,
        meta_verified_at: cand.meta_verified_at,
        meta_ads_active_now: cand.meta_ads_active_now || 0,
        meta_ads_recent90d: cand.meta_ads_recent90d || 0,
        meta_ads_total_in_library: cand.meta_ads_total || 0,
        ad_signals: [
          cand.meta_ads_active_now > 0
            ? `${cand.meta_ads_active_now} aktive ad${cand.meta_ads_active_now === 1 ? "" : "s"} på Meta`
            : `${cand.meta_ads_recent90d} ad${cand.meta_ads_recent90d === 1 ? "" : "s"} sidste 90 dage`,
        ],
        marketing_tech_match: "",
        apollo_company: null,
        // Skip drain — no apollo_enrichment_pending. SDR fetches contacts
        // on-demand in cockpit via "Find beslutningstager".
        apollo_enrichment_pending: false,
        apollo_enrichment_deferred: true,
        apollo_enriched_at: null,
        phone_missing: !phone,
        discovered_at: checkedAt,
        pushed_to_cloudtalk_at: null,
        twenty_opportunity_id: null,
      });
      saveUserData(TARGET_USER, ud);
      stats.rawAppended = (stats.rawAppended || 0) + 1;
    } catch (e) {
      stats.errors++;
      console.warn("[branche-walk] candidate failed:", cand.name, e.message);
    }
  }

  state.lastRunAt = checkedAt;
  // Garbage-collect scannedCvrs older than 60 days to keep state lean.
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const [cvr, ts] of Object.entries(state.scannedCvrs)) {
    if (new Date(ts).getTime() < cutoff) delete state.scannedCvrs[cvr];
  }
  saveBrancheWalkState(state);

  logActivity(
    "discovery",
    `Branche-walk (${codeEntry.label}): ${stats.dfCandidatesActive} aktive · ${stats.metaVerifyAttempted || 0} Meta-verify'd · ${stats.metaVerified || 0} bestod · ${stats.rawAppended || 0} ICP-klar leads tilføjet`,
    { stats, userId: TARGET_USER },
  );
  console.log("[branche-walk] done:", JSON.stringify(stats));
  res.json({ ok: true, stats, nextCode: BRANCHE_WALK_CODES[state.codeCursor % BRANCHE_WALK_CODES.length] });
});

// ── META ADS-FIRST DISCOVERY ────────────────────────────────────────
// Architectural pivot from Apollo-first. The old path was:
//
//   Apollo says "has Meta pixel" → maybe still advertising? → guess
//   brand name → exact phrase match Meta → 25-40% false positives
//
// The new path is:
//
//   Meta Ad Library: who is CURRENTLY running ads in DK right now?
//   → dedupe by pageId → resolve each pageName in Apollo →
//   → apply ICP filter (DK + 5-50 emp) → append lead with
//   → meta_verified_active=true baked in
//
// Why this is structurally better: every lead starts from ground truth
// (verified currently advertising). No more name-matching guesswork —
// Meta tells us the page name directly. Apollo's role narrows from
// "discovery + enrichment" to pure enrichment (employees, country,
// people contacts).
//
// Cost: ~$2/run on Apify (400 ads × $0.005 BRONZE) + Apollo's people-
// match for the ICP-fit subset (~2 credits each). One run/day fits the
// $50 Apify overage ceiling + 4k Apollo monthly credit.

const META_ADS_DISCOVER_STATE_FILE = path.join(DATA_DIR, "discovery", "meta_ads_discover.json");

// ─── Non-DK brand blocklist ───────────────────────────────────────
// Big international brands run Meta ads in DK but aren't DK companies.
// We reject them at meta-ads-discover intake AND in a periodic sweep.
// Match is case-insensitive substring on the Meta pageName / lead name,
// anchored with word-boundaries so "Apple" won't match "Pineapplecake".
// Grow this list whenever a brand appears in the queue that shouldn't.
const NON_DK_BRAND_BLOCKLIST = [
  // US tech / e-commerce
  "AT&T", "Apple", "Amazon", "Google", "Microsoft", "Meta",
  "Netflix", "Disney", "Spotify", "Uber", "Airbnb", "PayPal", "Stripe",
  "Shopify", "Wix", "Squarespace", "Zoom", "Adobe", "Oracle", "Salesforce",
  "IBM", "Intel", "Dell", "Tesla", "Ford", "Toyota",
  // SaaS / B2B
  "Atlassian", "Slack", "Notion", "Asana", "Monday.com", "HubSpot",
  "Mailchimp", "Klaviyo", "Intercom", "Zendesk", "Twilio", "Cloudflare",
  // Travel / OTA
  "Booking.com", "Expedia", "Trivago", "Hotels.com", "TripAdvisor",
  "Skyscanner", "Kayak", "Vrbo", "Agoda",
  // UK / EU e-com that just runs DK ads
  "WeightWorld", "ASOS", "Boohoo", "Zalando", "Wish",
  // Telecom
  "Vodafone", "Verizon", "T-Mobile",
  // Misc global
  "Coca-Cola", "Nike", "Adidas", "McDonald", "Starbucks",
  "L'Oréal", "Loreal", "Unilever", "Nestlé", "Nestle", "Samsung",
  "Huawei", "Xiaomi", "Sony", "Panasonic",
];
function looksLikeNonDkBrand(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase().trim();
  for (const brand of NON_DK_BRAND_BLOCKLIST) {
    const b = brand.toLowerCase();
    const idx = lower.indexOf(b);
    if (idx < 0) continue;
    const before = idx === 0 || /[^a-zæøå0-9]/.test(lower[idx - 1]);
    const after  = idx + b.length === lower.length || /[^a-zæøå0-9]/.test(lower[idx + b.length]);
    if (before && after) return true;
  }
  return false;
}

// DK-company evidence check — phone recovery gates on this so we don't
// attach a phone to a lead unless we have at least one signal that it's
// actually a Danish company.
function hasDkCompanyEvidence(lead) {
  if (!lead) return false;
  if (/^\d{8}$/.test(String(lead.cvr || ""))) return true;
  if (/^\d{8}$/.test(String(lead.df_cvr_match || ""))) return true;
  const web = String(lead.web || lead.website || "").toLowerCase();
  if (/\.dk(\/|$|\?)/.test(web)) return true;
  const apolloCountry = String((lead.apollo_company && lead.apollo_company.country) || "").toLowerCase();
  if (apolloCountry === "denmark" || apolloCountry === "dk") return true;
  const zip = String(lead.zip || "").trim();
  if (/^\d{4}$/.test(zip) && Number(zip) >= 800 && Number(zip) <= 9999) return true;
  const ph = String(lead.phone || lead.ph || "").replace(/[\s\-\(\)]/g, "");
  if (ph.startsWith("+45") || /^\d{8}$/.test(ph)) return true;
  return false;
}

// ─── DK-company verification via Datafordeler ─────────────────────────
// Takes an advertiser name (from Meta/LinkedIn ad scrape) and tries to
// find a real registered DK business with that legal name. Returns the
// full DF company record (with phone, address, emp interval, branche) on
// success, or null. Free — no Apollo credits charged.
//
// Used at intake to filter the firehose of "ads shown in DK" down to
// "registered DK businesses we can actually call." Verified leads land
// in the autodialer with phone + CVR + ICP data already populated; non-
// matches are dropped (they were going to "needs research" purgatory
// anyway).
async function tryDfVerifyDkCompany(rawName) {
  if (!rawName) return null;
  const name = String(rawName).trim();
  if (name.length < 3) return null;
  // Try several name variants — DK companies are registered with legal
  // form suffixes (A/S, ApS) but advertise under the bare brand. We
  // also try UPPERCASE because some DF entries are all-caps.
  const variants = [
    name,
    `${name} A/S`, `${name} ApS`, `${name} IVS`,
    name.toUpperCase(),
    `${name.toUpperCase()} A/S`, `${name.toUpperCase()} ApS`,
  ];
  for (const v of variants) {
    try {
      const r = await dfGqlFetch(
        `{ CVR_Navn(first: 3, where: { vaerdi: { eq: "${v.replace(/"/g, '\\"')}" } }) { edges { node { CVREnhedsId vaerdi } } } }`,
      );
      const hit = r?.CVR_Navn?.edges?.[0]?.node;
      if (!hit) continue;
      // CVR_Navn returns the historical entry — pull current CVR number
      const r2 = await dfGqlFetch(
        `{ CVR_Virksomhed(first: 1, where: { id: { eq: "${hit.CVREnhedsId}" } }) { edges { node { CVRNummer } } } }`,
      );
      const cvrNr = r2?.CVR_Virksomhed?.edges?.[0]?.node?.CVRNummer;
      if (!cvrNr) continue;
      try {
        const company = await lookupDatafordeler(String(cvrNr));
        if (company && company.cvr) return company;
      } catch (_) { /* try next variant */ }
    } catch (_) { /* try next variant */ }
  }
  return null;
}

// Heuristic ICP-by-emp gate using Datafordeler's interval data.
// DF reports employees as intervals (intervalFra/intervalTil), not exact
// counts. We treat the LOWER bound as the size signal: if a company is
// "100-249 employees", intervalFra=100 fails our 1-25 cap. Returns true
// if the lead passes (or no emp data — give benefit of doubt).
function dfEmpPassesIcp(dfCompany) {
  if (!dfCompany) return false;
  // emp field may be "10-19" interval string or exact number
  const emp = String(dfCompany.emp || dfCompany.emps || "").trim();
  if (!emp) return true; // no data → include
  const m = emp.match(/^(\d+)/);
  if (!m) return true;
  const low = Number(m[1]);
  return low <= 25;
}

// Broad Danish keywords used to surface DK advertisers from Meta Ad Library.
// Each run rotates through these via the keywordCursor in the state file so
// we sweep different slices of the active-ad pool over time. Picked for two
// properties: (1) common in DK ad copy (high recall) and (2) cross-industry
// (avoids over-indexing on one niche). Apify's actor REQUIRES a q= param —
// the no-keyword bulk URL returns 403 BLOCKED from Meta.
const META_DISCOVER_KEYWORDS = [
  // Geographic — generic DK signal
  "DK", "Danmark", "København", "Copenhagen", "Aarhus", "Odense", "Aalborg",
  "Esbjerg", "Frederiksberg", "Vejle",
  // Commerce intents
  "shop", "tilbud", "køb", "bestil", "online", "ny", "spar", "rabat",
  "udsalg", "gratis", "fragt", "levering", "abonnement", "box",
  "lancering", "kollektion", "nyhed",
  // Consumer verticals — fashion
  "mode", "tøj", "sko", "smykker", "ur", "taske", "accessories",
  "børnetøj", "herremode", "dametøj",
  // Beauty
  "skønhed", "skincare", "makeup", "hår", "parfume",
  "klinik", "wellness", "massage", "neglesalon",
  // Food + drink
  "mad", "kaffe", "vin", "økologisk", "snack",
  "øl", "spiritus", "gin", "te", "kosttilskud", "protein",
  // Home + interior
  "møbler", "interiør", "bolig", "hjem", "have",
  "lampe", "lys", "tæppe", "have & grill",
  // Lifestyle / experience
  "rejse", "ferie", "oplevelse", "fitness", "yoga", "pilates",
  // Family + pets
  "børn", "baby", "legetøj", "hund", "kat", "kæledyr", "foder",
  // Pro / hobby
  "sport", "cykel", "outdoor", "vandring", "ski",
  // Design / branding
  "design", "håndlavet", "håndværk", "kunst", "vintage",
  // Sustainability
  "bæredygtig", "genbrug", "økologi",
  // Gifts
  "gave", "julegave", "fødselsdag",
  // Plants + garden
  "planter", "blomster",
  // Q2 2026 expansion — niche DTC verticals + cities
  "Helsingør", "Næstved", "Holstebro", "Slagelse", "Roskilde",
  "kollektion", "drop", "premium", "håndplukket",
  "ren hud", "hudpleje", "selvbruner", "duft",
  "luksus", "designer", "særlig",
  "kost", "tilskud", "vitaminer", "raw",
  "fest", "konfirmation", "bryllup",
  "spil", "brætspil", "puslespil",
  "musik", "vinyl", "instrument",
];

function loadMetaAdsDiscoverState() {
  try {
    if (fs.existsSync(META_ADS_DISCOVER_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(META_ADS_DISCOVER_STATE_FILE, "utf8"));
    }
  } catch (e) { console.warn("[meta-ads-discover] state load:", e.message); }
  return { scannedPageIds: {}, lastRunAt: null, keywordCursor: 0 };
}

function saveMetaAdsDiscoverState(s) {
  fs.mkdirSync(path.dirname(META_ADS_DISCOVER_STATE_FILE), { recursive: true });
  fs.writeFileSync(META_ADS_DISCOVER_STATE_FILE, JSON.stringify(s, null, 2));
}

// Apify scrape of currently-running DK Meta ads for ONE keyword. Returns
// raw ad records, one per matching ad. Multiple ads from the same
// advertiser collapse via pageId dedup downstream.
// Each call uses ONE keyword (Apify's actor requires q= or Meta returns
// 403 BLOCKED). Caller rotates keywords across runs via state cursor.
async function apifyDiscoverDkMetaAds({ resultsLimit = 200, keyword }) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN not configured");
  if (!keyword) throw new Error("keyword required (no-keyword bulk scrape is BLOCKED by Meta)");
  const params = new URLSearchParams({
    // "all" includes recently-paused advertisers (last 90 days). Wider net
    // of companies actively investing in marketing infrastructure even if
    // they're between campaigns. classifyAdActivity() filters post-fetch.
    active_status: "all",
    ad_type: "all",
    country: "DK",
    media_type: "all",
    search_type: "keyword_unordered",
    q: keyword,
  });
  const url = `https://www.facebook.com/ads/library/?${params.toString()}`;
  const input = {
    startUrls: [{ url }],
    onlyTotal: false,
    resultsLimit,
  };
  const startResp = await fetch(
    `https://api.apify.com/v2/acts/apify~facebook-ads-scraper/runs?token=${token}&memory=2048&timeout=3600`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  if (!startResp.ok) {
    const body = await startResp.text();
    throw new Error(`Apify start failed ${startResp.status}: ${body.slice(0, 400)}`);
  }
  const { data: run } = await startResp.json();
  // Poll for completion
  const t0 = Date.now();
  const MAX_WAIT_MS = 25 * 60 * 1000;
  let status = run.status;
  let runData = run;
  while (status === "READY" || status === "RUNNING") {
    if (Date.now() - t0 > MAX_WAIT_MS) {
      throw new Error(`Apify discover timeout after ${(MAX_WAIT_MS / 60000).toFixed(0)}min`);
    }
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
    if (!poll.ok) continue;
    runData = (await poll.json()).data;
    status = runData.status;
  }
  if (status !== "SUCCEEDED") throw new Error(`Apify discover ended ${status}`);
  const itemsResp = await fetch(
    `https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${token}&format=json`,
  );
  if (!itemsResp.ok) throw new Error(`Apify items fetch ${itemsResp.status}`);
  return itemsResp.json();
}

// Dedup ads → unique advertisers. Some advertisers have many concurrent
// ads (3-50), so 400 ad results typically collapse to ~120-200 unique
// pageIds. We also drop advertisers we've already processed (state file)
// so each run produces FRESH discoveries.
function adsToUniqueAdvertisers(items, scannedPageIds) {
  // Group raw scraper items by advertiser pageId so we can classify
  // EACH advertiser's ad activity. Apify's facebook-ads-scraper returns
  // one item per ad — a single advertiser shows up N times if they have
  // N ads in the library. Previously we just deduped by pageId and
  // kept the first item, which meant "advertiser appears in library
  // for any reason" → save as lead. Too loose.
  //
  // PR4: TIGHTEN to "recent advertising activity". For each advertiser,
  // group their items, call classifyAdActivity, and DROP advertisers
  // where recent90d === 0 (no active ad, no ad ended within 90 days).
  // The 90-day window is what META_RECENT_WINDOW_DAYS controls. Result:
  // we only save companies that ARE running ads now or paused recently.
  const byPage = new Map();
  for (const it of items) {
    const pid = String(it.pageID || it.pageId || it.snapshot?.pageId || "");
    if (!pid) continue;
    if (scannedPageIds[pid]) continue; // already processed in a past run
    if (!byPage.has(pid)) byPage.set(pid, []);
    byPage.get(pid).push(it);
  }
  const fresh = [];
  for (const [pid, group] of byPage) {
    const activity = classifyAdActivity(group);
    // Hard gate: NO recent ads in 90 days → skip the advertiser. Without
    // this filter the queue fills with companies whose only ad ran 6+
    // months ago — not what an SDR wants to call.
    if (activity.recent90d === 0) continue;
    const it = group[0]; // pick the first ad as the breadcrumb sample
    fresh.push({
      pageId: pid,
      pageName: it.pageName || it.snapshot?.pageName || "",
      pageProfileUri: it.snapshot?.pageProfileUri || "",
      adArchiveId: String(it.adArchiveID || it.adArchiveId || ""),
      pageProfilePictureUrl: it.snapshot?.pageProfilePictureUrl || "",
      // Carry ad-activity stats so the lead can show them in UI + sort
      ads_active_now: activity.activeNow,
      ads_recent90d: activity.recent90d,
      ads_total_in_library: activity.total,
    });
  }
  return fresh;
}

app.post("/api/cron/meta-ads-discover", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!process.env.APIFY_API_TOKEN) {
    return res.status(503).json({ error: "APIFY_API_TOKEN not configured" });
  }
  // Per-call cost knobs. Each keyword scrape: resultsLimit × $0.005.
  // Default: 3 keywords × 100 ads = ~$1.50/run. 1 run/day = ~$45/mo.
  // ?keywords= overrides the rotation (comma-sep list); ?limit= sets
  // resultsLimit per keyword.
  const RESULTS_LIMIT = Math.max(30, Math.min(500, Number(req.query.limit) || 100));
  const KEYWORDS_PER_RUN = Math.max(1, Math.min(10, Number(req.query.keywords_per_run) || 3));
  const TARGET_USER = (req.query.userId || "u1").toString();
  // Caller can pin a specific keyword list via ?keywords=DK,tøj,mode for testing.
  const customKeywords = (req.query.keywords || "").toString().split(",").map((s) => s.trim()).filter(Boolean);
  // Synchronous flow. Cloud Run timeout bumped to 1200s in deploy.yml
  // to fit Apify scrape (~3-5min) + N × DF lookups + saves. We can't
  // background-IIFE this on default Cloud Run because CPU is throttled
  // once res.send fires.
  const stats = {
    adsScraped: 0,
    uniqueAdvertisers: 0,
    alreadyScanned: 0,
    fresh: 0,
    apolloResolved: 0,
    apolloMisses: 0,
    skippedNotDk: 0,
    skippedSize: 0,
    icpFitAppended: 0,
    errors: 0,
    keywordsUsed: [],
  };

  // 1. Pick the keywords for this run — either custom from ?keywords= or
  //    rotating through META_DISCOVER_KEYWORDS via the state cursor.
  const state = loadMetaAdsDiscoverState();
  let keywordsToUse;
  if (customKeywords.length > 0) {
    keywordsToUse = customKeywords;
  } else {
    keywordsToUse = [];
    for (let i = 0; i < KEYWORDS_PER_RUN; i++) {
      keywordsToUse.push(META_DISCOVER_KEYWORDS[(state.keywordCursor + i) % META_DISCOVER_KEYWORDS.length]);
    }
    state.keywordCursor = (state.keywordCursor + KEYWORDS_PER_RUN) % META_DISCOVER_KEYWORDS.length;
  }
  stats.keywordsUsed = keywordsToUse;

  // 2. Scrape current DK Meta ads — one Apify run per keyword. Apify charges
  //    per dataset item so parallelism doesn't affect cost; serial is simpler
  //    and gentler on rate limits.
  let items = [];
  for (const kw of keywordsToUse) {
    try {
      const batch = await apifyDiscoverDkMetaAds({ resultsLimit: RESULTS_LIMIT, keyword: kw });
      items.push(...batch);
    } catch (e) {
      console.warn(`[meta-ads-discover] keyword '${kw}' failed:`, e.message);
      stats.errors++;
    }
  }
  stats.adsScraped = items.length;

  // 3. Dedupe to unique advertisers (and drop ones we've already processed
  //    in past runs via the scannedPageIds map). The state object was loaded
  //    earlier above when picking keywords; we mutate it through the run
  //    and save once at the end.
  const fresh = adsToUniqueAdvertisers(items, state.scannedPageIds);
  stats.uniqueAdvertisers = new Set(items.map((it) => it.pageID || it.pageId || it.snapshot?.pageId)).size;
  stats.alreadyScanned = stats.uniqueAdvertisers - fresh.length;
  stats.fresh = fresh.length;

  // 3. For each fresh advertiser: DK-VERIFY then SAVE.
  //    v2 flow (PR9): Datafordeler name-search is the first gate. Only
  //    advertisers that resolve to a real registered DK business (real
  //    8-digit CVR) make it into the pool. Phone + address + emp data
  //    come from DF for free. Non-matches are dropped (the previous
  //    "needs research" purgatory path is gone — those leads had a
  //    7% conversion-to-callable rate and burned context). ICP gate
  //    on DF's intervalFra: drop if 25+ employees.
  const checkedAt = new Date().toISOString();
  for (const adv of fresh) {
    state.scannedPageIds[adv.pageId] = checkedAt;
    if (!adv.pageName) continue;
    // Hard reject non-DK mega-brands at intake (AT&T, Booking.com, etc.
    // run Meta ads to DK audiences but aren't DK companies).
    if (looksLikeNonDkBrand(adv.pageName)) {
      stats.skippedNonDkBrand = (stats.skippedNonDkBrand || 0) + 1;
      continue;
    }
    // Datafordeler verification — drop if not a registered DK business
    let df = null;
    try {
      df = await tryDfVerifyDkCompany(adv.pageName);
    } catch (e) { /* network blip — treat as not found */ }
    if (!df || !df.cvr || !/^\d{8}$/.test(String(df.cvr))) {
      stats.skippedNotInDf = (stats.skippedNotInDf || 0) + 1;
      continue;
    }
    if (!dfEmpPassesIcp(df)) {
      stats.skippedOverSize = (stats.skippedOverSize || 0) + 1;
      continue;
    }
    try {
      const ud = loadUserData(TARGET_USER);
      if (!ud.leads) ud.leads = [];
      // De-dup by real CVR (the DF-verified one) and by name. Past meta-
      // leads may use synthetic "meta-<pageId>" CVRs from before this
      // change — skip if either form already exists.
      const dupByRealCvr = ud.leads.some((l) => l.cvr === df.cvr);
      const dupByOldCvr  = ud.leads.some((l) => l.cvr === `meta-${adv.pageId}`);
      const dupByName    = ud.leads.some(
        (l) => (l.name || "").toLowerCase().trim() === (df.name || adv.pageName).toLowerCase().trim(),
      );
      if (dupByRealCvr || dupByOldCvr || dupByName) {
        stats.skippedDuplicates = (stats.skippedDuplicates || 0) + 1;
        continue;
      }
      const phone = df.phone || df.ph || "";
      ud.leads.push({
        // Take the DF record wholesale, then overlay meta-ad signals
        ...df,
        listId: "ungrouped",
        addedAt: checkedAt,
        source: "meta-ads-discover",
        icpFit: true,                       // DF-verified DK + emp-pass
        meta_advertiser: true,
        ad_signals: [
          adv.ads_active_now > 0
            ? `${adv.ads_active_now} aktive ad${adv.ads_active_now === 1 ? "" : "s"} på Meta`
            : `${adv.ads_recent90d} ad${adv.ads_recent90d === 1 ? "" : "s"} sidste 90 dage`,
        ],
        meta_verified_active: adv.ads_active_now > 0,
        meta_verified_at: checkedAt,
        meta_live_ad_count: adv.ads_active_now,
        meta_ads_active_now: adv.ads_active_now,
        meta_ads_recent90d: adv.ads_recent90d,
        meta_ads_total_in_library: adv.ads_total_in_library,
        apollo_company: null,
        apollo_enrichment_pending: false,   // DF gave us everything needed
        apollo_enriched_at: null,
        phone: phone,
        ph: phone,
        phone_missing: !phone,
        discovered_at: checkedAt,
        pushed_to_cloudtalk_at: null,
        twenty_opportunity_id: null,
        meta_page_id: adv.pageId,
        meta_page_name: adv.pageName,
        meta_ad_sample_archive: adv.adArchiveId,
        df_verified_at: checkedAt,
      });
      saveUserData(TARGET_USER, ud);
      stats.rawAppended = (stats.rawAppended || 0) + 1;
      stats.dfVerified = (stats.dfVerified || 0) + 1;
      if (phone) stats.withPhoneAtIntake = (stats.withPhoneAtIntake || 0) + 1;
    } catch (e) {
      stats.errors++;
      console.warn("[meta-ads-discover] append failed:", adv.pageName, e.message);
    }
  }

  state.lastRunAt = checkedAt;
  saveMetaAdsDiscoverState(state);
  logActivity(
    "discovery",
    `Meta-ads-discover: ${stats.adsScraped} ads → ${stats.fresh} nye annoncører · ${stats.rawAppended || 0} råleads gemt · ${stats.dfVerified || 0} DK-verificeret`,
    { stats, userId: TARGET_USER },
  );
  console.log("[meta-ads-discover] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
});

// POST /api/cron/purge-outside-icp — one-shot cleanup against the current
// ICP gate (1-15 emp + 2-15M DKK revenue + DK). Uses stored apollo_company
// data — no Apify spend, no Apollo credits. Null-tolerant (unknown data =
// keep). Companies failing the gate get lastAction='not-relevant' with
// archived_reason='outside-new-icp:<reason>' so the action is reversible.
app.post("/api/cron/purge-outside-icp", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  const TARGET_USER = (req.query.userId || "u1").toString();
  const stats = {
    activeBefore: 0,
    archived: 0,
    archivedNotDk: 0,
    archivedTooManyEmp: 0,
    archivedTooFewEmp: 0,
    archivedRevenueTooLow: 0,
    archivedRevenueTooHigh: 0,
    keptKnown: 0,
    keptUnknown: 0,
  };
  const samples = [];

  const ud = loadUserData(TARGET_USER);
  if (!ud.leads) ud.leads = [];
  const checkedAt = new Date().toISOString();

  for (const lead of ud.leads) {
    if (lead.lastAction === "not-relevant") continue;
    stats.activeBefore++;
    const ac = lead.apollo_company || {};
    const country = ac.country;
    const emp = ac.estimatedEmployees ?? (typeof lead.emps === "number" ? lead.emps : null);
    const rev = ac.annualRevenue;
    const name = lead.name || "?";

    // Apply same passesIcpGate logic with detailed reason tracking
    let reason = null;
    if (country && country !== "Denmark") reason = "not-dk";
    else if (emp != null && emp > APOLLO_DISCOVER_MAX_EMPLOYEES) reason = "too-many-emp";
    else if (emp != null && emp < APOLLO_DISCOVER_MIN_EMPLOYEES) reason = "too-few-emp";
    else if (rev != null && rev > 0 && rev < APOLLO_DISCOVER_MIN_REVENUE_USD) reason = "revenue-too-low";
    else if (rev != null && rev > 0 && rev > APOLLO_DISCOVER_MAX_REVENUE_USD) reason = "revenue-too-high";

    if (reason) {
      lead.lastAction = "not-relevant";
      lead.archived_reason = `outside-new-icp:${reason}`;
      lead.archived_at = checkedAt;
      stats.archived++;
      if (reason === "not-dk") stats.archivedNotDk++;
      else if (reason === "too-many-emp") stats.archivedTooManyEmp++;
      else if (reason === "too-few-emp") stats.archivedTooFewEmp++;
      else if (reason === "revenue-too-low") stats.archivedRevenueTooLow++;
      else if (reason === "revenue-too-high") stats.archivedRevenueTooHigh++;
      if (samples.length < 15) {
        const detail = reason === "too-many-emp" ? `${emp} emp`
          : reason === "revenue-too-high" ? `$${(rev / 1e6).toFixed(1)}M rev`
          : reason === "not-dk" ? `country=${country}`
          : reason;
        samples.push({ name, reason, detail });
      }
    } else {
      if (emp == null && rev == null) stats.keptUnknown++;
      else stats.keptKnown++;
    }
  }

  saveUserData(TARGET_USER, ud);
  logActivity(
    "purge-outside-icp",
    `ICP-purge: ${stats.archived} arkiveret (${stats.archivedTooManyEmp} for store · ${stats.archivedRevenueTooHigh} for høj omsætning · ${stats.archivedNotDk} ikke-DK)`,
    { stats, userId: TARGET_USER },
  );
  console.log("[purge-outside-icp]", JSON.stringify(stats));
  res.json({ ok: true, stats, samples });
});

// POST /api/cron/verify-leads — STRICT Meta Ad Library check on ALL active
// leads. Critical fix 2026-06-02: previous version used onlyTotal:true which
// only counted ads matching the search KEYWORD, not ads FROM the company.
// This passed leads where Meta had ads mentioning "Comedy Zoo" in copy
// (e.g. competing events) even when Comedy Zoo itself wasn't advertising.
//
// New flow: onlyTotal:false + resultsLimit:5 → returns up to 5 ad records
// per query with pageName. We then check advertiserMatchesCompany() on
// each returned pageName — only flip meta_verified_active=true if at
// least one ad's pageName matches the lead's company name.
//
// When ?archive=1 the failures (verifiedInactive) get lastAction='not-
// relevant' so they're permanently removed from the dialer, not just
// hidden behind the Måske-relevant chip. Use this for the once-and-for-all
// cleanup the operator asked for.
async function runVerifyLeadsBatch(req, res) {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!process.env.APIFY_API_TOKEN) {
    return res.status(503).json({ error: "APIFY_API_TOKEN not configured" });
  }
  const LIMIT = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const TARGET_USER = (req.query.userId || "u1").toString();
  const FORCE = req.query.force === "1";
  // ?archive=1 → permanently archive failures (lastAction='not-relevant').
  // Operator asked for "once and for all get rid of those not running ads".
  const ARCHIVE = req.query.archive === "1";
  // ?exclude_sources=branche-walk,csv → skip leads whose source starts
  // with any of those prefixes. Branche-walk leads are intentionally
  // saved without an advertising promise (Datafordeler-direct, size+
  // industry only), so verifying them against Meta Ad Library and
  // archiving the failures would nuke the whole pool. Use exclude to
  // protect them while still cleaning up meta-ads/linkedin/gmaps/tech
  // leads that DID promise to be advertising.
  const EXCLUDE_PREFIXES = String(req.query.exclude_sources || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const stats = {
    scanned: 0,
    verifiedActive: 0,
    verifiedInactive: 0,
    archived: 0,
    skippedRecent: 0,
    skippedNoName: 0,
    errors: 0,
  };

  const ud = loadUserData(TARGET_USER);
  const now = Date.now();
  // Pick candidates from ALL sources. Skip archived; skip leads with no
  // usable name; skip leads we verified recently (unless force=1).
  const todo = [];
  stats.skippedExcludedSource = 0;
  for (const l of ud.leads || []) {
    if (l.lastAction === "not-relevant") continue;
    // Skip excluded source prefixes (e.g. branche-walk-*) — those leads
    // weren't claimed to be Meta advertisers in the first place.
    if (EXCLUDE_PREFIXES.length && EXCLUDE_PREFIXES.some((p) => (l.source || "").startsWith(p))) {
      stats.skippedExcludedSource++;
      continue;
    }
    const brand = brandForMetaAdsSearch(l.name);
    if (!brand || brand.length < 3) { stats.skippedNoName++; continue; }
    if (!FORCE && l.meta_verified_at) {
      const age = now - new Date(l.meta_verified_at).getTime();
      if (age < STALE_MS) { stats.skippedRecent++; continue; }
    }
    todo.push({ lead: l, brand });
    if (todo.length >= LIMIT) break;
  }

  if (todo.length === 0) {
    return res.json({ ok: true, stats, note: "nothing to verify (all recent or filtered)" });
  }

  // STRICT verify — use onlyTotal:false + resultsLimit:5 so we get
  // pageName fields back and can confirm the ads are actually FROM the
  // company, not just ads mentioning the keyword in their copy.
  const startUrls = todo.map(({ lead, brand }) => ({
    url: buildAdsLibraryUrl(brand),
    _cvr: lead.cvr,
    _name: lead.name,
    _brand: brand,
  }));

  let items;
  try {
    // Inline call to apifyRun (the async-poll one) since apifyVerifyMetaAds
    // hardcodes onlyTotal:true.
    const token = process.env.APIFY_API_TOKEN;
    const input = {
      startUrls: startUrls.map((s) => ({ url: s.url })),
      onlyTotal: false,
      resultsLimit: 5,
    };
    const startResp = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-ads-scraper/runs?token=${token}&memory=2048&timeout=3600`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    );
    if (!startResp.ok) throw new Error(`Apify start ${startResp.status}: ${(await startResp.text()).slice(0,300)}`);
    const { data: run } = await startResp.json();
    const t0 = Date.now();
    let status = run.status;
    let runData = run;
    while (status === "READY" || status === "RUNNING") {
      if (Date.now() - t0 > 25 * 60 * 1000) throw new Error("Apify verify timeout");
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
      if (!poll.ok) continue;
      runData = (await poll.json()).data;
      status = runData.status;
    }
    if (status !== "SUCCEEDED") throw new Error(`Apify ended ${status}`);
    const itemsResp = await fetch(`https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${token}&format=json`);
    if (!itemsResp.ok) throw new Error(`Apify items fetch ${itemsResp.status}`);
    items = await itemsResp.json();
  } catch (e) {
    return res.status(502).json({ error: `Apify verify failed: ${e.message}` });
  }

  // Group items by inputUrl → list of pageNames
  const urlToMeta = new Map(startUrls.map((s) => [s.url, s]));
  const pageNamesByCvr = new Map();
  for (const item of items) {
    const meta = urlToMeta.get(item.inputUrl);
    if (!meta) continue;
    const pn = item.pageName || item.snapshot?.pageName || "";
    if (!pn) continue;
    if (!pageNamesByCvr.has(meta._cvr)) pageNamesByCvr.set(meta._cvr, []);
    pageNamesByCvr.get(meta._cvr).push(pn);
  }

  // For each candidate: verify by name-match. If any returned pageName
  // matches the lead's company name (advertiserMatchesCompany), the lead
  // is actively advertising. Otherwise it's a false positive (Meta keyword
  // hit ad copy of other companies) → mark inactive.
  const verifyByCvr = new Map();
  const checkedAt = new Date().toISOString();
  for (const { lead, brand } of todo) {
    const pageNames = pageNamesByCvr.get(lead.cvr) || [];
    const matched = pageNames.filter((pn) =>
      advertiserMatchesCompany(pn, lead.name) || advertiserMatchesCompany(pn, brand),
    ).length;
    verifyByCvr.set(lead.cvr, {
      active: matched > 0,
      matched,
      totalCount: pageNames.length,
      pageNames,
      checkedAt,
    });
  }

  // Apply verdicts back to user data
  const ud2 = loadUserData(TARGET_USER);
  for (const lead of ud2.leads || []) {
    if (!verifyByCvr.has(lead.cvr)) continue;
    const v = verifyByCvr.get(lead.cvr);
    lead.meta_verified_active = v.active;
    lead.meta_verified_at = v.checkedAt;
    lead.meta_live_ad_count = v.totalCount;
    lead.meta_live_advertisers = v.pageNames.slice(0, 5);
    lead.meta_live_name_matched = v.matched;
    stats.scanned++;
    if (v.active) stats.verifiedActive++;
    else {
      stats.verifiedInactive++;
      if (ARCHIVE) {
        lead.lastAction = "not-relevant";
        lead.archived_reason = "not-currently-advertising-on-meta";
        lead.archived_at = checkedAt;
        stats.archived++;
      }
    }
  }
  saveUserData(TARGET_USER, ud2);

  logActivity(
    "verification",
    `Verify-leads: ${stats.scanned} tjekket · ${stats.verifiedActive} aktive · ${stats.verifiedInactive} ikke aktive${ARCHIVE?` (${stats.archived} arkiveret)`:` (i Måske-relevant)`}`,
    { stats, userId: TARGET_USER },
  );
  console.log("[verify-leads]", JSON.stringify(stats));
  res.json({ ok: true, stats });
}
app.post("/api/cron/verify-leads", runVerifyLeadsBatch);
app.post("/api/cron/verify-existing-apollo-leads", runVerifyLeadsBatch); // legacy alias

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

// GET /api/admin/cloudtalk-audit — survey current lead phones + CloudTalk
// recent activity to find the credit drain. CloudTalk Essential covers
// DK-domestic only; non-+45 numbers + SMS sends + voicemail attempts all
// consume credits. Returns:
//   * Per-user phone breakdown by country prefix
//   * List of non-DK leads (specific offenders Apollo gave foreign HQs to)
//   * Recent CloudTalk calls (last 50) with talked-to + cost-relevant info
//   * Recent CloudTalk SMS (last 20)
async function runCloudtalkAudit(req, res) {
  // Dual-auth: admin session OR cron-secret. Credit audit is admin-only
  // for the session path; cron-secret bypasses for ops debugging.
  const viaCron = process.env.CRON_SECRET && req.headers["x-cron-secret"] === process.env.CRON_SECRET;
  if (!viaCron) {
    if (!req.userId) return res.status(401).json({ error: "Not logged in" });
    const allUsers = JSON.parse(fs.readFileSync(USERS_FILE, "utf8") || "[]");
    const me = allUsers.find((u) => u.id === req.userId);
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
  }

  // 1. Survey ACTIVE leads' phone numbers by country prefix
  const byPrefix = {};
  const nonDkLeads = [];
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
      try {
        const ud = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
        for (const l of ud.leads || []) {
          if (l.lastAction === "not-relevant") continue;
          const phone = String(l.ph || l.phone || "").replace(/[^0-9+]/g, "");
          if (!phone) continue;
          // Classify the prefix
          let prefix = "unknown";
          if (phone.startsWith("+45") || (phone.startsWith("45") && phone.length === 10) || /^\d{8}$/.test(phone)) {
            prefix = "DK (+45)";
          } else if (phone.startsWith("+1")) prefix = "US/CA (+1)";
          else if (phone.startsWith("+44")) prefix = "UK (+44)";
          else if (phone.startsWith("+49")) prefix = "DE (+49)";
          else if (phone.startsWith("+46")) prefix = "SE (+46)";
          else if (phone.startsWith("+47")) prefix = "NO (+47)";
          else if (phone.startsWith("+33")) prefix = "FR (+33)";
          else if (phone.startsWith("+")) prefix = "other-intl";
          byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
          if (prefix !== "DK (+45)") {
            nonDkLeads.push({
              cvr: l.cvr,
              name: l.name,
              phone,
              prefix,
              source: l.source,
            });
          }
        }
      } catch (_) { /* skip bad file */ }
    }
  }

  // 2. CloudTalk recent calls + SMS — paginated CDR endpoints
  let recentCalls = [];
  let recentSms = [];
  let callStats = { total: 0, domestic: 0, international: 0, totalMinutes: 0 };
  if (isCloudTalkConfigured()) {
    try {
      const r = await fetch(`${CLOUDTALK_API_BASE}/calls/index.json?limit=50`, {
        headers: { Authorization: cloudTalkAuthHeader() },
      });
      if (r.ok) {
        const j = await r.json();
        const calls = (j?.responseData?.data || []).map((row) => row.Cdr || row).filter(Boolean);
        recentCalls = calls.map((c) => {
          const num = String(c.public_external || "").replace(/[^0-9+]/g, "");
          const isDom = num.startsWith("+45") || (num.startsWith("45") && num.length === 10);
          const talkedSec = Number(c.talking_time || 0);
          callStats.total++;
          if (isDom) callStats.domestic++; else callStats.international++;
          callStats.totalMinutes += talkedSec / 60;
          return {
            startedAt: c.started_at,
            number: num,
            type: c.type,
            talkedSec,
            domestic: isDom,
            agent: c.agent_first_name || c.agent_name,
          };
        });
      }
    } catch (e) { console.warn("[ct-audit] calls fetch:", e.message); }
    try {
      const r = await fetch(`${CLOUDTALK_API_BASE}/sms/index.json?limit=20`, {
        headers: { Authorization: cloudTalkAuthHeader() },
      });
      if (r.ok) {
        const j = await r.json();
        recentSms = (j?.responseData?.data || []).map((row) => row.Sms || row).filter(Boolean).map((s) => ({
          sentAt: s.created || s.sent_at,
          to: s.phone_number || s.to,
          status: s.status,
          direction: s.direction,
          textPreview: String(s.text || "").slice(0, 80),
        }));
      }
    } catch (e) { console.warn("[ct-audit] sms fetch:", e.message); }
  }

  res.json({
    phoneSurveyByPrefix: byPrefix,
    nonDkLeadCount: nonDkLeads.length,
    nonDkLeads: nonDkLeads.slice(0, 50),
    cloudtalkRecentCalls: recentCalls.slice(0, 25),
    cloudtalkRecentSms: recentSms,
    callStats,
    recommendations: nonDkLeads.length > 0
      ? `${nonDkLeads.length} active leads have non-DK phones — dialing them burns credits. Recommend purging or marking phone_missing=true for these.`
      : "No non-DK phones found in active dialer.",
  });
}
app.get("/api/admin/cloudtalk-audit", authMiddleware, runCloudtalkAudit);
app.get("/api/cron/cloudtalk-audit", runCloudtalkAudit);

// POST /api/admin/strip-non-dk-phones — defensive cleanup: replace non-DK
// phone numbers with empty + phone_missing=true so the autodialer-maintain
// pre-flight gate keeps them out of the dial queue. Apollo-returned foreign
// HQ phones (Baum und Pferdgarten's +1 etc) burn CloudTalk credits silently.
// Dual auth: admin session (via authMiddleware) OR cron secret (so the
// operator + I can both trigger this cleanup). Same body shape either way.
async function runStripNonDkPhones(req, res) {
  // Cron-secret path skips the admin role check
  const viaCron = process.env.CRON_SECRET && req.headers["x-cron-secret"] === process.env.CRON_SECRET;
  if (!viaCron) {
    if (!req.userId) return res.status(401).json({ error: "Not logged in" });
    const allUsers = JSON.parse(fs.readFileSync(USERS_FILE, "utf8") || "[]");
    const me = allUsers.find((u) => u.id === req.userId);
    if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
  }
  const stats = { stripped: 0, byPrefix: {}, examples: [] };
  if (!fs.existsSync(DATA_DIR)) return res.json({ ok: true, stats });
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
    const userId = f.slice("data_".length, -".json".length);
    if (!userId) continue;
    const ud = loadUserData(userId);
    let dirty = false;
    for (const l of ud.leads || []) {
      if (l.lastAction === "not-relevant") continue;
      const raw = String(l.ph || l.phone || "").replace(/[^0-9+]/g, "");
      if (!raw) continue;
      const isDk = raw.startsWith("+45") || (raw.startsWith("45") && raw.length === 10) || /^\d{8}$/.test(raw);
      if (isDk) continue;
      // Capture prefix for stats
      let prefix = "other-intl";
      if (raw.startsWith("+1")) prefix = "US/CA"; else if (raw.startsWith("+44")) prefix = "UK";
      else if (raw.startsWith("+49")) prefix = "DE"; else if (raw.startsWith("+46")) prefix = "SE";
      else if (raw.startsWith("+47")) prefix = "NO";
      stats.byPrefix[prefix] = (stats.byPrefix[prefix] || 0) + 1;
      if (stats.examples.length < 10) stats.examples.push({ name: l.name, was: raw, prefix });
      // Strip — keep the bad number in a side field for audit
      l.phone_non_dk_orig = raw;
      l.ph = "";
      l.phone = "";
      l.phone_missing = true;
      l.phone_recovered_at = null;
      l.phone_recovered_source = `stripped-non-dk:${prefix}`;
      stats.stripped++;
      dirty = true;
    }
    if (dirty) saveUserData(userId, ud);
  }
  logActivity(
    "ct-credit-saver",
    `Strip non-DK phones: ${stats.stripped} fjernet (${Object.entries(stats.byPrefix).map(([k,v])=>`${k}=${v}`).join(", ")})`,
    { stats },
  );
  res.json({ ok: true, stats });
}
// Two routes pointing at the same handler — admin-session OR cron-secret.
app.post("/api/admin/strip-non-dk-phones", authMiddleware, runStripNonDkPhones);
app.post("/api/cron/strip-non-dk-phones", runStripNonDkPhones);

// ── BULK ARCHIVE by source prefix ──────────────────────────────────
// Hard-archives every active lead whose source starts with the given
// prefix. Used when a discovery cron produced obvious noise (e.g. a
// branche-walk code that turned out to be all dentists/non-ICP) and we
// want a one-click "clean this up" before tomorrow's runs land on top.
//
// Required query params:
//   source_prefix=branche-walk-862100   (or any prefix substring)
//   reason=...                          (archive_reason set on each lead)
//
// Optional:
//   limit=N                              (cap, default 1000, max 5000)
//   dry=1                                (count what WOULD archive, no writes)
//   userId=u1                            (defaults to req.userId for admin auth)
async function runArchiveBySource(req, res) {
  const TARGET_USER = (req.query.userId || req.userId || "u1").toString();
  const PREFIX = String(req.query.source_prefix || "").trim();
  const REASON = String(req.query.reason || "").trim();
  const LIMIT = Math.max(1, Math.min(5000, Number(req.query.limit) || 1000));
  const DRY = req.query.dry === "1";
  if (!PREFIX) return res.status(400).json({ error: "source_prefix required" });
  if (!REASON && !DRY) return res.status(400).json({ error: "reason required (or pass dry=1 to preview)" });
  const stats = { matched: 0, archived: 0, alreadyArchived: 0 };
  const ud = loadUserData(TARGET_USER);
  const nowIso = new Date().toISOString();
  for (const l of ud.leads || []) {
    const src = String(l.source || "");
    if (!src.startsWith(PREFIX)) continue;
    stats.matched++;
    if (l.lastAction === "not-relevant") { stats.alreadyArchived++; continue; }
    if (DRY) continue;
    if (stats.archived >= LIMIT) break;
    l.lastAction = "not-relevant";
    l.lastDispositionAt = nowIso;
    l.archived_reason = REASON;
    l.archived_at = nowIso;
    stats.archived++;
  }
  if (!DRY && stats.archived > 0) {
    saveUserData(TARGET_USER, ud);
    logActivity("bulk-archive", `🧹 Bulk-arkiveret ${stats.archived} leads med kilde-prefix "${PREFIX}" — ${REASON}`, { stats, userId: TARGET_USER });
  }
  console.log("[archive-by-source]", JSON.stringify({ prefix: PREFIX, reason: REASON, dry: DRY, ...stats }));
  res.json({ ok: true, stats, dry: DRY });
}
app.post("/api/admin/archive-by-source", authMiddleware, runArchiveBySource);
app.post("/api/cron/archive-by-source", (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  return runArchiveBySource(req, res);
});

// ── BULK ARCHIVE specific CVRs ─────────────────────────────────────────
// Used to one-shot archive a vetted list of misfit leads (too big, wrong
// country, etc.) without touching the rest. Takes ?cvrs=A,B,C&reason=text.
async function runArchiveByCvrs(req, res) {
  const TARGET_USER = (req.query.userId || req.userId || "u1").toString();
  const cvrsParam = (req.query.cvrs || "").toString().trim();
  if (!cvrsParam) return res.status(400).json({ error: "cvrs päkrævet" });
  const cvrs = new Set(cvrsParam.split(",").map((s) => s.trim()).filter(Boolean));
  const REASON = (req.query.reason || "ICP-fail (manuel)").toString().slice(0, 200);
  const DRY = req.query.dry === "1";
  const nowIso = new Date().toISOString();
  const stats = { matched: 0, archived: 0, alreadyArchived: 0, notFound: 0 };
  const ud = loadUserData(TARGET_USER);
  for (const l of ud.leads || []) {
    if (!cvrs.has(String(l.cvr))) continue;
    stats.matched++;
    if (l.lastAction === "not-relevant") { stats.alreadyArchived++; continue; }
    if (DRY) continue;
    l.lastAction = "not-relevant";
    l.lastDispositionAt = nowIso;
    l.archived_reason = REASON;
    l.archived_at = nowIso;
    stats.archived++;
  }
  stats.notFound = cvrs.size - stats.matched;
  if (!DRY && stats.archived > 0) {
    saveUserData(TARGET_USER, ud);
    logActivity("bulk-archive", `🧹 Bulk-arkiveret ${stats.archived} leads (manuel CVR-liste): ${REASON}`, { stats, userId: TARGET_USER });
  }
  console.log("[archive-by-cvrs]", JSON.stringify({ count: cvrs.size, reason: REASON, dry: DRY, ...stats }));
  res.json({ ok: true, stats, dry: DRY });
}
app.post("/api/admin/archive-by-cvrs", authMiddleware, runArchiveByCvrs);
app.post("/api/cron/archive-by-cvrs", (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  return runArchiveByCvrs(req, res);
});

// ── DF-VERIFY RETROACTIVE for unknowns ─────────────────────────────────
// Walks active leads with no employee data and runs them through
// tryDfVerifyDkCompany. If found → backfill cvr, phone, address, emp.
// If not found → archive as "not in Datafordeler". If found but over the
// 25-emp ICP cap → archive as too-big.
async function runDfVerifyUnknowns(req, res) {
  const TARGET_USER = (req.query.userId || req.userId || "u1").toString();
  const LIMIT = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
  const DRY = req.query.dry === "1";
  const stats = {
    candidates: 0,
    dfMatched: 0,
    backfilled: 0,
    archivedNotInDf: 0,
    archivedTooBig: 0,
    skippedAlreadyHasEmp: 0,
    errors: 0,
  };
  const ud = loadUserData(TARGET_USER);
  const nowIso = new Date().toISOString();
  // Target: active leads with no emp data
  const todo = (ud.leads || []).filter((l) => {
    if (l.lastAction === "not-relevant") return false;
    if (l.twenty_opportunity_id || l.twenty_pushed_at) return false;
    const emp = String(l.emp || l.emps || "").trim();
    const apolloEmp = (l.apollo_company || {}).estimatedEmployees;
    if (emp || apolloEmp) return false;
    return !!(l.name || "").trim();
  }).slice(0, LIMIT);
  stats.candidates = todo.length;

  for (const lead of todo) {
    try {
      const df = await tryDfVerifyDkCompany(lead.name);
      if (!df || !df.cvr || !/^\d{8}$/.test(String(df.cvr))) {
        // Not found in DF — archive (non-DK or unverified)
        if (!DRY) {
          // Re-load fresh in case other crons mutated
          const ud2 = loadUserData(TARGET_USER);
          const l2 = (ud2.leads || []).find((x) => x.cvr === lead.cvr);
          if (l2 && l2.lastAction !== "not-relevant") {
            l2.lastAction = "not-relevant";
            l2.lastDispositionAt = nowIso;
            l2.archived_reason = "Auto-arkiveret: ikke i Datafordeler (DK-verify failed)";
            l2.archived_at = nowIso;
            saveUserData(TARGET_USER, ud2);
          }
        }
        stats.archivedNotInDf++;
        continue;
      }
      stats.dfMatched++;
      // Has DF data — apply emp-gate
      if (!dfEmpPassesIcp(df)) {
        if (!DRY) {
          const ud2 = loadUserData(TARGET_USER);
          const l2 = (ud2.leads || []).find((x) => x.cvr === lead.cvr);
          if (l2 && l2.lastAction !== "not-relevant") {
            l2.lastAction = "not-relevant";
            l2.lastDispositionAt = nowIso;
            l2.archived_reason = `Auto-arkiveret: over ICP-cap (DF emp=${df.emp || "?"})`;
            l2.archived_at = nowIso;
            l2.apollo_company = { ...(l2.apollo_company || {}), country: df.country || "Denmark", estimatedEmployees: parseInt((df.emp || "0").split("-")[0]) || null };
            saveUserData(TARGET_USER, ud2);
          }
        }
        stats.archivedTooBig++;
        continue;
      }
      // Pass — backfill DF data on the lead
      if (!DRY) {
        const ud2 = loadUserData(TARGET_USER);
        const l2 = (ud2.leads || []).find((x) => x.cvr === lead.cvr);
        if (l2 && l2.lastAction !== "not-relevant") {
          // Overlay DF data without clobbering existing populated fields
          if (df.phone && !l2.phone) { l2.phone = df.phone; l2.ph = df.phone; l2.phone_missing = false; }
          if (df.emp && !l2.emp) l2.emp = df.emp;
          if (df.city && !l2.city) l2.city = df.city;
          if (df.zip && !l2.zip) l2.zip = df.zip;
          if (df.addr && !l2.addr) l2.addr = df.addr;
          // Don't overwrite synthetic cvr with real one (keeps dedup keys stable)
          l2.df_cvr_match = df.cvr;
          l2.df_verified_at = nowIso;
          saveUserData(TARGET_USER, ud2);
          stats.backfilled++;
        }
      } else {
        stats.backfilled++;
      }
    } catch (e) { stats.errors++; }
    // Be gentle on Datafordeler (it has rate limits)
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!DRY) {
    logActivity("df-verify", `🔍 Retroaktiv DF-verify: ${stats.dfMatched}/${stats.candidates} matchet · ${stats.backfilled} berigetet · ${stats.archivedNotInDf} ikke-DK · ${stats.archivedTooBig} for store`, { stats, userId: TARGET_USER });
  }
  console.log("[df-verify-unknowns]", JSON.stringify({ dry: DRY, ...stats }));
  res.json({ ok: true, stats, dry: DRY });
}
app.post("/api/admin/df-verify-unknowns", authMiddleware, runDfVerifyUnknowns);
app.post("/api/cron/df-verify-unknowns", (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  return runDfVerifyUnknowns(req, res);
});

// ── RESTORE wrongly-archived verified-advertising leads ────────────────
// Drain's STEP 0.5 archives leads as "Apollo: ikke fundet i database"
// when Apollo's name index doesn't have them. Before PR7 the spill-
// rescue only kept the lead if meta_verified_active=true (currently
// running ads RIGHT NOW), which excluded recently-paused advertisers
// — 16 of today's 21 archives fell in that gap.
//
// This endpoint walks archived leads matching:
//   archived_reason starts with "Apollo: ikke fundet" OR "Apollo ICP"
//   AND has a verified advertising signal:
//     meta_advertiser OR linkedin_advertiser OR meta_ads_recent90d > 0
//
// Restores by: clearing lastAction, lastDispositionAt, archived_reason
// + setting needs_research=true so the cockpit-open auto-reveal fires.
// PR6's filter lets these stay in the main queue while phone-research
// happens via Lusha/Apollo on-demand.
async function runRestoreSpillLeads(req, res) {
  const TARGET_USER = (req.query.userId || req.userId || "u1").toString();
  const LIMIT = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));
  const DRY = req.query.dry === "1";
  // Optional: only restore leads archived in the last N hours
  const HOURS = Number(req.query.hours);
  const cutoffMs = HOURS ? Date.now() - HOURS * 3600 * 1000 : 0;
  // Optional: ?cvrs=foo,bar — restore exactly these CVRs, bypass guards.
  // Used when an SDR wants to manually rescue specific over-size leads
  // the heuristic emp-cap would otherwise skip.
  const cvrsParam = (req.query.cvrs || "").toString().trim();
  const explicitCvrs = cvrsParam ? new Set(cvrsParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const stats = { matched: 0, restored: 0, alreadyActive: 0 };
  const ud = loadUserData(TARGET_USER);
  for (const l of ud.leads || []) {
    if (l.lastAction !== "not-relevant") { stats.alreadyActive++; continue; }
    const reason = String(l.archived_reason || "");
    // Explicit-CVR mode bypasses the reason/verified/cutoff filters
    // (operator already vetted these specific leads manually).
    if (explicitCvrs) {
      if (!explicitCvrs.has(String(l.cvr))) continue;
      stats.matched++;
      if (DRY) continue;
      if (stats.restored >= LIMIT) break;
      delete l.lastAction;
      delete l.lastDispositionAt;
      delete l.archived_reason;
      delete l.archived_at;
      l.needs_research = true;
      l.phone_missing = true;
      l.apollo_enrichment_pending = false;
      l.apollo_enrichment_deferred = true;
      stats.restored++;
      continue;
    }
    if (!reason.startsWith("Apollo: ikke fundet") && !reason.startsWith("Apollo ICP")) continue;
    const isVerifiedAd =
      l.meta_advertiser === true ||
      l.linkedin_advertiser === true ||
      l.meta_verified_active === true ||
      (Number(l.meta_ads_recent90d) || 0) > 0;
    if (!isVerifiedAd) continue;
    if (cutoffMs) {
      const ts = new Date(l.archived_at || l.lastDispositionAt || 0).getTime();
      if (!ts || ts < cutoffMs) continue;
    }
    stats.matched++;
    // Skip "Apollo ICP" reasons that indicate truly over-size companies
    // (4500 emp, 360 emp, etc). Heuristic: parse the "X emp" from reason
    // and bail if it's > 25 (our ICP cap).
    const empMatch = reason.match(/(\d+)\s*emp/);
    if (empMatch && Number(empMatch[1]) > 25) continue;
    if (DRY) continue;
    if (stats.restored >= LIMIT) break;
    delete l.lastAction;
    delete l.lastDispositionAt;
    delete l.archived_reason;
    delete l.archived_at;
    l.needs_research = true;
    l.phone_missing = true; // ensure they land in research-bucket aware flow
    l.apollo_enrichment_pending = false; // drain already tried + failed
    l.apollo_enrichment_deferred = true;  // cockpit-open auto-reveal will retry
    stats.restored++;
  }
  if (!DRY && stats.restored > 0) {
    saveUserData(TARGET_USER, ud);
    logActivity("bulk-restore", `↻ Restored ${stats.restored} verified-advertising leads from Apollo-not-found archive`, { stats, userId: TARGET_USER });
  }
  console.log("[restore-spill-leads]", JSON.stringify({ dry: DRY, ...stats }));
  res.json({ ok: true, stats, dry: DRY });
}
app.post("/api/admin/restore-spill-leads", authMiddleware, runRestoreSpillLeads);
app.post("/api/cron/restore-spill-leads", (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  return runRestoreSpillLeads(req, res);
});

// ── CVR BACKFILL via Datafordeler name search ───────────────────────
// Older leads (meta-*, gmaps-*, linkedin-*, tech-*, apollo-*) were
// saved with SYNTHETIC CVRs because their source didn't provide a real
// Danish CVR number. Resolve them retroactively by name-searching
// Datafordeler. ~70% should match a real DK company. FREE — no Apollo
// credits used; Datafordeler is gratis with a key.
async function runCvrBackfill(req, res) {
  const TARGET_USER = (req.query.userId || req.userId || "u1").toString();
  const LIMIT = Math.max(5, Math.min(300, Number(req.query.limit) || 50));
  const SYNTHETIC_PREFIX_RE = /^(meta-|gmaps-|linkedin-|tech-|apollo-|csv-)/i;
  const REAL_CVR_RE = /^\d{8}$/;
  const stats = { scanned: 0, matched: 0, notMatched: 0, alreadyReal: 0, errors: 0 };

  const ud = loadUserData(TARGET_USER);
  const candidates = (ud.leads || []).filter((l) =>
    l.lastAction !== "not-relevant" &&
    !REAL_CVR_RE.test(String(l.cvr || "")) &&
    SYNTHETIC_PREFIX_RE.test(String(l.cvr || "")) &&
    (l.name || "").trim().length >= 3
  ).slice(0, LIMIT);
  stats.scanned = candidates.length;
  if (candidates.length === 0) {
    return res.json({ ok: true, stats, note: "no synthetic-CVR leads to backfill" });
  }

  // Helper: normalize name for comparison (strip legal forms, lowercase)
  const norm = (s) => String(s || "").toLowerCase()
    .replace(/\b(a\/s|aps|ivs|i\/s|p\/s|k\/s)\b/gi, "")
    .replace(/[æÆ]/g, "a").replace(/[øØ]/g, "o").replace(/[åÅ]/g, "a")
    .replace(/\s+/g, " ").trim();

  // Direct CVR_Navn name lookup. Tries the original name + common DK
  // legal-form variants. Datafordeler indexes BOTH legal names ("Senzone
  // ApS") AND trade names ("Senzone") under CVR_Navn, so this hits both
  // cases. Returns { cvr, enhedsId } or null.
  const lookupCvrByName = async (rawName) => {
    const variants = new Set();
    const base = String(rawName || "").trim();
    if (!base) return null;
    variants.add(base);
    // Add legal-form suffix variants
    for (const suffix of [" ApS", " A/S", " IVS", " I/S", " P/S", " K/S"]) {
      if (!base.toLowerCase().endsWith(suffix.toLowerCase())) variants.add(base + suffix);
    }
    // Add stripped-suffix variant
    const stripped = base.replace(/\s+(A\/S|ApS|IVS|I\/S|P\/S|K\/S)\s*$/i, "").trim();
    if (stripped && stripped !== base) variants.add(stripped);
    // Add uppercase (Datafordeler often stores uppercase legal names)
    variants.add(base.toUpperCase());
    for (const variant of variants) {
      const escaped = variant.replace(/"/g, '\\"');
      try {
        const r = await dfGqlFetch(
          `{ CVR_Navn(first: 5, where: { vaerdi: { eq: "${escaped}" } }) { edges { node { CVREnhedsId vaerdi } } } }`
        );
        const edges = r?.CVR_Navn?.edges || [];
        if (edges.length === 0) continue;
        // For each match, verify it's an active company and fetch its CVRNummer
        for (const edge of edges) {
          const eid = edge.node.CVREnhedsId;
          if (!eid) continue;
          const v = await dfGqlFetch(
            `{ CVR_Virksomhed(first: 1, where: { id: { eq: "${eid}" } }) { edges { node { id CVRNummer status } } } }`
          );
          const virk = v?.CVR_Virksomhed?.edges?.[0]?.node;
          if (virk?.CVRNummer && virk?.status === "aktiv") {
            return { cvr: String(virk.CVRNummer), enhedsId: eid };
          }
        }
      } catch (_) { /* try next variant */ }
    }
    return null;
  };

  for (const lead of candidates) {
    try {
      const hit = await lookupCvrByName(lead.name);
      if (!hit || !REAL_CVR_RE.test(hit.cvr)) {
        stats.notMatched++;
        continue;
      }
      // Re-load + patch
      const ud2 = loadUserData(TARGET_USER);
      const l2 = (ud2.leads || []).find((x) => x.cvr === lead.cvr);
      if (!l2) { stats.errors++; continue; }
      // Guard: don't overwrite if the real CVR already attached to ANOTHER lead
      const dup = (ud2.leads || []).some((x) => x.cvr === hit.cvr && x !== l2);
      if (dup) { stats.notMatched++; continue; }
      l2.cvr_synthetic = l2.cvr;
      l2.cvr = hit.cvr;
      l2.cvr_backfilled_at = new Date().toISOString();
      l2.cvr_backfill_source = "datafordeler-cvr-navn";
      // Bonus: also try to grab Datafordeler phone via the enhedsId
      if (!l2.phone && !l2.ph) {
        try {
          const phResp = await dfGqlFetch(
            `{ CVR_Telefonnummer(first: 1, where: { CVREnhedsId: { eq: "${hit.enhedsId}" } }) { edges { node { vaerdi } } } }`
          );
          const ph = phResp?.CVR_Telefonnummer?.edges?.[0]?.node?.vaerdi;
          if (ph) {
            l2.phone = ph;
            l2.ph = ph;
            l2.phone_missing = false;
            l2.phone_recovered_at = new Date().toISOString();
            l2.phone_recovered_source = "datafordeler-cvr-backfill";
          }
        } catch (_) { /* phone is bonus; not fatal */ }
      }
      saveUserData(TARGET_USER, ud2);
      stats.matched++;
    } catch (e) {
      stats.errors++;
      console.warn("[cvr-backfill]", lead.cvr, e.message);
    }
  }
  console.log("[cvr-backfill] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
}
app.post("/api/admin/backfill-cvr", authMiddleware, runCvrBackfill);
app.post("/api/cron/backfill-cvr", (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  return runCvrBackfill(req, res);
});

app.post("/api/cloudtalk/call", authMiddleware, async (req, res) => {
  // HARD GUARD — only DK-domestic calls allowed. CloudTalk Essential
  // doesn't cover international and each int'l call burns credits.
  // Defense in depth: client-side guard ALSO blocks, but the server
  // is the final word. Returns 400 (not 503) so the SDR sees a clear
  // error message and doesn't think it's an outage.
  const requestedPhone = String(req.body?.phone || "").replace(/[^0-9+]/g, "");
  const isDkPhone = requestedPhone.startsWith("+45")
    || (requestedPhone.startsWith("45") && requestedPhone.length === 10)
    || /^\d{8}$/.test(requestedPhone);
  if (requestedPhone && !isDkPhone) {
    console.warn("[cloudtalk/call] blocked non-DK dial:", requestedPhone, "userId=", req.userId);
    return res.status(400).json({
      error: `Kun DK-numre tillades. ${requestedPhone} starter ikke med +45.`,
      blockedNonDk: true,
      attempted: requestedPhone,
    });
  }
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
      // CloudTalk rejects click-to-call when the agent isn't Online in a
      // softphone (web phone / desktop app / mobile). Surface an actionable
      // message rather than the raw payload so the SDR knows what to do.
      const msg = String((d.responseData && (d.responseData.message || d.responseData.error)) || d.error || d.message || "").toLowerCase();
      const offline = /not.?logged|offline|active.?(call|interface).?(required|missing)|agent.*not.*online|status/.test(msg);
      const friendly = offline
        ? "Du er ikke online i CloudTalk-softphonen. Åbn softphonen (eller pop-ud-vinduet), log ind, og sæt status til Online — derefter virker click-to-call."
        : `CloudTalk afviste opkaldet (${r.status}): ${JSON.stringify(d).slice(0, 160)}`;
      return res.status(503).json({ error: friendly, configured: true, ready: !offline });
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
      // CloudTalk SMS is a paid add-on and only works on SMS-capable
      // numbers (limited country support; DK outbound often isn't
      // included). Every payload shape returns a generic "Bad Request"
      // when SMS isn't provisioned. Return 503 (not 502) so the client
      // falls back to the device's native SMS composer instead of
      // surfacing a confusing raw error.
      const reason = JSON.stringify(d).slice(0, 200);
      console.warn("[cloudtalk/sms] rejected:", r.status, reason);
      return res.status(503).json({
        error: "CloudTalk SMS er ikke aktiveret på kontoen (kræver SMS-tillæg + SMS-kapabelt nummer). Falder tilbage til enhedens SMS.",
        configured: false,
        cloudtalk: reason,
      });
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
// ─── Active-call state (drives the inbound/outbound screen-pop) ──────────
// CloudTalk posts a webhook on call start (inbound ring / outbound dial)
// and call end. We persist the "currently active call" so the SDR's
// browser — which polls /api/cloudtalk/active-call — can pop the matching
// lead on screen automatically, even when the softphone dock is closed.
const ACTIVE_CALL_FILE = path.join(DATA_DIR, "active_call.json");
function setActiveCall(obj) { try { fs.writeFileSync(ACTIVE_CALL_FILE, JSON.stringify(obj || null)); } catch {} }
function getActiveCall() { try { return JSON.parse(fs.readFileSync(ACTIVE_CALL_FILE, "utf8")); } catch { return null; } }
// Normalize a phone number to its last 8 digits (DK national number) for
// matching — strips +45 / 0045 / spaces / dashes.
function phoneKey(p) {
  return String(p || "").replace(/\D/g, "").replace(/^45/, "").slice(-8);
}
// Find a lead across all users matching a phone number. Returns {lead, owner}.
function findLeadByPhone(number) {
  const target = phoneKey(number);
  if (!target || target.length < 6) return null;
  if (!fs.existsSync(DATA_DIR)) return null;
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
    try {
      const ud = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      const lead = (ud.leads || []).find((l) => phoneKey(l.phone || l.ph) === target);
      if (lead) return { lead, owner: f.slice("data_".length, -".json".length) };
    } catch {}
  }
  return null;
}

// Poll CloudTalk's calls API for the most recent call. This is how we
// drive the screen-pop WITHOUT requiring a CloudTalk webhook to be
// configured in their dashboard. CloudTalk creates the CDR at call start,
// so a call that just rang/dialed shows up here within a few seconds.
// Cached ~2s so the browser polling every 3s doesn't hammer CloudTalk.
let _ctCallCache = { at: 0, data: null };
async function fetchLatestCloudTalkCall() {
  if (Date.now() - _ctCallCache.at < 2000) return _ctCallCache.data;
  try {
    const r = await fetch(`${CLOUDTALK_API_BASE}/calls/index.json?limit=1`, {
      headers: { "Authorization": cloudTalkAuthHeader() },
    });
    if (!r.ok) { _ctCallCache = { at: Date.now(), data: null }; return null; }
    const j = await r.json();
    const cdr = j?.responseData?.data?.[0]?.Cdr || null;
    _ctCallCache = { at: Date.now(), data: cdr };
    return cdr;
  } catch {
    _ctCallCache = { at: Date.now(), data: null };
    return null;
  }
}

// GET /api/admin/lead-economics — daily $/lead trend + source breakdown.
// Admin-only. Computes blended cost from fixed monthly subscriptions
// (Apify + Apollo + GCP) prorated to the day, plus variable Apollo
// credit burn per discovered lead. Aim is a single number the operator
// can watch to know whether the funnel is still cheap enough to scale.
//
// Cost knobs are env vars so we can update the model without code:
//   APIFY_MONTHLY_USD   default 45  (STARTER $29 + ~$16 overage)
//   APOLLO_MONTHLY_USD  default 99  (Pro plan baseline)
//   GCP_MONTHLY_USD     default 8   (Cloud Run + GCS + Scheduler)
//   APOLLO_CREDIT_USD   default 0.025  ($99 / 4000 credits)
//   APOLLO_CREDITS_PER_LEAD default 2  (= APOLLO_SEARCH_LIMIT)
//
// Returns per-day buckets for last 30 days + today/week/month aggregates.
app.get("/api/admin/lead-economics", authMiddleware, async (req, res) => {
  // Admin role check — non-admin SDRs shouldn't see cost data.
  const allUsers = JSON.parse(fs.readFileSync(USERS_FILE, "utf8") || "[]");
  const me = allUsers.find((u) => u.id === req.userId);
  if (!me || me.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }

  const APIFY_MONTHLY_USD = Number(process.env.APIFY_MONTHLY_USD) || 45;
  const APOLLO_MONTHLY_USD = Number(process.env.APOLLO_MONTHLY_USD) || 99;
  const GCP_MONTHLY_USD = Number(process.env.GCP_MONTHLY_USD) || 8;
  const APOLLO_CREDIT_USD = Number(process.env.APOLLO_CREDIT_USD) || 0.025;
  const APOLLO_CREDITS_PER_LEAD = Number(process.env.APOLLO_CREDITS_PER_LEAD) || 2;

  const FIXED_MONTHLY = APIFY_MONTHLY_USD + APOLLO_MONTHLY_USD + GCP_MONTHLY_USD;
  const FIXED_DAILY = FIXED_MONTHLY / 30;

  // Walk all user data files for leads with a discovered_at timestamp.
  // Source-tagged events come from CVR-walk (apify/discover-ads), Apollo
  // discovery, CSV imports, manual adds. Anything older than 30 days is
  // outside the window and dropped.
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 30;
  const cutoffMs = now - WINDOW_DAYS * DAY_MS;
  const buckets = {}; // YYYY-MM-DD → { total, bySource: {...} }
  const sourceTotals = {};

  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
      try {
        const ud = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
        for (const lead of ud.leads || []) {
          const ts = lead.discovered_at || lead.imported_at || lead.created_at || lead.addedAt;
          if (!ts) continue;
          const t = new Date(ts).getTime();
          if (!t || t < cutoffMs) continue;
          const day = new Date(t).toISOString().slice(0, 10);
          const source = lead.source || "other";
          if (!buckets[day]) buckets[day] = { total: 0, bySource: {} };
          buckets[day].total++;
          buckets[day].bySource[source] = (buckets[day].bySource[source] || 0) + 1;
          sourceTotals[source] = (sourceTotals[source] || 0) + 1;
        }
      } catch (e) { console.warn("[lead-economics] read", f, e.message); }
    }
  }

  // Build complete 30-day series (fill zeros for missing days) so the
  // chart doesn't skip and the rolling averages are accurate.
  const series = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const t = now - i * DAY_MS;
    const day = new Date(t).toISOString().slice(0, 10);
    const b = buckets[day] || { total: 0, bySource: {} };
    // Per-day cost = prorated fixed + variable Apollo enrichment credits.
    // Apify scrape is a fixed cost and already counted in APIFY_MONTHLY;
    // Apollo people/match is the only variable cost (2 credits × leads
    // × $0.025/credit). Other lead sources (CSV, manual) don't add
    // variable cost — they share the fixed pool.
    const variableUsd = b.total * APOLLO_CREDITS_PER_LEAD * APOLLO_CREDIT_USD;
    const costUsd = FIXED_DAILY + variableUsd;
    series.push({
      day,
      leads: b.total,
      bySource: b.bySource,
      costUsd: Math.round(costUsd * 100) / 100,
      perLeadUsd: b.total > 0 ? Math.round((costUsd / b.total) * 1000) / 1000 : null,
    });
  }

  // Aggregates — today is last 24h, week is last 7, month is full 30.
  const agg = (days) => {
    const slice = series.slice(-days);
    const leads = slice.reduce((s, r) => s + r.leads, 0);
    const cost = slice.reduce((s, r) => s + r.costUsd, 0);
    return {
      leads,
      costUsd: Math.round(cost * 100) / 100,
      perLeadUsd: leads > 0 ? Math.round((cost / leads) * 1000) / 1000 : null,
    };
  };

  // Projected monthly from current 7-day pace
  const week = agg(7);
  const projectedMonthlyLeads = Math.round((week.leads / 7) * 30);

  res.json({
    series,
    today: agg(1),
    week,
    month: agg(30),
    projectedMonthlyLeads,
    sourceTotals,
    fixedMonthly: {
      apify: APIFY_MONTHLY_USD,
      apollo: APOLLO_MONTHLY_USD,
      gcp: GCP_MONTHLY_USD,
      total: FIXED_MONTHLY,
    },
    variableModel: {
      apolloCreditsPerLead: APOLLO_CREDITS_PER_LEAD,
      apolloUsdPerCredit: APOLLO_CREDIT_USD,
      usdPerEnrichedLead: APOLLO_CREDITS_PER_LEAD * APOLLO_CREDIT_USD,
    },
  });
});

// GET /api/activity — recent system activity feed. Merges the logged
// events (imports, promotions, enrichment, calls) with the META scraper's
// run history from state.json, newest first.
app.get("/api/activity", authMiddleware, async (req, res) => {
  let events = [];
  try { events = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8")) || []; } catch {}
  // Fold in scraper runs
  try {
    const runs = (loadDiscoveryState().runs || []).slice(-30);
    for (const r of runs) {
      events.push({
        at: r.completedAt || r.startedAt,
        type: "scraper",
        message: `META-scrape: ${r.scrapedThisRun || 0} tjekket · ${r.withAds || 0} med ads (hitrate ${r.hitratePct ?? 0}%)`,
        meta: { ok: r.ok, fail: r.fail },
      });
    }
  } catch {}
  // Fold in recent CloudTalk calls — both answered + missed (talking_time=0).
  // Lets the SDR see if anyone called back while they were away.
  if (isCloudTalkConfigured()) {
    try {
      const r = await fetch(`${CLOUDTALK_API_BASE}/calls/index.json?limit=20`, {
        headers: { Authorization: cloudTalkAuthHeader() },
      });
      if (r.ok) {
        const j = await r.json();
        const calls = (j?.responseData?.data || []).map((row) => row.Cdr || row).filter(Boolean);
        for (const c of calls) {
          const inbound = /incom/i.test(c.type || "");
          const talked = Number(c.talking_time || 0) > 0;
          const missed = inbound && !talked;
          const num = c.public_external || "";
          const match = num ? findLeadByPhone(num) : null;
          const who = match?.lead?.name || c.contact_name || num || "Ukendt nummer";
          events.push({
            at: c.started_at || c.ended_at,
            type: missed ? "missed-call" : (inbound ? "call-in" : "call-out"),
            message: missed
              ? `📵 Missed ${inbound ? "indgående" : "udgående"}: ${who} (${num})`
              : `📞 ${inbound ? "Indgående" : "Udgående"}: ${who} — ${talked ? Math.round(c.talking_time) + "s" : "voicemail"}`,
            meta: { callId: c.id, number: num, cvr: match?.lead?.cvr || null, missed },
          });
        }
      }
    } catch (e) { /* network blip is fine */ }
  }
  events.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  res.json({ events: events.slice(0, Number(req.query.limit) || 150) });
});

// GET /api/cloudtalk/active-call — the SDR's browser polls this. Returns
// the live/just-started call (if any) + the matched company so the UI can
// screen-pop. Primary source is CloudTalk's calls API (no webhook needed);
// the webhook-set file is used as a faster signal when available.
app.get("/api/cloudtalk/active-call", authMiddleware, async (req, res) => {
  let number = "", direction = "", callId = "", startedAt = "";
  // 1) Webhook file (fastest, if configured + fresh < 2 min)
  const wh = getActiveCall();
  if (wh && wh.startedAt && Date.now() - new Date(wh.startedAt).getTime() < 2 * 60 * 1000) {
    number = wh.number; direction = wh.direction; callId = wh.callId || ""; startedAt = wh.startedAt;
  } else {
    // 2) Poll CloudTalk's calls API — CDR is created at call start.
    const cdr = await fetchLatestCloudTalkCall();
    if (cdr && cdr.started_at) {
      const startMs = new Date(cdr.started_at).getTime();
      // "Fresh" = started within the last 90s → treat as the active /
      // just-happened call worth popping. Dedup on the client by call id.
      if (Date.now() - startMs < 90 * 1000) {
        number = cdr.public_external || "";
        direction = /incom/i.test(cdr.type || "") ? "inbound" : "outbound";
        callId = cdr.id || "";
        startedAt = cdr.started_at;
      }
    }
  }
  if (!number) return res.json({ active: false });
  const match = findLeadByPhone(number);
  res.json({
    active: true,
    call: { callId, number, direction, startedAt },
    lead: match ? {
      name: match.lead.name, cvr: match.lead.cvr, phone: match.lead.phone || match.lead.ph,
      city: match.lead.city, lastAction: match.lead.lastAction, lastCallAt: match.lead.lastCallAt,
      meta_advertiser: !!match.lead.meta_advertiser,
    } : null,
  });
});

app.post("/api/cloudtalk/webhook", express.json({ type: "*/*" }), (req, res) => {
  // Webhook signature verification (CloudTalk includes a token or HMAC
  // header — confirm exact mechanism in their docs, then validate here).
  const expectedToken = process.env.CLOUDTALK_WEBHOOK_TOKEN;
  if (expectedToken && req.headers["x-cloudtalk-token"] !== expectedToken) {
    return res.status(401).json({ error: "Invalid webhook token" });
  }
  try {
    const evt = req.body || {};
    const evtName = String(evt.event || evt.type || evt.event_type || "").toLowerCase();
    console.log("[cloudtalk-webhook]", evtName || "unknown", "call_id=", evt.call_id || evt.id || "?");

    // ── Classify event → maintain active-call state for the screen-pop ──
    const isEnd = /end|hangup|finish|complete|terminat/.test(evtName) ||
      evt.talking_time_seconds != null || evt.duration != null;
    const isStart = !isEnd && /start|ring|incoming|outgoing|new|initiat|answer|dial/.test(evtName);
    const extNumber = evt.external_number || evt.public_external_number || evt.contact_phone ||
      evt.caller_id || evt.from_number || evt.to_number || evt.external_phone || evt.number || "";
    const direction = String(evt.direction || evt.call_direction ||
      (/incoming|inbound/.test(evtName) ? "inbound" : /outgoing|outbound|dial/.test(evtName) ? "outbound" : "")).toLowerCase();
    if (isStart && extNumber) {
      setActiveCall({
        callId: evt.call_id || evt.id || null,
        number: extNumber,
        direction: direction || "inbound",
        contactName: evt.contact_name || evt.contact || "",
        startedAt: new Date().toISOString(),
      });
    } else if (isEnd) {
      setActiveCall(null);
    }

    // Match the event back to a lead and persist the call history.
    //
    // Match strategy — try in order:
    //   1. lastCloudTalkCallId  (works for OUTBOUND — we set it on dial)
    //   2. phone match           (catches INBOUND where there's no callId
    //                             link, and any case where the webhook
    //                             fires before /api/cloudtalk/call had
    //                             a chance to set the id)
    //
    // Was the root cause of "incoming calls not always registered" —
    // inbound calls fell through gate #1 silently.
    const callId = evt.call_id || evt.id;
    const fallbackNumber = extNumber || "";
    if (callId || fallbackNumber) {
      if (fs.existsSync(DATA_DIR)) {
        for (const f of fs.readdirSync(DATA_DIR)) {
          if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
          try {
            const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
            let lead = null;
            if (callId) {
              lead = (userData.leads || []).find((l) => String(l.lastCloudTalkCallId) === String(callId));
            }
            if (!lead && fallbackNumber) {
              const target = phoneKey(fallbackNumber);
              if (target && target.length >= 6) {
                lead = (userData.leads || []).find((l) => phoneKey(l.phone || l.ph) === target);
              }
            }
            if (!lead) continue;
            const nowIso = new Date().toISOString();
            // Set lastCallAt on the lead if missing — covers inbound where
            // we didn't pre-set it from /api/cloudtalk/call. Don't overwrite
            // an existing value (avoids clobbering outbound timestamps).
            if (!lead.lastCallAt || isEnd) lead.lastCallAt = lead.lastCallAt || nowIso;
            if (isEnd) {
              lead.lastCallEndedAt = nowIso;
              lead.lastCallDuration = evt.talking_time_seconds || evt.duration || null;
              lead.lastCallRecordingUrl = evt.recording_url || null;
            }
            // Record direction so the UI can label "Indgående/Udgående".
            if (direction) lead.lastCallDirection = direction;
            // Stamp the CloudTalk id on inbound leads too, so a subsequent
            // call-end event lands on the right lead without re-matching.
            if (callId && !lead.lastCloudTalkCallId) lead.lastCloudTalkCallId = String(callId);
            fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(userData, null, 2));
            break;
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

// POST /api/cron/cloudtalk-call-sync — safety net for the webhook.
//
// Polls CloudTalk's calls/index.json for the most recent N calls, matches
// each by phone to a lead, and writes call history if we don't have it
// recorded yet. Catches the cases where the webhook doesn't fire (e.g.
// CloudTalk webhook config drift, Cloud Run cold-start dropping the
// request, or webhook never wired for inbound events).
//
// Idempotent — uses the CloudTalk call id as the dedup key
// (lead.cloudTalkCallIds[] keeps the last 50 ids we've ingested per lead).
// Runs every 15 minutes on weekdays.
app.post("/api/cron/cloudtalk-call-sync", async (req, res) => {
  if (process.env.CRON_SECRET && req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  if (!isCloudTalkConfigured()) return res.status(503).json({ error: "CloudTalk not configured" });

  // CloudTalk caps at 100 per page; 50 is enough headroom between
  // 15-min poll cycles (call volume is typically <20/hr).
  const limit = Math.max(10, Math.min(100, Number(req.query.limit) || 50));
  const stats = { polled: 0, inbound: 0, outbound: 0, missed: 0, newlyRecorded: 0, unmatched: 0, alreadyRecorded: 0, errors: 0 };

  let calls = [];
  try {
    const r = await fetch(`${CLOUDTALK_API_BASE}/calls/index.json?limit=${limit}`, {
      headers: { Authorization: cloudTalkAuthHeader() },
    });
    if (!r.ok) {
      console.warn("[cloudtalk-call-sync] CT API", r.status);
      return res.status(502).json({ error: `CloudTalk API ${r.status}` });
    }
    const j = await r.json();
    calls = (j?.responseData?.data || []).map((row) => row.Cdr || row).filter(Boolean);
  } catch (e) {
    console.error("[cloudtalk-call-sync] fetch", e.message);
    return res.status(502).json({ error: e.message });
  }
  stats.polled = calls.length;

  // Walk every user data file ONCE to load + index by phone — much faster
  // than re-reading the file for every call.
  const userFiles = [];
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.startsWith("data_") || !f.endsWith(".json") || f === "data.json") continue;
      try {
        const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
        const byPhone = new Map();
        for (const lead of (userData.leads || [])) {
          const k = phoneKey(lead.phone || lead.ph);
          if (k && k.length >= 6) byPhone.set(k, lead);
        }
        userFiles.push({ path: path.join(DATA_DIR, f), userData, byPhone, dirty: false });
      } catch { /* skip malformed */ }
    }
  }

  for (const c of calls) {
    const inbound = /incom/i.test(c.type || "");
    const talked = Number(c.talking_time || 0) > 0;
    if (inbound) stats.inbound++; else stats.outbound++;
    if (inbound && !talked) stats.missed++;

    const num = c.public_external || "";
    const k = phoneKey(num);
    if (!k || k.length < 6) { stats.unmatched++; continue; }

    let matched = null;
    let matchedFile = null;
    for (const f of userFiles) {
      const lead = f.byPhone.get(k);
      if (lead) { matched = lead; matchedFile = f; break; }
    }
    if (!matched) { stats.unmatched++; continue; }

    // Dedup — has this exact call already been recorded?
    if (!Array.isArray(matched.cloudTalkCallIds)) matched.cloudTalkCallIds = [];
    if (matched.cloudTalkCallIds.includes(String(c.id))) {
      stats.alreadyRecorded++;
      continue;
    }
    matched.cloudTalkCallIds.push(String(c.id));
    // Cap history list — keep the most recent 50 ids per lead
    if (matched.cloudTalkCallIds.length > 50) {
      matched.cloudTalkCallIds = matched.cloudTalkCallIds.slice(-50);
    }

    // Write the call history. Use whichever timestamp the call has.
    const startedAt = c.started_at || c.ended_at || new Date().toISOString();
    matched.lastCallAt = startedAt;
    if (c.ended_at) matched.lastCallEndedAt = c.ended_at;
    matched.lastCallDuration = Number(c.talking_time || 0) || null;
    matched.lastCallDirection = inbound ? "inbound" : "outbound";
    if (c.recording_url) matched.lastCallRecordingUrl = c.recording_url;
    matched.lastCloudTalkCallId = String(c.id);
    if (inbound && !talked) matched.lastCallMissed = true;
    else matched.lastCallMissed = false;
    matchedFile.dirty = true;
    stats.newlyRecorded++;

    // Activity log entry so it surfaces in the Dashboard feed
    const lbl = inbound && !talked ? "📵 Missed indgående"
      : inbound ? `📞 Indgående (${Math.round(c.talking_time || 0)}s)`
      : `📞 Udgående (${Math.round(c.talking_time || 0)}s)`;
    try {
      logActivity(
        inbound && !talked ? "missed-call" : "call",
        `${lbl}: ${matched.name || num} (${num})`,
        { cvr: matched.cvr, callId: String(c.id), direction: inbound ? "inbound" : "outbound" },
      );
    } catch {}
  }

  // Flush dirty user files
  for (const f of userFiles) {
    if (!f.dirty) continue;
    try { fs.writeFileSync(f.path, JSON.stringify(f.userData, null, 2)); }
    catch (e) { console.warn("[cloudtalk-call-sync] save", f.path, e.message); stats.errors++; }
  }

  console.log("[cloudtalk-call-sync] done:", JSON.stringify(stats));
  res.json({ ok: true, stats });
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

  // Real Twenty CRM push — creates an Opportunity via Twenty's REST API.
  // Stage is configurable via TWENTY_OPP_STAGE (default NEW; flip to KOLD
  // once that enum option is added in Twenty Settings → Objects →
  // Opportunity → stage). The lead's company name becomes the Opportunity
  // name; amount is initialised at 0 DKK.
  try {
    const d = loadUserData(req.userId);
    const lead = (d.leads || []).find((l) => l.cvr === cvr);
    if (!lead) return res.status(404).json({ error: "Lead ikke fundet" });

    const baseUrl = String(process.env.TWENTY_WORKSPACE_URL || "").replace(/\/+$/, "");
    const stage = process.env.TWENTY_OPP_STAGE || "NEW";
    const oppName = lead.name || `Vedio-lead ${cvr}`;

    // ─── Build a rich description so the AE doesn't open a bare Twenty
    // card. Includes: SDR's typed notes, primary contact, phone, LinkedIn,
    // Meta-advertiser signal, and which source the lead came from. The
    // description is the FIRST thing AE sees on the opportunity — make it
    // count.
    const contacts = Array.isArray(lead.contacts) ? lead.contacts : [];
    const primaryContact = contacts.find((c) => c.phone || c.email) || contacts[0] || null;
    const phone = lead.phone || lead.ph || "";
    const sdrNotes = (notes || lead.notes || "").trim();
    const adSignals = Array.isArray(lead.ad_signals) ? lead.ad_signals.filter(Boolean) : [];
    const linkedinUrl = (primaryContact && primaryContact.linkedin_url) || lead.linkedin_url || "";

    const descLines = [];
    descLines.push(`🎯 INTERESSERET — pushet ${new Date().toLocaleString("da-DK", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`);
    descLines.push("");
    descLines.push(`🏢 ${lead.name || "—"}${lead.city ? " · " + lead.city : ""}${lead.ind ? " · " + lead.ind : ""}`);
    if (phone) descLines.push(`📞 ${phone}`);
    if (lead.web) descLines.push(`🌐 ${lead.web}`);
    descLines.push("");
    if (primaryContact) {
      descLines.push(`👤 ${primaryContact.name || "—"}${primaryContact.title ? " · " + primaryContact.title : ""}`);
      if (primaryContact.phone) descLines.push(`   📞 ${primaryContact.phone}`);
      if (primaryContact.email) descLines.push(`   ✉ ${primaryContact.email}`);
      if (primaryContact.linkedin_url) descLines.push(`   💼 ${primaryContact.linkedin_url}`);
      if (contacts.length > 1) descLines.push(`   + ${contacts.length - 1} flere kontakter på leadet`);
    } else if (linkedinUrl) {
      descLines.push(`💼 ${linkedinUrl}`);
    }
    descLines.push("");
    if (lead.meta_advertiser) descLines.push(`🎯 Annoncerer på Meta · ${adSignals.length ? adSignals.join(", ") : "Apollo-bekræftet"}`);
    if (lead.source) descLines.push(`📡 Kilde: ${lead.source}`);
    if (sdrNotes) {
      descLines.push("");
      descLines.push("─── SDR-noter ───");
      descLines.push(sdrNotes);
    }
    const description = descLines.join("\n");

    // Twenty's standard Opportunity object does NOT have a `description`
    // field — sending one returns 400 "Object opportunity doesn't have
    // any 'description' field". The clean alternative is Twenty's Notes
    // object: create a Note with the rich SDR context, then link it to
    // the Opportunity via noteTarget. That's the same UX as if a user
    // had added a note inside Twenty manually.
    const payload = {
      name: oppName,
      stage,
      amount: { amountMicros: 0, currencyCode: "DKK" },
      // Twenty's source enum: UNKNOWN / LINKEDIN / FACEBOOK / LEMLIST /
      // WEBSITE. "UNKNOWN" is the right neutral default for Vedio Leads —
      // our leads come from META scrape / Apollo / CSV / Datafordeler.
      source: "UNKNOWN",
    };
    const r = await fetch(`${baseUrl}/rest/opportunities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.TWENTY_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn("[twenty/push]", r.status, JSON.stringify(j).slice(0, 300));
      return res.status(502).json({
        error: `Twenty afviste push (${r.status}): ${(j.messages && j.messages[0]) || j.error || JSON.stringify(j).slice(0, 200)}`,
      });
    }
    // Twenty's REST response shape: { data: { createOpportunity: {...} } }
    const opp = j.data?.createOpportunity || j.data?.opportunity || j.data || {};
    const opportunityId = opp.id;
    const url = opportunityId ? `${baseUrl}/objects/opportunities/${opportunityId}` : null;

    // Attach the SDR-context as a Note linked to the Opportunity. Best-
    // effort: if either the Note or the noteTarget call fails, we log
    // and continue — the Opportunity creation is the primary success
    // criterion. Twenty's standard schema has both objects.
    let noteAttached = false;
    if (opportunityId && description && description.trim()) {
      try {
        const noteResp = await fetch(`${baseUrl}/rest/notes`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.TWENTY_API_TOKEN}`,
          },
          body: JSON.stringify({
            title: `SDR-noter · ${oppName}`,
            body: description,
          }),
        });
        const noteJson = await noteResp.json().catch(() => ({}));
        if (noteResp.ok) {
          const noteData = noteJson.data?.createNote || noteJson.data?.note || noteJson.data || {};
          const noteId = noteData.id;
          if (noteId) {
            const linkResp = await fetch(`${baseUrl}/rest/noteTargets`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.TWENTY_API_TOKEN}`,
              },
              body: JSON.stringify({ noteId, opportunityId }),
            });
            if (linkResp.ok) {
              noteAttached = true;
            } else {
              const linkJson = await linkResp.json().catch(() => ({}));
              console.warn("[twenty/note-link]", linkResp.status, JSON.stringify(linkJson).slice(0, 200));
            }
          }
        } else {
          console.warn("[twenty/note]", noteResp.status, JSON.stringify(noteJson).slice(0, 200));
        }
      } catch (e) { console.warn("[twenty/note] failed:", e.message); }
    }

    lead.twenty_opportunity_id = opportunityId;
    lead.twenty_pushed_at = new Date().toISOString();
    lead.twenty_url = url;
    lead.twenty_stage = stage;
    lead.twenty_note_attached = noteAttached;
    if (notes) lead.twenty_pushed_notes = notes;
    saveUserData(req.userId, d);
    logActivity("twenty-push", `🎯 ${lead.name} pushet til Twenty (stage: ${stage}${noteAttached ? " + note" : ""})`, { cvr, userId: req.userId, opportunityId });
    res.json({ ok: true, opportunity: { id: opportunityId, url, stage, noteAttached } });
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
