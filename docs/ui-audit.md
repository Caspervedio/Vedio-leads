# Vedio Leads — UI Audit (Phase 3 cleanup)

Read of `public/index.html` (9,287 lines) on 2026-06-16. Goal: strip dead UI and tighten the daily SDR loop (queue → cockpit → tel: → disposition → next).

The honest one-liner: **half the sidebar, a third of the dashboard, and ~6 cockpit elements are obsolete or have stale terminology.** The cockpit auto-fires Apollo + Full Enrich on open already (line 6912-6918), so most "Find beslutningstager" / "🔍 Berig med Apollo" CTAs are redundant. The "Eksperimentelle" agents (Look-alike, Maps, Tech Stack, List Builder) are all standalone pages for crons that no longer run.

---

## Section 1 — Sidebar navigation

Sidebar block: lines 754-820. Default landing nav highlight goes to `nv-d` (Dashboard, line 755) and login forces `sv('discovery')` (line 1513).

| ID | Label | Routes to | Verdict | Why |
|---|---|---|---|---|
| `nv-d` (l.755) | Dashboard | `sv('discovery')` → `renderDiscoveryPage()` | **KILL** (or rename to "Pipeline") | Discovery is admin/diagnostics. SDR does not need it daily. With branche-walk + storeleads + gmaps crons running autonomously, this page is a pipeline-health monitor — not a workflow surface. Should not be the default landing. |
| `nv-ad` (l.759) | Autodialer | `sv('autodialer')` → `renderAutodialerPage()` | **KEEP** + make default | This is the only page the SDR needs. Should be the post-login landing (change line 1513). |
| `nv-meta` (l.768) | META Scraper | `sv('meta-scraper')` → `renderMetaScraperPage()` | **KILL** | Meta-ads-discover is no longer a source (cron deleted today). Meta is now a scorer only. The standalone "AI Agent" page that drives a cron is obsolete UX. The Meta Ad Library deep-link is already on every lead row + cockpit (line 7107). |
| `nv-csv` (l.773) | CSV Analyse | `sv('csv-upload')` → `renderCsvUploadPage()` | **KEEP** | Real entry point — Casper imports SalesNav exports. But move to a less prominent spot (under "Værktøjer" is fine — already is). |
| `nv-s` (l.777) | CVR Discovery | `sv('search')` → CVR Discovery hero | **KILL** | This is the legacy "search the CVR registry by company name" form. Nicolas does not free-form CVR-lookup. Datafordeler discovery is fully cron-driven now. |
| `nv-la` (l.789) | Look-alike Finder | `sv('lookalike')` → `renderLookalikePage()` | **KILL** | "Look-alike Agent" — operator already flagged this as legacy ML-suggest. No cron, no live data. Delete page + page div (lines 1158-1183). |
| `nv-gm` (l.793) | Maps Scraper | `sv('google-maps')` → `renderGoogleMapsPage()` | **KILL** | gmaps-discover **still runs** as a cron (twice daily), but its leads land in the autodialer queue automatically. This standalone page is orphaned UI for triggering manual scrapes — not needed in the SDR workflow. Delete page + page div (lines 1080-1095). |
| `nv-ts` (l.797) | Tech Stack Scanner | `sv('tech-stack')` → `renderTechStackPage()` | **KILL** | tech-discover-* crons removed today. Page div lines 1097-1111. |
| `nv-lb` (l.801) | Liste-builder | `sv('list-builder')` → `renderListBuilderPage()` | **KILL** | Legacy CVR list-builder, superseded by branche-walk + storeleads crons. Page div lines 1113-1123. |
| `nv-li` (l.805) | LinkedIn-opslag | `openLinkedinLookupModal()` (modal, not page) | **ASK** / KEEP-as-cockpit-only | Standalone LinkedIn URL → Apollo phone reveal. Functionally **identical** to the LinkedIn URL paste box now living inside the cockpit at line 7156. Probably kill from sidebar — the cockpit-inline version is the right UX. |
| `nv-l` (l.814) | Min liste | `sv('leads')` | already `display:none` — fine. |
| `nv-c` (l.816) | Mine kunder | `sv('customers')` | already `display:none` — fine. |

