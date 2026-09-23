# Vedio Ring

Kaldeværktøjet Vedios SDR'er bruger til at ringe danske webshops op, og
admin-siden founderne styrer det fra. Systemet finder selv leads, beriger dem
med en person og et telefonnummer, og lægger dem på SDR'ernes lister.

Live: `https://leads-ako4zbaita-ew.a.run.app` — SDR'erne på `/`, admin på `/admin`.

> Det gamle AE-værktøj ligger stadig på `/legacy` (`public/index.html`). Det
> bruges ikke længere. Nyt arbejde hører hjemme i `app.html` og `admin.html`.

---

## Sådan hænger det sammen

```
Kilder ─────────► Fælles pulje ─────────► Christians liste (60)
StoreLeads        data_pool.json          Marcus' liste (60)
CVR-walk          admin ser og retter     fyldes op automatisk
Google Maps       her
Meta Ad Library
```

**Én fælles pulje.** Alt hvad crons finder lander i `data_pool.json`. Derfra
fylder hver SDR's liste sig selv op til 60 leads — de holder ved fra dag til
dag, og et lead kan kun ligge på én SDR's liste ad gangen. Er en SDR væk i
fem dage, frigives deres leads til den anden.

**Rækkefølgen bestemmer kvaliteten, ikke filtre.** Et lead er ringbart, så
snart der er et dansk nummer. Leads med en navngiven beslutningstager
sorteres først, så omstillingsopkald først dukker op, når de gode er brugt.

---

## SDR-appen (`/`)

| Fane | Hvad den er til |
|---|---|
| **Ringeliste** | Dagens 60 leads. Træk i rækkefølgen, fjern et lead for i dag. |
| **Opkald** | Ét kort ad gangen: firma, kontakt, nummer, pitch, noter, udfald. |
| **Opfølgning** | Aftalte tilbagekald og sendte mails, kun ens egne. |
| **Resultater** | Dagens opkald, demoer, provision. |
| **Research** | Opgaven mellem opkaldene: find navn og nummer på leads, automatikken ikke kunne færdiggøre. |

**Kortet** viser to linjer om hvad firmaet laver (Gemini læser deres website),
op til tre Vedio-kunder i samme branche man kan nævne, og et link til deres
egne annoncer i Meta Ad Library. Alt hvad kortet påstår, er tjekket — "kører
annoncer lige nu" kommer fra deres Facebook-side, ikke fra et gæt.

**Udfald** (1–8): Demo booket · Send mail · Følg op · Ingen svar · Ikke nu ·
Ikke relevant · Forkert nummer · Telefonmenu ("tryk 1 for…" — leadet sendes
til Research for et direkte nummer og prøves igen om tre hverdage). Alt kan
fortrydes i 10 minutter.

**Mails** sendes fra SDR'ens egen Gmail (forbindes under ⚙), så svar lander i
deres indbakke. Er den ikke forbundet, åbnes udkastet i deres mailprogram.
Et lead med en sendt mail får automatisk en opfølgning to hverdage efter.

**Noter** er en tråd pr. lead: alt hvad nogen har skrevet, ældst først, med
navn og tidspunkt. Udfaldsnoter ligger i samme strøm.

---

## Admin (`/admin`)

- **Overblik** — tal for i dag og ugen, opkald pr. bookede demo over 30 dage,
  per SDR med opkald, taletid og manuelt berigede leads, provision, puljens
  tilstand, 14-dages strip og Gemini-opsummering af ugen.
- **Leads** — hele puljen med filtre. Ret et lead, arkivér det, eller slet
  det permanent. "Se som Christian / Marcus" åbner SDR-appen som dem.
- **Tilgang** — nye leads pr. dag (og hvor mange der faktisk kan ringes til,
  som er den første flaskehals), integrationernes status, CSV-import og
  referencekundelisten.
- **Demoer** — godkend eller afvis bookede demoer. Provision følger de
  godkendte.
