/**
 * Helper utilities for the Plan Materials PDF validation flow.
 *
 * Provides:
 *   • Plan-name & file-name normalisation for lenient equality
 *   • PDF file-name extraction from URLs
 *   • Flexible plan-name ↔ PDF-file-name matcher
 *
 * These helpers are intentionally pure (no page / IO) so that they can be
 * unit-tested in isolation and reused by other validation specs.
 */

// ─── Normalisation ────────────────────────────────────────────────────────

/**
 * Return a canonical, comparable form of a string:
 *   • Unicode-normalised (accents stripped)
 *   • lower-cased
 *   • all non-alphanumeric characters removed
 *
 * Example:
 *   "2027 Annual Notice of Change – Molina (HMO D-SNP)"
 *   → "2027annualnoticeofchangemolinahmodsnp"
 */
function normalizeForCompare(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Split a string into alphanumeric tokens using non-alphanumeric characters as
 * boundaries. Used for word-level overlap scoring.
 */
function tokenize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// ─── URL / File helpers ───────────────────────────────────────────────────

/**
 * Extract the file name from a PDF URL (strips query string and fragment).
 *   "https://.../MI-H5926-1-0-AC-EN-27-S-508.pdf?x=1"
 *   → "MI-H5926-1-0-AC-EN-27-S-508.pdf"
 */
function extractPdfFileName(url) {
  if (!url) return '';
  try {
    const clean = String(url).split('#')[0].split('?')[0];
    const parts = clean.split('/');
    return decodeURIComponent(parts[parts.length - 1] || '');
  } catch {
    return '';
  }
}

/**
 * Return an absolute URL for a possibly relative href, resolved against baseUrl.
 */
function toAbsoluteUrl(href, baseUrl) {
  if (!href) return '';
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

// ─── Plan-name ↔ File-name matching ───────────────────────────────────────

/**
 * Document-type aliases: how plan-name words map to file-name abbreviations.
 * Keep both sides tokenised (lower-case, no punctuation).
 */
const DOC_TYPE_ALIASES = [
  { key: 'anoc',      planTokens: ['anoc', 'annual', 'notice', 'change'],     fileTokens: ['ac',  'anoc'] },
  { key: 'sob',       planTokens: ['sob',  'summary', 'benefits'],            fileTokens: ['sb',  'sob'] },
  { key: 'eoc',       planTokens: ['eoc',  'evidence', 'coverage'],           fileTokens: ['eoc'] },
  { key: 'formulary', planTokens: ['formulary', 'drug'],                       fileTokens: ['fm',  'formulary', 'drug'] },
  { key: 'provider',  planTokens: ['provider', 'directory'],                   fileTokens: ['pd',  'provider'] },
  { key: 'member',    planTokens: ['member', 'handbook', 'guide'],             fileTokens: ['mh',  'handbook'] },
];

/**
 * Two-digit / four-digit year token pairs (2027 ↔ 27, 2026 ↔ 26, …).
 * Only meaningful for years appearing in both the plan text and the file name.
 */
function yearMatchTokens(planTokens, fileTokens) {
  const found = [];
  for (const t of planTokens) {
    if (!/^20\d{2}$/.test(t)) continue;
    const short = t.slice(2);              // "2027" → "27"
    if (fileTokens.includes(short) || fileTokens.includes(t)) {
      found.push({ plan: t, file: fileTokens.includes(short) ? short : t });
    }
  }
  for (const t of fileTokens) {
    if (!/^\d{2}$/.test(t)) continue;
    const long = `20${t}`;
    if (planTokens.includes(long) && !found.some(f => f.plan === long)) {
      found.push({ plan: long, file: t });
    }
  }
  return found;
}

/**
 * Compare a plan display name against a PDF file name using a *flexible*
 * strategy that survives the "encoded" nature of Molina file names.
 *
 * The comparison is considered a MATCH when at least one of the following
 * signals is present:
 *
 *   1. Strict equality after normalising both strings (case / space /
 *      punctuation / underscore / hyphen insensitive).
 *   2. One normalised string is a substring of the other (covers file names
 *      like `Molina_Medicare_Complete_Care_HMO_DSNP_ANOC.pdf`).
 *   3. A **year match** (e.g. plan "2027" vs file "27") AND a
 *      **document-type alias match** (e.g. plan "ANOC" vs file "AC").
 *   4. An overall overlap score ≥ 60 combining year, doc-type and token
 *      overlap ratios.
 *
 * `similarityPercent` is a single 0-100 number suitable for UI display:
 *   - 100  when the strings are equal (or one contains the other) after normalisation
 *   -  score  otherwise (year 40 + doc-type 40 + up to 20 for token overlap)
 *
 * @param {string} planName
 * @param {string} fileName
 * @returns {{
 *   match: boolean,
 *   score: number,
 *   similarityPercent: number,
 *   planNormalized: string,
 *   fileNormalized: string,
 *   planTokens: string[],
 *   fileTokens: string[],
 *   commonTokens: string[],
 *   yearMatches: {plan:string,file:string}[],
 *   docTypeMatch: string|null,
 *   strictMatch: boolean,
 *   reasons: string[],
 * }}
 */
function comparePlanNameToFileName(planName, fileName) {
  const planTokens = tokenize(planName);
  const fileBase   = String(fileName || '').replace(/\.pdf$/i, '');
  const fileTokens = tokenize(fileBase);

  const planNorm = normalizeForCompare(planName);
  const fileNorm = normalizeForCompare(fileBase);

  const planSet = new Set(planTokens);
  const fileSet = new Set(fileTokens);
  const commonTokens = [...planSet].filter(t => fileSet.has(t));

  const reasons = [];

  // ── 1 & 2. Strict / substring match after normalisation ──────────────
  let strictMatch = false;
  if (planNorm && fileNorm) {
    if (planNorm === fileNorm) {
      strictMatch = true;
      reasons.push('Plan name equals file name after normalisation');
    } else if (planNorm.length >= 8 && fileNorm.includes(planNorm)) {
      strictMatch = true;
      reasons.push('Plan name is contained within file name after normalisation');
    } else if (fileNorm.length >= 8 && planNorm.includes(fileNorm)) {
      strictMatch = true;
      reasons.push('File name is contained within plan name after normalisation');
    }
  }

  // ── 3. Year alias match (2027 ↔ 27) ──
  const yearMatches = yearMatchTokens(planTokens, fileTokens);
  if (yearMatches.length) reasons.push(`Year token match: ${yearMatches.map(m => `${m.plan}↔${m.file}`).join(', ')}`);

  // ── 4. Document-type alias match ──
  let docTypeMatch = null;
  for (const alias of DOC_TYPE_ALIASES) {
    const planHas = alias.planTokens.some(t => planTokens.includes(t));
    const fileHas = alias.fileTokens.some(t => fileTokens.includes(t));
    if (planHas && fileHas) {
      docTypeMatch = alias.key;
      reasons.push(`Document-type alias "${alias.key}" matches (plan ↔ file)`);
      break;
    }
  }

  // ── 5. Overlap ratio ──
  const totalUnique = new Set([...planTokens, ...fileTokens]).size || 1;
  const overlapRatio = commonTokens.length / totalUnique;
  if (commonTokens.length) reasons.push(`Common tokens (${commonTokens.length}): [${commonTokens.slice(0, 8).join(', ')}]`);

  // ── 6. Composite score ──
  let score = 0;
  if (strictMatch) {
    score = 100;
  } else {
    if (yearMatches.length) score += 40;
    if (docTypeMatch)       score += 40;
    score += Math.min(20, Math.round(overlapRatio * 200));
  }

  const match = strictMatch || (yearMatches.length > 0 && !!docTypeMatch) || score >= 60;

  if (!match && !reasons.length) reasons.push('No meaningful overlap found between plan name and file name');

  return {
    match,
    score,
    similarityPercent: score,
    planNormalized: planNorm,
    fileNormalized: fileNorm,
    planTokens, fileTokens, commonTokens,
    yearMatches, docTypeMatch, strictMatch,
    reasons,
  };
}

// ─── File-safe helpers ────────────────────────────────────────────────────

/**
 * Safe file-system name derived from a plan display name.
 * Trims to a reasonable length, keeps letters, digits, dashes and underscores.
 */
function sanitizePlanNameForFile(name, maxLen = 80) {
  const cleaned = String(name || 'plan')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return cleaned.substring(0, maxLen) || 'plan';
}

module.exports = {
  normalizeForCompare,
  tokenize,
  extractPdfFileName,
  toAbsoluteUrl,
  comparePlanNameToFileName,
  sanitizePlanNameForFile,
};
