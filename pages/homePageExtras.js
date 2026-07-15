/**
 * Home Page Extras — Standalone (non-mixin) helpers that historically lived
 * in pages/HomePage.js.
 *
 * These functions are NOT used by the Plan Materials ANOC test but are kept
 * in the framework so QA vs PROD comparison tests can reuse them:
 *
 *   • captureContactContent(page)  — clicks the floating contact widget and
 *                                    extracts panel text / links / phones / emails
 *   • captureCarouselCards(page)   — cycles a Bootstrap / Slick / Owl / Swiper
 *                                    carousel, capturing each slide's content
 *
 * Kept as pure functions (not attached to PageCapture) to make them easy to
 * unit-test and reuse against any Playwright `page` handle.
 */

const logger = require('../utils/logger');
const { waitForDomStable } = require('../utils/asyncHelpers');
const frameworkConfig = require('../config/framework.config');

/**
 * Find and click a floating contact button, capture the flyout/panel content.
 */
async function captureContactContent(page) {
  const empty = { found: false, text: '', links: [], phoneNumbers: [], emails: [] };

  const btnSelectors = [
    'button.btn-activate', '.btn-activate',
    'button.contact-btn', '.contact-btn',
    '#contactBtn', '#contact-button',
    '[class*="contact-trigger"]', '[class*="contact-widget"]',
    '[class*="FloatingButton"]', '[class*="floating-button"]',
    '[class*="contact"] button', '[class*="Contact"] button',
    'a[class*="contact-trigger"]',
  ];

  let clicked = false;
  for (const sel of btnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click({ timeout: frameworkConfig.elementProbeTimeoutMs });
        clicked = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!clicked) return empty;

  await waitForDomStable(page, { stableMs: 300, timeoutMs: 3000 });

  const content = await page.evaluate(() => {
    const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();

    const panelSelectors = [
      '[class*="contact"][class*="content"]', '[class*="contact"][class*="panel"]',
      '[class*="contact"][class*="flyout"]', '[class*="Contact"][class*="Content"]',
      '[class*="Contact"][class*="Panel"]', '[class*="floating"][class*="content"]',
      '[class*="Floating"][class*="Content"]', '[class*="contact"][class*="body"]',
      '[class*="contact"][class*="detail"]', '[class*="contact-popup"]',
      '[class*="contactPopup"]',
    ];

    let panel = null;
    for (const sel of panelSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0 && normalize(el.innerText).length > 5) {
          panel = el;
          break;
        }
      }
      if (panel) break;
    }

    if (!panel) {
      const btnSelectors = [
        'button.btn-activate', '.btn-activate', 'button.contact-btn',
        '.contact-btn', '#contactBtn', '#contact-button', '[class*="FloatingButton"]',
      ];
      for (const sel of btnSelectors) {
        const btn = document.querySelector(sel);
        if (!btn) continue;
        const parent = btn.closest('[class*="contact"], [class*="Contact"], [class*="floating"], [class*="Floating"]') || btn.parentElement;
        if (parent) {
          const child = parent.querySelector('[class*="content"], [class*="panel"], [class*="flyout"], [class*="body"], [class*="detail"]');
          if (child && child.offsetWidth > 0 && child.offsetHeight > 0 && normalize(child.innerText).length > 5) {
            panel = child;
            break;
          }
          if (normalize(parent.innerText).length > 20) {
            panel = parent;
            break;
          }
        }
      }
    }

    if (!panel) return { found: false, text: '', links: [], phoneNumbers: [], emails: [] };

    const text = normalize(panel.innerText);
    const links = Array.from(panel.querySelectorAll('a[href]'))
      .filter((a) => a.offsetWidth > 0 || a.offsetHeight > 0)
      .map((a) => ({ text: normalize(a.innerText), href: a.href }));

    const phoneRegex = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    const phoneNumbers = [...new Set((text.match(phoneRegex) || []).map((p) => p.replace(/\D/g, '')))];

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = [...new Set(text.match(emailRegex) || [])];

    return { found: true, text, links, phoneNumbers, emails };
  });

  return content;
}

