/**
 * scripts/createSitecoreDocsExcel.js
 * ─────────────────────────────────────────────────────────────────────────
 * Generate `data/marketplace/MarketplaceSitecoreDocsData.xlsx` from an
 * in-file seed of Sitecore PDF URLs (SBC / SOB / EOC / OOC × EN + ES).
 *
 * The seed is state-config-driven so each state can opt in/out of any
 * doc-type and pick whether that doc-type is plan-level (uses the stem
 * in the filename, e.g. ID27SBCE_G1_1.pdf) or state-level (a single
 * shared file, e.g. ID27EOCE.pdf).
 *
 * QA workflow:
 *   1. Append another block to STATE_CONFIGS below (copy an existing one).
 *   2. Run `npm run data:sitecore-docs`.
 *   3. Existing sheet gets overwritten. A dated backup is saved next to it.
 *
 * Sheet columns (one row per plan — same shape as before so the spec
 * loader keeps working):
 *   Run | TestId | State | RateCode | PlanCode | PlanName
 *   SBC_Display | SBC_EN_Name | SBC_ES_Name | SBC_EN_URL | SBC_ES_URL
 *   SOB_Display | SOB_EN_Name | SOB_ES_Name | SOB_EN_URL | SOB_ES_URL
 *   EOC_Display | EOC_EN_Name | EOC_ES_Name | EOC_EN_URL | EOC_ES_URL
 *   OOC_Display | OOC_EN_Name | OOC_ES_Name | OOC_EN_URL | OOC_ES_URL
 *   Notes
 * A doc-type that a state does NOT publish leaves those cells empty —
 * the spec loader skips them automatically.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUT_PATH  = path.join(process.cwd(), 'data', 'marketplace', 'MarketplaceSitecoreDocsData.xlsx');
const SHEET     = 'SitecoreDocs';

// ═══════════════════════════════════════════════════════════════════════════
// State configs — one block per state. Add new blocks at the bottom.
// ═══════════════════════════════════════════════════════════════════════════
//
// docTypes[<TYPE>] shape:
//   • pathSeg:  URL path segment for that type ('sbc', 'SOB', 'EOC', 'OOC')
//   • display:  the Display column value copied from the QA tracker
//   • usesStem: true  → filename includes the plan's stem
//                        e.g. ID27SBCE_G1_1.pdf
//               false → filename is state-level (shared across all plans)
//                        e.g. ID27EOCE.pdf
//
// plans: [PlanCode, PlanName, PdfStem]
//
// The `host` field is preserved verbatim in every URL; the spec rewrites
// it to the target env at load time (marketplaceSitecoreDocs.hostRewrite).

const STATE_CONFIGS = [
  // ─── Idaho ──────────────────────────────────────────────────────────
  {
    state:    'ID',
    rateCode: 'ID91278',
    year:     '2027',
    host:     'https://www.molinahealthcare.com',
    basePath: '/-/media/project/pws/healthcare/pdf/pdf/ifp/id/materials',
    docTypes: {
      SBC: { pathSeg: 'sbc', display: 'Member Portal',         usesStem: true  },
      SOB: { pathSeg: 'SOB', display: 'PWS and Member Portal', usesStem: true  },
      EOC: { pathSeg: 'EOC', display: 'Member Portal',         usesStem: false },
      OOC: { pathSeg: 'OOC', display: 'Member Portal',         usesStem: true  },
    },
    plans: [
      ['ID001000101', 'Molina Gold Core 1500',                                              'G1_1'],
      ['ID001000102', 'Molina Gold Core Zero',                                               'G1_2'],
      ['ID001000103', 'Molina Gold Core 1500 LCS',                                           'G1_3'],
      ['ID001000201', 'Molina Silver Core 70',                                               'S1_1'],
      ['ID001000202', 'Molina Silver Core Zero',                                             'S1_2'],
      ['ID001000203', 'Molina Silver Core LCS',                                              'S1_3'],
      ['ID001000204', 'Molina Silver Core 73',                                               'S1_4'],
      ['ID001000205', 'Molina Silver Core 87',                                               'S1_5'],
      ['ID001000206', 'Molina Silver Core 94',                                               'S1_6'],
      ['ID001000901', 'Molina Silver Saver 70 with Four Free PCP Visits',                    'S12_1'],
      ['ID001000902', 'Molina Silver Saver Zero',                                            'S12_2'],
      ['ID001000903', 'Molina Silver Saver LCS with Four Free PCP Visits',                   'S12_3'],
      ['ID001000904', 'Molina Silver Saver 73 with Four Free PCP Visits',                    'S12_4'],
      ['ID001000905', 'Molina Silver Saver 87 with Four Free PCP Visits',                    'S12_5'],
      ['ID001000906', 'Molina Silver Saver 94 with Four Free PCP Visits',                    'S12_6'],
      ['ID002000101', 'Molina Gold Core 1500 Plus with Adult Vision',                        'G1V_1'],
      ['ID002000102', 'Molina Gold Core Zero Plus with Adult Vision',                        'G1V_2'],
      ['ID002000103', 'Molina Gold Core 1500 LCS Plus with Adult Vision',                    'G1V_3'],
      ['ID002000201', 'Molina Silver Core 70 Plus with Adult Vision',                        'S1V_1'],
      ['ID002000202', 'Molina Silver Core Zero Plus with Adult Vision',                      'S1V_2'],
      ['ID002000203', 'Molina Silver Core LCS Plus with Adult Vision',                       'S1V_3'],
      ['ID002000204', 'Molina Silver Core 73 Plus with Adult Vision',                        'S1V_4'],
      ['ID002000205', 'Molina Silver Core 87 Plus with Adult Vision',                        'S1V_5'],
      ['ID002000206', 'Molina Silver Core 94 Plus with Adult Vision',                        'S1V_6'],
      ['ID003000101', 'Molina Gold Core 1500 Plus with Adult Dental and Vision',             'G1DV_1'],
      ['ID003000102', 'Molina Gold Core Zero Plus with Adult Dental and Vision',             'G1DV_2'],
      ['ID003000103', 'Molina Gold Core 1500 LCS Plus with Adult Dental and Vision',         'G1DV_3'],
      ['ID003000201', 'Molina Silver Core 70 Plus with Adult Dental and Vision',             'S1DV_1'],
      ['ID003000202', 'Molina Silver Core Zero Plus with Adult Dental and Vision',           'S1DV_2'],
      ['ID003000203', 'Molina Silver Core LCS Plus with Adult Dental and Vision',            'S1DV_3'],
      ['ID003000204', 'Molina Silver Core 73 Plus with Adult Dental and Vision',             'S1DV_4'],
      ['ID003000205', 'Molina Silver Core 87 Plus with Adult Dental and Vision',             'S1DV_5'],
      ['ID003000206', 'Molina Silver Core 94 Plus with Adult Dental and Vision',             'S1DV_6'],
    ],
  },

  // ─── California ─────────────────────────────────────────────────────
  // CA only publishes SBC + EOC on Sitecore (no SOB, no OOC). EOC is
  // plan-level (uses the stem), unlike ID where EOC is state-level.
  {
    state:    'CA',
    rateCode: 'CA18126',
    year:     '2027',
    host:     'https://www.molinahealthcare.com',
    basePath: '/-/media/project/pws/healthcare/pdf/pdf/ifp/ca/materials',
    docTypes: {
      SBC: { pathSeg: 'sbc', display: 'Member Portal',         usesStem: true },
      EOC: { pathSeg: 'EOC', display: 'PWS and Member Portal', usesStem: true },
    },
    plans: [
      ['CA001000101', 'Platinum 90 HMO',         'P90_1'],
      ['CA001000103', 'Platinum 90 HMO AI-AN',   'P90_3'],
      ['CA001000201', 'Gold 80 HMO',             'G80_1'],
      ['CA001000203', 'Gold 80 HMO AI-AN',       'G80_3'],
      ['CA001000301', 'Silver 70 HMO',           'S70_1'],
      ['CA001000303', 'Silver 70 HMO AI-AN',     'S70_3'],
      ['CA001000304', 'Silver 73 HMO',           'S70_4'],
      ['CA001000305', 'Silver 87 HMO',           'S70_5'],
      ['CA001000306', 'Silver 94 HMO',           'S70_6'],
      ['CA001000401', 'Bronze 60 HMO',           'B60_1'],
      ['CA001000402', '$0 Cost Share HMO AI-AN', 'B60_2'],
      ['CA001000403', 'Bronze 60 HMO AI-AN',     'B60_3'],
      ['CA001000501', 'Minimum Coverage HMO',    'M1_1'],
    ],
  },

  // ─── Washington ─────────────────────────────────────────────────────
  // WA publishes SBC + SOB (plan-level) and EOC (state-level, no stem —
  // same pattern as ID). No OOC.
  {
    state:    'WA',
    rateCode: 'WA84481',
    year:     '2027',
    host:     'https://www.molinahealthcare.com',
    basePath: '/-/media/project/pws/healthcare/pdf/pdf/ifp/wa/materials',
    docTypes: {
      SBC: { pathSeg: 'sbc', display: 'Member Portal',         usesStem: true  },
      SOB: { pathSeg: 'SOB', display: 'PWS and Member Portal', usesStem: true  },
      EOC: { pathSeg: 'EOC', display: 'Member Portal',         usesStem: false },
    },
    plans: [
      ['WA006000501', 'Molina Cascade Complete Gold',      'G6_1'],
      ['WA006000502', 'Molina Cascade Complete Gold Zero', 'G6_2'],
      ['WA006000503', 'Molina Cascade Complete Gold LCS',  'G6_3'],
      ['WA006000601', 'Molina Cascade Silver 70',          'S6_1'],
      ['WA006000602', 'Molina Cascade Silver Zero',        'S6_2'],
      ['WA006000603', 'Molina Cascade Silver LCS',         'S6_3'],
      ['WA006000604', 'Molina Cascade Silver 73',          'S6_4'],
      ['WA006000605', 'Molina Cascade Silver 87',          'S6_5'],
      ['WA006000606', 'Molina Cascade Silver 94',          'S6_6'],
      ['WA006000701', 'Molina Cascade Bronze',             'B6_1'],
      ['WA006000702', 'Molina Cascade Bronze Zero',        'B6_2'],
      ['WA006000703', 'Molina Cascade Bronze LCS',         'B6_3'],
      ['WA006000901', 'Molina Cascade Vital Gold',         'G7_1'],
      ['WA006000902', 'Molina Cascade Vital Gold Zero',    'G7_2'],
      ['WA006000903', 'Molina Cascade Vital Gold LCS',     'G7_3'],
    ],
  },

  // ─── New Mexico ─────────────────────────────────────────────────────
  // Same schema as WA: SBC + SOB (plan-level) and EOC (state-level). No OOC.
  {
    state:    'NM',
    rateCode: 'NM19722',
    year:     '2027',
    host:     'https://www.molinahealthcare.com',
    basePath: '/-/media/project/pws/healthcare/pdf/pdf/ifp/nm/materials',
    docTypes: {
      SBC: { pathSeg: 'sbc', display: 'Member Portal',         usesStem: true  },
      SOB: { pathSeg: 'SOB', display: 'PWS and Member Portal', usesStem: true  },
      EOC: { pathSeg: 'EOC', display: 'Member Portal',         usesStem: false },
    },
    plans: [
      ['NM001000101', 'Molina Gold Saver On Exchange',                                  'G1_1'],
      ['NM001000102', 'Molina Native American Gold Saver Zero',                         'G1_2'],
      ['NM001000103', 'Molina Native American Gold Saver LCS',                          'G1_3'],
      ['NM001000113', 'Molina Native American Gold Saver Turquoise 3 LCS EXTRA SAVINGS','G1_13'],
      ['NM001000190', 'Molina Gold Saver Turquoise 3 EXTRA SAVINGS',                    'G1_90'],
      ['NM001001100', 'Molina Clear Cost Gold Off Exchange',                            'G13_0'],
      ['NM001001101', 'Molina Clear Cost Gold On Exchange',                             'G13_1'],
      ['NM001001102', 'Molina Native American Clear Cost Gold Zero',                    'G13_2'],
      ['NM001001103', 'Molina Native American Clear Cost Gold LCS',                     'G13_3'],
      ['NM001001113', 'Molina Native American Clear Cost Turquoise 3 LCS EXTRA SAVINGS','G13_13'],
      ['NM001001190', 'Molina Clear Cost Turquoise 3 EXTRA SAVINGS',                    'G13_90'],
      ['NM001001201', 'Molina Clear Cost Silver On Exchange',                           'S13_1'],
      ['NM001001202', 'Molina Native American Clear Cost Silver Zero',                  'S13_2'],
      ['NM001001203', 'Molina Native American Clear Cost Silver LCS',                   'S13_3'],
      ['NM001001204', 'Molina Clear Cost Silver 73',                                    'S13_4'],
      ['NM001001295', 'Molina Clear Cost Turquoise 2 with EXTRA SAVINGS',               'S13_95'],
      ['NM001001299', 'Molina Clear Cost Turquoise 1 with EXTRA SAVINGS',               'S13_99'],
      ['NM001001401', 'Molina Silver Saver On Exchange',                                'S14_1'],
      ['NM001001402', 'Molina Native American Silver Saver Zero',                       'S14_2'],
      ['NM001001403', 'Molina Native American Silver Saver LCS',                        'S14_3'],
      ['NM001001404', 'Molina Silver Saver 73',                                         'S14_4'],
      ['NM001001495', 'Molina Silver Saver Turquoise 2 with EXTRA SAVINGS',             'S14_95'],
      ['NM001001499', 'Molina Silver Saver Turquoise 1 with EXTRA SAVINGS',             'S14_99'],
      ['NM001001501', 'Molina Bronze Saver 7000 On Exchange',                           'B15_1'],
      ['NM001001502', 'Molina Native American Bronze Saver Zero',                       'B15_2'],
      ['NM001001503', 'Molina Native American Bronze Saver 7000 LCS',                   'B15_3'],
    ],
  },

  // ─── Nevada ─────────────────────────────────────────────────────────
  // Same schema as WA/NM: SBC + SOB (plan-level) + EOC (state-level). No OOC.
  {
    state:    'NV',
    rateCode: 'NV79363',
    year:     '2027',
    host:     'https://www.molinahealthcare.com',
    basePath: '/-/media/project/pws/healthcare/pdf/pdf/ifp/nv/materials',
    docTypes: {
      SBC: { pathSeg: 'sbc', display: 'Member Portal',         usesStem: true  },
      SOB: { pathSeg: 'SOB', display: 'PWS and Member Portal', usesStem: true  },
      EOC: { pathSeg: 'EOC', display: 'Member Portal',         usesStem: false },
    },
    plans: [
      ['NV002000101', 'Molina Gold Core 1500 Plus with Adult Vision',     'G1V_1'],
      ['NV002000102', 'Molina Gold Core Zero Plus with Adult Vision',     'G1V_2'],
      ['NV002000103', 'Molina Gold Core 1500 LCS Plus with Adult Vision', 'G1V_3'],
      ['NV002000201', 'Molina Silver Core 70 Plus with Adult Vision',     'S1V_1'],
      ['NV002000202', 'Molina Silver Core Zero Plus with Adult Vision',   'S1V_2'],
      ['NV002000203', 'Molina Silver Core LCS Plus with Adult Vision',    'S1V_3'],
      ['NV002000204', 'Molina Silver Core 73 Plus with Adult Vision',     'S1V_4'],
      ['NV002000205', 'Molina Silver Core 87 Plus with Adult Vision',     'S1V_5'],
      ['NV002000206', 'Molina Silver Core 94 Plus with Adult Vision',     'S1V_6'],
    ],
  },

  // ─── Texas ──────────────────────────────────────────────────────────
  // TX publishes SBC + SOB + EOC. SBC/SOB use the plan stem; EOC uses a
  // product-group tag (SM / CC / V / OX / DV) provided per-plan as the
  // 4th tuple element ({ EOC: '<tag>' }). No OOC.
  {
    state:    'TX',
    rateCode: 'TX45786',
    year:     '2027',
    host:     'https://www.molinahealthcare.com',
    basePath: '/-/media/project/pws/healthcare/pdf/pdf/ifp/tx/materials',
    docTypes: {
      SBC: { pathSeg: 'sbc', display: 'Member Portal',         usesStem: true },
      SOB: { pathSeg: 'SOB', display: 'PWS and Member Portal', usesStem: true },
      EOC: { pathSeg: 'EOC', display: 'Member Portal',         usesStem: true },
    },
    plans: [
      // Silver 3 (EOC=SM)
      ['TX001000200', 'Silver 3',                                                          'S3_0',    { EOC: 'SM' }],

      // Standard Core Gold + Silver (EOC=CC)
      ['TX002000101', 'Molina Gold Core 1500',                                             'G1_1',    { EOC: 'CC' }],
      ['TX002000102', 'Molina Gold Core Zero',                                             'G1_2',    { EOC: 'CC' }],
      ['TX002000103', 'Molina Gold Core 1500 LCS',                                         'G1_3',    { EOC: 'CC' }],
      ['TX002000201', 'Molina Silver Core 70',                                             'S1_1',    { EOC: 'CC' }],
      ['TX002000202', 'Molina Silver Core Zero',                                           'S1_2',    { EOC: 'CC' }],
      ['TX002000203', 'Molina Silver Core LCS',                                            'S1_3',    { EOC: 'CC' }],
      ['TX002000204', 'Molina Silver Core 73',                                             'S1_4',    { EOC: 'CC' }],
      ['TX002000205', 'Molina Silver Core 87',                                             'S1_5',    { EOC: 'CC' }],
      ['TX002000206', 'Molina Silver Core 94',                                             'S1_6',    { EOC: 'CC' }],

      // Gold Standard (EOC=CC)
      ['TX002001001', 'Molina Gold Standard',                                              'G8_1',    { EOC: 'CC' }],
      ['TX002001002', 'Molina Gold Standard Zero',                                         'G8_2',    { EOC: 'CC' }],
      ['TX002001003', 'Molina Gold Standard LCS',                                          'G8_3',    { EOC: 'CC' }],

      // Silver Standard (EOC=CC)
      ['TX002001101', 'Molina Silver Standard 70',                                         'S8_1',    { EOC: 'CC' }],
      ['TX002001102', 'Molina Silver Standard Zero',                                       'S8_2',    { EOC: 'CC' }],
      ['TX002001103', 'Molina Silver Standard LCS',                                        'S8_3',    { EOC: 'CC' }],
      ['TX002001104', 'Molina Silver Standard 73',                                         'S8_4',    { EOC: 'CC' }],
      ['TX002001105', 'Molina Silver Standard 87',                                         'S8_5',    { EOC: 'CC' }],
      ['TX002001106', 'Molina Silver Standard 94',                                         'S8_6',    { EOC: 'CC' }],

      // Silver Saver with Four Free PCP Visits (EOC=CC)
      ['TX002001201', 'Molina Silver Saver 70 with Four Free PCP Visits',                  'S12_1',   { EOC: 'CC' }],
      ['TX002001202', 'Molina Silver Saver Zero',                                          'S12_2',   { EOC: 'CC' }],
      ['TX002001203', 'Molina Silver Saver LCS with Four Free PCP Visits',                 'S12_3',   { EOC: 'CC' }],
      ['TX002001204', 'Molina Silver Saver 73 with Four Free PCP Visits',                  'S12_4',   { EOC: 'CC' }],
      ['TX002001205', 'Molina Silver Saver 87 with Four Free PCP Visits',                  'S12_5',   { EOC: 'CC' }],
      ['TX002001206', 'Molina Silver Saver 94 with Four Free PCP Visits',                  'S12_6',   { EOC: 'CC' }],

      // Gold Enhanced (EOC=CC)
      ['TX002001301', 'Molina Gold Enhanced 750',                                          'G12_1',   { EOC: 'CC' }],
      ['TX002001302', 'Molina Gold Enhanced Zero',                                         'G12_2',   { EOC: 'CC' }],
      ['TX002001303', 'Molina Gold Enhanced 750 LCS',                                      'G12_3',   { EOC: 'CC' }],

      // Empower (EOC=OX)
      ['TX002001400', 'Molina Silver Empower 2750',                                        'S16_0',   { EOC: 'OX' }],
      ['TX002001500', 'Molina Silver Empower 3750',                                        'S17_0',   { EOC: 'OX' }],
      ['TX002001600', 'Molina Silver Empower 4500',                                        'S18_0',   { EOC: 'OX' }],
      ['TX002001700', 'Molina Silver Empower 5500',                                        'S19_0',   { EOC: 'OX' }],
      ['TX002001800', 'Molina Gold Empower 2000',                                          'G16_0',   { EOC: 'OX' }],

      // Core Plus with Adult Vision (EOC=V)
      ['TX005000101', 'Molina Gold Core 1500 Plus with Adult Vision',                      'G1V_1',   { EOC: 'V'  }],
      ['TX005000102', 'Molina Gold Core Zero Plus with Adult Vision',                      'G1V_2',   { EOC: 'V'  }],
      ['TX005000103', 'Molina Gold Core 1500 LCS Plus with Adult Vision',                  'G1V_3',   { EOC: 'V'  }],
      ['TX005000201', 'Molina Silver Core 70 Plus with Adult Vision',                      'S1V_1',   { EOC: 'V'  }],
      ['TX005000202', 'Molina Silver Core Zero Plus with Adult Vision',                    'S1V_2',   { EOC: 'V'  }],
      ['TX005000203', 'Molina Silver Core LCS Plus with Adult Vision',                     'S1V_3',   { EOC: 'V'  }],
      ['TX005000204', 'Molina Silver Core 73 Plus with Adult Vision',                      'S1V_4',   { EOC: 'V'  }],
      ['TX005000205', 'Molina Silver Core 87 Plus with Adult Vision',                      'S1V_5',   { EOC: 'V'  }],
      ['TX005000206', 'Molina Silver Core 94 Plus with Adult Vision',                      'S1V_6',   { EOC: 'V'  }],

      // Empower Plus with Adult Vision (EOC=OX)
      ['TX005000400', 'Molina Silver Empower 2750 Plus with Adult Vision',                 'S16V_0',  { EOC: 'OX' }],
      ['TX005000500', 'Molina Silver Empower 3750 Plus with Adult Vision',                 'S17V_0',  { EOC: 'OX' }],
      ['TX005000600', 'Molina Silver Empower 4500 Plus with Adult Vision',                 'S18V_0',  { EOC: 'OX' }],
      ['TX005000700', 'Molina Silver Empower 5500 Plus with Adult Vision',                 'S19V_0',  { EOC: 'OX' }],
      ['TX005000800', 'Molina Gold Empower 2000 Plus with Adult Vision',                   'G16V_0',  { EOC: 'OX' }],

      // Gold Enhanced Plus with Adult Vision (EOC=V)
      ['TX005000901', 'Molina Gold Enhanced 750 Plus with Adult Vision',                   'G12V_1',  { EOC: 'V'  }],
      ['TX005000902', 'Molina Gold Enhanced Zero Plus with Adult Vision',                  'G12V_2',  { EOC: 'V'  }],
      ['TX005000903', 'Molina Gold Enhanced 750 LCS Plus with Adult Vision',               'G12V_3',  { EOC: 'V'  }],

      // Core Plus with Adult Dental and Vision (EOC=DV)
      ['TX006000101', 'Molina Gold Core 1500 Plus with Adult Dental and Vision',           'G1DV_1',  { EOC: 'DV' }],
      ['TX006000102', 'Molina Gold Core Zero Plus with Adult Dental and Vision',           'G1DV_2',  { EOC: 'DV' }],
      ['TX006000103', 'Molina Gold Core 1500 LCS Plus with Adult Dental and Vision',       'G1DV_3',  { EOC: 'DV' }],
      ['TX006000201', 'Molina Silver Core 70 Plus with Adult Dental and Vision',           'S1DV_1',  { EOC: 'DV' }],
      ['TX006000202', 'Molina Silver Core Zero Plus with Adult Dental and Vision',         'S1DV_2',  { EOC: 'DV' }],
      ['TX006000203', 'Molina Silver Core 70 LCS Plus with Adult Dental and Vision',       'S1DV_3',  { EOC: 'DV' }],
      ['TX006000204', 'Molina Silver Core 73 Plus with Adult Dental and Vision',           'S1DV_4',  { EOC: 'DV' }],
      ['TX006000205', 'Molina Silver Core 87 Plus with Adult Dental and Vision',           'S1DV_5',  { EOC: 'DV' }],
      ['TX006000206', 'Molina Silver Core 94 Plus with Adult Dental and Vision',           'S1DV_6',  { EOC: 'DV' }],

      // Gold Enhanced Plus with Adult Dental and Vision (EOC=DV)
      ['TX006000301', 'Molina Gold Enhanced 750 Plus with Adult Dental and Vision',        'G12DV_1', { EOC: 'DV' }],
      ['TX006000302', 'Molina Gold Enhanced Zero Plus with Adult Dental and Vision',       'G12DV_2', { EOC: 'DV' }],
      ['TX006000303', 'Molina Gold Enhanced 750 LCS Plus with Adult Dental and Vision',    'G12DV_3', { EOC: 'DV' }],

      // Empower Plus with Adult Dental and Vision (EOC=OX)
      ['TX006000400', 'Molina Silver Empower 2750 Plus with Adult Dental and Vision',      'S16DV_0', { EOC: 'OX' }],
      ['TX006000500', 'Molina Silver Empower 3750 Plus with Adult Dental and Vision',      'S17DV_0', { EOC: 'OX' }],
      ['TX006000600', 'Molina Silver Empower 4500 Plus with Adult Dental and Vision',      'S18DV_0', { EOC: 'OX' }],
      ['TX006000700', 'Molina Silver Empower 5500 Plus with Adult Dental and Vision',      'S19DV_0', { EOC: 'OX' }],
      ['TX006000800', 'Molina Gold Empower 2000 Plus with Adult Dental and Vision',        'G16DV_0', { EOC: 'OX' }],
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Row builder
// ═══════════════════════════════════════════════════════════════════════════

const HEADER = [
  'Run', 'TestId', 'State', 'RateCode', 'PlanCode', 'PlanName',
  'SBC_Display', 'SBC_EN_Name', 'SBC_ES_Name', 'SBC_EN_URL', 'SBC_ES_URL',
  'SOB_Display', 'SOB_EN_Name', 'SOB_ES_Name', 'SOB_EN_URL', 'SOB_ES_URL',
  'EOC_Display', 'EOC_EN_Name', 'EOC_ES_Name', 'EOC_EN_URL', 'EOC_ES_URL',
  'OOC_Display', 'OOC_EN_Name', 'OOC_ES_Name', 'OOC_EN_URL', 'OOC_ES_URL',
  'Notes',
];

/**
 * Build one plan-row of Excel data.
 * `runningIndex` gives the global TestId sequence across all states.
 * `overrides` (optional 4th plan-tuple element) lets a plan supply a
 * per-doc-type filename suffix that replaces the default stem — used by
 * TX where EOC files are grouped by product (`_CC`, `_V`, `_OX`, `_DV`,
 * `_SM`) instead of by plan stem.
 */
