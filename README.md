# Vedio Leads 🎯

CVR-baseret lead- og enrichment-system bygget til Vedios SDR/AE-team.

---

## Hurtig start

### Krav
- Node.js 18+ → https://nodejs.org

### Installation

```bash
# 1. Installer afhængigheder
npm install

# 2. Kopiér konfigurationsfil
cp .env.example .env

# 3. Start serveren
npm start
```

Åbn **http://localhost:3000** i din browser.

---

## Konfiguration (`.env`)

| Variabel | Beskrivelse |
|---|---|
| `PORT` | Server-port (standard: 3000) |
| `CVR_PROVIDER` | `cvrapi` (standard) eller `datafordeler` |
| `DATAFORDELER_USER` | OAuth Client ID fra datafordeler.dk IT-system |
| `DATAFORDELER_PASS` | OAuth Client Secret fra datafordeler.dk IT-system |
| `CLEARBIT_KEY` | Clearbit enrichment API-nøgle |
| `APOLLO_KEY` | Apollo.io API-nøgle |
| `N8N_WEBHOOK_URL` | Standard n8n webhook URL |

---

## CVR-datakilde

### cvrapi.dk (standard — virker med det samme)
Ingen konto nødvendig. Opdateret dagligt fra Erhvervsstyrelsen.

### Datafordeler GraphQL (anbefalet til produktion)
1. Opret gratis konto på **datafordeler.dk**
2. Aktiver datasættet **"CVR — Det Centrale Virksomhedsregister (GraphQL)"**
3. Opret et IT-system i Datafordeler Administration og generér **Client ID** og **Client Secret**
4. Udfyld `DATAFORDELER_USER` (Client ID) og `DATAFORDELER_PASS` (Client Secret) i `.env`
5. Sæt `CVR_PROVIDER=datafordeler`

Systemet henter automatisk et OAuth Bearer-token (client_credentials) og fornyer det før udløb.
Endpoint: `https://graphql.datafordeler.dk/CVR/v1`

---

## Funktioner

### 🔍 Søg & Filtrér
- Fritekst på navn, CVR, branche, by
- Inkluder / ekskluder søgeord
- Reklamebeskyttelse (alle / skjul / kun)
- Branche (DB07-koder med grupper)
- Selskabsform, ansatte, egenkapital, resultat
- Virksomhedens alder, stiftelsesår
- Postnummer-interval (inkluder / ekskluder)
- Har telefon / email / sociale profiler
- Teknologi-stack (WordPress, Shopify, HubSpot osv.)
- Pipeline-fase filter
- ICP-score minimum

### 🎯 SDR/AE-værktøjer (på hvert lead-kort)
- **ICP-score** — 1–5 stjerner, klikbar, gemmes persistent
- **Pipeline-fase** — Ny → Kvalificeret → I dialog → Tilbud → Vundet / Tabt
- **Follow-up dato** — datopicker per lead
- **Tags** — skriv + Enter, flervalg, fjern med klik
- **SDR-noter** — fritekst, autosave
- **Email-skabeloner** — Cold outreach og Follow-up præudfyldt

### 📱 Social Media
- Instagram, Facebook, TikTok, LinkedIn per virksomhed
- Klikbare profillinks direkte fra lead-kortet
- Filtrer på "Har sociale profiler"
- Enrichment via Clearbit/Apollo API

### ✨ Enrichment
- Completeness score (%) per lead
- Automatisk berigelse via Clearbit (kræver API-nøgle)
- Status: telefon, email, website, sociale profiler, finansdata

### 📊 Finansdata
- Omsætning, bruttofortjeneste, resultat, egenkapital
- Sortérbare kolonner i tabellen
- Søjlediagram + nøgletabel i detalje-panel
- *Live finans kræver Erhvervsstyrelsens årsrapport-API*

### ⚡ n8n Integration
- Push leads som JSON payload via webhook
- Payload inkluderer: CVR, kontakt, sociale profiler, ICP-score, pipeline, noter, tags
- CORS-fri proxy via `/api/webhook/n8n`

### 📋 Lister & Eksport
- Opret navngivne ringelister
- Bulk-tilføj valgte leads
- CSV-eksport med alle felter inkl. sociale profiler, ICP-score, pipeline, noter, tags

---

## Filstruktur

```
vedio-leads/
├── server.js          # Express backend + CVR-proxy + API
├── public/
│   └── index.html     # Komplet frontend SPA (standalone-kompatibel)
├── data.json          # Leads, lister, meta (auto-oprettet)
├── .env               # Din konfiguration (lav fra .env.example)
├── .env.example       # Eksempel
├── .gitignore
├── package.json
└── README.md
```

---

## API-reference

| Metode | Endpoint | Beskrivelse |
|---|---|---|
| GET | `/api/search?q=...` | Søg virksomheder |
| GET | `/api/company/:cvr` | Enkelt CVR-opslag |
| GET | `/api/leads` | Hent alle leads + lister |
| POST | `/api/leads` | Tilføj lead |
| DELETE | `/api/leads/:cvr` | Fjern lead |
| PATCH | `/api/leads/:cvr` | Opdatér lead-felt |
| PATCH | `/api/meta/:cvr` | Gem ICP/pipeline/noter/tags |
| POST | `/api/lists` | Opret liste |
| DELETE | `/api/lists/:id` | Slet liste |
| POST | `/api/webhook/n8n` | Proxy til n8n (undgår CORS) |
| GET | `/api/status` | Health check |

### Søgeparametre

```
q            Søgetekst (påkrævet, min. 2 tegn)
branche      DB07-kode prefix, fx "62" for IT
form         Selskabsform: ApS, A/S, I/S, ...
city         Bynavn (delsøgning)
zip          Postnummer prefix
empMin       Minimum ansatte
empMax       Maximum ansatte
foundedFrom  Stiftet fra år
foundedTo    Stiftet til år
hasPhone     true = kun med telefon
hasEmail     true = kun med email
status       active / inactive
```

---

## Deploy til Railway (anbefalet)

1. Gå til **railway.app** → New Project → Deploy from GitHub
2. Push mappen til GitHub
3. Sæt environment variables i Railway dashboard
4. Railway opdager `npm start` automatisk

**Eller lokalt med Docker:**
```bash
docker build -t vedio-leads .
docker run -p 3000:3000 --env-file .env vedio-leads
```
