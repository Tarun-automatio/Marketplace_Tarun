# Marketplace

Playwright framework for Molina Marketplace (Individual & Family / IFP) validation.

Four suites:

- **Marketplace toggle check** — validates the 2026/2027 coverage-year toggle on the *Member Resources → Forms & Documents* page across states, languages (English / Spanish), and devices (Desktop / iPhone SE / iPad Pro).
- **Marketplace Plan Search** — validates Audience/Category filters, plan-name search, and per-plan PDF URL matches.
- **Marketplace Drug Pharmacy Links** — validates external-site CTAs (Find a pharmacy, Find a provider, mail-order form) on the IFP drug page and the ExternalSiteModal → Continue → new-tab redirect chain.
- **Marketplace Sitecore Docs** — directly hits each Sitecore-hosted plan document PDF URL (SBC / EOC / OOC, SOB optional) per state and per language, and verifies Chrome renders the PDF + the filename matches.

> CY2027 Plan Materials / Drug suites live in the sibling folder `cy2027/`.

---

## Setup (one-time)

```powershell
cd marketplace

"npm install" : to download the dependency (ignore "" to run in terminal)
npm test
```

---

## Run commands — Marketplace (toggle check)

Run all commands from the framework root (`marketplace/`).

"npm test" or "npm run test:marketplace" : Cleans old artifacts and runs the marketplace toggle-check suite in headless mode

"npm run test:marketplace:headed" : Same run, but with a visible Chrome window

Each row in the Marketplace data sheet where `Run=Y` is auto-multiplied across three device profiles — **Desktop**, **iPhone SE**, and **iPad Pro** — so 1 sheet row = 3 test cases (Desktop + 2 responsive). English rows load the base URL; Spanish (`Language=es`) rows load `/es-us/…` and preserve the language through navigation.

---

## Run commands — Marketplace Plan Search

Extends the marketplace flow with Audience/Category filters, plan-name search, and per-plan PDF URL validation. One Excel row = one plan search that verifies N pipe-separated expected PDF URLs.

"npm run test:marketplace:plans" : Cleans old artifacts and runs the plan-search suite in headless mode

"npm run test:marketplace:plans:headed" : Same run, but with a visible Chrome window

---

## Run commands — Marketplace Drug Pharmacy Links

Validates the external-site CTAs on the Individual & Family drug page (`/ifp/{state}/drugs`) — e.g. **Find a pharmacy**, **Find a provider**, mail-order form. Each CTA must open Molina's ExternalSiteModal; clicking **Continue** must open a new tab that lands on the expected external URL after any redirect chain.

"npm run test:marketplace:pharmacy" : Cleans old artifacts and runs the drug-pharmacy CTA suite in headless mode

"npm run test:marketplace:pharmacy:headed" : Same run, but with a visible Chrome window

Data lives in the same [MarketplaceData.xlsx](data/marketplace/MarketplaceData.xlsx) workbook as the toggle-check suite, but on a **separate sheet `DrugPharmacy`** so all Marketplace data stays in one file. Adding a new CTA (e.g. a new "Find a provider" link) is a one-row Excel edit — no code change required.

---

## Run commands — Marketplace Sitecore Docs (SBC / EOC / OOC)

Directly hits each Sitecore-hosted plan document PDF URL and verifies:

