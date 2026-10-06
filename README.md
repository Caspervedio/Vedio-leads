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
| **Resultater** | Dagens opkald, demoer, provision. En booket demo kan rettes bagefter (✎ Ret): firmanavn, hjemmeside, kontakt, numre og en note - bookingen og status røres ikke. |
| **Research** | Opgaven mellem opkaldene: find navn og nummer på leads, automatikken ikke kunne færdiggøre. |

**Kortet** viser to linjer om hvad firmaet laver (Gemini læser deres website),
op til tre Vedio-kunder i samme branche man kan nævne, og et link til deres
egne annoncer i Meta Ad Library. Alt hvad kortet påstår, er tjekket — "kører
annoncer lige nu" kommer fra deres Facebook-side, ikke fra et gæt.
Er leadet selv Vedio-kunde (samme website eller firmanavn i kundelisten), står
det på kortet og i listen: en *nuværende* kunde ringes aldrig op koldt og
kommer ikke på listerne; en *tidligere* kunde får mærket "Tidl. kunde".
Referencekunder vises kun fra leadets egen branche. Kunder vi ikke kunne læse
hjemmesiden på, kan admin finde via Google (kun svar hvor en af kildernes egne
sider bekræfter firmaet) eller give en kategori i listen under Tilgang.
Inden for branchen kommer den tætteste niche først (en kafferister til et
kaffe-lead) via kundens niche-ord; nogle vises kun ved et niche-match (fx en
negleklinik kun til klinikker). SDR'ernes egen referenceliste er lagt ind:
godkendte tidligere kunder vises med "tidl. kunde", store brands (LEGO, Orkla,
Toyota, Billund Airport) og konkurrent-lignende cases vises ikke automatisk, og
bookede demoer ligger skjult, indtil de har købt. En genimport af kunde-CSV'en
bevarer alt dette.

**Udfald** (1–8): Demo booket · Mail sendt · Følg op · Ingen svar · Ikke nu ·
Ikke relevant · Forkert nummer · Telefonmenu ("tryk 1 for…" — leadet sendes
til Research for et direkte nummer og prøves igen om tre hverdage). Alt kan
fortrydes i 10 minutter.

