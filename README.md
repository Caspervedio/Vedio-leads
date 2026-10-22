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
| **Dine tal** | SDR'ens egne tal: kvalificeret provision i lønnen (ventende demoer står som "op til", lægges ikke til lønnen), dagens og ugens opkald og demoer, coachen, egne demoer og egne opkald i dag. En booket demo kan rettes bagefter (✎ Ret). Holdets tal ligger i admin. |
| **Research** | Opgaven mellem opkaldene: find navn og nummer på leads, automatikken ikke kunne færdiggøre. |

**Kortet** viser to linjer om hvad firmaet laver (Gemini læser deres website),
op til tre Vedio-kunder i samme branche man kan nævne, og et link til deres
egne annoncer i Meta Ad Library. Alt hvad kortet påstår, er tjekket — "kører
annoncer lige nu" kommer fra deres Facebook-side, ikke fra et gæt.
Er leadet selv Vedio-kunde (samme website eller firmanavn i kundelisten), står
det på kortet og i listen: en *nuværende* kunde ringes aldrig op koldt og
kommer ikke på listerne; en *tidligere* kunde får mærket "Tidl. kunde".
Referencekunder vises kun fra leadets egen branche - og nu også kun fra samme
**niche** (fx belysning, møbler, have under Bolig): samme niche først, så kunder
hvis tags matcher leadet, så brede kunder i branchen; en kunde fra en anden
niche vises aldrig. Hver kunde har en niche (Gemini sorterer dem én gang under
Tilgang → "Sortér i nicher med AI"; kan rettes pr. kunde), leads får deres fra
nøgleord. **Se alle kunder** på kortet åbner alle nuværende og tidligere
kunder med logo, delt i branche og niche, med søgning - leadets egen niche
øverst. ✓ = må nævnes som reference. Logoer hentes én gang via serveren og
gemmes i `logos/`. Kunder vi ikke kunne læse
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