**Bottom line on sidebar:** kill 6 of 9 visible items. Keep Autodialer + CSV. Move CVR Discovery + LinkedIn-opslag into a small "Værktøjer" footer at most. Drop "AI Agent" and "Eksperimentelle" section headers — neither makes sense without their agents.

Resulting sidebar:

```
Vedio Leads
├── Autodialer  (default)
└── Værktøjer
    └── CSV Analyse
```

That's it. Three lines instead of fifteen.

---

## Section 2 — Dashboard / autodialer page

The default-landing dashboard at `sv('discovery')` is the "Vedio Leads — auto-pipeline" page (lines 1004-1041). Separate from the autodialer page (lines 1126-1144). Below covers both, since the recommendation is to kill the former and land on the latter.

### 2a) "Vedio Leads — auto-pipeline" dashboard (discovery-page)

| Element | Lines | Verdict | Why |
|---|---|---|---|
| Section label "Dashboard" + h2 + subtitle | 1006-1010 | **KILL whole page** | If Autodialer is the new default, this dashboard is admin-only diagnostics. |
| `disc-autoflow` pipeline-status banner | 1013, render at 2684-2811 | **MOVE to Autodialer footer or admin-only** | The 7-source pipeline status grid (branche-walk, storeleads, gmaps, etc) is useful but doesn't belong on the SDR's daily landing. Stash under a collapsible "🔧 Pipeline" foldout on the Autodialer page. |
| `disc-summary` tile row (Aktive annoncører, ICP-kvalificerede, Seneste kørsel, Kandidatpulje) | 1016, render at 2667-2677 | **KILL** | "Aktive annoncører of X tjekkede" is a META-scraper metric — META is no longer a source. "Kandidatpulje" and "Seneste kørsel" are about Apollo-discovery, also deleted. |
| `disc-review-queue` ICP-klar review queue | 1021, render at 2528-2620 | **KILL** | This is the "bulk approve discovery results → push to user.leads" workflow. With autodialer-maintain cron auto-promoting (hourly target=100), the SDR never needs to approve. Dead workflow. |
| Source-filter tabs (Alle / META / Look-alike / Maps / Tech Stack / CSV) | 1026-1033 | **KILL** | Four of six tabs (META, Look-alike, Maps, Tech) point at obsolete sources. If you keep the page at all, only "Alle" + "CSV" remain. |
| `disc-filter-bar` (free-text search + industry + city + emp + ads filters) | 1036, render at 2813-2831 | **KILL** | Discovery-row filtering. No daily need. |
| `disc-results` rows | 1039, render at 2870+ | **KILL** | The lead-discovery row table. |

**Verdict on the page as a whole: kill it.** Migrate the pipeline-status widget to an admin-only collapsible card on the Autodialer page if Casper wants to see cron health.

### 2b) Autodialer page (the real daily workspace)

Page wrapper lines 1126-1144. Main render at line 5160.

