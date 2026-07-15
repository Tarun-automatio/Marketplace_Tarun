const path = require('path');
const logger = require('./logger');

const BLOCK_SIGNALS = [
  'access denied',
  "you don't have permission",
  'reference #',
  'errors.edgesuite.net'
];

function sanitizeFileName(value) {
  return String(value || 'state').replace(/[^a-z0-9_-]/gi, '_');
}

function normalizeUrlForComparison(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    parsed.search = '';
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${normalizedPath}`.toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function getLinkUrl(item) {
  return typeof item === 'string' ? item : (item && (item.href || item.url));
}

function filterOutMainUrl(links, mainUrl, onExcluded) {
  const mainUrlNormalized = normalizeUrlForComparison(mainUrl);
  const filtered = (links || []).filter((item) => normalizeUrlForComparison(getLinkUrl(item)) !== mainUrlNormalized);
  const excludedCount = (links || []).length - filtered.length;

  if (excludedCount > 0 && typeof onExcluded === 'function') {
    onExcluded(excludedCount, mainUrl);
  }

  return filtered;
}

function isEnvironmentBlocked(snapshot) {
  const text = String(snapshot?.visibleText || '').toLowerCase();
  const title = String(snapshot?.title || '').toLowerCase();

  return BLOCK_SIGNALS.some((signal) => text.includes(signal) || title.includes(signal));
}

function compareLinkMappings(qaSnapshot, prodSnapshot) {
  const normalize = (link) => ({
    text: (link.text || '').toLowerCase().trim(),
    href: normalizeUrlForComparison(link.href)
  });

  const qaLinks = (qaSnapshot.links || []).map(normalize);
  const prodLinks = (prodSnapshot.links || []).map(normalize);

  const qaMap = new Map();
  qaLinks.forEach((link) => {
    if (link.text) {
      qaMap.set(link.text, link.href);
    }
  });

  const prodMap = new Map();
  prodLinks.forEach((link) => {
    if (link.text) {
      prodMap.set(link.text, link.href);
    }
  });

  let matchCount = 0;
  let mismatchCount = 0;
  let missingInProd = 0;
  let newInProd = 0;

  for (const [text, qaHref] of qaMap) {
    if (prodMap.has(text)) {
      if (qaHref === prodMap.get(text)) {
        matchCount += 1;
      } else {
        mismatchCount += 1;
      }
    } else {
      missingInProd += 1;
    }
  }

  for (const [text] of prodMap) {
    if (!qaMap.has(text)) {
      newInProd += 1;
    }
  }

  const totalComparable = matchCount + mismatchCount + missingInProd;
  const matchPercentage = totalComparable > 0 ? Math.round((matchCount / totalComparable) * 100) : 100;

  return {
    status: mismatchCount === 0 && missingInProd === 0 ? 'pass' : 'fail',
    matchCount,
    mismatchCount,
    missingInProd,
    newInProd,
    matchPercentage,
    totalQaLinks: qaMap.size,
    totalProdLinks: prodMap.size
  };
}

function countBrokenLinks(...validationGroups) {
  return validationGroups.flat().filter((item) => item && !item.ok).length;
}

function printFinalSummary(results, reportsDir) {
  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  const blocked = results.filter((item) => item.status === 'BLOCKED').length;
  const errors = results.filter((item) => item.status === 'ERROR').length;

  logger.section('FINAL SUMMARY');
  logger.info('SUMMARY', `States Tested: ${results.length}`);
  logger.info('SUMMARY', `Passed: ${passed}  |  Failed: ${failed}  |  Blocked: ${blocked}  |  Errors: ${errors}`);
  logger.info('SUMMARY', `Reports Directory: ${reportsDir}`);

  results.forEach((item) => {
    const icon = item.status === 'PASS' ? 'PASS'
      : item.status === 'FAIL' ? 'FAIL'
      : item.status === 'BLOCKED' ? 'BLOCKED'
      : 'ERROR';

    const healthLabel = item.comparison?.healthScore != null ? ` (health: ${item.comparison.healthScore}%)` : '';
    logger.info('SUMMARY', `[${icon}] ${item.state}: ${item.status}${healthLabel}`);
    if (item.reportFile) {
      logger.info('SUMMARY', `  Report: ${path.basename(item.reportFile)}`);
    }
  });

  logger.section('Multi-State Testing Complete!');
}

module.exports = {
  sanitizeFileName,
  normalizeUrlForComparison,
  filterOutMainUrl,
  isEnvironmentBlocked,
  compareLinkMappings,
  countBrokenLinks,
  printFinalSummary
};