function buildRow({ cfg, planCode, planName, stem, overrides = {}, runningIndex }) {
  const y2 = String(cfg.year).slice(-2);
  const stateUp = cfg.state.toUpperCase();
  const base = `${cfg.host}${cfg.basePath}`;

  const row = {
    Run:      'Y',
    TestId:   `TC${String(runningIndex + 1).padStart(3, '0')}_${stateUp}_${planCode}`,
    State:    stateUp,
    RateCode: cfg.rateCode,
    PlanCode: planCode,
    PlanName: planName,

    SBC_Display: '', SBC_EN_Name: '', SBC_ES_Name: '', SBC_EN_URL: '', SBC_ES_URL: '',
    SOB_Display: '', SOB_EN_Name: '', SOB_ES_Name: '', SOB_EN_URL: '', SOB_ES_URL: '',
    EOC_Display: '', EOC_EN_Name: '', EOC_ES_Name: '', EOC_EN_URL: '', EOC_ES_URL: '',
    OOC_Display: '', OOC_EN_Name: '', OOC_ES_Name: '', OOC_EN_URL: '', OOC_ES_URL: '',
    Notes:       '',
  };

  for (const [dt, cfgDt] of Object.entries(cfg.docTypes)) {
    // Suffix precedence: per-plan override > state usesStem stem > none.
    // An override value of '' explicitly forces a state-level filename.
    let suffix;
    if (Object.prototype.hasOwnProperty.call(overrides, dt)) {
      suffix = overrides[dt];
    } else {
      suffix = cfgDt.usesStem ? stem : '';
    }
    const suffixPart = suffix ? `_${suffix}` : '';

    // Filename convention: <STATE><YY><TYPE><LANG>[_<SUFFIX>].pdf
    //   TYPE (3 letters): SBC / SOB / EOC / OOC
    //   LANG (1 letter):  E (English) / S (Spanish)
    const enName = `${stateUp}${y2}${dt}E${suffixPart}.pdf`;
    const esName = `${stateUp}${y2}${dt}S${suffixPart}.pdf`;
    const enUrl  = `${base}/${cfgDt.pathSeg}/${cfg.year}/english/${enName}`;
    const esUrl  = `${base}/${cfgDt.pathSeg}/${cfg.year}/spanish/${esName}`;

    row[`${dt}_Display`] = cfgDt.display;
    row[`${dt}_EN_Name`] = enName;
    row[`${dt}_ES_Name`] = esName;
    row[`${dt}_EN_URL`]  = enUrl;
    row[`${dt}_ES_URL`]  = esUrl;
  }
  return row;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  const rows = [];
  let running = 0;
  const perStateCounts = [];

  for (const cfg of STATE_CONFIGS) {
    const before = rows.length;
    for (const planTuple of cfg.plans) {
      const [planCode, planName, stem, overrides] = planTuple;
      rows.push(buildRow({ cfg, planCode, planName, stem, overrides, runningIndex: running }));
      running += 1;
    }
    perStateCounts.push({ state: cfg.state, plans: rows.length - before });
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  if (fs.existsSync(OUT_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const backup = OUT_PATH.replace(/\.xlsx$/i, `_backup_${stamp}.xlsx`);
    fs.copyFileSync(OUT_PATH, backup);
    console.log(`[SEED] Backed up existing workbook \u2192 ${path.basename(backup)}`);
  }

  const ws = XLSX.utils.json_to_sheet(rows, { header: HEADER });
  ws['!cols'] = HEADER.map((h) => {
    if (/URL$/i.test(h))  return { wch: 110 };
    if (/Name$/i.test(h)) return { wch: 28  };
    if (h === 'PlanName') return { wch: 46  };
    return { wch: h.length + 6 };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET);
  XLSX.writeFile(wb, OUT_PATH);

  console.log(`[SEED] Wrote ${rows.length} plan row(s) to ${OUT_PATH}`);
  for (const c of perStateCounts) {
    console.log(`[SEED]   \u2022 ${c.state}: ${c.plans} plan(s)`);
  }
  console.log(`[SEED] Sheet: "${SHEET}"  \u00b7  ${HEADER.length} columns`);
}

if (require.main === module) main();
