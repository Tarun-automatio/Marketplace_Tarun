/**
 * Popup & Modal Methods (mixin for PageCapture.prototype)
 *
 * Handles detection, capture, validation, and dismissal of popups/modals/overlays.
 * Includes: Passport member prompt, Yes/No popup validation, generic modal dismissal,
 * and nuclear popup cleanup.
 *
 * Methods access `this.page`, `this.popupText`, `this.skipPassportDismissal`
 * via the PageCapture instance.
 */

const {
  MODAL_CONTAINER_SELECTORS,
  INNER_MODAL_SELECTORS,
  YES_NO_REGEX,
  YES_REGEX,
  NO_REGEX,
} = require('./selectors');
const frameworkConfig = require('../config/framework.config');
const logger = require('../utils/logger');
const { waitForDomStable } = require('../utils/asyncHelpers');

module.exports = {
  buildPassportMemberPromptRegex() {
    return /Are you already a Passport by Molina Healthcare member\??|¿?Ya es miembro de Passport by Molina Healthcare\??/i;
  },

  async tryDismissPassportMemberPromptInContext(context, contextLabel) {
    const promptRegex = this.buildPassportMemberPromptRegex();
    const promptVisible = await context.getByText(promptRegex).first().isVisible().catch(() => false);
    if (!promptVisible) {
      return false;
    }

    // Capture popup content before dismissing
    if (!this.popupText) {
      try {
        const popupContent = await this.page.evaluate((innerSelectors) => {
          const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();

          for (const sel of innerSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
              return normalize(el.innerText);
            }
          }

          const yesNoRegex = /^(yes|no|sí|si)$/i;
          const btn = Array.from(document.querySelectorAll('button, a, [role="button"], label'))
            .find((b) => b.offsetWidth > 0 && b.offsetHeight > 0 && yesNoRegex.test(normalize(b.innerText || '')));
          if (btn) {
            const container = btn.closest('.modal, .modal-content, .modal-body, [role="dialog"], .modalconent, .modalcontent, .popup, .overlay, .dialog') || btn.parentElement;
            return container ? normalize(container.innerText) : '';
          }
          return '';
        }, INNER_MODAL_SELECTORS);
        if (popupContent) {
          this.popupText = popupContent;
          logger.info('POPUP', `Captured popup content (${popupContent.length} chars) in ${contextLabel}`);
        }
      } catch { /* ignore capture errors */ }
    }

    const noCandidates = this._buildButtonCandidates(context, NO_REGEX, true);
    const clicked = await this._clickFirstVisible(noCandidates);
    if (clicked) {
      logger.info('POPUP', `Clicked No on Passport membership prompt in ${contextLabel}`);
    }
    return clicked;
  },

  async dismissPassportMemberPromptIfPresent() {
    if (this.skipPassportDismissal) return;
    await this._tryInMainAndFrames(async (context, label) => {
      return this.tryDismissPassportMemberPromptInContext(context, label);
    });
  },

  async validatePopupYesNo(url, timeout, waitAfterNetworkIdleMs) {
    const result = {
      detected: false,
      popupText: '',
      buttons: [],
      yesClick: { clicked: false, redirectUrl: '', pageTitle: '', pageContent: null, openedNewTab: false },
      noClick: { clicked: false, redirectUrl: '', pageTitle: '', pageContent: null },
    };

    await waitForDomStable(this.page);

    const popupInfo = await this.page.evaluate((containerSelectors) => {
      const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
      const yesNoRegex = /^(yes|no|sí|si)$/i;

      let container = null;
      for (const sel of containerSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
          const btns = Array.from(el.querySelectorAll('button, a, [role="button"], label, input[type="button"], input[type="submit"]'))
            .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0)
            .map((b) => normalize(b.innerText || b.value || b.getAttribute('aria-label') || ''))
            .filter(Boolean);
          const hasYesNo = btns.some((b) => yesNoRegex.test(b));
          if (hasYesNo) {
            container = el;
            break;
          }
        }
      }

      if (!container) {
        const allBtns = Array.from(document.querySelectorAll('button, a, [role="button"], label'))
          .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0 && yesNoRegex.test(normalize(b.innerText || '')));
        if (allBtns.length > 0) {
          const btn = allBtns[0];
          container = btn.closest('.modal, .modal-content, .modal-body, [role="dialog"], .modalconent, .modalcontent, .popup, .overlay, .dialog') || btn.parentElement;
        }
      }

      if (!container) return { detected: false, text: '', buttons: [] };

      const text = normalize(container.innerText);
      const buttons = Array.from(container.querySelectorAll('button, a, [role="button"], label, input[type="button"], input[type="submit"]'))
        .filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0)
        .map((el) => normalize(el.innerText || el.value || el.getAttribute('aria-label') || ''))
        .filter(Boolean);

      return { detected: true, text, buttons };
    }, MODAL_CONTAINER_SELECTORS);

    if (!popupInfo.detected) {
      logger.info('POPUP_VALIDATE', 'No popup with Yes/No buttons detected on this page');
      return result;
    }

    result.detected = true;
    result.popupText = popupInfo.text;
    result.buttons = popupInfo.buttons;
    logger.info('POPUP_VALIDATE', `Popup detected — text: ${popupInfo.text.substring(0, 150)}${popupInfo.text.length > 150 ? '...' : ''}`);
    logger.info('POPUP_VALIDATE', `Popup buttons: [${popupInfo.buttons.join(', ')}]`);

    // ── Click "Yes" / "Sí" ──
    const yesCandidates = this._buildButtonCandidates(this.page, YES_REGEX, true);
    let newPagePromise = null;

    for (const candidate of yesCandidates) {
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) continue;

      logger.info('POPUP_VALIDATE', 'Clicking "Yes/Sí" on Passport membership prompt');
      const context = this.page.context();
      newPagePromise = context.waitForEvent('page', { timeout: frameworkConfig.elementInteractionTimeoutMs }).catch(() => null);
      await candidate.click({ timeout: frameworkConfig.elementInteractionTimeoutMs }).catch(() => null);
      result.yesClick.clicked = true;
      break;
    }

    if (result.yesClick.clicked) {
      const newTabPage = await newPagePromise;

      if (newTabPage) {
        logger.info('POPUP_VALIDATE', 'Yes click opened a new tab — capturing content from new tab');
        try { await newTabPage.waitForLoadState('domcontentloaded', { timeout: frameworkConfig.networkIdleWaitMs }); } catch { /* continue */ }
        try { await newTabPage.waitForLoadState('networkidle', { timeout: frameworkConfig.networkIdleWaitMs }); } catch { /* continue */ }
        result.yesClick.redirectUrl = newTabPage.url();
        result.yesClick.pageTitle = await newTabPage.title().catch(() => '');
        result.yesClick.pageContent = await this._capturePageContentSummary(newTabPage);
        result.yesClick.openedNewTab = true;
        logger.info('POPUP_VALIDATE', `After Yes (new tab) — URL: ${result.yesClick.redirectUrl}`);
        logger.info('POPUP_VALIDATE', `After Yes (new tab) — Title: ${result.yesClick.pageTitle}`);
        logger.info('POPUP_VALIDATE', `After Yes (new tab) — Headings: ${result.yesClick.pageContent.headings.length}, Links: ${result.yesClick.pageContent.links.length}, Images: ${result.yesClick.pageContent.images.length}`);
        logger.info('POPUP_VALIDATE', `After Yes (new tab) — Body text (first 120 chars): ${result.yesClick.pageContent.visibleText.substring(0, 120)}...`);
        await newTabPage.close().catch(() => {});
      } else {
        logger.info('POPUP_VALIDATE', 'Yes click stayed on same page — capturing content');
        await waitForDomStable(this.page, { stableMs: frameworkConfig.animationSettleMs, timeoutMs: frameworkConfig.domStableTimeoutMs });
        try { await this.page.waitForLoadState('networkidle', { timeout: frameworkConfig.elementInteractionTimeoutMs }); } catch { /* continue */ }
        result.yesClick.redirectUrl = this.page.url();
        result.yesClick.pageTitle = await this.page.title().catch(() => '');
        result.yesClick.pageContent = await this._capturePageContentSummary();
        result.yesClick.openedNewTab = false;
        logger.info('POPUP_VALIDATE', `After Yes — URL: ${result.yesClick.redirectUrl}`);
        logger.info('POPUP_VALIDATE', `After Yes — Title: ${result.yesClick.pageTitle}`);
        logger.info('POPUP_VALIDATE', `After Yes — Headings: ${result.yesClick.pageContent.headings.length}, Links: ${result.yesClick.pageContent.links.length}, Images: ${result.yesClick.pageContent.images.length}`);
        logger.info('POPUP_VALIDATE', `After Yes — Body text (first 120 chars): ${result.yesClick.pageContent.visibleText.substring(0, 120)}...`);
      }
    }

    // ── Reload and click "No" ──
    logger.info('POPUP_VALIDATE', 'Reloading page to click "No"');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    try { await this.page.waitForLoadState('networkidle', { timeout: frameworkConfig.networkIdleWaitMs }); } catch { /* continue */ }
    await this.acceptCookiesIfPresent();
    await waitForDomStable(this.page);

    const popupReappeared = await this.page.evaluate(() => {
      const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
      const yesNoRegex = /^(yes|no|sí|si)$/i;
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"], label'))
        .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0 && yesNoRegex.test(normalize(b.innerText || '')));
      return btns.length > 0;
    }).catch(() => false);

    if (popupReappeared) {
      const noCandidates = this._buildButtonCandidates(this.page, NO_REGEX, true);

      for (const candidate of noCandidates) {
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        logger.info('POPUP_VALIDATE', 'Clicking "No" on Passport membership prompt');
        await candidate.click({ timeout: frameworkConfig.elementInteractionTimeoutMs }).catch(() => null);
        result.noClick.clicked = true;
        break;
      }

      if (result.noClick.clicked) {
        await waitForDomStable(this.page, { stableMs: frameworkConfig.animationSettleMs, timeoutMs: frameworkConfig.domStableTimeoutMs });
        try { await this.page.waitForLoadState('networkidle', { timeout: frameworkConfig.elementInteractionTimeoutMs }); } catch { /* continue */ }
        result.noClick.redirectUrl = this.page.url();
        result.noClick.pageTitle = await this.page.title().catch(() => '');
        result.noClick.pageContent = await this._capturePageContentSummary();
        logger.info('POPUP_VALIDATE', `After No — URL: ${result.noClick.redirectUrl}`);
        logger.info('POPUP_VALIDATE', `After No — Title: ${result.noClick.pageTitle}`);
        logger.info('POPUP_VALIDATE', `After No — Headings: ${result.noClick.pageContent.headings.length}, Links: ${result.noClick.pageContent.links.length}, Images: ${result.noClick.pageContent.images.length}`);
        logger.info('POPUP_VALIDATE', `After No — Body text (first 120 chars): ${result.noClick.pageContent.visibleText.substring(0, 120)}...`);
      }
    } else {
      logger.warn('POPUP_VALIDATE', 'Popup did not reappear after reload — skipping No click');
    }

    this.popupText = result.popupText;
    return result;
  },

  async _capturePageContentSummary(targetPage) {
    const pg = targetPage || this.page;
    return pg.evaluate(() => {
      const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        return el.getClientRects().length > 0;
      };

      const visibleText = normalize(document.body ? document.body.innerText : '');

      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter(isVisible)
        .map((h) => ({ level: parseInt(h.tagName.charAt(1), 10), text: normalize(h.innerText) }));

      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(isVisible)
        .map((a) => {
          let text = normalize(a.innerText);
          if (!text) text = normalize(a.getAttribute('aria-label') || '');
          if (!text) text = normalize(a.getAttribute('title') || '');
          return { text: text || '', href: a.href };
        })
        .filter((l) => l.href);

      const images = Array.from(document.querySelectorAll('img'))
        .filter(isVisible)
        .map((img) => ({
          src: img.src || '',
          alt: normalize(img.alt),
          isBroken: !img.complete || img.naturalWidth === 0
        }));

      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
        .filter(isVisible)
        .map((el) => normalize(el.innerText || el.value || el.getAttribute('aria-label') || ''))
        .filter(Boolean);

      const navItems = Array.from(document.querySelectorAll('nav a, [role="navigation"] a'))
        .filter(isVisible)
        .map((a) => ({ text: normalize(a.innerText), href: a.href }));

      const metaDescription = (() => {
        const el = document.querySelector('meta[name="description"]');
        return el ? (el.getAttribute('content') || '').trim() : '';
      })();

      return { visibleText, headings, links, images, buttons, navItems, metaDescription };
    }).catch(() => ({
      visibleText: '', headings: [], links: [], images: [], buttons: [], navItems: [], metaDescription: ''
    }));
  },

  async dismissAllPopups() {
    await Promise.all([
      this.acceptCookiesIfPresent(),
      this.dismissPassportMemberPromptIfPresent()
    ]);

    const dismissed = await this.page.evaluate(() => {
      let count = 0;

      const closeSelectors = [
        '.modal .close', '.modal [aria-label="Close"]', '.modal .btn-close',
        '.modal-header button', '[role="dialog"] button[aria-label="Close"]',
        '[role="dialog"] .close', '.overlay .close', '.popup .close',
        '[class*="modal"] [class*="close"]', '[class*="popup"] [class*="close"]',
        '[class*="overlay"] [class*="close"]',
      ];
      for (const sel of closeSelectors) {
        document.querySelectorAll(sel).forEach((btn) => {
          if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
            try { btn.click(); count++; } catch { /* ignore */ }
          }
        });
      }

      const contactBtnSelectors = [
        'button.btn-activate', '.btn-activate',
        'button.contact-btn', '.contact-btn',
        '#contactBtn', '#contact-button',
        '[class*="contact-trigger"]', '[class*="contact-widget"]',
        '[class*="FloatingButton"]',
      ];
      for (const sel of contactBtnSelectors) {
        document.querySelectorAll(sel).forEach((btn) => {
          if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
            const parent = btn.closest('[class*="contact"], [class*="Contact"], [class*="floating"], [class*="Floating"]') || btn.parentElement;
            if (parent) {
              const panel = parent.querySelector('[class*="content"], [class*="panel"], [class*="flyout"], [class*="body"], [class*="detail"]');
              if (panel && panel.offsetWidth > 0 && panel.offsetHeight > 0) {
                try { btn.click(); count++; } catch { /* ignore */ }
              }
            }
          }
        });
      }

      const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
      document.querySelectorAll('button, a, div, [role="button"]').forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' || el.offsetWidth === 0) return;
        const text = normalize(el.innerText || el.getAttribute('aria-label') || '');
        if (!/^\s*contact(\s+us)?\s*$/i.test(text)) return;
        const parent = el.parentElement;
        if (parent) {
          const panel = parent.querySelector('[class*="content"], [class*="panel"], [class*="flyout"], [class*="body"]');
          if (panel && panel.offsetWidth > 0 && panel.offsetHeight > 0) {
            try { el.click(); count++; } catch { /* ignore */ }
          }
        }
      });

      document.querySelectorAll('div, section, aside, [role="dialog"]').forEach((el) => {
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
        if (el.closest('header, footer, nav, [role="banner"], [role="contentinfo"], [role="navigation"]')) return;
        const tag = el.tagName.toLowerCase();
        if (tag === 'header' || tag === 'footer' || tag === 'nav') return;
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') return;
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (/to learn more|call \(\d{3}\)|TTY\s*7/i.test(text)) {
          const closeBtn = el.querySelector('button, [aria-label="Close"], [class*="close"], .close');
          if (closeBtn) {
            try { closeBtn.click(); count++; } catch { /* ignore */ }
          }
          el.style.display = 'none';
          count++;
        }
      });

      document.querySelectorAll(
        '.modal-backdrop, .modal.show, .modal[style*="display: block"], ' +
        '[role="dialog"], [class*="overlay"][class*="visible"], ' +
        '[class*="popup"][style*="display: block"]'
      ).forEach((el) => {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          el.style.display = 'none';
          count++;
        }
      });

      const chatWidgetCloseSelectors = [
        '[class*="intercom"] [aria-label="Close"]',
        '[class*="intercom"] button[class*="close"]',
        '[id*="drift"] [aria-label="Close"]',
        '[id*="drift"] button[class*="close"]',
        '#hubspot-messages-iframe-container [aria-label="Close"]',
        '[class*="livechat"] [aria-label="Close"]',
        '[class*="zendesk"] [aria-label="Close"]',
        '#tidio-chat [aria-label="Close"]',
        '[class*="chat-widget"] [aria-label="Close"]',
        '[class*="chat-widget"] button[class*="close"]',
        '[class*="chatWidget"] button[class*="close"]',
      ];
      for (const sel of chatWidgetCloseSelectors) {
        document.querySelectorAll(sel).forEach((btn) => {
          if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
            try { btn.click(); count++; } catch { /* ignore */ }
          }
        });
      }

      return count;
    }).catch(() => 0);

    if (dismissed > 0) {
      await waitForDomStable(this.page, { stableMs: 200, timeoutMs: 2000 });
      logger.info('POPUP', `Dismissed ${dismissed} popup/modal element(s) before snapshot`);
    }
  },

  async nukeAllPopups() {
    const removed = await this.page.evaluate(() => {
      const yesNo = /^(yes|no|s[ií]|si)$/i;
      let removedCount = 0;

      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], label'));
      const modalRoots = new Set();
      for (const btn of buttons) {
        const text = (btn.innerText || '').replace(/\s+/g, ' ').trim();
        if (!yesNo.test(text)) continue;
        let container = btn;
        let candidate = btn.parentElement;
        while (candidate && candidate !== document.body && candidate !== document.documentElement) {
          const cs = getComputedStyle(candidate);
          const isOverlay = cs.position === 'fixed' || cs.position === 'absolute' ||
            cs.zIndex > 100 ||
            candidate.classList.toString().match(/modal|popup|overlay|dialog/i) ||
            candidate.getAttribute('role') === 'dialog';
          if (isOverlay) container = candidate;
          candidate = candidate.parentElement;
        }
        modalRoots.add(container);
      }
      for (const el of modalRoots) {
        el.remove();
        removedCount++;
      }

      const overlaySelectors = [
        '.modal-backdrop', '.overlay-backdrop', '[class*="backdrop"]',
        '.modal.show', '.modal[style*="display: block"]', '.modal[style*="display:block"]',
        '[role="dialog"]', '[role="alertdialog"]',
        '.modalconent', '.modalcontent',
        '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#cookie-banner',
        '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="consent-banner"]',
      ];
      for (const sel of overlaySelectors) {
        document.querySelectorAll(sel).forEach(el => { el.remove(); removedCount++; });
      }

      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      document.body.classList.remove('modal-open');
      document.documentElement.style.overflow = '';

      if (!window.__popupKillerInstalled__) {
        window.__popupKillerInstalled__ = true;
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;
              const nodeText = (node.innerText || '').replace(/\s+/g, ' ').trim();
              const isModal = node.matches('[role="dialog"], .modal, [class*="modal"], [class*="popup"], [class*="overlay"], [class*="backdrop"]') ||
                /^(yes|no|s[ií]|si)$/im.test(nodeText);
              if (isModal) {
                node.remove();
              }
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }

      return removedCount;
    }).catch(() => 0);

    if (removed > 0) {
      logger.info('POPUP_NUKE', `Removed ${removed} popup/overlay element(s) from DOM`);
    }
  },
};
