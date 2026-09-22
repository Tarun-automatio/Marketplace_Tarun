# Marketplace

Playwright framework for Molina Marketplace (Individual & Family / IFP) validation.

This framework contains **five suites**. Each suite section below follows the same layout:

1. **Run commands** (all `npm` commands for the suite, grouped together)
2. **What it does** (test steps performed)
3. **Data sheet + config** (Excel columns, Settings sheet, env-var overrides)

Suites:

- [1. Marketplace Toggle Check](#1-marketplace-toggle-check)
- [2. Marketplace Plan Search](#2-marketplace-plan-search)
- [3. Marketplace Drug Pharmacy Links](#3-marketplace-drug-pharmacy-links)
- [4. Marketplace Sitecore Docs (SBC / EOC / OOC / SOB)](#4-marketplace-sitecore-docs-sbc--eoc--ooc--sob)
- [5. Marketplace Brochure & Formulary](#5-marketplace-brochure--formulary)

Plus:

- [Run all suites at once](#run-all-suites-at-once)
- [Utility commands](#utility-commands)
- [Git commands](#git-commands)

> CY2027 Plan Materials / Drug suites live in the sibling folder `cy2027/`.

Run all commands from the framework root (`marketplace/`).

---

## Setup (one-time)

```powershell
cd marketplace
```

Then:

- "npm install" — download all dependencies (ignore the surrounding `""` — they are only here to make the command copy-friendly in this README)
- "npm test" — quick smoke run to confirm the setup works

---

## 1. Marketplace Toggle Check

### Run commands

- "npm test" or "npm run test:marketplace" — cleans old artifacts and runs the toggle-check suite in **headless** mode
- "npm run test:marketplace:headed" — same run, but with a visible Chrome window

### What it does

Validates the **2026 / 2027 coverage-year toggle** on the *Member Resources → Forms & Documents* page across states, languages (English / Spanish), and devices (Desktop / iPhone SE / iPad Pro).

Test steps performed:

1. Load the Marketplace landing page for the row's state (uses `AppUrl` from the sheet, or the `MARKETPLACE_URL` env default).
2. If `Language=es`, prepend `/es-us/…` to the URL and keep Spanish through navigation.
3. Navigate to **Member Resources → Forms & Documents**.
4. Verify the coverage-year toggle shows the row's `DefaultYear` selected.
5. Switch to the `AlternateYear` and verify the toggle + page state updates.
6. Re-run steps 4–5 on **iPhone SE** and **iPad Pro** viewports.

Each `Run=Y` row auto-expands to 3 test cases (Desktop + iPhone SE + iPad Pro).

### Data sheet + config

**File:** `data/marketplace/MarketplaceData.xlsx` — **Sheet:** `Marketplace`

Columns: `Run, State, Language, DefaultYear, AlternateYear, AppUrl, TestId, Notes`

- `Language`: `en` or `es` (Spanish auto-prepends `/es-us` to the URL)
- `AppUrl`: leave blank to use the `MARKETPLACE_URL` env default
- `TestId`: shown in the report header and used as the HTML report filename

---

## 2. Marketplace Plan Search

### Run commands

- "npm run test:marketplace:plans" — cleans old artifacts and runs the plan-search suite in **headless** mode
- "npm run test:marketplace:plans:headed" — same run, but with a visible Chrome window

### What it does

Validates **Audience/Category filters**, **plan-name search**, and **per-plan PDF URL matches** on the Forms & Documents page. One Excel row = one plan search that verifies N pipe-separated expected PDF URLs.

Two flows run per plan, per language (EN + ES):

1. **Positive SOB flow**
   - Apply `Category = Schedule of Benefits`.
   - Search the `PlanName`.
   - For each expected PDF card, click and verify the new tab URL matches SOB rules + the expected filename.
2. **Negative SBC flow**
   - Apply `Category = Summary of Benefits`.
   - Re-search the same `PlanName`.
   - Assert **zero** result cards match (behaviourally proves SBC is not exposed on the public UI).
   - If the SBC option is missing from the Category accordion entirely, the "apply" step also PASSes on that alone.

Toggles:

- `$env:MARKETPLACE_PLANS_NEGATIVE_SBC='false'` — disables the negative SBC flow
- `MARKETPLACE_PLANS_SBC_AUDIENCE` / `MARKETPLACE_PLANS_SBC_CATEGORY` — override the filter copy if UI text shifts

### Data sheet + config

**File:** `data/marketplace/MarketplacePlansData.xlsx`

**Sheet `Plans`** — primary search per test (one row = one test)

Columns: `Run, TestId, State, Year, Label, Audience, Category, PlanName, ExpectedUrls`

- `Label` — short document-type name shown on plan cards (e.g. `SBC`)
- `Audience` / `Category` — filter checkbox values (e.g. `Member`, `Summary of Benefits`)
- `PlanName` — text typed into the search box (also used to filter matching cards)
- `ExpectedUrls` — pipe-separated PDF URLs, one per matching card

**Sheet `Settings`** — global run config (Key / Value / Notes). Change these cells to retarget the suite without editing code.

- `AppUrl` — landing URL (e.g. `https://uat-pws.molinahealthcare.com/`, `https://pws-q3.molinahealthcare.com/`). Precedence: `MARKETPLACE_PLANS_URL` env → this Value → `framework.config.js` default.

**Sheet `AdditionalSearches`** — optional; extra searches to run AFTER the primary

- Columns: `TestId, Label, Audience, Category, ExpectedUrls`
- Each row joins to a `Plans` row via `TestId` (case-insensitive) and runs in row order.
- Between searches the framework unchecks the previous Audience/Category filters and applies the new ones automatically.
- Common use: primary search validates SBC PDFs, additional search validates SOB PDFs for the same plan.

---

## 3. Marketplace Drug Pharmacy Links

### Run commands

- "npm run test:marketplace:pharmacy" — cleans old artifacts and runs the drug-pharmacy CTA suite in **headless** mode
- "npm run test:marketplace:pharmacy:headed" — same run, but with a visible Chrome window

### What it does

Validates the **external-site CTAs** on the Individual & Family drug page (`/ifp/{state}/drugs`) — e.g. *Find a pharmacy*, *Find a provider*, mail-order form. Each CTA must open Molina's ExternalSiteModal; clicking **Continue** must open a new tab that lands on the expected external URL after any redirect chain.

Test steps performed (per CTA row):

1. Navigate to `/ifp/{state}/drugs` for the row's state.
2. Locate the CTA by its visible `LinkLabel`.
3. Click the CTA — Molina's **ExternalSiteModal** must open.
4. Verify the Continue link's `href` matches `ExpectedInitialUrl` (typically a Caremark entry URL before redirects).
5. Click **Continue** — a **new tab** must open.
6. Verify the new tab settles on `ExpectedFinalUrl` after the full 302 redirect chain (URL comparison is lenient).

### Data sheet + config

**File:** `data/marketplace/MarketplaceData.xlsx` — **Sheet:** `DrugPharmacy`

Data lives on the same workbook as the toggle-check suite, but on a separate sheet so all Marketplace data stays in one file. Adding a new CTA is a one-row Excel edit.

Columns: `Run, TestId, State, LinkLabel, ExpectedInitialUrl, ExpectedFinalUrl, Notes`

- `LinkLabel` — visible text of the CTA on the IFP drugs page (e.g. `Find a pharmacy`, `Find a provider`)
- `ExpectedInitialUrl` — the Continue link's `href` (typically a Caremark entry URL before redirects)
- `ExpectedFinalUrl` — the URL the new tab settles on after all 302 redirects; both are compared with lenient URL normalization

Optional env filters (narrow the matrix without editing the sheet):

- `MARKETPLACE_PHARMACY_STATE`
- `MARKETPLACE_PHARMACY_LINK_LABEL`

---

## 4. Marketplace Sitecore Docs (SBC / EOC / OOC / SOB)

### Run commands

- "npm run test:marketplace:docs" — cleans old artifacts and runs the Sitecore-docs suite in **headless** mode
- "npm run test:marketplace:docs:headed" — same run, but with a visible Chrome window
- "npm run data:sitecore-docs" — regenerates `data/marketplace/MarketplaceSitecoreDocsData.xlsx` from the seed configs at the top of [scripts/createSitecoreDocsExcel.js](scripts/createSitecoreDocsExcel.js) (adds new states / plans without touching the workbook by hand)
- "npm run report:regen:docs" — regenerates `Consolidated.html`, `Consolidated-<STATE>.html`, and the `all-reports-<STATE>/` flat share folder from whatever `variant.json` files are already on disk under `reports/marketplace-sitecore-docs/` — use this when the flat folder looks short after a run (fs-flush race safety net; no test run required)

### What it does

Directly hits each **Sitecore-hosted plan document PDF URL** (SBC / EOC / OOC by default; SOB optional) per state and per language, and verifies Chrome renders the PDF + the filename matches.

Test steps performed (per plan × doc-type × language):

1. Rewrite the sheet URL host — `SourceHost` → `TargetHost` — see [Environment host swap](#environment-host-swap).
2. `page.goto(pdfUrl)` — must resolve (no 404 / redirect off-file).
3. Verify Chrome's built-in PDF viewer mounts: `embed[type="application/x-google-chrome-pdf"]`.
   - If headless Chrome blocks inline rendering, an HTTP probe falls back to confirm `HTTP 200 + application/pdf`.
4. Verify the filename in the tab URL matches the expected filename from the data sheet (also cross-checked against `Content-Disposition` and the embed's `original-url`).

One Excel row = one plan; each plan expands to up to **8 URL tests** (4 doc-types × EN + ES). Default doc-type filter is `SBC,EOC,OOC` — flip on SOB with `$env:MARKETPLACE_SITECORE_DOCS_TYPES='SBC,SOB,EOC,OOC'`.

#### Narrow the matrix with env vars

```powershell
$env:MARKETPLACE_SITECORE_DOCS_STATE     = 'ID'          # ID / CA / WA / NM / NV / TX …
$env:MARKETPLACE_SITECORE_DOCS_DOCTYPE   = 'SBC'         # SBC / EOC / OOC / SOB
$env:MARKETPLACE_SITECORE_DOCS_LANGUAGE  = 'en'          # en / es
$env:MARKETPLACE_SITECORE_DOCS_PLAN      = 'Gold Core'   # substring match on PlanName
npm run test:marketplace:docs
```

Unset the variables (`Remove-Item Env:MARKETPLACE_SITECORE_DOCS_STATE`) to widen the scope again.

#### Environment host swap

Excel URLs come from the SharePoint tracker in production form (`www.molinahealthcare.com`). The spec rewrites the host to the target QA env at load time. Per URL, the effective target is resolved in this order:

1. **Row `TargetHost` cell** — per-row override on the `SitecoreDocs` sheet (column `TargetHost`). Populate this to send specific rows to a different env (e.g. WA rows → `uat-pws.molinahealthcare.com`) while leaving the rest on the default.
2. **`MARKETPLACE_SITECORE_DOCS_TARGET_HOST` env var** — applies to every row whose cell is blank.
3. **Config default** — `pws-q3.molinahealthcare.com`.

- `MARKETPLACE_SITECORE_DOCS_SOURCE_HOST` — defaults to `www.molinahealthcare.com`
- `MARKETPLACE_SITECORE_DOCS_TARGET_HOST` — defaults to `pws-q3.molinahealthcare.com`

Point every row at Q1/Q2/prod without editing the workbook by overriding `MARKETPLACE_SITECORE_DOCS_TARGET_HOST` (and leaving the `TargetHost` column empty).

#### Reports & sharing

After a run, `reports/marketplace-sitecore-docs/` contains:

```
Consolidated.html                    ← all-states dashboard (filterable table)
Consolidated-<STATE>.html            ← per-state dashboard (one per state that ran)
all-reports-<STATE>/                 ← flat share folder — all HTMLs + a flat-link dashboard
  Consolidated-<STATE>.html
  TC001_XX_XXXXXXXXXX_SBC_EN.html
  TC001_XX_XXXXXXXXXX_SBC_ES.html
  …
<per-URL folders>/                   ← individual per-URL evidence (HTML + screenshots)
```

Upload the `all-reports-<STATE>/` folder (or zip it) to a user story. Individual HTMLs are self-contained (screenshots embedded as base64), so a reviewer clicking any file gets full evidence.

### Data sheet + config

**File:** `data/marketplace/MarketplaceSitecoreDocsData.xlsx` — **Sheet:** `SitecoreDocs`

Columns (one row per plan):

```
Run, TestId, State, RateCode, PlanCode, PlanName,
SBC_Display, SBC_EN_Name, SBC_ES_Name, SBC_EN_URL, SBC_ES_URL,
SOB_Display, SOB_EN_Name, SOB_ES_Name, SOB_EN_URL, SOB_ES_URL,
EOC_Display, EOC_EN_Name, EOC_ES_Name, EOC_EN_URL, EOC_ES_URL,
OOC_Display, OOC_EN_Name, OOC_ES_Name, OOC_EN_URL, OOC_ES_URL,
Notes
```

- A doc-type a state doesn't publish leaves its cells empty — the loader skips them automatically (e.g. CA has only SBC + EOC).
- Regenerate the workbook from the seed configs with "npm run data:sitecore-docs" (edit the `STATE_CONFIGS` array at the top of [scripts/createSitecoreDocsExcel.js](scripts/createSitecoreDocsExcel.js) to add new states / plans; each state config picks which doc-types are present and whether each uses the plan stem or a state-level filename).
- Per-plan filename overrides (4th tuple element `{ EOC: 'CC' }`) support states like TX where EOC files are grouped by product tag instead of by plan stem.

---

## 5. Marketplace Brochure & Formulary

### Run commands

- "npm run test:marketplace:brochure" — cleans old artifacts and runs the Brochure & Formulary suite in **headless** mode
- "npm run test:marketplace:brochure:headed" — same run, but with a visible Chrome window
- "npm run data:brochure-formulary" — regenerates `data/marketplace/MarketplaceBrochureFormularyData.xlsx` from the seed configs at the top of [scripts/createBrochureFormularyExcel.js](scripts/createBrochureFormularyExcel.js) (adds new states without touching the workbook by hand)
- "npm run report:regen:brochure" — rebuilds `Consolidated.html`, `Consolidated-<STATE>.html`, and the `all-reports-<STATE>/` flat folder from whatever `variant.json` files are already on disk under `reports/marketplace-brochure-formulary/` (fs-flush race safety net, no test run required)

### What it does

Verifies **Formulary + Member Brochure + Broker Brochure PDFs** per state via the *Forms & Documents* filter + search flow, in both EN and ES.

Per state, three doc-type checks run — all via the UI filter + search flow — under **both EN and ES** site languages. Each PDF card is labeled by the URL's own `/English/` vs `/Spanish/` segment, not by the outer site-language pass.

1. **Formulary**
   - Apply Audience = `Marketplace`, Category = `Formulary and Drug Lists`.
   - Search the Formulary filename.
   - Verify each expected Formulary PDF card (EN + ES) opens with the right URL + filename.
2. **Member Brochure**
   - Clear search, uncheck Formulary Category, apply Category = `Member Handbooks and Coverage`.
   - Search the Member Brochure filename.
   - Verify each expected Member Brochure PDF (EN + ES).
3. **Broker Brochure**
   - Same `Member Handbooks and Coverage` filter (Broker Brochures surface here too).
   - Separate search on the Broker filename.
   - Verify each expected Broker Brochure PDF (EN + ES).

#### Narrow the matrix with env vars

```powershell
$env:MARKETPLACE_BROCHURE_FORMULARY_STATE = 'CA'        # or ID / NM / NV / TX / TX-OX / WA
$env:MARKETPLACE_BROCHURE_FORMULARY_YEAR  = '2027'
npm run test:marketplace:brochure
```

#### One-off environment override (bypass the Settings sheet)

```powershell
$env:MARKETPLACE_BROCHURE_FORMULARY_URL         = 'https://q3-pws.molinahealthcare.com/'
$env:MARKETPLACE_BROCHURE_FORMULARY_TARGET_HOST = 'q3-pws.molinahealthcare.com'
npm run test:marketplace:brochure
```

#### Skip Broker checks

Either flip `BrokerEnabled = false` on the `Settings` sheet, or set `$env:MARKETPLACE_BROCHURE_FORMULARY_BROKER_ENABLED = 'false'` for one run.

### Data sheet + config

**File:** `data/marketplace/MarketplaceBrochureFormularyData.xlsx`

**Sheet `BrochureFormulary`** — one row per state

Columns:

```
Run, TestId, State, Year,
Formulary_Search, Formulary_EN_Name, Formulary_ES_Name, Formulary_EN_URL, Formulary_ES_URL,
MemberBrochure_Search, MemberBrochure_EN_Name, MemberBrochure_ES_Name, MemberBrochure_EN_URL, MemberBrochure_ES_URL,
BrokerBrochure_EN_Name, BrokerBrochure_ES_Name, BrokerBrochure_EN_URL, BrokerBrochure_ES_URL,
VanityFormulary, Notes
```

- `*_Search`: text typed into the plan search box; usually the PDF filename stem (e.g. `CAFormulary27`).
- Any doc-type a state doesn't publish leaves its `*_Name` / `*_URL` cells empty and is skipped automatically (e.g. TX-OX has no Formulary).
- Sheet URLs are stored in **production form**; the `SourceHost` → `TargetHost` swap in the Settings sheet rewrites them at test time.

**Sheet `Settings`** — global run config (Key / Value / Notes). Edit those cells to point the suite at Q1 / Q3 / UAT / prod or to track a UI copy change — no code change required.

| Key                   | Purpose                                      | UAT default                               |
| --------------------- | -------------------------------------------- | ----------------------------------------- |
| `AppUrl`            | Landing page                                 | `https://uat-pws.molinahealthcare.com/` |
| `Audience`          | Audience filter checkbox                     | `Marketplace`                           |
| `FormularyCategory` | Category filter for the Formulary pass       | `Formulary and Drug Lists`              |
| `BrochureCategory`  | Category filter for the Member + Broker pass | `Member Handbooks and Coverage`         |
| `SourceHost`        | Host inside the sheet's PDF URLs (prod form) | `www.molinahealthcare.com`              |
| `TargetHost`        | Host to rewrite to at test time              | `uat-pws.molinahealthcare.com`          |
| `Languages`         | Comma-separated site-language passes         | `en,es`                                 |
| `BrokerEnabled`     | `false` skips the Broker Brochure step     | `true`                                  |

Resolution order for each key: **explicit env var** (for CI one-off overrides) → **Settings sheet** → **hardcoded fallback in `config/framework.config.js`**.

---

## Run all suites at once

- "npm run test:all" — runs every spec under `tests/` (toggle-check + plan-search + drug-pharmacy + sitecore-docs + brochure-formulary)

The `tests/` folder layout:

```
tests/
  marketplace/
    marketplace.spec.js
    marketplacePlanSearch.spec.js
    marketplaceDrugPharmacy.spec.js
    marketplaceSitecoreDocs.spec.js
    marketplaceBrochureFormulary.spec.js
```

Reports land under `reports/<suite>/<slug>/` as a self-contained HTML file with screenshots alongside.

---

## Utility commands

- "npm run clean:artifacts" — cleans `reports/` and `test-results/` folders only (no test run)
- "npm run report:open" — opens the marketplace-toggleCheck report folder
- "npm run data:sitecore-docs" — regenerates the Sitecore-docs Excel workbook from the state configs in [scripts/createSitecoreDocsExcel.js](scripts/createSitecoreDocsExcel.js)
- "npm run report:regen:docs" — rebuilds the Sitecore-docs dashboards + `all-reports-<STATE>/` flat folder from existing `variant.json` files (no test run)
- "npm run data:brochure-formulary" — regenerates the Brochure & Formulary Excel workbook from the state configs in [scripts/createBrochureFormularyExcel.js](scripts/createBrochureFormularyExcel.js)
- "npm run report:regen:brochure" — rebuilds the Brochure & Formulary dashboards + `all-reports-<STATE>/` flat folder from existing `variant.json` files (no test run)

---

## Git commands

Repository: `https://github.com/Naresh-Jangid_molina/molina-automation-framework`
Default working branch: `dev`

### First-time git identity (per machine, one-time)

- "git config --global user.name ""Your Name""" — set your commit author name
- "git config --global user.email ""you@molinahealthcare.com""" — set your commit email

### First-time clone (fresh machine)

- "git clone https://github.com/Naresh-Jangid_molina/molina-automation-framework.git" — downloads the repo
- "cd molina-automation-framework" — enter the project folder
- "git checkout dev" — switch to the working branch
- "npm install" — install dependencies

### Everyday workflow

- "git status" — see what has changed locally
- "git pull" — pull the latest changes from `origin/dev` before you start work
- "git add -A" — stage all changes (new / modified / deleted files)
- "git add path/to/file" — stage a specific file only
- "git commit -m ""your message""" — commit staged changes with a message
- "git push" — push commits to `origin/dev`