**Ringelisten er 10 friske leads ad gangen** (⚙ "Leads på hver SDR's liste") -
ingen opfølgninger. Forfaldne opfølgninger ligger i deres eget spor, så de ikke
tager pladsen fra nye leads og ikke bliver glemt: Opfølgning-fanen har filtret
**Venter nu** (valgt, når noget venter; aftalte først, så "Mail sendt", så
"Ingen svar"-genopkald, ældste først) og tallet på fanen viser hvor mange. På
Ringeliste står én smal linje, kun når der venter aftalte opfølgninger; i
Opkald-fanens sidekolonne de tre næste. **Ring** på en åbner den øverst på listen, til et udfald (eller
Spring over) sender den videre. Listen fyldes op efter hvert opkald. **↻ Nye leads** (øverst
på Ringelisten) bytter hele den friske del af listen ud med de næste fra puljen;
de fravalgte hviler til i morgen som ved "Ikke i dag". Opfølgninger, det lead der
er en samtale i gang på, og leads SDR'en selv har researchet eller tilføjet bliver.
Højst 5 gange om dagen pr. SDR, og hvert byt logges. Leads en SDR selv har researchet eller tilføjet,
er reserveret til dem (andre får dem ikke) og kommer først. **Fokus i dag**
over listen: branche, webshop-størrelse (StoreLeads' anslåede omsætning) og
aktive Meta-annoncer (mindst 1 · 3 · 5 · 10 · 20, efterset i Ad Library) - listen
fyldes fra fokus først og fra resten, når fokus er tomt. (Kontakt-håndtaget
ejer/marketing/omstilling er taget ud - ingen brugte det.)

**Fravælg uden opkald** (tæller ikke som et opkald): *Ikke vores
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

Faner: **Overblik · Leads · Tilgang · Resultater · Kunder · Drift**, og ⚙.
Ordbog i hele værktøjet: en **demo** bookes, founders **vurderer** den, og en
**kvalificeret** demo giver provision.

- **Overblik** — tal for i dag og ugen, og ét kort **SDR'erne** med tre faner:
  *I dag* (lister, opkald, tid på leads, demoer - farvet mod målene),
  *Sammenlign* (en periode side om side med flag og AI's vurdering; tallet på
  fanen er antal flag) og *Ugens læring* (AI ud fra debriefs). Derunder de
  sidste 14 dage og puljens tilstand.
- **Tilgang** — kun tilgangen af leads: nye pr. dag, tragten, kilder og nicher.
- **Kunder** — referencekundelisten (kategori, niche, skjul, recheck).
- **Drift** — hvad værktøjerne koster denne måned, om integrationerne virker,
  og CSV-import af leads.
- **⚙ Indstillinger** — i faner: Pulje & regler · Mål · Løn · Arbejdsgang ·
  Pitch & mails · Integrationer. Ét Gem gemmer alle faner.
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
  mails og i noter. Ret et lead, arkivér det, eller slet det permanent. Klik på "Admin ▾" i toppen for at åbne SDR-appen som en af SDR'erne.
- **Tilgang** — nye leads pr. dag (og hvor mange der faktisk kan ringes til,
  som er den første flaskehals), integrationernes status, CSV-import og
  referencekundelisten.
- **Resultater** (hed før Demoer) — åbner med status for den valgte periode
  (denne uge · 30 dage · denne måned · sidste måned · alt · egne datoer; valget
  huskes, og **Konvertering** følger samme periode): demoer booket, demo pr.
  samtale, kvalificeret, solgt, provision i den åbne løn - pilene er mod samme
  antal dage før - og hvad der venter på dig. Under det tre faner: **Demoer** (godkend), **Løn + fravær** (lønperioden + **sygdom**) og
  **Konvertering** (fra demo til salg). Sygdom registreres pr. SDR som en dag
  eller en periode; den tælles i hverdage pr. lønperiode, står under lønnen og
  som "Sygedage" i Excel-arket, og ændrer ikke beløbene. Gemmes i
  `sdr_absence.json` (ikke i puljen).
- **Telefonen i browseren (Twilio Voice) - "hjernen", trin 1.** Når admin har slået det til
  for en SDR under ⚙ → Telefoni (og Twilio-nøglerne ligger som secrets:
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`,
  `TWILIO_TWIML_APP_SID`), ringer SDR'en fra kortet på sit eget danske nummer:
  Frankfurt-edge, Opus først (op til 40 kbit/s), SDK'ens egne advarsler som
  lydkvalitets-prik, tastatur til telefonmenuer, og "Test lyd" under ⚙ (man hører
  sig selv). **Lyd** under ⚙ vælger mellem *standard* (Chrome renser lyden: ekko-,
  støj- og volumenbehandling - til laptop-mikrofon og højttaler) og *headset*
  (ingen bearbejdning - kabel- eller USB-headset; det er Chromes støjreduktion og
  auto-gain, der får en stemme til at lyde komprimeret og "inde i en kasse").
  Valget gemmes i browseren (`vl_mic_mode`). Bruger man en Bluetooth-mikrofon
  (AirPods o.l.), skifter Mac'en til hands-free-profilen i telefonkvalitet, så alt
  lyder komprimeret - kortet advarer om det ved første opkald; brug Mac'ens egen
  mikrofon eller et kabelheadset. Samtalen optages i to kanaler (samtykke: SDR'en
  siger det selv, eller en besked afspilles for kunden - valg under Telefoni), og
  når røret lægges på, læser Gemini optagelsen (`/api/twilio/recording` →
  `recordingAnalyse`): transskript, resumé, hvem man fik fat i, gæt på udfald og
  "hvorfor ikke demo", indvendinger, næste skridt, coaching, forslag til
  tjeklisten (grundlag, købssignaler, annoncebudget) og en opfølgningsmail.
  Resuméet lander i notetråden; på kortet kan SDR'en bruge det som note, åbne
  mailen klar til at sende, og tjeklisten forudfyldes ved "Demo booket". Udfaldet
  gemmer den rigtige varighed (`dial_s`) og `call_sid`. Indgående opkald til et
  SDR-nummer ringer i browseren og noteres på leadet ("Ringede selv tilbage").
  **Telefonvinduet** (knappen nederst til venstre, kun når telefonen er slået til) ringer
  et vilkårligt dansk nummer op med tastatur og slår nummeret op i hele puljen, mens
  man taster (`GET /api/sdr/lookup?phone=`: firma, kontakt, status); et indgående
  opkald åbner vinduet af sig selv med ringetone og den matchede kunde; efter
  samtalen står resuméet der med "Åbn lead og sæt udfald" (`POST /api/sdr/open-lead`:
  øverst på listen, når leadet kan være ens, ellers vises det bare på kortet). Under
  samtalen viser vinduet navn, nummer, initialer, tid og lydkvalitet med runde
  Mute/Tastatur/Læg på-knapper (timer og kvalitet opdateres i både vinduet og kortet).
  Ringer man et nummer op uden lead på kortet, hæftes samtalen på det lead, nummeret
  tilhører. Lyd slettes hos Twilio efter `retention_days` (30) af `POST /api/cron/recordings-prune`;
  transskript og resumé bliver. Alle webhooks tjekkes mod Twilios signatur
  (`TWILIO_SKIP_VALIDATE=1` kun til lokale tests; `PUBLIC_URL` = den offentlige adresse).
- **Lead-kvalitet: hvem der faktisk booker kvalificerede demoer (okt. 2026).** De
  1.096 StoreLeads-leads, der var ringet til, viste: Facebook-side + Meta-pixel + under
  5 mio. kr i omsætning gav én kvalificeret demo pr. ca. 42 opkald; ingen side, ingen
  pixel eller 5 mio.+ gav én pr. ca. 213 - og halvdelen af alle opkald gik dertil. De
  største butikker (trafik-rang under 300k) gav 1 kvalificeret demo af 209. Derfor:
  - **Svage leads sidst** (`sdrFitWeak`): uden Facebook-side (og uden verificerede
    annoncer), uden Meta-pixel (medmindre de har aktive annoncer) eller over
    omsætningsgrænsen. Køen har tre bånd: passer → svagt match → aldrig kørt annoncer;
    inden for hvert bånd styrer Ad Library-vægten som før. Admin: "Svage leads sidst"
    og "Omsætningsgrænse" (5 mio. kr) under Pulje & regler (`rules.rank_weak_last`,
    `rules.weak_revenue_mio`). Kortet viser "Svagt match · <grund>".
  - **Venter på Facebook-opslaget**: et nyt lead med et Facebook-link serveres ikke,
    før sideopslaget (`/api/cron/meta-pages-check`, hver 2. time) har kørt - højst 48
    timer (`sdrPagePending`). Uden siden kan annoncerne ikke tjekkes, og leadet ville
    havne blandt de svage ved en fejl.
  - **StoreLeads-indtag i den rigtige ende** (`storeLeadsReserveOrder`): butikker med
    Facebook-side + pixel først, derefter dansk nummer, så trafik-båndet 700k-1,5M,
    300k-700k, 1,5M-3M, 3M+. Butikker med rang under 300k
    (`STORELEADS_PROMOTE_RANK_MIN`) eller over omsætningsgrænsen hentes ikke ind
    (`storeLeadsPromotable`) - de bliver i reserven. Før gik de mest besøgte først,
    og e-mail vejede tungere end en Facebook-side; de næste 80 havde ingen med side +
    pixel, nu har alle 80. Alle stærke butikker med dansk nummer i båndene op til 3M
    er allerede hentet ind; de næste er stærke butikker i 3M+-båndet (ingen
    opkaldsdata endnu - hold øje). Stærke butikker uden nummer kommer efter dem
    (CVR-opslaget finder sjældent et nummer).
  - **"Ikke vores målgruppe" med begrundelse**: ét tryk (For stor, For lille / hobby,
    Sælger ikke online, Service eller B2B, Har bureau eller eget team, Forkert branche,
    Andet) gemmes på leadet (`icp_why`, også i `screen_log`) og i noten; Fortryd
    gendanner den. Admin ser fordelingen de seneste 30 dage under Pulje & regler
    (`GET /api/sdr/admin/icp-why`).
  - StoreLeads-abonnementet er opsagt med vilje (okt. 2026) for at spare udgiften;
    vi havde allerede hentet en stor reserve. Hentningen fejler derfor med "account no
    longer has API access" - det er forventet. Indtaget kører videre fra de ca. 34.700
    butikker i reserven, som ikke fyldes op igen.
- **Ad Library-tjekket læser ikke tomme sider som "aldrig" (okt. 2026).** SDR'erne
  klagede over, at listerne næsten ingen annoncører havde. Årsagen var tjekket selv:
  fra 16. okt. kl. 21:21 til det løb tør for leads dagen efter gav hver eneste
  opslag "har aldrig kørt annoncer" (1.070 i træk, nul aktive, nul "har kørt før").
  Meta viste siden uden resultater (sandsynligvis throttling), og `adlibParse` læste
  "ingen tæller og ingen annoncer" som nul annoncer; "aldrig" ligger nederst i
  køen i 30 dage, så SDR'erne fik kun de få resterende annoncører og derefter
  pausede og leads uden Facebook-side. Stikprøver i en rigtig browser: Moccatime
  (ca. 120 annoncer), NordicHigh (73 aktive) og Hobbydrivhuse (78 aktive) stod alle
  som "aldrig". Rettet sådan:
  - En side uden tæller, uden annonce-id'er og uden "Ingen annoncer matcher" er
    **ulæselig** (`null` → `blocked`) og prøves igen, aldrig "nul". "Ingen annoncer"
    læses to gange (2,5 s imellem), og en langsom side får et ekstra kig (5 s), før
    den kaldes ulæselig - tunge sider med mange annoncer renderer langsomt på én CPU.
  - En kørsel stopper ved 4 ulæselige i træk (før: 3 i alt), og en side, der ikke
    kunne læses, venter 3 timer (`ADLIB_FAILED`, i hukommelsen).
  - "Aldrig"-svar holdes tilbage under kørslen. Efter 12 i træk (`ADLIB_NONE_STREAK`)
    tjekkes en "kanarie" - en side, vi ved har mange aktive annoncer. Læses den som
    aktiv, er stimen ægte (en klump små butikker uden annoncer) og svarene gemmes;
    er den også tom, svarer Meta ikke normalt - stimen kasseres, og kørslen stopper.
    (Uden kanarien stoppede hver kørsel på de samme 12 ægte "aldrig"-leads, 22. okt.)
  - Rækkefølgen for tjek: leads på en liste, så dem der ikke er ringet til, så
    trafik-båndet der booker (700k-1,5M først). Seneste kørsel gemmes (`adlib_last_run`) og
    vises under Indstillinger → Ad Library-status.
  - Leads, der ikke er ringet til, tjekkes før dem, der er.
  - Reparation: `POST /api/cron/adlib-repair?from&to[&dry=1]` (cron-secret) sætter
    tjekkets egne "aldrig"-svar i vinduet tilbage til "ikke efterset" (rangeres
    straks over leads uden Facebook-side; det gamle svar gemmes i `adlib_prev`) og
    markerer "har kørt før"-svar til nyt tjek (`adlib_recheck`, beholder status og
    plads, til de er tjekket igen - den gamle læsning kunne også gøre en aktiv til
    "har kørt før", hvis kun aktiv-visningen fejlede). SDR'ernes egne "ingen aktive
    annoncer" og alle "aktiv"-svar røres ikke. Kørt 22. okt. 2026 for hele
    perioden med den gamle læsning.
  - Linket til Ad Library på kortet viser nu alle lande (før kun Danmark - en dansk
    butik, der annoncerer i Tyskland, så tom ud) og åbner de aktive annoncer, når
    der er nogen.
- **Ad Library-tjek - er de annoncører?** Facebook-sidens "kører annoncer"-flag viste sig
  forkert på 10 af 14 leads på listerne (okt. 2026). Puljen efterses derfor i selve
  Meta Ad Library (sidens egne annoncer, alle lande) - lister først, dernæst puljen
  i serveringsrækkefølge, 30 ad gangen hvert 20. minut via Cloud Scheduler-jobbet
  `adlib-check` → `POST /api/cron/adlib-check?batch=30` (Cloud Run giver kun CPU,
  mens en forespørgsel kører, så en intern timer sultede; `ADLIB_SWEEP=1` slår
  timeren til på en lokal server uden scheduler).
  Resultatet står på leadet (`adlib_status` active · past · none, `adlib_active`,
  `adlib_total`, `adlib_last_start`, `adlib_checked_at`); aktive tjekkes igen efter
  14 dage, resten efter 30. Listerne serverer **aktive annoncører først, så sider
  der har kørt annoncer før, så de ikke-efterset** - og sider, der aldrig har kørt
  en annonce, kommer allersidst (Casper, 20. okt.: de skal blive ved med at være en
  mulighed, ellers løber listerne tør; ⚙ → Regler → "Skjul leads, der aldrig har
  kørt annoncer" holder dem helt ude, slået fra som standard). Kortet
  og Ringelisten viser beviset ("Kører 12 Meta-annoncer lige nu · tjekket 16. okt.",
  "Har kørt Meta-annoncer · sidst sep. 2026", "Ingen annoncer i Ad Library"), og
  linket åbner de aktive annoncer. SDR'en kan selv fravælge med "Ingen aktive
  annoncer" - det gemmes som et tjek, og leadet hviler 3 måneder. Dækningen og en
  manuel kørsel står under ⚙ → Regler.
  Rækkefølgen inden for de efterset er vægtet (`adlibScore`): mange og friske
  aktive annoncer øverst (3+ annoncer eller en ny inden for 30 dage), så sider
  der pausede inden for 90 dage, så tynde annoncører (1-2 gamle annoncer), så
  ældre pauser, så de ikke-efterset, så sider uden Facebook-side, og sider der
  aldrig har kørt en annonce allersidst. ⚙ → Regler kan skjule "aldrig" og
  "stoppet for over et år siden" helt (begge slået fra som standard). Fokus-
  håndtaget "Aktive Meta-annoncer" har også "Har kørt annoncer (nu eller før)"
  til den SDR, der kun vil ringe til annoncører - og "Ingen aktive annoncer lige
  nu" (efterset: pauset eller aldrig) til den, der tager dem med en anden pitch.
- **StoreLeads-estimatet er synligt.** For webshops fra StoreLeads (ca. 4 af 10 leads)
  står den anslåede årlige omsætning og månedlige besøg ("≈ 2,3 mio. kr/år · 972
  besøg/md · StoreLeads-estimat") på opkaldskortet under websitet, som hint på
  tjeklistens første punkt, under firmanavnet på demorækken og som chips øverst i
  admins vurdering - sammen med Meta-status på annoncepunkterne. Tallet er
  StoreLeads' estimat i USD-cent omregnet med 6,9 kr/$; samme tal driver
  størrelsesfilteret i "Fokus i dag".
- **Annoncebudget.** Meta offentliggør ikke forbrug for almindelige annoncer, så
  tjeklistens punkt 2 spørger SDR'en om det, de fik at vide i samtalen - ét tryk på
  *Under 10.000 · 10-25.000 · 25-50.000 · Over 50.000 · Ved ikke* (kr/md). 10.000+
  sætter fluebenet, under 10.000 fjerner det. Som udgangspunkt står et estimat på
  punktet (5-15 % af StoreLeads-omsætningen, kun når de kører annoncer). Svaret
  gemmes i `demo_check.spend_band`, står på demorækken, i admins vurdering, i
  Slack/Twenty-linjen og i Excel-kolonnen "Annoncebudget (SDR)".
- **Opkaldskortet (okt. 2026).** Under kontaktpersonen ligger to faner: **Samtale**
  (AI'en, der lytter med - se næste punkt) og **Pitch** (egen pitch eller et script).
  Højre kolonne viser **Noter** (notefeltet og tråden), **Historik** (opkald, udfald,
  noter, AI-resuméer, mails, demo - nyeste først) og **Referencer**; "Næste på listen"
  og "Opfølgninger der venter" er taget ud af kortet (de ligger på Ringelisten og
  under Opfølgning). Træning- og mail-knapperne er væk; mailen skrives nu af AI'en
  efter samtalen. Tastaturgenvejene virker stadig, hint-linjen er fjernet.
- **AI lytter med under samtalen (Samtale-fanen).** Hints, der kommer 8-12 sekunder
  efter noget er sagt, hjælper ikke midt i en sætning (Casper, okt. 2026), så fanen er
  et **løbende overblik** plus **analysen ca. 7 sekunder efter, røret er lagt på**. Mens
  opkaldet kører, forker Twilio lyden til serveren (`<Start><Stream track="both_tracks">`
  → WebSocket `/api/twilio/stream`, μ-law i 20 ms-pakker, begge kanaler; forbindelsen
  skal bære Twilios signatur over wss-adressen, ellers 403). Hvert 15. sekund
  (`LIVE_CHUNK_MS`) sendes de nye sekunder som stereo-WAV (venstre = SDR, højre = kunde)
  til Gemini 2.5 Flash uden "thinking" (svar på 3-5 s) sammen med linjerne indtil nu,
  det forrige overblik, pitchens "Hvis de siger …"-svar og tjeklisten. Den svarer med de
  linjer, der blev sagt, og et opdateret **status**-objekt: et par sætninger om hvor
  samtalen er, hvilke tjeklistepunkter kunden faktisk har afklaret (med hvad de sagde -
  et afklaret punkt bliver stående), annoncebudget-bånd ("ved ikke" tæller ikke),
  indvendingerne indtil nu med ét svar til hver, og det ene, SDR'en bør gøre nu. Kortet
  viser grundlag/købssignaler med flueben, indvendinger med svar, en "Nu"-linje og den
  rullende transskription.
  **Når røret lægges på**, venter serveren ikke på et klip, der er undervejs: dets lyd og
  resten af bufferen sendes som de sidste sekunder sammen med hele transskriptionen i
  ét kald (`liveFinal`, lille thinking-budget `LIVE_FINAL_THINKING` = 512), med samme
  prompt som optagelsens analyse (`callAnalysisPrompt`/`callAnalysisParse`, delt mellem
  de to) plus feltet `tail` (de sidste sekunders replikker, som lægges til
  transskriptionen) → resumé, hvem man fik fat i, udfald, "hvorfor ikke demo",
  indvendinger, næste skridt, coaching, tjeklisteforslag og opfølgningsmail. Den gemmes
  på leadet under opkaldets `CallSid` (`recordings[]` med `source: "live"`,
  `sid: "live:<CallSid>"` indtil optagelsen kommer) og skrives i notetråden (én note pr.
  samtale, `ai_noted`).
  **Optagelsen bagefter:** `/api/twilio/recording` hæfter lyden (sid, url, Twilios
  varighed) på den eksisterende post og springer sin egen analyse over, så længe
  live-analysen er undervejs (`finalStatus` pending/running). Fejler den, er samtalen
  for kort (< 20 s) eller kom der ingen linjer, læses optagelsen som før
  (`liveRecordingFallback`); er live-delen slået fra, sker det altid.
  **Indgående opkald:** strømmen og optagelsen hører til det indgående hovedopkald, mens
  browseren får et barnekald; TwiML'en giver derfor `parent_sid` med til browseren
  (`<Client><Identity>…</Identity><Parameter name="parent_sid">`), og kortet abonnerer
  og gemmer udfaldet på det.
  Kortet abonnerer pr. `CallSid` over SSE (`POST /api/sdr/live/ticket` → engangsbillet,
  `GET /api/sdr/live?sid&ticket`: hello/start/lines/status/end/final) og lægger analysen
  samme sted, som optagelsens ville være endt (`DIAL.ai`), så Samtale-fanen,
  telefonvinduet og "Demo booket" læser det samme. Admin slår det fra under Telefoni
  ("AI lytter med under samtalen", `dialer.live`), og så sendes ingen Stream-TwiML.
  Samtalens linjer holdes i hukommelsen i 5 min efter opkaldet. Cloud Run holder
  WebSocket'en som ét request, så en samtale over 20 min (request-timeout) mister
  live-delen, ikke opkaldet - optagelsen samler op.
- **Notefeltet hører til ét lead.** Kladden i notefeltet følger det lead, den blev
  skrevet på (`#notebox` husker `data-cvr`): en genopfrisk af samme lead (polling, gemt
  kontakt) beholder teksten, men næste lead starter med et tomt felt, og udfald, skip,
  fravalg og mailskabeloner læser kun noten gennem `noteVal(L)`, som er tom, hvis feltet
  blev tegnet for et andet lead. (Fejlen kom, da Noter flyttede til højre kolonne:
  teksten fulgte med til næste lead og blev gemt der ved udfaldet.)
- **Tjekliste og tier ved "Demo booket".** Når en SDR trykker *Demo booket*, åbner en
  tjekliste i to trin, før udfaldet gemmes: først de **seks grundlag**, der skal være
  på plads for at demoen kan kvalificeres (sælger online · mindst 10.000 kr/md på
  annoncer · løbende behov for annoncer · en på holdet kan drive det · fri til at
  starte · beslutningstager deltager), så de **tre købssignaler** (nævner selv
  problemet · har prøvet at løse det · vil i gang snart). Signalerne sætter tier:
  2 eller flere = **Tier 1** (fuld provision, 1.000 kr), ellers **Tier 2** (500 kr) -
  grænsen og satserne står under ⚙ → Løn. Mangler der grundlag, siger listen det,
  men demoen bookes alligevel. Svarene gemmes på leadet (`demo_check`, `demo_tier`),
  står i Slack-beskeden, i Twenty-noten og i Excel-arket, og admin ser dem under
  Resultater → Demoer, når demoen vurderes - *Kvalificeret* går altid gennem listen,
  hvor tier kan rettes. Satsen låses ved kvalificering; tier kan rettes, indtil
  lønperioden låses.
- **Demoer** (fanen under Resultater) — godkend eller afvis bookede demoer. Provision følger
  **lønperioden**: et møde godkendt til og med d. 28. kommer med i den
  måneds løn, godkendt fra d. 29. i næste måneds. Vælg "Løn <måned>" for at se
  hvad hver SDR skal have, møde for møde. En lønperiode låses automatisk efter
  d. 28. kl. 23:59 (`commission_locks.json`) og ændres aldrig bagefter: et møde
  der afvises efter udbetaling, modregnes i den næste åbne periode, og intet
  betales to gange. Hvert møde beholder satsen fra godkendelsesdagen.
  Et godkendt møde i en åben periode kan flyttes til næste måneds løn ("→
  <måned>" i møde-listen) og tilbage igen, så længe perioden ikke er låst.
  **Konvertering** er to kort. Det første, *Konvertering*, åbner med tre tal: **sundhed** (kundeværdi/LTV fra ⚙ →
  Løn delt med pris pr. salg - sundt fra 3×, tyndt 1-3×, under 1× taber vi
  penge pr. kunde), **salgsrate** (solgt af alle kvalificerede, ikke kun de
  afgjorte) og **pris pr. salg**; under hvert tal står, hvad det bliver,
  hvis alle ventende lukker. Derunder én bjælke: solgt / venter / ikke
  solgt af de kvalificerede, og i småt hvor mange bookede der venter på
  vurdering (de tæller ikke - de er måske ikke kvalificerede). Nederst
  omkostningerne som tal: grundløn pro rata × antal SDR'er, provision for de
  kvalificerede, faste værktøjsabonnementer (dollarkurs under ⚙), i alt,
  pr. kvalificeret demo og pr. salg.
  En kvalificeret demo uden afgørelse markeres **gul efter 14 dage og rød
  efter 45** (dagene sættes under ⚙ → Løn; benchmark: de fleste afgør inden
  14, 90% inden 45). Overblik får en alarm, og "venter på svar"-feltet
  tæller dem. **Udsæt** parkerer en langsom beslutter til en dato med en note
  - stadig åben, men rykkes ikke før da.
  **Fra demo til salg** (under møde-listen): kvalificerede demoer venter, til
  de markeres *Solgt* (dato, valgfri værdi og note) eller *Ikke solgt* (grund:
  pris, timing, valgte en anden, intet behov, svarer ikke, andet). Fortryd
  sender den tilbage til Venter. Står firmaet allerede som betalende i
  kundelisten, står det på rækken. Øverst salgsrate (solgt af afgjorte), antal
  solgt og værdi, hvor mange der venter (og hvor længe) og pr. SDR. SDR'en ser
  "Solgt" på sin demo og i tråden. Kun opfølgning - provisionen følger stadig
  godkendelsen. Tallene står også i Sammenlign SDR'er og i Excel-eksporten.
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

Hvad automatikken ikke kan, havner i Research-fanen til SDR'erne. Et lead, en SDR
har gemt noget på (navn eller nummer), hviler 30 dage fra Research - også hvis
der stadig mangler et direkte nummer; det, der blev gemt, er det, der kunne findes.
"Kunne ikke findes" hviler 90 dage, "Spring over" kun for den SDR, resten af dagen.

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