| Element | Lines | Verdict | Why |
|---|---|---|---|
| Header "📞 Autodialer" + h2 "Din opkaldskø" + paragraph | 1128-1133 | **TRIM** | The paragraph text is dated (says "1–4 dispositioner" — there are 5 now) and the SDR doesn't read it after day 1. Replace with a single line: "X leads i kø · Tryk Start opkald". |
| "▶ Start opkald" big purple button | 1134 | **KEEP** | Primary CTA, well-placed. |
| `ad-stats` tile row (Klar i kø / Ringet i dag / Interesseret i dag / Konvertering / Næste callback) | 1136, render at 5393-5409 | **KEEP** | All five tiles are useful and drillable. |
| `ad-activity` table (Ringet/Interesseret/Follow-up/SMS/Ingen svar/Ikke relevant manuel/Auto-arkiveret/Pushet) | 1138, render at 6184-6291 | **KEEP, slim down** | Useful but 8 rows is a lot. "Auto-arkiveret (system)" and "Pr. SDR" panel (lines 6259-6290) are admin metrics — collapse behind an "Detaljer" toggle. Daily call-goal chip (lines 6228-6235) is gold, keep it. |
| `ad-economics` admin-only $/lead card | 1140, render at 6298+ | **KEEP** (admin) | Silently hidden for non-admin (403). Fine. |
| Lists chip row ("Alle leads" + user lists) | 5419-5424 (rendered into `ad-lists`) | **ASK** | If lists are unused (everyone always sees "Alle leads"), kill them. Otherwise keep. Operator-only call. |
| Category tabs (Alle / DK e-commerce / DK service) | 5521-5539 | **KEEP** | Just shipped, clean two-way segmentation. |
| Kilde (source) chip row — Annoncører / StoreLeads / Maps / CSV / Manuel / Beriges nu / Mangler nummer / Måske relevant / Pushet til Twenty / Arkiveret | 5467-5510 | **KEEP, slim slightly** | Already cleaned today (Meta-ads-discover, lookalike etc. removed line 5473-5481). Consider one more pass: "🟡 Måske relevant" is rarely used — could become a hover-tooltip on Annoncører. "Manuel" chip is fine to keep. |
| Sort dropdown (Prioritet / Flest ads / Senest tilføjet / Navn / Manuel) | 5547-5553 | **KEEP, trim** | "Manuel (træk)" and "Navn (A-Å)" are rarely used. Just "Prioritet" + "Senest tilføjet" cover 95%. |
| Activity log button (📋 Aktivitet) | 5517 | **KEEP** | Useful debug surface. |
| Eksportér CSV button | 5518 | **KEEP** | Cheap. Useful. |
| Queue table | 5644-5728 | **KEEP** | Core workflow. |

### 2c) Discovery pipeline widget specifically

Lines 2684-2811. **Recommendation: collapse into a `<details>` foldout** ("🔧 Pipeline status — 7 kilder") on the Autodialer page so it's there for Casper to glance at but doesn't dominate the SDR's screen. The Apollo credit-exhausted banner inside it (line 2729-2740) should always be loud when relevant.

---

## Section 3 — Cockpit modal

Cockpit lives at lines 1197-1227 (shell) and renders detail via `renderCockpitDetail()` at line 6988+.

### 3a) Top toolbar (lines 1199-1221)

| Element | Lines | Verdict | Why |
|---|---|---|---|
| Autodialer logo + "X / Y leads" progress | 1200-1206 | **KEEP** | Position anchor for the SDR. |
| ▶ Start Dialer | 1209 | **KEEP** | Anchor button. |
| ⏸ Pause | 1210 | **KEEP** | Used when SDR steps away. |
| ⏭ Skip | 1211 | **KEEP** | Used. |
| Dialer-state pill (Klar / Ringer / Venter disposition / Pause) | 1212 | **KEEP** | Tight feedback loop. |
| 📞 Manuelt opkald | 1216 | **ASK** | Phone is editable inline on the lead (line 7190 ✎ ret). Manual-dial-by-number is rare. Could probably go. |
| 💬 Manuel SMS | 1217 | **ASK** | Same logic. Probably kill — disposition `2 = SMS` opens the SMS composer for the current lead, which is the 99% case. |
| 📋 Aktivitet | 1218 | **ASK** | Duplicates the same button on Autodialer page. Pick one location. Recommend keeping on Autodialer page only. |
| ? (help) | 1219 | **KEEP** | Cheap. Hidden behind one keypress. |
| Luk (esc) | 1220 | **KEEP** | Necessary. |

