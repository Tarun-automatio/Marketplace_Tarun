/**
 * scripts/createBrochureFormularyExcel.js
 * ─────────────────────────────────────────────────────────────────────────
 * Generate `data/marketplace/MarketplaceBrochureFormularyData.xlsx` from
 * an in-file seed of Formulary / Member Brochure / Broker Brochure URLs
 * per state.
 *
 * QA workflow:
 *   1. Append another block to STATE_CONFIGS below (copy an existing one).
 *   2. Run `npm run data:brochure-formulary`.
 *   3. Existing sheet gets overwritten. A dated backup is saved next to it.
 *
 * Sheet columns (one row per state):
 *   Run | TestId | State | Year
 *   Formulary_Search       | Formulary_EN_Name    | Formulary_ES_Name    | Formulary_EN_URL    | Formulary_ES_URL
 *   MemberBrochure_Search  | MemberBrochure_EN_Name | MemberBrochure_ES_Name | MemberBrochure_EN_URL | MemberBrochure_ES_URL
 *   BrokerBrochure_EN_Name | BrokerBrochure_ES_Name | BrokerBrochure_EN_URL | BrokerBrochure_ES_URL
 *   VanityFormulary | Notes
 *
 * The spec skips empty cells automatically (e.g. TX-OX has no Formulary,
 * most states have no Spanish Formulary).
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUT_PATH = path.join(process.cwd(), 'data', 'marketplace', 'MarketplaceBrochureFormularyData.xlsx');
const SHEET    = 'BrochureFormulary';

// ═══════════════════════════════════════════════════════════════════════════
// State configs — one block per state. Add new blocks at the bottom.
// ═══════════════════════════════════════════════════════════════════════════
//
// Each state config drives BOTH the filename stems and the URL segments.
// URLs preserve prod host — the spec rewrites host at load time via
// `marketplaceBrochureFormulary.hostRewrite`.
//
// Fields:
//   • stateCode  — 2- to 5-char state identifier used in the TestId & URLs
//   • urlState   — lowercase folder segment on Sitecore (usually stateCode
//                  in lowercase; TX-OX still lives under /ifp/tx/…)
//   • year       — coverage year (2027 for the CY27 batch)
//   • host       — production host (rewritten to Q3 at run time)
//   • stems      — filename stems per doc-type:
//       .formularyEN  → e.g. 'CAFormulary27'    (empty = no formulary for state)
//       .formularyES  → e.g. ''                 (usually empty; CMS requires English)
//       .memberBroEN  → e.g. 'CAMBRBrochure27'
//       .memberBroES  → e.g. 'CAMBRBrochure27'
//       .brokerBroEN  → e.g. 'CABrochure27'
//       .brokerBroES  → e.g. 'CABrochure27'
//   • vanityFormulary — informational (goes into the report), e.g.
//                       'MolinaHealthcare.com/CAFormulary27'
//   • notes      — free-form comments, ends up in the sheet's Notes column

const STATE_CONFIGS = [
  {
    stateCode: 'CA',
    urlState:  'ca',
    year:      '2027',
    host:      'https://www.molinahealthcare.com',
    stems: {
      formularyEN: 'CAFormulary27',
      formularyES: 'CAFormulary27',
      memberBroEN: 'CAMBRBrochure27',
      memberBroES: 'CAMBRBrochure27',
      brokerBroEN: 'CABrochure27',
      brokerBroES: 'CABrochure27',
    },
    displayNames: {
      member: 'CA Plan Brochure',
      broker: 'CA Broker Brochure',
    },
    vanityFormulary: 'MolinaHealthcare.com/CAFormulary27',
    notes: '',
  },
  {
    stateCode: 'ID',
    urlState:  'id',
    year:      '2027',
    host:      'https://www.molinahealthcare.com',
    stems: {
      formularyEN: 'IDFormulary27',
      formularyES: 'IDFormulary27',
      memberBroEN: 'IDMBRBrochure27',
      memberBroES: 'IDMBRBrochure27',
      brokerBroEN: 'IDBrochure27',
      brokerBroES: 'IDBrochure27',
    },
    displayNames: {
      member: 'ID Plan Brochure',
      broker: 'ID Broker Brochure',
    },
    vanityFormulary: 'MolinaHealthcare.com/IDFormulary27',
    notes: '',
  },
  {
    stateCode: 'NM',
    urlState:  'nm',
    year:      '2027',
    host:      'https://www.molinahealthcare.com',
    stems: {
      formularyEN: 'NMFormulary27',
      formularyES: 'NMFormulary27',
      memberBroEN: 'NMMBRBrochure27',
      memberBroES: 'NMMBRBrochure27',
      brokerBroEN: 'NMBrochure27',
      brokerBroES: 'NMBrochure27',
    },
    displayNames: {
      member: 'NM Plan Brochure',
      broker: 'NM Broker Brochure',
    },
    vanityFormulary: 'MolinaHealthcare.com/NMFormulary27',
    notes: '',
  },
  {
    stateCode: 'NV',
    urlState:  'nv',
    year:      '2027',
    host:      'https://www.molinahealthcare.com',
    stems: {
      formularyEN: 'NVFormulary27',
      formularyES: 'NVFormulary27',
      memberBroEN: 'NVMBRBrochure27',
      memberBroES: 'NVMBRBrochure27',
      brokerBroEN: 'NVBrochure27',
      brokerBroES: 'NVBrochure27',
    },
    displayNames: {
      member: 'NV Plan Brochure',
      broker: 'NV Broker Brochure',
    },
    vanityFormulary: 'MolinaHealthcare.com/NVFormulary27',
    notes: '',
  },
  {
    stateCode: 'TX',
    urlState:  'tx',
    year:      '2027',
    host:      'https://www.molinahealthcare.com',
    stems: {
      formularyEN: 'TXFormulary27',
      formularyES: 'TXFormulary27',
      memberBroEN: 'TXMBRBrochure27',
      memberBroES: 'TXMBRBrochure27',
      brokerBroEN: 'TXBrochure27',
      brokerBroES: 'TXBrochure27',
    },
    displayNames: {
      member: 'TX Plan Brochure',
      broker: 'TX Broker Brochure',
    },
    vanityFormulary: 'MolinaHealthcare.com/TXFormulary27',
    notes: '',
  },
  {
    // Same underlying /ifp/tx/ folder as TX; different filename stems for
    // the Off-Exchange brochures. Source note: "Same as OnX" formulary,
    // so we intentionally leave formulary empty (avoids double-counting).
    stateCode: 'TX-OX',
    urlState:  'tx',
    year:      '2027',
    host:      'https://www.molinahealthcare.com',
    stems: {
      formularyEN: '',
      formularyES: '',
      memberBroEN: 'TXOXMBRBrochure27',
      memberBroES: 'TXOXMBRBrochure27',
      brokerBroEN: 'TXOXBrochure27',
      brokerBroES: 'TXOXBrochure27',
    },
    displayNames: {
      member: 'TX Off Exchange Plan Brochure',
      broker: 'TX Off Exchange Broker Brochure',
    },
    vanityFormulary: '',
    notes: 'Formulary is shared with TX (OnX) — not re-verified for OX.',
  },
  {
    stateCode: 'WA',
    urlState:  'wa',
    year:      '2027',
    host:      'https://www.molinahealthcare.com',
    stems: {
      formularyEN: 'WAFormulary27',
      formularyES: 'WAFormulary27',
      memberBroEN: 'WAMBRBrochure27',
      memberBroES: 'WAMBRBrochure27',
      brokerBroEN: 'WABrochure27',
      brokerBroES: 'WABrochure27',
    },
    displayNames: {
      member: 'WA Plan Brochure',
      broker: 'WA Broker Brochure',
    },
    vanityFormulary: 'MolinaHealthcare.com/WAFormulary27',
    notes: '',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Row builder
// ═══════════════════════════════════════════════════════════════════════════

const HEADER = [
  'Run', 'TestId', 'State', 'Year',
  'Formulary_Search',      'Formulary_EN_Name',      'Formulary_ES_Name',      'Formulary_EN_URL',      'Formulary_ES_URL',
  'MemberBrochure_Search', 'MemberBrochure_EN_Name', 'MemberBrochure_ES_Name', 'MemberBrochure_EN_URL', 'MemberBrochure_ES_URL',
  'BrokerBrochure_Search', 'BrokerBrochure_EN_Name', 'BrokerBrochure_ES_Name', 'BrokerBrochure_EN_URL', 'BrokerBrochure_ES_URL',
  'VanityFormulary', 'Notes',
];

function buildPdfUrl({ cfg, docSeg, lang, stem }) {
  if (!stem) return '';
  return `${cfg.host}/-/media/project/pws/healthcare/pdf/pdf/ifp/${cfg.urlState}/materials/${docSeg}/${cfg.year}/${lang}/${stem}.pdf`;
}

function buildRow({ cfg, runningIndex }) {
  const stemSuffix = `${cfg.stateCode}_BROCH_FORM`;
  const testId = `TC${String(runningIndex + 1).padStart(3, '0')}_${stemSuffix}`;
  const asFile = (stem) => (stem ? `${stem}.pdf` : '');
  // Display names now come from the site card headings (e.g. "CA Plan
  // Brochure") — the sheet feeds these into both the on-page Search box
  // and the expected card title. URLs / filenames stay filename-stem based.
  const memberDisplay = (cfg.displayNames && cfg.displayNames.member) || asFile(cfg.stems.memberBroEN) || '';
  const brokerDisplay = (cfg.displayNames && cfg.displayNames.broker) || asFile(cfg.stems.brokerBroEN) || '';

  return {
    Run:      'Y',
    TestId:   testId,
    State:    cfg.stateCode,
    Year:     cfg.year,

    Formulary_Search:       cfg.stems.formularyEN || cfg.stems.formularyES || '',
    Formulary_EN_Name:      asFile(cfg.stems.formularyEN),
    Formulary_ES_Name:      asFile(cfg.stems.formularyES),
    Formulary_EN_URL:       buildPdfUrl({ cfg, docSeg: 'formulary', lang: 'english', stem: cfg.stems.formularyEN }),
    Formulary_ES_URL:       buildPdfUrl({ cfg, docSeg: 'formulary', lang: 'spanish', stem: cfg.stems.formularyES }),

    MemberBrochure_Search:  memberDisplay,
    MemberBrochure_EN_Name: memberDisplay,
    MemberBrochure_ES_Name: memberDisplay,
    MemberBrochure_EN_URL:  buildPdfUrl({ cfg, docSeg: 'brochure', lang: 'english', stem: cfg.stems.memberBroEN }),
    MemberBrochure_ES_URL:  buildPdfUrl({ cfg, docSeg: 'brochure', lang: 'spanish', stem: cfg.stems.memberBroES }),

    BrokerBrochure_Search:  brokerDisplay,
    BrokerBrochure_EN_Name: brokerDisplay,
    BrokerBrochure_ES_Name: brokerDisplay,
    BrokerBrochure_EN_URL:  buildPdfUrl({ cfg, docSeg: 'brochure', lang: 'english', stem: cfg.stems.brokerBroEN }),
    BrokerBrochure_ES_URL:  buildPdfUrl({ cfg, docSeg: 'brochure', lang: 'spanish', stem: cfg.stems.brokerBroES }),

    VanityFormulary: cfg.vanityFormulary || '',
    Notes:           cfg.notes || '',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  const rows = STATE_CONFIGS.map((cfg, i) => buildRow({ cfg, runningIndex: i }));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  if (fs.existsSync(OUT_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const backup = OUT_PATH.replace(/\.xlsx$/i, `_backup_${stamp}.xlsx`);
    fs.copyFileSync(OUT_PATH, backup);
    console.log(`[SEED] Backed up existing workbook \u2192 ${path.basename(backup)}`);
  }

  const ws = XLSX.utils.json_to_sheet(rows, { header: HEADER });
  ws['!cols'] = HEADER.map((h) => {
    if (/URL$/i.test(h))    return { wch: 110 };
    if (/Name$/i.test(h))   return { wch: 30 };
    if (/Search$/i.test(h)) return { wch: 30 };
    if (h === 'VanityFormulary') return { wch: 40 };
    if (h === 'Notes')      return { wch: 46 };
    return { wch: h.length + 6 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET);
  XLSX.writeFile(wb, OUT_PATH);

  console.log(`[SEED] Wrote ${rows.length} state row(s) to ${OUT_PATH}`);
  for (const r of rows) console.log(`[SEED]   \u2022 ${r.State}: formulary=${r.Formulary_EN_Name || '(none)'}, member=${r.MemberBrochure_EN_Name || '(none)'}, broker=${r.BrokerBrochure_EN_Name || '(none)'}`);
  console.log(`[SEED] Sheet: "${SHEET}"  \u00b7  ${HEADER.length} columns`);
}

if (require.main === module) main();