**Ringelisten er 10 ad gangen** (⚙ "Leads på hver SDR's liste"): op til 3
forfaldne opfølgninger øverst (aftalte før "ingen svar"), resten friske leads
fra puljen; resten af opfølgningerne venter i Opfølgning og roterer ind. Listen
fyldes op efter hvert opkald. Leads en SDR selv har researchet eller tilføjet,
er reserveret til dem (andre får dem ikke) og kommer først. **Fokus i dag**
over listen: branche, webshop-størrelse (StoreLeads' anslåede omsætning) og
kontakt (ejer/direktør, marketing/salg, omstilling) - listen fyldes fra fokus
først og fra resten, når fokus er tomt.

**Fjern fra listen** (uden at ringe — tæller ikke som et opkald): *Ikke vores
målgruppe* (arkiveres), *For svag lige nu* (hviler 90 dage og kommer tilbage
nederst i puljen) eller *Ring senere* (en dato; bliver SDR'ens opfølgning).
Trykkes "Ikke relevant" uden "Ring op", spørger kortet om det var et opkald. Ved
"Følg op" står "Jeg har ringet" altid tændt (de fleste ringer fra egen telefon);
slå den fra for at flytte leadet uden at det tæller. Tallet "fjernet" står ved "ringet i dag", i admins Per SDR og i Excel.
Tasterne følger nu etiketterne på knapperne.

**Sagt nej til** (ved siden af Din liste): alle leads med *Ikke relevant*, *Ikke
nu*, *Forkert nummer* eller *Ikke vores målgruppe* - ens egne, eller *Hele
teamet*. Søgefeltet øverst søger i navn, kontakt, nummer, mail og noter (en mail
der kun står i en note, findes også). **Åbn igen**: *Ring nu* (øverst på ens
egen liste) eller *Følg op* på en dag (i Opfølgning). Leadet følger den, der
åbner det; tråden siger hvis nej det var. Uden dansk nummer går det til
Research og kommer tilbage til en, når nummeret er fundet. Puljens egne
oprydninger (Apollo, ICP-grænser m.m.) er ikke med - de ligger under admins
Leads → Arkiveret.

**Et nej gælder firmaet, ikke kun leadet:** samme firma ligger tit flere gange
med samme telefonnummer (StoreLeads' landebutikker, LAURIE DK/NO/FI, eller
CVR-registeret oveni). Står ét af dem som *Ikke relevant* (eller *Ikke nu*, til
det kommer tilbage) fra en af os, serveres de andre med samme nummer ikke.
Intet skrives på søskendene - åbnes nej'et igen, er de tilbage. En aftalt
opfølgning eller en ejer sat efter nej'et (Åbn igen, admin-flyt) går forud.

**Ingen svar gang på gang:** efter 3 opkald i træk uden svar (siden sidste
samtale) parkeres leadet i 60 dage og kommer tilbage nederst i puljen — begge
tal sættes under ⚙.

Kortet har altid et link til Meta Ad Library med firmanavnet i søgefeltet og
LinkedIn-søgninger: på kontakten (når vi ikke har profilen) og "Find andre" hos
firmaet.

**Mails** skriver SDR'en selv i sin egen Gmail (med deres signatur) og trykker
"✉ Mail sendt" på kortet. Leadet får mærket ✉ Mail sendt og automatisk en
opfølgning to hverdage efter. (At sende fra værktøjet via Gmail er slået fra på
kortet - mails derfra kom uden signatur. Koden ligger der stadig.)

**Noter** er en tråd pr. lead: alt hvad nogen har skrevet, ældst først, med
navn og tidspunkt. Udfaldsnoter ligger i samme strøm.

---

## Admin (`/admin`)

- **Overblik** — tal for i dag og ugen, opkald pr. bookede demo over 30 dage,
  per SDR med opkald, taletid og manuelt berigede leads, provision, puljens
  tilstand, 14-dages strip og Gemini-opsummering af ugen.
  Klik på et tal (14-dages strip, Opkald/Demoer/Samtaler-felterne øverst,
  opkald og demoer i Per SDR) for at se rækkerne bag det, delt op pr. SDR:
  hvilke leads, hvornår, udfald, note og varighed - for demoer også hvor demoen
  står nu. For nye leads deles der op pr. kilde. Tallene lægges sammen præcis
  som i stripen.
- **Sammenlign SDR'er** (fold-ud under 14-dages stripen, lukket som standard;
  henter først tal, når den åbnes, og husker om man lod den stå åben) — for en valgt periode (denne
  uge, 7/30 dage, denne/sidste måned eller egne datoer): øverst AI's vurdering,
  så et kort pr. SDR med en status (På sporet / Hold øje / Under forventning /
  For lidt data), bookede demoer og fire tal - opkald pr. dag, kontaktrate,
  demo pr. samtale, kvalificeret - med mål eller team ved siden af og
  begrundelsen under et tal, der er flaget. Under kortene teamet på én linje.
  "Vis alle tal" folder hele tabellen (aktivitet, konvertering, kvalitet,
  indsats) og hvordan opkaldene ender ud. Grønt = klart bedst (10% foran den
  næste); gråt = for lidt bag tallet (fx under 30 opkald, 15 samtaler, eller en
  SDR med under 50 opkald / 2 hele dage). Samme tal som Excel-eksporten - de
  regnes ét sted (`sdrPeriodStats`).
  **Flag** øverst: under forventning (rød) / hold øje (gul) / afviger (grå) -
  mod målene under ⚙ (opkald pr. dag, opkald pr. demo, andel kvalificerede),
  mod resten af teamet og mod perioden før, kun når forskellen er for stor til
  at være tilfældig (z-test). I oplæringsperioden er et ikke-nået mål gult.
  **AI's vurdering** (Gemini) skrives ud fra tal og flag, gemmes pr. periode i
  `sdr_perf_notes.json` (ikke i puljen) og genbruges i 3 timer.
- **Eksportér resultater** (knap på Per SDR-kortet i Overblik) — et Excel-ark (.xlsx) for en valgt periode,
  evt. én SDR: Oversigt med nøgletal pr. SDR, Per dag, Demoer, alle Opkald,
  Nye leads pr. kilde og Definitioner. Samme tælleregler som Overblik.
- **Leads** — hele puljen med filtre. Søgningen leder også i kontakters
  mails og i noter. Ret et lead, arkivér det, eller slet det permanent. "Se som Christian / Marcus" åbner SDR-appen som dem.
- **Tilgang** — nye leads pr. dag (og hvor mange der faktisk kan ringes til,
  som er den første flaskehals), integrationernes status, CSV-import og
  referencekundelisten.
- **Demoer** — godkend eller afvis bookede demoer. Provision følger
  **lønperioden**: et møde godkendt til og med d. 28. kommer med i den
  måneds løn, godkendt fra d. 29. i næste måneds. Vælg "Løn <måned>" for at se
  hvad hver SDR skal have, møde for møde. En lønperiode låses automatisk efter
  d. 28. kl. 23:59 (`commission_locks.json`) og ændres aldrig bagefter: et møde
  der afvises efter udbetaling, modregnes i den næste åbne periode, og intet
  betales to gange. Hvert møde beholder satsen fra godkendelsesdagen.
  Et godkendt møde i en åben periode kan flyttes til næste måneds løn ("→
  <måned>" i møde-listen) og tilbage igen, så længe perioden ikke er låst.
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

*Filer:* 📎, træk ind eller indsæt et skærmbillede. Billeder, PDF, lyd og video
(op til 1 GB) sendes i stykker á 8 MB videre til Geminis Files API, som gemmer
dem i 48 timer; Word/PowerPoint/Excel og tekstfiler læses på serveren og gives
som tekst (`chat_files/<id>/`). Uploaden starter med det samme og vises med
fremdrift — man kan skrive videre, og sende før en video er færdigbehandlet.

*Artefakter:* Gemini kan lave et dokument (markdown) eller en webside (HTML)
som et kort under svaret — eller man trykker "Gem som artefakt". Det åbnes stort,
kan downloades, kopieres med formatering og deles med et link (`/a/<token>`),
der virker uden login, tæller visninger og kan slås fra igen. Sider vises i en
sandbox og kan ikke nå appen. Gemt pr. SDR i `artifacts/<id>/`, med versioner;
"Artefakter" ligger ved siden af "Samtaler" i panelet.

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