### 3b) Lead detail body (lines 6988-7285)

| Element | Lines | Verdict | Why |
|---|---|---|---|
| Header card — logo + name + Lead X of Y + category badge | 7035-7074 | **KEEP** | Just shipped (DK e-com / DK service badge line 7047-7049). Tight. |
| CVR row with virk.dk deep-link / synthetic-ID fallback | 7053-7064 | **KEEP** | Just shipped. Good UX. |
| Talking points card (description, growth, funding, tech-stack, keywords, website/LinkedIn/FB/IG links, Meta Ads Library, ad signals, LinkedIn ad URL) | 7076-7112 | **KEEP, but tighten** | Genuinely useful for the call. Two concerns: (1) "Vækst 6 mdr / 12 mdr" with Apollo growth signals — Apollo has spotty DK SMB data, often blank. Hide the line if both are null instead of showing two empty cells. (2) Tech-stack pills (`technologyNames.slice(0,8)`) — these are Apollo-derived and DK SMB hit rate is bad. Hide entirely when array is empty (already does, line 7087). Fine. |
| Switchboard + decision-makers card | 7115-7161 | **KEEP** | This is the call-prep heart of the cockpit. |
| Pending spinner "Apollo + Full Enrich henter direkte nummer — kontakter klar om ca. 60-90 sek" | 7124 | **KEEP** | Just shipped. Aligned with auto-reveal. |
| **"🔍 Find beslutningstager" CTA button** (when contacts empty + not pending) | 7152 | **KILL** | **This is now redundant.** `renderCockpit()` auto-fires Apollo + Full Enrich on cockpit-open (lines 6912-6918). If we landed here with empty contacts and the reveal isn't pending, the auto-reveal already failed. Manual re-fire wastes another Apollo credit ($0.05) and the SDR doesn't know that. Replace with a quiet "Ingen kontakter fundet — prøv LinkedIn-paste nedenfor" message + the LinkedIn URL paste box. |
| LinkedIn URL paste input + "+ Tilføj" | 7156-7158 | **KEEP** | Just shipped. The natural manual-fallback when Apollo+FullEnrich come up dry. |
| Call status + LOUD phone number + ✎ ret | 7185-7194 | **KEEP** | Core. Just shipped phone-source pill (line 7188 srcLbl). |
| Phone source pill (Direkte mobil / Direkte (Apollo) / Hovednr. (CVR) / Hovednr. website) | 7171-7183 | **KEEP** | Just shipped. Excellent — SDR instantly knows expectation. |
| Best-time-to-call chip | 7188 (rendered via `cockpitBestTimeWindow` at 8069) | **KEEP** | Useful nudge. Tiny visual cost. |
| Phone-source pill | 7188 (srcLbl) | **KEEP** | Same. |
| Quick-research deep-links (🔎 Google / 💼 LinkedIn / 📒 Krak) | 7208-7212 | **KEEP** | Used when SDR needs to verify or escalate. |
| 🛡 Gatekeeper-scripts dropdown + library | 7214-7218, library at 8096-8104 | **KEEP** | Just shipped. Cheap to keep. |
| Disposition grid (1-5 buttons) | 7226-7232 | **KEEP, reorder?** | See Section 6 — the 2×3 grid + the order (1=Interesseret, 2=SMS, 3=Ingen svar, 4=Ikke relevant, 5=Follow-up planlagt) is a workable but slightly awkward keyboard order. Consider swapping 3 and 5: most common after Interesseret is Ingen svar > Follow-up > Ikke relevant > SMS. |
| "📅 Planlæg follow-up…" button | 7236-7238 | **KEEP** | The "schedule on top of Interesseret" escape hatch. Used. |
| Twenty push card (interested + not yet pushed) | 7242-7251 | **KEEP, but auto-fire** | See Section 6 — should auto-trigger when SDR picks Interesseret AND already saw the `_showInterestedTwentyPrompt` modal (line 6602). Currently the modal pushes for you (good), so this whole card is mostly redundant. Kill the card; the modal is enough. |
| Follow-up planlæg card (interested + no callback) | 7254-7263 | **ASK** | Duplicates the "📅 Planlæg follow-up…" button above. Pick one. |
| Callback-scheduled confirmation banner | 7265-7269 | **KEEP** | Useful confirmation. |
| "Pushet til Twenty" confirmation | 7271-7273 | **KEEP** | Useful confirmation. |
| Notes textarea | 7276-7277 | **KEEP** | Used. |
| Forrige / Næste nav buttons | 7280-7283 | **KEEP** | Mouse-fallback for arrow keys. |