/**
 * Capture all carousel/slider card texts by clicking the "next" arrow
 * until the carousel wraps back to the first slide.
 */
async function captureCarouselCards(page, options = {}) {
  const maxClicks = options.maxClicks || 50;
  const settleMs = options.settleMs || 600;
  const budgetMs = options.budgetMs || 60000;
  const deadline = Date.now() + budgetMs;

  const nextBtnInfo = await page.evaluate(() => {
    const selectors = [
      'a.carousel-control-next', 'button.carousel-control-next',
      '[data-slide="next"]', '[data-bs-slide="next"]',
      '.slick-next', '.owl-next', '.swiper-button-next',
      '.flickity-button.next', '.splide__arrow--next',
      '[class*="carousel"] [class*="next"]', '[class*="slider"] [class*="next"]',
      '[aria-label*="Next" i]', '[aria-label*="next slide" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) return { found: true, selector: sel };
    }
    return { found: false };
  });

  if (!nextBtnInfo.found) {
    logger.info('CAROUSEL', 'No carousel next button found — skipping');
    return [];
  }

  logger.info('CAROUSEL', `Next button found via: ${nextBtnInfo.selector}`);

  function getVisibleCards() {
    return page.evaluate(() => {
      const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
      const containerSelectors = [
        '.carousel-inner', '.slick-track', '.owl-stage', '.swiper-wrapper',
        '.flickity-slider', '.splide__list', '[class*="carousel"]', '[class*="slider"]',
      ];
      let container = null;
      for (const sel of containerSelectors) {
        const el = document.querySelector(sel);
        if (el) { container = el; break; }
      }
      if (!container) return [];

      const cardSelectors = [
        '.carousel-item.active .card', '.carousel-item.active [class*="card"]',
        '.carousel-item.active', '.slick-active .card', '.slick-slide.slick-active',
        '.owl-item.active', '.swiper-slide-active', '.swiper-slide-visible',
        '[class*="carousel-item"].active',
      ];
      let cardEls = [];
      for (const sel of cardSelectors) {
        cardEls = Array.from(document.querySelectorAll(sel)).filter(
          (el) => el.offsetWidth > 0 && el.offsetHeight > 0
        );
        if (cardEls.length > 0) break;
      }
      if (cardEls.length === 0) {
        cardEls = Array.from(container.children).filter(
          (el) => el.offsetWidth > 0 && el.offsetHeight > 0 && (normalize(el.innerText).length > 0 || el.querySelector('img'))
        );
      }

      return cardEls.map((card) => {
        const text = normalize(card.innerText);
        const links = Array.from(card.querySelectorAll('a[href]'))
          .filter((a) => a.offsetWidth > 0 && a.offsetHeight > 0)
          .map((a) => ({
            text: normalize(a.innerText || a.getAttribute('aria-label') || ''),
            href: a.href || '',
          }))
          .filter((l) => l.href && /^https?:\/\//i.test(l.href));
        const images = Array.from(card.querySelectorAll('img'))
          .filter((img) => (img.naturalWidth > 0 || img.offsetWidth > 0))
          .map((img) => ({
            src: img.src || '', alt: img.alt || '',
            width: img.naturalWidth || img.offsetWidth || 0,
            height: img.naturalHeight || img.offsetHeight || 0,
          }));
        return { text, links, images };
      });
    });
  }

  const allCards = [];
  const seenTexts = new Set();
  let clicks = 0;
  let duplicateStreak = 0;
  const MAX_DUPLICATE_STREAK = 3;
  const opTimeout = 10000;

  const withTimeout = (promise, ms = opTimeout) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('op timeout')), ms))]);

  function getActiveSlideIndex() {
    return page.evaluate(() => {
      const active = document.querySelector('.carousel-item.active');
      if (!active) return -1;
      const parent = active.parentElement;
      if (!parent) return -1;
      return Array.from(parent.children).indexOf(active);
    });
  }

  async function waitForBootstrapTransition(prevIndex) {
    try {
      await page.waitForFunction(
        (prevIdx) => {
          const active = document.querySelector('.carousel-item.active');
          if (!active) return false;
          const parent = active.parentElement;
          if (!parent) return false;
          const currentIdx = Array.from(parent.children).indexOf(active);
          const transitioning = document.querySelector(
            '.carousel-item-next, .carousel-item-prev, .carousel-item-start, .carousel-item-end, .carousel-item-left, .carousel-item-right'
          );
          return currentIdx !== prevIdx && !transitioning;
        },
        prevIndex,
        { timeout: frameworkConfig.elementProbeTimeoutMs }
      );
    } catch {
      await page.waitForTimeout(settleMs);
    }
  }

  const isBootstrap = await page.evaluate(() => !!document.querySelector('.carousel-inner')).catch(() => false);

  function cardKey(card) {
    if (card.text) return card.text;
    if (card.images && card.images.length) return card.images.map(i => i.src).sort().join('|');
    return '';
  }

  const initialCards = await withTimeout(getVisibleCards()).catch(() => []);
  for (const card of initialCards) {
    const key = cardKey(card);
    if (key && !seenTexts.has(key)) {
      seenTexts.add(key);
      allCards.push({ index: allCards.length + 1, text: card.text, links: card.links, images: card.images || [] });
    }
  }
  logger.info('CAROUSEL', `Initial capture: ${allCards.length} card(s), isBootstrap=${isBootstrap}`);

  while (clicks < maxClicks) {
    if (Date.now() >= deadline) {
      logger.warn('CAROUSEL', `Time budget (${budgetMs}ms) exceeded after ${clicks} click(s) — stopping`);
      break;
    }
    try {
      const prevIndex = isBootstrap ? await getActiveSlideIndex().catch(() => -1) : -1;

      if (isBootstrap) {
        await page.evaluate(() => {
          const carousel = document.querySelector('.carousel');
          if (carousel && typeof window.jQuery !== 'undefined' && window.jQuery(carousel).carousel) {
            window.jQuery(carousel).carousel('next');
          } else if (carousel && typeof bootstrap !== 'undefined' && bootstrap.Carousel) {
            bootstrap.Carousel.getInstance(carousel)?.next() ||
              new bootstrap.Carousel(carousel).next();
          } else {
            const btn = carousel?.querySelector('.carousel-control-next') ||
              document.querySelector('a.carousel-control-next, button.carousel-control-next, [data-slide="next"], [data-bs-slide="next"]');
            if (btn) btn.click();
          }
        });
      } else {
        await page.click(nextBtnInfo.selector, { timeout: opTimeout, force: true });
      }

      if (isBootstrap && prevIndex >= 0) {
        await waitForBootstrapTransition(prevIndex);
      } else {
        await page.waitForTimeout(settleMs);
      }
      clicks++;

      const visibleCards = await withTimeout(getVisibleCards());
      let foundNew = false;
      for (const card of visibleCards) {
        const key = cardKey(card);
        if (key && !seenTexts.has(key)) {
          seenTexts.add(key);
          allCards.push({ index: allCards.length + 1, text: card.text, links: card.links, images: card.images || [] });
          foundNew = true;
        }
      }

      if (foundNew) {
        duplicateStreak = 0;
      } else {
        duplicateStreak++;
        if (duplicateStreak >= MAX_DUPLICATE_STREAK) break;
      }
    } catch {
      clicks++;
      duplicateStreak++;
      if (duplicateStreak >= MAX_DUPLICATE_STREAK) break;
    }
  }

  logger.info('CAROUSEL', `Captured ${allCards.length} unique card(s) after ${clicks} click(s)`);
  return allCards;
}

module.exports = { captureContactContent, captureCarouselCards };