- **⚙** — Calendly-link, dagligt mål, listestørrelse, provision, pitch,
  mailskabeloner, Slack-webhook og reglerne for hvad puljen må servere.

---

## Sådan bliver et lead ringbart

1. **Findes** — StoreLeads (danske Shopify/WooCommerce-shops), CVR-walk på
   udvalgte brancher, Google Maps, Meta Ad Library.
2. **Verificeres** — dansk firma, rigtig shop, ikke en dublet.
3. **Beriges** — Full Enrich finder en person (gratis søgning, ca. 58% træffer),
   Apollo og Datafordeler finder numre, Gemini læser websitet og skriver de to
   linjer.
4. **Meta-tjekkes** — deres Facebook-side fortæller, om de annoncerer lige nu.
5. **Lander på en liste** — bedste først.

Hvad automatikken ikke kan, havner i Research-fanen til SDR'erne.

**Sparring (den lilla ✦ nederst til højre).** En chat med Gemini i et panel til højre. Den
kender pitchen, de 12 scripts, træningsguiden, referencekunderne og det lead
SDR'en har åbent (kan slås fra), og svarer på dansk i telefonsprog.
Den kan også slå op i platformen — alle leads (navn, website, person, nummer),
SDR'ens egen liste, opfølgninger, tal og seneste opkald — og viser under svaret,
hvad den slog op. Samtaler gemmes pr. SDR (`chats/chats_<id>.json`), kan
genåbnes og slettes. Svar kan
kopieres eller lægges direkte i noten.

**Hvor meget der kommer ind.** Puljen fyldes op til et antal *friske* leads
(aldrig ringet, med navn + nummer, ikke parkeret) — 450 som udgangspunkt, sat
under ⚙. Under tallet flyttes nye butikker ind og der købes telefonnumre; over
det venter alt der koster pr. lead. Et lead på en SDR-liste får altid sit
nummer.

**StoreLeads-reserven.** StoreLeads koster det samme uanset hvor meget vi
henter, så alle danske butikker hentes 4× om dagen ind i en reserve
(`discovery/storeleads_reserve.json`, uden for puljen). Derfra flyttes de
bedste ind, når der mangler friske leads — i tre tiers:

1. 10+ varer, trafik-rang 100k–3M (~13.100)
2. 10+ varer, lav trafik (~13.400)
3. alle øvrige (~20.000 — mange er hoteller, restauranter, klinikker o.l. med en lille shop)

Derudover hentes ~5.600 danske **brancher** direkte på StoreLeads' kategori
(hoteller, klinikker, fitness, B2B, håndværk, undervisning m.fl.) — de er
servicevirksomheder med en lille webshop, og ligger som tier 3.
Reserven kan ses under **Leads → Reserve**, hvor du også kan hente bestemte
butikker ind i puljen med det samme.

En tier flyttes først ind, når reserven ikke har flere fra tier'en over. Når
alt er hentet, kan StoreLeads sættes på pause — reserven fodrer videre.
CVR-walk, Google Maps og Meta Ad Library kører først, når reserven er tom.

**Genopring (admin).** Firmaer Vedio har mødt før — fra Twenty: LinkedIn-
outreach, Facebook-leads, gamle demoer, folk der har prøvet Vedio. Kunder nu,
aktive deals (rørt inden for 45 dage), "ikke ICP" og "bruger konkurrent" er
udeladt. De ligger i puljen men uden for SDR'ernes lister, til admin giver dem
videre fra **Leads → Genopring**; SDR'en ser historikken som små mærker på
kortet ("Tidligere kunde", "Har haft demo · jun 2026", "Tabt: ikke prioritet",
"Kom via Facebook-annonce"). De gratis opslag kører på dem, så dem med kun et
website kan få et navn og et nummer; betalte opslag venter, til de er givet
videre. Hentes igen hver mandag.

---

## Drift