### 3c) Specifically flagged items

- **"Find beslutningstager"** (line 7152, `enrichLeadWithKaspr('cockpit')`): **REDUNDANT.** Auto-reveal at line 6912-6918 fires the same `/api/contact/reveal-direct-dial/:cvr` endpoint on every cockpit-open. The button is a manual re-fire that wastes a credit. **Kill.**
- **CloudTalk references**: searched. Cleanly removed already. Comments only (lines 740, 1467, 1472, 1479, 1635, 6044, 6086). No live softphone code. OK.
- **Kaspr references**: line 2470-2480 (`kasprUrl()` + `kasprChip()` function — used only by the dead Discovery page rows), line 2540-2553 (review queue comments mentioning Kaspr), line 3122-3152 (the "Open Kaspr-focused info card" function used by Discovery), line 3151 ("Berig med Apollo" CTA — function name still `enrichLeadWithKaspr` for backwards compat). Function `enrichLeadWithKaspr` is also called from line 7152 (the kill candidate above). **Recommendation:** when you kill the Discovery page, all Kaspr-related leftover code in 2470-3152 dies with it. Function `enrichLeadWithKaspr` should be renamed `enrichWithApollo` for clarity (line 7486).
- **Lusha references**: just three comment references (line 7490). Dead. Fine.
- **Tech Stack Scanner integrations in cockpit**: the cockpit only consumes `aco.technologyNames` from Apollo (line 7087). The standalone Tech Stack Scanner page is unrelated. Kill the page, keep the Apollo-tech chips.

---

## Section 4 — Lead-row pills / badges / chips

Source: queue-row render at `renderAutodialerPage()` (line 5715+) and discovery-row render at line 3035+.

### Autodialer queue row (the daily list)

| Element | Lines | Verdict | Why |
|---|---|---|---|
| Index number + drag handle ⠿ | 5716 | **KEEP** | Useful. |
| Company name | 5717 | **KEEP** | Obvious. |
| `adBadge` "🎯 ANNONCØR" pill | 5662-5664, applied 5717 | **KEEP** | Strong ICP signal. |
| `socialIcons` FB 📘 + ads chip 🔥 N | 5703-5708 | **KEEP** | Useful at-a-glance. |
| City column | 5718 | **KEEP** | Useful for regional preferences. |
| `dispCell` lastActionChip (Interesseret / Follow-up / SMS / Ingen svar / Ikke relevant) | 5714, defined at 6977 | **KEEP** | Necessary state. |
| `archiveReasonChip` (archive view only) | 5711-5713 | **KEEP** | Auditability. Just shipped. |
| Phone number cell (clickable to dial) | 5670-5672 | **KEEP** | Loud and clear. |
| ✎ edit phone | 5684 | **KEEP** | Inline correction. |
| "▶ Start opkald" per-row button | 5688-5689 | **ASK** | Duplicates the row's onclick (`adOpenLead`) which already opens the cockpit. The button literally just adds `autostart=true`. Probably keep — the visual cue matters more than the function. But: making the WHOLE ROW clickable + the button feels redundant. Worth one A/B in your head. |
| `twentyStageChip` (twenty-pushed view) | 5677-5679 | **KEEP** | Useful. |
| `restore` button (archive view) | 5681 | **KEEP** | Just shipped. |

