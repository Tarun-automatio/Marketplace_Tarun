/**
 * Shared CSS selectors, regex patterns, and device configurations
 * used across page capture modules.
 */

const COOKIE_BANNER_SELECTORS = [
  '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#cookie-banner',
  '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="consent-banner"]',
  '[id*="cookie"]', '[aria-label*="cookie" i]', '[role="dialog"]',
];

const MODAL_CONTAINER_SELECTORS = [
  '.modal.show', '.modal[style*="display: block"]', '.modal[style*="display:block"]',
  '[role="dialog"]:not([aria-hidden="true"])', '[role="alertdialog"]',
  '.modalconent', '.modalcontent', '.modal-content', '.modal-body',
  '.popup', '.overlay', '.dialog',
  '[class*="popup"]:not(button)', '[class*="modal"]:not(button)', '[class*="dialog"]:not(button)',
];

const INNER_MODAL_SELECTORS = [
  '.modalconent', '.modalcontent',
  '.modal-content .modal-body', '.modal.show .modal-body',
  '.modal-body', '[role="dialog"] [class*="content"]', '.modal-content',
  '.modal.show', '[role="dialog"]:not([aria-hidden="true"])',
  '.popup', '.overlay', '.dialog',
];

const YES_NO_REGEX = /^(yes|no|sí|si)$/i;
const YES_REGEX = /^\s*(Yes|Sí|Si)\s*$/i;
const NO_REGEX = /^\s*No\s*$/i;

const RESPONSIVE_DEVICES = [
  { name: 'iPhone_SE', width: 375, height: 667 },
  { name: 'iPad_Pro', width: 834, height: 1194 },
];

module.exports = {
  COOKIE_BANNER_SELECTORS,
  MODAL_CONTAINER_SELECTORS,
  INNER_MODAL_SELECTORS,
  YES_NO_REGEX,
  YES_REGEX,
  NO_REGEX,
  RESPONSIVE_DEVICES,
};
