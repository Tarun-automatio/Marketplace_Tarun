# PlanMaterialAutomation

Playwright framework for Molina Medicare PDF validation.

Three suites:

- **Plan Materials** — validates Annual Notice of Change (ANOC), Summary of Benefits (SOB), Evidence of Coverage (EOC) etc. under the *<YEAR> Plan Materials* section.
- **Drug / Pharmacy** — validates Comprehensive Formulary, Prior Authorization Grid, Step Therapy Grid etc. under the *<YEAR> Pharmacy and Prescription Benefits Documents* section.
- **Marketplace** — validates the 2026/2027 coverage-year toggle on the *Member Resources → Forms & Documents* page across states, languages (English / Spanish), and devices (Desktop / iPhone SE / iPad Pro).

---

## Setup (one-time)

```powershell
cd PlanMaterialAutomation

"npm install" : to download the dependency (ignore "" to run in terminal)
npm test
```

---

## Run commands — Plan Materials

Run all commands from the framework root (`PlanMaterialAutomation/`).

"npm test" : Cleans old artifacts and runs the plan-materials suite in headless mode

"npm run test:headed" : Same run, but with a visible Chrome window

"npm run test:debug" : Runs with LOG_LEVEL=DEBUG for verbose logs

---

## Run commands — Drug / Pharmacy

"npm run test:drug" : Cleans old artifacts and runs the drug-page suite in headless mode

"npm run test:drug:headed" : Same run, but with a visible Chrome window

---

## Run commands — Marketplace

"npm run test:marketplace" : Cleans old artifacts and runs the marketplace suite in headless mode

"npm run test:marketplace:headed" : Same run, but with a visible Chrome window

Each row in the Marketplace data sheet where `Run=Y` is auto-multiplied across three device profiles — **Desktop**, **iPhone SE**, and **iPad Pro** — so 1 sheet row = 3 test cases (Desktop + 2 responsive). English rows load the base URL; Spanish (`Language=es`) rows load `/es-us/…` and preserve the language through navigation.


---

## Run both suites

"npm run test:all" : Runs every spec under `tests/` (plan-materials + drug + marketplace)

---

## Utility commands

"npm run clean:artifacts" : Cleans reports/ and test-results/ folders only (no test run)

"npm run report:open" : Opens the custom PlanMaterials HTML report

---

## Data sheets

Each suite is driven by an Excel workbook. Add rows and set `Run=Y` to enable them.

- Plan Materials → `data/PlanMaterialsData.xlsx`  (sheet `Plans`)
- Drug / Pharmacy → `data/DrugPageData.xlsx`  (sheet `Plans`)
  - Columns: `Run, State, Year, Accordion, PlanName, ExpectedUrl`
- Marketplace → `data/MarketplaceData.xlsx`  (sheet `Marketplace`)
  - Columns: `Run, State, Language, DefaultYear, AlternateYear, AppUrl, TestId, Notes`
  - `Language`: `en` or `es` (Spanish auto-prepends `/es-us` to the URL)
  - `AppUrl`: leave blank to use the `MARKETPLACE_URL` env default
  - `TestId`: shown in the report header and used as the HTML report filename
  - Each `Run=Y` row expands to 3 test cases (Desktop + iPhone SE + iPad Pro)

Reports land under `reports/<suite>/<slug>/` with their own HTML file and a matching `.zip` bundle.

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