### Discovery row (will die with the page kill)

If you kill the Discovery page per Section 1, the source badge / lifecycle chip / verdictPill / autoFlowChip code at lines 2996-3050 + 3035+ all dies with it. **No separate decision needed.**

### Status chip semantics (in source-filter chip row at line 5467-5510)

All are KEEP — they map 1:1 to the lead-bucket logic. Just shipped the categorisation today.

---

## Section 5 — Other top-level pages

| View | Page div lines | Status | Verdict |
|---|---|---|---|
| `discovery` (Dashboard) | 1004-1041 | LIVE | **KILL** (see Section 2). |
| `autodialer` | 1126-1144 | LIVE | **KEEP** — make default. |
| `meta-scraper` | 1048-1078 | LIVE but agent-cron deleted | **KILL** (Section 1). |
| `google-maps` | 1080-1095 | LIVE but page orphaned | **KILL** (Section 1). |
| `tech-stack` | 1097-1111 | LIVE but cron gone | **KILL**. |
| `csv-upload` | 1147-1156 | LIVE — Casper uses | **KEEP**. |
| `list-builder` | 1113-1123 | LIVE but legacy | **KILL**. |
| `lookalike` | 1158-1183 | LIVE but legacy | **KILL**. |
| `leads` | (sidebar hidden) | Hidden, still mounted | Keep code, no nav. Fine. |
| `customers` | (sidebar hidden) | Hidden, still mounted | Keep code, no nav. Fine. |
| `search` (CVR Discovery hero) | 958-1000 | LIVE but legacy | **KILL** (Section 1). |

Killing these pages also kills their render functions:
- `renderLookalikePage` (line 3307)
- `renderGoogleMapsPage` (line 4764)
- `renderTechStackPage` (line 4159)
- `renderListBuilderPage` (line 3988)
- `renderMetaScraperPage` (line 4468)
- `renderDiscoveryPage` (line 2284) — minus the pipeline-status widget which you'll move into Autodialer

That's roughly 1,500-2,000 lines of dead JS once the trim is done.

---

## Section 6 — UX redesign recommendations

Now the opinion part. Daily workflow is: open → see queue → click lead → cockpit auto-enriches → tel: deeplink → conversation → press 1-5 → next. 6-10 seconds of friction per call adds up to 30 lost dials/day at 50 cph.

Ranked by impact (high → low):

### #1 (HIGH) — Make Autodialer the post-login default

Line 1513 calls `sv('discovery')` after server login. That's the dead pipeline-monitor dashboard. Change to `sv('autodialer')`. Nicolas lands on his queue. Cheap, one-character delta, removes one click per session.

### #2 (HIGH) — Cockpit auto-opens to first ready lead

Today the SDR sees the Autodialer queue, then clicks "▶ Start opkald" or a row. That's two clicks before any work happens. If the queue is non-empty, **auto-open the cockpit at the top lead within 1.5s of landing on Autodialer.** Add an opt-out keyboard shortcut ("q" for queue-view). For SDR-mode users, default is "cockpit-first".

### #3 (HIGH) — Kill "Find beslutningstager" button (line 7152)

The auto-reveal at line 6912-6918 already fires on every cockpit-open. The button just re-fires the same endpoint and wastes a credit. Replace with the existing LinkedIn paste input as the manual fallback.

### #4 (HIGH) — Auto-push to Twenty on Interesseret

Currently disposition 1 = Interesseret → `_showInterestedTwentyPrompt` modal → SDR clicks "Push" or "Senere". This is correct — the modal is the loud guard. But the standalone "→ Push til Twenty" card at line 7242-7251 (rendered after the modal closes) is a second prompt for the same action. **Kill that card.** The modal handles it; if SDR dismissed the modal, that's an explicit "not now" and the card adds nothing. (Or: kill the modal, auto-push silently with an undo toast. Operator's call.)

