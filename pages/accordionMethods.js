/**
 * Accordion Methods (mixin for PageCapture.prototype)
 *
 * Handles expanding, collapsing, and capturing content from accordion/collapsible sections.
 * Supports Bootstrap 3/4/5, CSS-modules (React/Next.js), <details>/<summary>,
 * Material UI, Foundation, FAQ patterns, and generic collapse/expandable.
 *
 * Methods access `this.page` via the PageCapture instance.
 */

const frameworkConfig = require('../config/framework.config');
const logger = require('../utils/logger');
const { waitForDomStable } = require('../utils/asyncHelpers');

module.exports = {
  async expandAllCollapsibles() {
    const hasCollapsibles = await this.page.evaluate(() => {
      const hasCssModAccordionBtn = Array.from(document.querySelectorAll('button')).some(btn => {
        const cls = typeof btn.className === 'string' ? btn.className : '';
        return /accordion/i.test(cls);
      });
      return !!(
        hasCssModAccordionBtn ||
        document.querySelector('details:not([open])') ||
        document.querySelector('[aria-expanded="false"]') ||
        document.querySelector('.accordion-button.collapsed') ||
        document.querySelector('[data-toggle="collapse"]') ||
        document.querySelector('[data-bs-toggle="collapse"]') ||
        document.querySelector('.accordion a[title="open"]') ||
        document.querySelector('[class*="accordion"]:not(button):not(script)') ||
        document.querySelector('[class*="faq"]:not(button):not(script)') ||
        document.querySelector('[class*="collapsible"]:not(button):not(script)') ||
        document.querySelector('[class*="expandable"]:not(button):not(script)') ||
        document.querySelector('.collapse:not(.show):not(.navbar-collapse)')
      );
    }).catch(() => false);
    if (!hasCollapsibles) {
      logger.info('EXPAND', `${this.page.url().substring(0, 60)} — no collapsible elements found, skipping`);
      return;
    }

    let totalExpanded = 0;

    for (let pass = 0; pass < 3; pass++) {
      let expanded;
      try {
        expanded = await this.page.evaluate(() => {
        let count = 0;

        function safeClick(el) {
          if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#') && el.getAttribute('href') !== 'javascript:void(0)') {
            return false;
          }
          try {
            const handler = (e) => e.preventDefault();
            el.addEventListener('click', handler, { once: true, capture: true });
            el.click();
            return true;
          } catch { return false; }
        }

        // 1. Open all <details> elements
        document.querySelectorAll('details:not([open])').forEach((el) => {
          el.setAttribute('open', '');
          count++;
        });

        // 2. Click ALL elements with aria-expanded="false"
        document.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
          if (safeClick(el)) count++;
        });

        // 3. Click all accordion buttons (Bootstrap 4/5, custom)
        document.querySelectorAll(
          '.accordion-button.collapsed, ' +
          '.accordion-header button:not([aria-expanded="true"]), ' +
          '.accordion-toggle:not(.active), ' +
          '[data-toggle="collapse"]:not(.active):not([aria-expanded="true"]), ' +
          '[data-bs-toggle="collapse"]:not([aria-expanded="true"]), ' +
          '.panel-heading.collapsed, .panel-title a.collapsed, ' +
          '.expandable:not(.expanded), ' +
          '.collapsible-header:not(.active), ' +
          '[role="tab"][aria-selected="false"], ' +
          '.faq-question:not(.active), .faq-toggle:not(.active), ' +
          '.toggle-header:not(.active), .toggle-trigger:not(.open)'
        ).forEach((el) => {
          if (safeClick(el)) count++;
        });

        // 4. Click toggle icons / "show more" / "expand" buttons (skip <a> to avoid navigation)
        const expandKeywords = /^(show more|read more|view more|see more|see all|expand|expand all|\+|▶|►|▾|⯈|more info|learn more)$/i;
        document.querySelectorAll('button, [role="button"], span[class*="toggle"], span[class*="expand"], span[class*="icon"]').forEach((el) => {
          const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
          if (expandKeywords.test(text)) {
            if (safeClick(el)) count++;
          }
        });

        // 4b. CSS-module React accordion buttons (className contains "accordion")
        document.querySelectorAll('button').forEach((btn) => {
          const cls = btn.className || '';
          if (typeof cls !== 'string' || !cls.toLowerCase().includes('accordion')) return;
          if (btn.hasAttribute('aria-expanded')) return;
          if (/\bopen\b/i.test(cls)) return;
          const sib = btn.nextElementSibling;
          if (!sib) {
            if (safeClick(btn)) count++;
          } else {
            const sc = (typeof sib.className === 'string') ? sib.className.toLowerCase() : '';
            if ((sc.includes('content') || sc.includes('collapse') || sc.includes('body') || sc.includes('panel') || sc.includes('accordion')) && sib.offsetHeight === 0) {
              if (safeClick(btn)) count++;
            }
          }
        });

        // 5. CSS :target based accordions — force all content visible
        const hasTargetAccordion = document.querySelector('.accordion a[title="open"], .accordion span.target-fix, .accordion a[id*="open-accordion"]');
        if (hasTargetAccordion) {
          const targetAccordions = document.querySelectorAll('.accordion .accordion-content');
          if (targetAccordions.length > 0 && !document.getElementById('__pw_accordion_override')) {
            const style = document.createElement('style');
            style.id = '__pw_accordion_override';
            style.textContent = '.accordion .accordion-content { display: block !important; max-height: none !important; overflow: visible !important; opacity: 1 !important; visibility: visible !important; height: auto !important; }';
            document.head.appendChild(style);
            count += targetAccordions.length;
          }
        }

        // 6. Generic [class*="accordion"] link toggles
        document.querySelectorAll('[class*="accordion"] a[href^="#"]').forEach((el) => {
          if (el.offsetWidth > 0 && el.offsetHeight > 0 && !el.hasAttribute('aria-expanded')) {
            if (safeClick(el)) count++;
          }
        });

        // 7. Force-show hidden .collapse elements (Bootstrap)
        if (!document.getElementById('__pw_collapse_override')) {
          const hiddenCollapses = document.querySelectorAll('.collapse:not(.show):not(.navbar-collapse):not(.nav-collapse)');
          if (hiddenCollapses.length > 0) {
            hiddenCollapses.forEach((el) => {
              el.classList.add('show');
              el.style.display = '';
              el.style.height = 'auto';
              count++;
            });
          }
        }

        return count;
      });
      } catch (evalError) {
        logger.warn('EXPAND', `Expand pass ${pass + 1} aborted (${evalError.message.substring(0, 80)})`);
        break;
      }

      totalExpanded += expanded;
      if (expanded === 0) break;
      await waitForDomStable(this.page, { stableMs: frameworkConfig.animationSettleMs, timeoutMs: 3000 });
    }

    const pageUrl = this.page.url();
    const label = pageUrl.length > 60 ? pageUrl.substring(0, 60) + '...' : pageUrl;
    logger.info('EXPAND', `${label} — expanded ${totalExpanded} collapsible section(s)`);
  },

  async collapseAllCollapsibles() {
    const hasExpanded = await this.page.evaluate(() => {
      return !!(
        document.querySelector('details[open]') ||
        document.querySelector('[aria-expanded="true"]') ||
        document.querySelector('.accordion-button:not(.collapsed)') ||
        document.querySelector('.accordion-toggle.active') ||
        document.querySelector('[class*="accordion"]:not(button):not(script)') ||
        document.querySelector('[class*="faq"]:not(button):not(script)') ||
        document.querySelector('.collapse.show:not(.navbar-collapse)')
      );
    }).catch(() => false);
    if (!hasExpanded) {
      logger.info('COLLAPSE', `${this.page.url().substring(0, 60)} — no expanded sections found, skipping`);
      return;
    }

    let totalCollapsed = 0;
    try {
      totalCollapsed = await this.page.evaluate(() => {
        let count = 0;

        function safeClick(el) {
          if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#') && el.getAttribute('href') !== 'javascript:void(0)') {
            return false;
          }
          try {
            const handler = (e) => e.preventDefault();
            el.addEventListener('click', handler, { once: true, capture: true });
            el.click();
            return true;
          } catch { return false; }
        }

        document.querySelectorAll('details[open]').forEach((el) => {
          el.removeAttribute('open');
          count++;
        });

        document.querySelectorAll('[aria-expanded="true"]').forEach((el) => {
          if (safeClick(el)) count++;
        });

        document.querySelectorAll(
          '.accordion-button:not(.collapsed), ' +
          '.accordion-toggle.active, ' +
          '.panel-heading:not(.collapsed), .panel-title a:not(.collapsed), ' +
          '.expandable.expanded, ' +
          '.collapsible-header.active, ' +
          '[role="tab"][aria-selected="true"], ' +
          '.faq-question.active, .faq-toggle.active, ' +
          '.toggle-header.active, .toggle-trigger.open'
        ).forEach((el) => {
          if (safeClick(el)) count++;
        });

        document.querySelectorAll('button').forEach((btn) => {
          const cls = typeof btn.className === 'string' ? btn.className.toLowerCase() : '';
          if (!cls.includes('accordion')) return;
          if (btn.hasAttribute('aria-expanded')) return;
          const sib = btn.nextElementSibling;
          if (sib) {
            const sc = typeof sib.className === 'string' ? sib.className.toLowerCase() : '';
            if ((sc.includes('content') || sc.includes('collapse') || sc.includes('body') || sc.includes('panel') || sc.includes('accordion')) && sib.offsetHeight > 0) {
              if (safeClick(btn)) count++;
            }
          }
        });

        const override = document.getElementById('__pw_accordion_override');
        if (override) {
          override.remove();
          count++;
        }

        return count;
      });

      if (totalCollapsed > 0) {
        await waitForDomStable(this.page, { stableMs: frameworkConfig.animationSettleMs, timeoutMs: 3000 });
      }
    } catch (err) {
      logger.warn('COLLAPSE', `Collapse aborted (${err.message.substring(0, 80)})`);
    }

    const pageUrl = this.page.url();
    const shortLabel = pageUrl.length > 60 ? pageUrl.substring(0, 60) + '...' : pageUrl;
    logger.info('COLLAPSE', `${shortLabel} — collapsed ${totalCollapsed} section(s)`);
  },

  async captureAccordionContent() {
    const page = this.page;

    const hasAccordion = await page.evaluate(() => {
      return !!(
        document.querySelector('.accordion-button') ||
        document.querySelector('.accordion-item') ||
        document.querySelector('[data-toggle="collapse"]') ||
        document.querySelector('[data-bs-toggle="collapse"]') ||
        document.querySelector('details > summary') ||
        document.querySelector('.MuiAccordionSummary-root') ||
        document.querySelector('[data-accordion]') ||
        document.querySelector('.faq-item .faq-question') ||
        document.querySelector('.accordion a[title="open"]') ||
        document.querySelector('[class*="accordion"][class*="item"]') ||
        document.querySelector('[class*="accordion"][class*="header"]') ||
        document.querySelector('[class*="accordion"][class*="title"]') ||
        document.querySelector('[class*="faq"][class*="question"]') ||
        document.querySelector('[class*="faq"][class*="header"]') ||
        document.querySelector('[class*="faq"][class*="title"]') ||
        document.querySelector('[class*="collapsible"][class*="header"]') ||
        document.querySelector('[class*="expandable"][class*="header"]') ||
        document.querySelector('.collapse:not(.show):not(.navbar-collapse)') ||
        document.querySelector('[class*="accordion"] [aria-expanded]') ||
        document.querySelector('[class*="accordion"] button') ||
        document.querySelector('[class*="accordion"] a[role="button"]') ||
        Array.from(document.querySelectorAll('button')).some(btn => {
          const cls = typeof btn.className === 'string' ? btn.className : '';
          return /accordion/i.test(cls);
        })
      );
    }).catch(() => false);
    if (!hasAccordion) {
      logger.info('ACCORDION', 'No accordion elements found — skipping');
      return [];
    }

    /* ─── Phase 1: Discover toggles ─── */
    const toggleInfoList = await page.evaluate(() => {
      const results = [];
      const seenText = new Set();
      const MAX_HEADER = 200;

      function add(el, type) {
        if (!el) return;
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > MAX_HEADER) return;
        const key = text.toLowerCase();
        if (seenText.has(key)) return;
        seenText.add(key);
        results.push({ text, type });
      }

      document.querySelectorAll('.accordion-item .accordion-button').forEach(e => add(e, 'bs5'));
      document.querySelectorAll('.panel-heading [data-toggle="collapse"], .panel-title a[data-toggle="collapse"]').forEach(e => add(e, 'bs4'));
      document.querySelectorAll('.card-header [data-toggle="collapse"], .card-header [data-bs-toggle="collapse"]').forEach(e => add(e, 'bs4'));
      document.querySelectorAll('button').forEach(btn => {
        const cls = btn.className || '';
        if (typeof cls === 'string' && cls.toLowerCase().includes('accordion')) add(btn, 'cssmod');
      });
      document.querySelectorAll('details > summary').forEach(e => add(e, 'details'));
      document.querySelectorAll('.MuiAccordionSummary-root').forEach(e => add(e, 'mui'));
      document.querySelectorAll('[data-accordion] .accordion-title, [data-accordion-item] .accordion-title').forEach(e => add(e, 'foundation'));
      document.querySelectorAll('.faq-item .faq-question, [class*="faq"] [class*="question"]').forEach(e => add(e, 'faq'));
      document.querySelectorAll('h2[role="button"], h3[role="button"], h4[role="button"]').forEach(e => add(e, 'heading'));
      document.querySelectorAll('[class*="collapsible"] > [class*="header"], [class*="expandable"] > [class*="header"]').forEach(e => add(e, 'heading'));
      document.querySelectorAll('.accordion a[title="open"]').forEach(e => add(e, 'csstarget'));
      document.querySelectorAll('.accordion a[id*="open-accordion"]').forEach(e => add(e, 'csstarget'));
      document.querySelectorAll('[class*="accordion"] button, [class*="accordion"] [role="button"], [class*="accordion"] a[href^="#"]').forEach(e => {
        if (e.offsetWidth > 0 && e.offsetHeight > 0) add(e, 'generic');
      });
      document.querySelectorAll('[class*="faq"] h2, [class*="faq"] h3, [class*="faq"] h4, [class*="faq"] button, [class*="faq"] [role="button"]').forEach(e => {
        if (e.offsetWidth > 0 && e.offsetHeight > 0) add(e, 'faq');
      });
      document.querySelectorAll('[aria-expanded]').forEach(e => {
        if (e.offsetWidth > 0 && e.offsetHeight > 0) add(e, 'aria');
      });
      document.querySelectorAll('[data-target^="#"], [data-bs-target^="#"]').forEach(e => {
        const tgt = e.getAttribute('data-target') || e.getAttribute('data-bs-target');
        try { if (tgt && document.querySelector(tgt)) add(e, 'bs4'); } catch {}
      });

      return results;
    });

    if (toggleInfoList.length === 0) return [];

    const items = [];
    const seenHeaders = new Set();

    for (const info of toggleInfoList) {
      try {
        const pair = await page.evaluate(async ({ text, type }) => {
          const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
          const target = text.toLowerCase();
          const delay = (ms) => new Promise(r => setTimeout(r, ms));

          function findToggle() {
            for (const b of document.querySelectorAll('button'))
              if (normalize(b.innerText).toLowerCase() === target) return b;
            for (const s of document.querySelectorAll('summary'))
              if (normalize(s.innerText).toLowerCase() === target) return s;
            for (const e of document.querySelectorAll('h2, h3, h4, a, [role="button"], .MuiAccordionSummary-root, .accordion-title'))
              if (normalize(e.innerText).toLowerCase() === target) return e;
            for (const e of document.querySelectorAll('[class*="faq"] [class*="question"], [class*="collapsible"] > [class*="header"], [class*="expandable"] > [class*="header"]'))
              if (normalize(e.innerText).toLowerCase() === target) return e;
            for (const e of document.querySelectorAll('[aria-expanded], [class*="accordion"] a, [class*="accordion"] span, [class*="faq"] a, [class*="faq"] span'))
              if (normalize(e.innerText).toLowerCase() === target) return e;
            return null;
          }

          const el = findToggle();
          if (!el) return null;

          let isOpen = false;
          if (type === 'details') {
            isOpen = el.closest('details')?.open === true;
          } else if (type === 'csstarget') {
            const parent = el.parentElement;
            const contentEl = parent ? parent.querySelector('.accordion-content') : null;
            isOpen = !!(contentEl && contentEl.offsetHeight > 0);
          } else {
            const acc = el.closest('.accordion-item');
            if (acc) { const b = acc.querySelector('.accordion-collapse, .accordion-body'); isOpen = !!(b && b.innerText.trim()); }
            if (!isOpen) { const p = el.closest('.panel, .card'); if (p) { const b = p.querySelector('.panel-collapse, .collapse, .card-body'); isOpen = !!(b && (b.classList.contains('show') || b.innerText.trim())); } }
            if (!isOpen) { const m = el.closest('[class*="MuiAccordion"]'); if (m) isOpen = m.classList.contains('Mui-expanded'); }
            if (!isOpen) {
              const sib = el.nextElementSibling;
              if (sib) {
                const sc = (sib.className && typeof sib.className === 'string') ? sib.className.toLowerCase() : '';
                if (sc.includes('content') || sc.includes('collapse') || sc.includes('body') || sc.includes('answer') || sc.includes('accordion'))
                  isOpen = sib.offsetHeight > 0 || sib.innerText.trim().length > 0;
              }
            }
            if (!isOpen) isOpen = el.getAttribute('aria-expanded') === 'true';
          }

          const rect = el.getBoundingClientRect();
          if (!isOpen && rect.width > 0 && rect.height > 0) {
            el.click();
            await delay(500);
          }

          const el2 = findToggle();
          if (!el2) return null;

          const header = normalize(el2.innerText);
          let bodyEl = null;

          if (type === 'details') {
            const d = el2.closest('details');
            if (d) {
              const txt = Array.from(d.childNodes).filter(n => n !== el2).map(n => n.textContent || '').join(' ');
              const detailsLinks = [];
              d.querySelectorAll('a[href]').forEach((a) => {
                if (a.closest('summary') === el2) return;
                const linkText = normalize(a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '');
                const href = a.href || '';
                if (href && /^https?:\/\//i.test(href)) detailsLinks.push({ text: linkText || href, href });
              });
              return { header, body: normalize(txt), links: detailsLinks };
            }
          }

          if (type === 'csstarget') {
            const parent = el2.parentElement;
            const contentEl = parent ? parent.querySelector('.accordion-content') : null;
            const body = contentEl ? normalize(contentEl.innerText || contentEl.textContent) : '';
            const csstargetLinks = [];
            if (contentEl) {
              contentEl.querySelectorAll('a[href]').forEach((a) => {
                const linkText = normalize(a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '');
                const href = a.href || '';
                if (href && /^https?:\/\//i.test(href)) csstargetLinks.push({ text: linkText || href, href });
              });
            }
            return { header, body, links: csstargetLinks };
          }

          const accItem = el2.closest('.accordion-item');
          if (accItem) bodyEl = accItem.querySelector('.accordion-body') || accItem.querySelector('.accordion-collapse');
          if (!bodyEl) { const p = el2.closest('.panel'); if (p) bodyEl = p.querySelector('.panel-body') || p.querySelector('.panel-collapse'); }
          if (!bodyEl) { const c = el2.closest('.card'); if (c) bodyEl = c.querySelector('.card-body') || c.querySelector('.collapse'); }
          if (!bodyEl) { const m = el2.closest('[class*="MuiAccordion"]'); if (m) bodyEl = m.querySelector('[class*="MuiAccordionDetails"]'); }
          if (!bodyEl) { const f = el2.closest('[data-accordion-item]'); if (f) bodyEl = f.querySelector('.accordion-content'); }
          if (!bodyEl) {
            const sib = el2.nextElementSibling;
            if (sib) {
              const sc = (sib.className && typeof sib.className === 'string') ? sib.className.toLowerCase() : '';
              if (sc.includes('content') || sc.includes('collapse') || sc.includes('body') || sc.includes('answer') || sc.includes('accordion')) bodyEl = sib;
            }
          }
          if (!bodyEl) { const cid = el2.getAttribute('aria-controls'); if (cid) bodyEl = document.getElementById(cid); }
          if (!bodyEl) {
            const tgt = el2.getAttribute('data-target') || el2.getAttribute('data-bs-target');
            if (tgt) { try { bodyEl = document.querySelector(tgt); } catch {} }
          }
          if (!bodyEl) {
            let anc = el2.parentElement;
            for (let lvl = 0; lvl < 3 && anc && !bodyEl; lvl++) {
              bodyEl = anc.querySelector('[class*="accordionContent"], [class*="accordion-content"], [class*="collapse-body"], [class*="panel-body"], [class*="faq-answer"]');
              anc = anc.parentElement;
            }
          }
          if (!bodyEl) { const fq = el2.closest('.faq-item, [class*="faq"]'); if (fq) bodyEl = fq.querySelector('.faq-answer, [class*="answer"], .faq-body, dd'); }
          if (!bodyEl && el2.tagName === 'A') {
            const href = el2.getAttribute('href') || '';
            if (href.startsWith('#') && href.length > 1) {
              try { bodyEl = document.querySelector(href); } catch {}
            }
          }
          if (!bodyEl) {
            const wrapper = el2.closest('[class*="accordion"], [class*="faq"], [class*="collapsible"], [class*="expandable"]');
            if (wrapper) {
              bodyEl = wrapper.querySelector('[class*="content"], [class*="body"], [class*="answer"], [class*="collapse"], [class*="panel"]');
              if (bodyEl === el2 || bodyEl === wrapper) bodyEl = null;
            }
          }

          const body = bodyEl ? normalize(bodyEl.innerText || bodyEl.textContent) : '';

          const links = [];
          if (bodyEl) {
            bodyEl.querySelectorAll('a[href]').forEach((a) => {
              const linkText = normalize(a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '');
              const href = a.href || '';
              if (href && /^https?:\/\//i.test(href)) links.push({ text: linkText || href, href });
            });
          }

          return { header, body, links };
        }, info);

        if (pair && pair.header) {
          const key = pair.header.toLowerCase();
          if (!seenHeaders.has(key)) {
            seenHeaders.add(key);
            items.push(pair);
          }
        }
      } catch { /* skip broken toggles */ }
    }

    return items;
  },
};
