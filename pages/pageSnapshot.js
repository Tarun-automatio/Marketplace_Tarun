/**
 * Page Snapshot Methods (mixin for PageCapture.prototype)
 *
 * Provides `captureSnapshot()` — a large, self-contained page-content scraper
 * used by the QA vs PROD comparison flow. Extracted from HomePage.js so the
 * core class stays focused on navigation, cookies, popups, and screenshots.
 *
 * Not used by the Plan Materials ANOC test, but kept in the framework so
 * comparison tests can reuse it via `new PageCapture(page).captureSnapshot()`.
 *
 * Method accesses `this.page`, `this.cookieBannerText`, `this.popupText`, and
 * `this.performanceMetrics` via the PageCapture instance.
 */

const { waitForDomStable } = require('../utils/asyncHelpers');

module.exports = {
  async captureSnapshot() {
    await this.dismissAllPopups();
    await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await waitForDomStable(this.page, { stableMs: 300, timeoutMs: 2000 });

    const snapshot = await this.page.evaluate(() => {
      const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const preserveTextSpacing = (value) => String(value || '').replace(/\r/g, '');
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return element.getClientRects().length > 0;
      };

      const placeholderTexts = Array.from(document.querySelectorAll('input[placeholder], textarea[placeholder], [aria-placeholder]'))
        .filter((element) => isVisible(element))
        .map((element) => preserveTextSpacing(element.getAttribute('placeholder') || element.getAttribute('aria-placeholder') || ''))
        .filter((text) => text.trim().length > 0);

      const visibleText = preserveTextSpacing(document.body ? document.body.innerText : '');

      // Build comparisonText excluding carousel slides and accordion body panels
      const hideForComparison = [];
      [
        '.owl-stage', '.carousel-inner', '.swiper-wrapper', '.slick-track',
        '.flickity-slider', '.splide__list',
        '.owl-nav', '.carousel-control-prev', '.carousel-control-next',
        '.slick-arrow', '.swiper-button-prev', '.swiper-button-next',
        '.flickity-button', '.splide__arrow',
        '.accordion-collapse', '.accordion-content', '.panel-collapse',
        '[class*="MuiCollapse"]',
      ].forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          hideForComparison.push({ el: el, prev: el.style.display });
          el.style.display = 'none';
        });
      });
      document.querySelectorAll('button').forEach(function (btn) {
        const cls = typeof btn.className === 'string' ? btn.className.toLowerCase() : '';
        if (!cls.includes('accordion')) return;
        const sib = btn.nextElementSibling;
        if (sib && hideForComparison.every(function (h) { return h.el !== sib; })) {
          const sc = typeof sib.className === 'string' ? sib.className.toLowerCase() : '';
          if (sc.includes('content') || sc.includes('collapse') || sc.includes('body') || sc.includes('panel') || sc.includes('accordion')) {
            hideForComparison.push({ el: sib, prev: sib.style.display });
            sib.style.display = 'none';
          }
        }
      });
      const coreText = preserveTextSpacing(document.body ? document.body.innerText : '');
      hideForComparison.forEach(function (h) { h.el.style.display = h.prev; });

      const comparisonText = preserveTextSpacing([coreText, ...placeholderTexts].filter(Boolean).join('\n'));
      const title = normalizeText(document.title);

      const getLinkLocation = (a) => {
        const hasImg = !!a.querySelector('img');
        let el = a;
        let region = null;
        let component = null;
        while (el && el !== document.body && el !== document.documentElement) {
          const tag = (el.tagName || '').toLowerCase();
          const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
          const role = (el.getAttribute ? (el.getAttribute('role') || '') : '').toLowerCase();
          if (!region) {
            if (tag === 'header' || role === 'banner') region = 'Header';
            else if (tag === 'footer' || role === 'contentinfo') region = 'Footer';
          }
          if (cls.includes('accordion') || cls.includes('collapsible') || cls.includes('integration-list') || cls.includes('detailing') || tag === 'details') {
            component = 'Accordion';
          } else if (cls.includes('carousel') || cls.includes('slider') || cls.includes('swiper') || cls.includes('owl-') || cls.includes('slick-')) {
            if (component !== 'Accordion') component = 'Carousel';
          } else if (!component) {
            if ((cls.includes('card') && !cls.includes('discard')) || cls.includes('card-deck') || cls.includes('card-group')) component = 'Card';
            else if (tag === 'nav' || role === 'navigation') component = 'Navigation';
          }
          if (region && component === 'Accordion') break;
          el = el.parentElement;
        }
        if (region) return region;
        if (component) return component;
        if (hasImg) return 'Image';
        return 'Body';
      };

      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => isVisible(a))
        .map((a) => {
          const text = normalizeText(a.innerText);
          return { text: text || '', href: a.href, rawHref: a.getAttribute('href') || '', location: getLinkLocation(a) };
        })
        .filter((link) => link.href);

      const images = Array.from(document.querySelectorAll('img'))
        .filter((img) => isVisible(img))
        .map((img) => ({
          src: img.src || '',
          alt: normalizeText(img.alt),
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          isBroken: !img.complete || img.naturalWidth === 0
        }));

      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
        .filter((el) => isVisible(el))
        .map((el) => normalizeText(el.innerText || el.value || el.getAttribute('aria-label') || ''))
        .filter(Boolean);

      const formFields = Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((el) => isVisible(el) && el.type !== 'hidden')
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          label: normalizeText(
            (el.labels && el.labels[0] ? el.labels[0].innerText : '') ||
            el.getAttribute('aria-label') || el.placeholder || ''
          )
        }));

      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter((h) => isVisible(h))
        .map((h) => ({
          level: parseInt(h.tagName.charAt(1), 10),
          text: normalizeText(h.innerText)
        }));

      const metaDesc = (() => {
        const el = document.querySelector('meta[name="description"]');
        return el ? (el.getAttribute('content') || '').trim() : '';
      })();

      const canonicalUrl = (() => {
        const el = document.querySelector('link[rel="canonical"]');
        return el ? (el.getAttribute('href') || '').trim() : '';
      })();

      const ogTags = {};
      document.querySelectorAll('meta[property^="og:"]').forEach((el) => {
        const prop = el.getAttribute('property');
        ogTags[prop] = (el.getAttribute('content') || '').trim();
      });

      const htmlLang = (document.documentElement.getAttribute('lang') || '').trim();

      const navItems = Array.from(document.querySelectorAll('nav a, [role="navigation"] a'))
        .filter((a) => isVisible(a))
        .map((a) => ({ text: normalizeText(a.innerText), href: a.href }));

      const headerText = (() => {
        const headerEl = document.querySelector('header, [role="banner"]');
        if (!headerEl) return '';
        return preserveTextSpacing(headerEl.innerText || '');
      })();

      const footerText = (() => {
        const footerEl = document.querySelector('footer, [role="contentinfo"]');
        if (!footerEl) return '';
        return preserveTextSpacing(footerEl.innerText || '');
      })();

      return {
        title, metaDescription: metaDesc, canonicalUrl, ogTags, htmlLang,
        visibleText, placeholderTexts, comparisonText,
        headerText, footerText,
        links, images, buttons, formFields, headings, navItems
      };
    });
    snapshot.cookieBannerText = this.cookieBannerText || '';
    snapshot.popupText = this.popupText || '';
    snapshot.performanceMetrics = this.performanceMetrics || null;
    return snapshot;
  },
};