### #5 (MED-HIGH) — Inline disposition reason for "Ikke relevant"

Today: press 4 → `_showArchiveReasonModal` → pick a reason → modal closes → advance. 3 clicks. **Better:** when SDR hovers/presses 4, expand a tiny inline strip of 4-5 reason chips ("Konkurrent / For lille / Forkert branche / Allerede kunde / Andet"). One click = reason + advance. Saves a modal context switch per "ikke relevant" lead, which is 30-40% of calls.

### #6 (MED) — Disposition keyboard order

Current: 1=Interesseret, 2=SMS, 3=Ingen svar, 4=Ikke relevant, 5=Follow-up planlagt. **Real frequency** on a cold-call day: Ingen svar > Ikke relevant > Interesseret > Follow-up > SMS. Putting Ingen svar on a less-reachable key (3) when it's the 50% case slows the rhythm. Suggested:

```
1 = Interesseret (anchor — high stakes, deserves the easy key)
2 = Ingen svar    (most common — needs to be quick)
3 = Ikke relevant (also common)
4 = Follow-up
5 = SMS
```

Same hand, more ergonomic. Worth A/B.

### #7 (MED) — Cockpit as full-page, not modal

The cockpit IS already full-screen (line 1197 `position:fixed;inset:0`). The only thing modal-ish is the escape-to-close. Honestly the current behavior is fine — it just *feels* modal because of the close button. Recommend: change "Luk (esc)" copy to "← Tilbage til kø" so it reads as a navigation back rather than a modal dismiss. Tiny change.

### #8 (MED) — Hide cockpit toolbar buttons that duplicate cockpit state

📞 Manuelt opkald (line 1216) and 💬 Manuel SMS (line 1217) duplicate "type a number, then call/SMS" — but the cockpit's current lead phone is already inline-editable. **Kill both** unless Casper actively uses manual dial without a lead context (in which case put them under a "⋮ Mere" overflow).

### #9 (MED) — Queue gating: auto-skip "still enriching" leads

Today, leads stuck in `apollo_enrichment_pending` are filtered out of the active queue (line 5207) → good. But on cockpit-open, the auto-reveal takes 60-90s. If the SDR clicks a lead and it's still spinning, they wait. **Improvement:** when the cockpit lands on a lead with pending enrichment, **show the spinner but also start working on the next-most-ready lead's data in the background** so the SDR can press "→ next" if they're impatient and the next one is instant.

Less important than the others — just a polish.

### #10 (MED-LOW) — Show keyboard shortcuts inline, always

Currently `?` shows a `showToast`. That's hidden — SDR needs to know to press `?`. **Better:** small "1=Int 2=Ing 3=Ikke 4=FU 5=SMS · → næste" footer strip at the bottom of the cockpit detail pane, font-size:10px, opacity:0.5. Always visible, gets out of the way once memorised.

### #11 (LOW) — Activity table: collapse "Auto-arkiveret (system)" + "Pr. SDR"

Lines 6202 + 6259-6290. The two-tier "manual vs auto archive" distinction is useful for Casper-the-operator (filter health) but noisy for Nicolas-the-SDR. Hide both behind a "Vis detaljer" toggle.

### #12 (LOW) — Dashboard sidebar nav rename

If you keep Dashboard at all, rename to "🔧 Pipeline" (admin) so the SDR knows it's not their workflow.

---

## Section 7 — Recommended order of work

Each PR is independently shippable + low blast radius.

### PR 1 — "Kill obvious legacy" (low risk, high signal)

Scope: sidebar items + standalone pages that are unambiguously dead.