1. `page.goto(pdfUrl)` resolves (no 404 / redirect off-file).
2. Chrome's built-in PDF viewer mounts (`embed[type="application/x-google-chrome-pdf"]`). If headless Chrome blocks inline rendering, an HTTP probe falls back to confirm `HTTP 200 + application/pdf`.
3. The filename in the tab URL matches the expected filename from the data sheet (also cross-checked against `Content-Disposition` and the embed's `original-url`).

One Excel row = one plan; each plan expands to up to 8 URL tests (4 doc-types × EN + ES). Default doc-type filter is `SBC,EOC,OOC` — flip on SOB with `$env:MARKETPLACE_SITECORE_DOCS_TYPES='SBC,SOB,EOC,OOC'`.

"npm run test:marketplace:docs" : Cleans old artifacts and runs the Sitecore-docs suite in headless mode

"npm run test:marketplace:docs:headed" : Same run, but with a visible Chrome window

"npm run data:sitecore-docs" : Regenerates `data/marketplace/MarketplaceSitecoreDocsData.xlsx` from the seed configs at the top of [scripts/createSitecoreDocsExcel.js](scripts/createSitecoreDocsExcel.js) (adds new states / plans without touching the workbook by hand)

"npm run report:regen:docs" : Regenerates `Consolidated.html`, `Consolidated-<STATE>.html`, and the `all-reports-<STATE>/` flat share folder from whatever `variant.json` files are already on disk under `reports/marketplace-sitecore-docs/` — use this when the flat folder looks short after a run (fs-flush race safety net; no test run required)

### Narrow the matrix with env vars

```powershell
$env:MARKETPLACE_SITECORE_DOCS_STATE     = 'ID'          # ID / CA / WA / NM / NV / TX …
$env:MARKETPLACE_SITECORE_DOCS_DOCTYPE   = 'SBC'         # SBC / EOC / OOC / SOB
$env:MARKETPLACE_SITECORE_DOCS_LANGUAGE  = 'en'          # en / es
$env:MARKETPLACE_SITECORE_DOCS_PLAN      = 'Gold Core'   # substring match on PlanName
npm run test:marketplace:docs
```

Unset the variables (`Remove-Item Env:MARKETPLACE_SITECORE_DOCS_STATE`) to widen the scope again.

### Environment host swap

Excel URLs come from the SharePoint tracker in production form (`www.molinahealthcare.com`). The spec rewrites the host to the target QA env at load time:

- `MARKETPLACE_SITECORE_DOCS_SOURCE_HOST` — defaults to `www.molinahealthcare.com`
- `MARKETPLACE_SITECORE_DOCS_TARGET_HOST` — defaults to `pws-q3.molinahealthcare.com`

Point at Q1/Q2/prod without editing the workbook by overriding `MARKETPLACE_SITECORE_DOCS_TARGET_HOST`.

### Reports & sharing

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

---

## Run all marketplace suites

"npm run test:all" : Runs every spec under `tests/` (toggle-check + plan-search + drug-pharmacy + sitecore-docs)

---

## Utility commands

"npm run clean:artifacts" : Cleans reports/ and test-results/ folders only (no test run)

"npm run report:open" : Opens the marketplace-toggleCheck report folder

"npm run data:sitecore-docs" : Regenerates the Sitecore-docs Excel workbook from the state configs in [scripts/createSitecoreDocsExcel.js](scripts/createSitecoreDocsExcel.js)

"npm run report:regen:docs" : Rebuilds the Sitecore-docs dashboards + `all-reports-<STATE>/` flat folder from existing `variant.json` files (no test run)

---

## Data sheets

Each suite is driven by an Excel workbook. Add rows and set `Run=Y` to enable them.

- **Marketplace project** (`data/marketplace/`)
  - Marketplace toggle check → `data/marketplace/MarketplaceData.xlsx`  (sheet `Marketplace`)
    - Columns: `Run, State, Language, DefaultYear, AlternateYear, AppUrl, TestId, Notes`
    - `Language`: `en` or `es` (Spanish auto-prepends `/es-us` to the URL)
    - `AppUrl`: leave blank to use the `MARKETPLACE_URL` env default
    - `TestId`: shown in the report header and used as the HTML report filename
    - Each `Run=Y` row expands to 3 test cases (Desktop + iPhone SE + iPad Pro)
  - Marketplace Plan Search → `data/marketplace/MarketplacePlansData.xlsx`
    - **Sheet `Plans`** — primary search per test (one row = one test)
      - Columns: `Run, TestId, State, Year, Label, Audience, Category, PlanName, ExpectedUrls`
      - `Label`: short document-type name shown on plan cards (e.g. `SBC`)
      - `Audience` / `Category`: filter checkbox values (e.g. `Member`, `Summary of Benefits`)
      - `PlanName`: text typed into the search box (also used to filter matching cards)
      - `ExpectedUrls`: pipe-separated PDF URLs — one per matching card
    - **Sheet `AdditionalSearches`** — optional; extra searches to run AFTER the primary
      - Columns: `TestId, Label, Audience, Category, ExpectedUrls`
      - Each row joins to a `Plans` row via `TestId` (case-insensitive)
      - Runs in row order; between searches the framework unchecks the previous Audience/Category filters and applies the new ones automatically
      - Common use: primary search validates SBC PDFs, additional search validates SOB PDFs for the same plan
  - Marketplace Drug Pharmacy Links → `data/marketplace/MarketplaceData.xlsx`  (sheet `DrugPharmacy`)
    - Columns: `Run, TestId, State, LinkLabel, ExpectedInitialUrl, ExpectedFinalUrl, Notes`
    - `LinkLabel`: visible text of the CTA on the IFP drugs page (e.g. `Find a pharmacy`, `Find a provider`)
    - `ExpectedInitialUrl`: the Continue link's `href` (typically a Caremark entry URL before redirects)
    - `ExpectedFinalUrl`: the URL the new tab settles on after all 302 redirects; both are compared with lenient URL normalization
    - Optional env filters `MARKETPLACE_PHARMACY_STATE` / `MARKETPLACE_PHARMACY_LINK_LABEL` narrow the matrix without editing the sheet
  - Marketplace Sitecore Docs → `data/marketplace/MarketplaceSitecoreDocsData.xlsx`  (sheet `SitecoreDocs`)
    - Columns (one row per plan): `Run, TestId, State, RateCode, PlanCode, PlanName, SBC_Display, SBC_EN_Name, SBC_ES_Name, SBC_EN_URL, SBC_ES_URL, SOB_Display, SOB_EN_Name, SOB_ES_Name, SOB_EN_URL, SOB_ES_URL, EOC_Display, EOC_EN_Name, EOC_ES_Name, EOC_EN_URL, EOC_ES_URL, OOC_Display, OOC_EN_Name, OOC_ES_Name, OOC_EN_URL, OOC_ES_URL, Notes`
    - A doc-type a state doesn't publish leaves its cells empty — the loader skips them automatically (e.g. CA has only SBC + EOC)
    - Regenerate the workbook from the seed configs with `npm run data:sitecore-docs` (edit the `STATE_CONFIGS` array at the top of [scripts/createSitecoreDocsExcel.js](scripts/createSitecoreDocsExcel.js) to add new states / plans; each state config picks which doc-types are present and whether each uses the plan stem or a state-level filename)
    - Per-plan filename overrides (4th tuple element `{ EOC: 'CC' }`) support states like TX where EOC files are grouped by product tag instead of by plan stem

Reports land under `reports/<suite>/<slug>/` as a self-contained HTML file with screenshots alongside.

The `tests/` folder layout:

```
tests/
  marketplace/
    marketplace.spec.js
    marketplacePlanSearch.spec.js
    marketplaceDrugPharmacy.spec.js
    marketplaceSitecoreDocs.spec.js
```

---

## Git commands

Repository: `https://github.com/Naresh-Jangid_molina/molina-automation-framework`
Default working branch: `dev`

### First-time clone (fresh machine)

"git clone https://github.com/Naresh-Jangid_molina/molina-automation-framework.git" : Downloads the repo

"cd molina-automation-framework" : Enter the project folder

"git checkout dev" : Switch to the working branch

"npm install" : Install dependencies

### Everyday workflow

"git status" : See what has changed locally

"git pull" : Pull the latest changes from origin/dev before you start work

"git add -A" : Stage all changes (new / modified / deleted files)

"git add path/to/file" : Stage a specific file only

"git commit -m ""your message""" : Commit staged changes with a message

"git push" : Push commits to origin/dev

### First-time git identity (per machine, one-time)

"git config --global user.name ""Your Name""" : Set your commit author name

"git config --global user.email ""you@molinahealthcare.com""" : Set your commit email
