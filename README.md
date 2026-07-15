# PlanMaterialAutomation

Playwright framework for Molina Medicare PDF validation.

Two suites:

- **Plan Materials** — validates Annual Notice of Change (ANOC), Summary of Benefits (SOB), Evidence of Coverage (EOC) etc. under the *<YEAR> Plan Materials* section.
- **Drug / Pharmacy** — validates Comprehensive Formulary, Prior Authorization Grid, Step Therapy Grid etc. under the *<YEAR> Pharmacy and Prescription Benefits Documents* section.

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

## Run both suites

"npm run test:all" : Runs every spec under `tests/` (plan-materials + drug)

---

## Utility commands

"npm run clean:artifacts" : Cleans reports/ and test-results/ folders only (no test run)

"npm run report:open" : Opens the custom PlanMaterials HTML report

---

## Data sheets

Each suite is driven by an Excel workbook. Add rows and set `Run=Y` to enable them.

- Plan Materials → `data/PlanMaterialsData.xlsx`  (sheet `Plans`)
- Drug / Pharmacy → `data/DrugPageData.xlsx`  (sheet `Plans`)

Columns: `Run, State, Year, Accordion, PlanName, ExpectedUrl`