**Cloud Run** i `europe-west1`, projekt `vedio-444210`. Én instans, altid
tændt. Data ligger i GCS-bucket'en `vedio-leads-data`, monteret på `/data`.

**Filer i bucket'en**

| Fil | Indhold |
|---|---|
| `data_pool.json` | Puljen: alle leads, begge SDR-lister, indstillinger |
| `discovery/storeleads_reserve.json` | Hentede butikker, der endnu ikke er i puljen |
| `users.json` | Brugere og adgangskoder |
| `customers.json` | Referencekunder til navnedrop |
| `gmail_tokens.json` | SDR'ernes Gmail-forbindelser |
| `activity.json` | Aktivitetslog |
| `backup/` | Daglig kopi af puljen kl. 03:30, 30 dage tilbage |

**Cron** (Cloud Scheduler, 25 jobs) kalder `/api/cron/*` med `x-cron-secret`.
De vigtigste:

| Job | Hvornår | Hvad |
|---|---|---|
| `storeleads-discover-*` | 4× dagligt | Henter butikker til reserven, flytter de bedste ind i puljen |
| `branche-walk-discover-*` | 6× dagligt | CVR-registret |
| `find-people` | hvert 15. min | Finder en navngiven person |
| `describe-companies` | hvert 20. min | De to linjer på kortet |
| `meta-pages-check` | hver 30. min | Annoncerer de lige nu? |
| `intake-enrich`, `drain-enrichment` | hvert 5. min | Kontakter og numre |
| `twenty-demo-sync` | hvert 5. min, 07-21 | Bookede demoer → Twenty |
| `twenty-retry-sync` | mandag 06:15 | Genopring-listen hentes fra Twenty |
| `pool-backup` | 03:30 | Backup |

**Puljen gemmes** kompakt. Baggrundsjob gemmer deres egen kopi; et lead, som
et andet job tilføjede imens, bevares (et lead admin sletter, forbliver væk).

**Deploy** sker af sig selv når `main` pushes (GitHub Actions →
`.github/workflows/deploy.yml`). Nøgler hentes fra Secret Manager.

---

## Integrationer

| Tjeneste | Bruges til |
|---|---|
| Datafordeler (CVR) | Firmadata, numre. Gratis |
| StoreLeads | Danske webshops |
| Apollo | Firmaopslag, kontakter, annoncørsignal |
| Full Enrich | Finder personer og direkte numre |
| Apify | Meta Ad Library og Facebook-sider |
| Gemini | Firmabeskrivelser, kundekategorier, ugens opsummering |
| Gmail | SDR'erne sender fra deres egen adresse |
| Slack | Besked når en demo bookes |
| Twenty (vedio.twenty.com) | Hver booket demo bliver en opportunity i *Demo Booked* med Victor som ejer — ca. 10 min efter booking, så en fortrudt booking aldrig kommer med. Findes firmaet allerede, genbruges det, og en åben opportunity flyttes i stedet for at blive dubleret. Log over hvad der er sendt: `twenty_demos.json` |

Status for dem alle kan tjekkes live under **Tilgang → Integrationer**.
**Tilgang → Abonnementer denne måned** viser forbrug, saldo og pris pr. booket
demo — og om vi får værdien ud af de faste abonnementer.

---

## Lokal udvikling

```bash
npm install
DATA_DIR=./local-data PORT=3010 node server.js
```

Læg en kopi af `data_pool.json` og `users.json` i `DATA_DIR`. Uden nøgler
kører appen fint — de dele, der kræver dem, slår bare fra.

**Filer der betyder noget**

```
server.js            hele backenden; SDR-delen ligger nederst
public/app.html      SDR-appen
public/admin.html    admin
public/app.css       fælles styling
public/index.html    det gamle værktøj (/legacy)
```

Efter en ændring i frontenden: træk inline-JS ud og kør `node --check`, ellers
opdager man først en tastefejl i produktion.