- Delete sidebar nav items: `nv-meta`, `nv-s`, `nv-la`, `nv-gm`, `nv-ts`, `nv-lb`, `nv-li` (lines 768, 777, 789, 793, 797, 801, 805). Also delete the "AI Agent" + "Eksperimentelle" + "Værktøjer" sub-headers since the only remaining "Værktøjer" item is CSV.
- Delete page divs: `meta-scraper-page`, `google-maps-page`, `tech-stack-page`, `list-builder-page`, `lookalike-page`, `discovery-page`, plus the CVR Discovery hero (lines 958-1000).
- Delete the render functions: `renderMetaScraperPage`, `renderGoogleMapsPage`, `renderTechStackPage`, `renderListBuilderPage`, `renderLookalikePage`, `renderDiscoveryPage` (and helpers).
- Delete kasprUrl/kasprChip/enrichLeadWithKaspr-Discovery-context branches.
- Update `sv()` switch (line 8252) to remove dead branches.
- Change login default landing line 1513 + 1690 from `sv('discovery')` to `sv('autodialer')`.

Net: ~1500-2000 lines deleted, no behavior change for the SDR's daily loop.

### PR 2 — "Cockpit tightening" (low risk, immediate UX win)

Scope: remove redundant buttons + tighten active-call workflow.

- Kill "🔍 Find beslutningstager" button (line 7152). Replace with quiet "Ingen kontakter fundet" + the existing LinkedIn paste box.
- Kill "→ Push til Twenty" standalone card (lines 7242-7251) — the `_showInterestedTwentyPrompt` modal already does it.
- Kill "📞 Manuelt opkald" + "💬 Manuel SMS" toolbar buttons (lines 1216-1217), or hide behind a "⋮ Mere" overflow.
- Move "📋 Aktivitet" to Autodialer only (it duplicates).
- Add a small always-visible keyboard-shortcut footer in the cockpit detail pane.
- Rename "Luk (esc)" to "← Tilbage til kø".
- Rename `enrichLeadWithKaspr` to `enrichLeadWithApollo` throughout (no functional change).

### PR 3 — "Auto-cockpit on landing" (medium risk, biggest workflow win)

Scope: make cockpit the default workspace, not a click away.

- After `sv('autodialer')`, if the queue is non-empty, `setTimeout(openCockpit, 1200)` to auto-open the first lead.
- Add an opt-out localStorage flag + a "queue-only" toggle button on the Autodialer header.
- Verify all the existing keyboard guards (mandatory disposition, dialerState transitions) hold up under auto-open. The 30s view-timer at line 6577-6585 needs a reset on auto-open.

### PR 4 — "Disposition flow" (medium risk, daily-feel win)

Scope: inline "Ikke relevant" reason chips + key reorder.

- Replace `_showArchiveReasonModal` with an inline chip strip that expands below the disposition grid when SDR hovers/keypresses 4 (or whatever the new key is).
- Reorder disposition keys (Interesseret=1, Ingen svar=2, Ikke relevant=3, Follow-up=4, SMS=5).
- Update `cockpitKeyHandler` map at line 6554.
- Update `cockpitShowHelp` toast at line 8059.

### PR 5 — "Dashboard simplification" (low risk, low priority)

Scope: move the still-useful Pipeline widget into Autodialer + slim the activity table.

- Move `renderPipelineStatusWidget()` output into a collapsible `<details>` on the Autodialer page footer.
- Collapse "Auto-arkiveret (system)" + "Pr. SDR" panel behind a "Detaljer" toggle.
- Remove the now-unused dashboard h2/subtitle/`disc-summary` block.

---

## Closing notes

The big idea: today's UI is sized for "discovery-first product where SDR is one user role." The reality is "SDR-driven calling tool with automated discovery in the background." Stripping out the discovery-as-workflow layer is ~25-40% of the SPA's surface area, but doesn't touch a single line of the SDR's actual daily loop. That's the right kind of cleanup.

If only PR1 + PR3 ship, Nicolas saves ~2 clicks per session and never sees a dead page again. PR2 + PR4 + PR5 are polish on top.
