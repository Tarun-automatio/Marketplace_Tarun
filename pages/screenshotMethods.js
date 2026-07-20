/**
 * Screenshot Methods (mixin for PageCapture.prototype)
 *
 * Handles full-page screenshots, responsive screenshots, mismatch highlighting,
 * page stability waiting, and fixed/sticky element handling for screenshot capture.
 *
 * Methods access `this.page` via the PageCapture instance.
 */

const path = require('path');
const frameworkConfig = require('../config/framework.config');
const logger = require('../utils/logger');
const { waitForDomStable } = require('../utils/asyncHelpers');
const { RESPONSIVE_DEVICES } = require('./selectors');

module.exports = {
  /**
   * Take a stable, DOM-quiescent screenshot with a URL-bar overlay at the top.
   *
   * @param {string} filePath — output path (png)
   * @param {object} [options]
   * @param {boolean} [options.fullPage=true] — pass `false` for a viewport-sized
   *   screenshot instead of the full scrollable page. Viewport-only shots are
   *   preferred for step-by-step evidence in flows where each step is a
   *   single-viewport action (e.g. marketplace nav flow).
   * @param {boolean} [options.preserveScroll=false] — when true, do NOT reset
   *   the page's scroll position to (0, 0) before capture. Used when the
   *   caller has already scrolled a specific section into view and wants
   *   that section to be visible in the screenshot (e.g. marketplace Steps
   *   4–6 scroll to the "All Forms & Documents" section before the shot).
   *   Existing callers (plan-materials, drug) don't pass this so scroll
   *   reset happens as before — behaviour is 100% back-compatible.
   */
  async saveScreenshot(filePath, options = {}) {
    const fullPage = options.fullPage !== false; // default true (back-compat)
    const preserveScroll = options.preserveScroll === true;
    // Capture the caller's scroll position up front so we can restore it
    // right before the actual shot — several internal helpers below
    // (`_waitForPageStable`, `_hideFixedElementsForScreenshot`, etc.)
    // scroll the page for their own purposes and end up at (0, 0).
    const savedScroll = preserveScroll
      ? await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => null)
      : null;
    await Promise.all([
      this.dismissAllPopups(),
      this.acceptCookiesIfPresent(),
      this.dismissPassportMemberPromptIfPresent()
    ]);
    await this.nukeAllPopups();
    await this._waitForPageStable();
    await this._hideFixedElementsForScreenshot();
    if (!preserveScroll) {
      await this.page.evaluate(() => window.scrollTo(0, 0));
    }
    await waitForDomStable(this.page, { stableMs: 100, timeoutMs: 1000 });

    // Replace <video> elements with static images to avoid black rectangles
    await this.page.evaluate(() => {
      document.querySelectorAll('video').forEach(v => {
        try { v.pause(); } catch {}
        const rect = v.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        let src = '';

        try {
          if (v.readyState >= 2 && v.videoWidth > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const sample = ctx.getImageData(0, 0, Math.min(50, canvas.width), Math.min(50, canvas.height)).data;
            let nonBlack = 0;
            for (let i = 0; i < sample.length; i += 4) {
              if (sample[i] > 10 || sample[i + 1] > 10 || sample[i + 2] > 10) nonBlack++;
            }
            if (nonBlack > sample.length / 16) src = canvas.toDataURL('image/jpeg', 0.85);
          }
        } catch {}

        if (!src) src = v.getAttribute('poster') || '';

        if (!src) {
          const parentBg = window.getComputedStyle(v.parentElement).backgroundImage || '';
          const m = parentBg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          if (m) src = m[1];
        }

        if (src) {
          const img = document.createElement('img');
          img.src = src;
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.objectFit = 'cover';
          img.style.display = 'block';
          v.replaceWith(img);
        } else {
          v.style.visibility = 'hidden';
        }
      });
    }).catch(() => {});
    await waitForDomStable(this.page, { stableMs: 150, timeoutMs: 1500 });

    // Inject URL bar at page top. When preserving scroll position, use
    // position:fixed so the bar overlays the viewport top instead of
    // sitting at document Y=0 (which would be off-screen when scrolled).
    const pageUrl = this.page.url();
    await this.page.evaluate(({ url, useFixed }) => {
      const bar = document.createElement('div');
      bar.id = '__url_bar_overlay__';
      bar.textContent = url;
      const positionCss = useFixed
        ? 'position:fixed;top:0;left:0;right:0;'
        : 'position:relative;';
      bar.style.cssText = positionCss + 'z-index:2147483647;background:#f1f3f4;color:#333;' +
        'font:13px/1.4 "Segoe UI",Roboto,Arial,sans-serif;padding:6px 14px;' +
        'border-bottom:1px solid #ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      document.body.insertBefore(bar, document.body.firstChild);
    }, { url: pageUrl, useFixed: preserveScroll });
    // Restore the caller's scroll position right before the shot so any
    // internal scroll-to-top calls above are undone. Only fires when
    // preserveScroll was requested.
    if (preserveScroll && savedScroll) {
      await this.page.evaluate(({ x, y }) => window.scrollTo(x, y), savedScroll).catch(() => {});
      await waitForDomStable(this.page, { stableMs: 100, timeoutMs: 500 });
    }
    logger.debug('SCREENSHOT', `Capturing screenshot: ${filePath}`);
    await this.page.screenshot({ path: filePath, fullPage });
    await this.page.evaluate(() => {
      const bar = document.getElementById('__url_bar_overlay__');
      if (bar) bar.remove();
    });
    await this._restoreFixedElements();
  },

  async _waitForPageStable() {
    await this.page.waitForFunction(() => document.readyState === 'complete', null, { timeout: frameworkConfig.pageLoadWaitMs }).catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: frameworkConfig.networkIdleWaitMs }).catch(() => {});
    // Scroll to trigger lazy-loaded content
    await this.page.evaluate(async () => {
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      const scrollHeight = document.body.scrollHeight;
      const step = Math.max(window.innerHeight, 600);
      for (let y = 0; y < scrollHeight; y += step) {
        window.scrollTo(0, y);
        await delay(80);
      }
      window.scrollTo(0, document.body.scrollHeight);
      await delay(150);
      window.scrollTo(0, 0);
    }).catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: frameworkConfig.elementInteractionTimeoutMs }).catch(() => {});
    // Wait for all resources in parallel
    await Promise.all([
      // Images
      this.page.evaluate(() => {
        return Promise.all(
          Array.from(document.querySelectorAll('img')).map(img => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            if (!img.src && img.dataset.src) img.src = img.dataset.src;
            if (!img.src && img.dataset.lazySrc) img.src = img.dataset.lazySrc;
            if (img.loading === 'lazy') img.loading = 'eager';
            return new Promise(resolve => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
              setTimeout(resolve, 3000);
            });
          })
        );
      }).catch(() => {}),
      // CSS background images
      this.page.evaluate(() => {
        const bgUrls = [];
        const elements = document.querySelectorAll('*');
        for (const el of elements) {
          const bg = window.getComputedStyle(el).backgroundImage || '';
          const matches = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g);
          if (matches) {
            for (const m of matches) {
              const url = m.replace(/url\(["']?/, '').replace(/["']?\)/, '');
              if (url) bgUrls.push(url);
            }
          }
        }
        if (!bgUrls.length) return Promise.resolve();
        return Promise.all(
          bgUrls.slice(0, 20).map(url =>
            new Promise(resolve => {
              const img = new Image();
              img.onload = resolve;
              img.onerror = resolve;
              setTimeout(resolve, 3000);
              img.src = url;
            })
          )
        );
      }).catch(() => {}),
      // Video elements
      this.page.evaluate(() => {
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return Promise.resolve();
        return Promise.all(
          videos.map(video => {
            if (video.paused && video.src) {
              video.muted = true;
              video.play().catch(() => {});
            }
            if (video.poster) {
              const img = new Image();
              img.src = video.poster;
            }
            if (video.readyState >= 2) return Promise.resolve();
            return new Promise(resolve => {
              video.addEventListener('loadeddata', resolve, { once: true });
              video.addEventListener('canplay', resolve, { once: true });
              video.addEventListener('error', resolve, { once: true });
              setTimeout(resolve, 3000);
              if (!video.src && video.querySelector('source')) {
                video.load();
              }
            });
          })
        );
      }).catch(() => {}),
      // Iframes
      this.page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe[src]'));
        if (!iframes.length) return Promise.resolve();
        return Promise.all(
          iframes.slice(0, 10).map(iframe => {
            try {
              if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') return Promise.resolve();
            } catch { /* cross-origin */ }
            return new Promise(resolve => {
              iframe.addEventListener('load', resolve, { once: true });
              setTimeout(resolve, 3000);
            });
          })
        );
      }).catch(() => {}),
    ]);
    // CSS fonts + animations
    await Promise.all([
      this.page.evaluate(() => document.fonts?.ready).catch(() => {}),
      this.page.evaluate(() => {
        return new Promise(resolve => {
          const allAnimations = document.getAnimations ? document.getAnimations() : [];
          if (allAnimations.length === 0) return resolve();
          Promise.allSettled(allAnimations.map(a => a.finished)).then(resolve);
          setTimeout(resolve, 3000);
        });
      }).catch(() => {})
    ]);
    await waitForDomStable(this.page, { stableMs: 200, timeoutMs: 2000 });
  },

  async _hideFixedElementsForScreenshot() {
    return this.page.evaluate(() => {
      const saved = [];

      // A. Remove modal backdrops
      const strictModalSelectors = [
        '.modal-backdrop', '.modal.show', '.modal.fade.show',
        '.modal[style*="display: block"]', '[class*="modal-backdrop"]',
      ];
      for (const sel of strictModalSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
          el.style.display = 'none';
        });
      }

      const broadSelectors = ['[class*="overlay"]', '[class*="backdrop"]', '[role="dialog"]'];
      for (const sel of broadSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const style = window.getComputedStyle(el);
          const isPositioned = style.position === 'fixed' || style.position === 'absolute';
          const coversViewport = el.offsetWidth >= window.innerWidth * 0.8 && el.offsetHeight >= window.innerHeight * 0.8;
          const zIndex = parseInt(style.zIndex, 10);
          const hasHighZ = !isNaN(zIndex) && zIndex > 100;
          if (isPositioned && (coversViewport || hasHighZ)) {
            saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
            el.style.display = 'none';
          }
        });
      }

      // B. Full-screen dark overlays
      document.querySelectorAll('div, section, aside').forEach((el) => {
        const style = window.getComputedStyle(el);
        if ((style.position === 'fixed' || style.position === 'absolute') &&
            el.offsetWidth >= window.innerWidth * 0.9 &&
            el.offsetHeight >= window.innerHeight * 0.9) {
          const bg = style.backgroundColor || '';
          const opacity = parseFloat(style.opacity);
          if (/rgba\(\s*0.*0.*0.*[0-9]*\./.test(bg) || opacity < 0.95) {
            saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
            el.style.display = 'none';
          }
        }
      });

      // C. Chat widget iframes
      const chatIframeSelectors = [
        'iframe[id*="intercom"]', 'iframe[id*="Intercom"]',
        'iframe[id*="drift"]', 'iframe[id*="Drift"]',
        'iframe[id*="livechat"]', 'iframe[id*="LiveChat"]',
        'iframe[id*="hubspot"]', 'iframe[id*="HubSpot"]',
        'iframe[id*="zendesk"]', 'iframe[id*="Zendesk"]',
        'iframe[id*="freshdesk"]', 'iframe[id*="Freshdesk"]',
        'iframe[id*="tidio"]', 'iframe[id*="Tidio"]',
        'iframe[id*="crisp"]', 'iframe[id*="Crisp"]',
        'iframe[id*="tawk"]', 'iframe[id*="Tawk"]',
        'iframe[id*="chat"]', 'iframe[class*="chat"]',
        'iframe[title*="chat" i]', 'iframe[title*="messaging" i]',
        '#launcher', '#web-messenger-container', '#hubspot-messages-iframe-container',
        '[id*="chat-widget"]', '[id*="chatWidget"]',
        '[class*="chat-widget"]', '[class*="chatWidget"]',
        '#tidio-chat', '#drift-widget', '#intercom-container',
        '[class*="intercom"]', '[class*="drift-"]',
      ];
      for (const sel of chatIframeSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.offsetWidth > 0 || el.offsetHeight > 0 || window.getComputedStyle(el).position === 'fixed') {
            saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
            el.style.display = 'none';
          }
        });
      }

      // D. Fixed-position iframes
      document.querySelectorAll('iframe').forEach((iframe) => {
        const style = window.getComputedStyle(iframe);
        if (style.position === 'fixed') {
          saved.push({ el: iframe, display: iframe.style.display, position: iframe.style.position, zIndex: iframe.style.zIndex, visibility: iframe.style.visibility });
          iframe.style.display = 'none';
        }
      });

      // E. Back-to-top buttons
      document.querySelectorAll('button, a, div, [role="button"]').forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'sticky') return;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase().trim();
        const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
        const id = (el.id || '').toLowerCase();
        if (/back.?to.?top|scroll.?to.?top|scroll.?up|go.?to.?top|return.?to.?top|^top$|↑|⬆|chevron.?up/i.test(text + ' ' + cls + ' ' + id)) {
          saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
          el.style.display = 'none';
        }
      });

      // F. Notification toasts
      const toastSelectors = [
        '.toast', '.toast-container', '[class*="snackbar"]', '[class*="Snackbar"]',
        '[class*="notification-bar"]', '[class*="alert-banner"]',
        '[class*="cookie-notice"]', '[class*="notice-bar"]',
        '[role="alert"]', '[role="status"]',
        '.Toastify', '[class*="toastify"]',
      ];
      for (const sel of toastSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const elStyle = window.getComputedStyle(el);
          if ((elStyle.position === 'fixed' || elStyle.position === 'sticky') && el.offsetWidth > 0 && el.offsetHeight > 0) {
            saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
            el.style.display = 'none';
          }
        });
      }

      // G. Social sharing widgets
      const socialSelectors = [
        '[class*="social-share"]', '[class*="share-buttons"]',
        '[class*="social-float"]', '[class*="floating-social"]',
        '[class*="addthis"]', '[class*="sharethis"]',
        '.at-share-btn-elements', '#at-share-dock',
        '[class*="share-bar"]',
      ];
      for (const sel of socialSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const elStyle = window.getComputedStyle(el);
          if ((elStyle.position === 'fixed' || elStyle.position === 'sticky') && el.offsetWidth > 0) {
            saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
            el.style.display = 'none';
          }
        });
      }

      // H. Development error widgets
      document.querySelectorAll('div, section, aside, span, p').forEach((el) => {
        const text = (el.innerText || '').trim();
        if (/JSS component is missing|missing React implementation|developer console|There was a problem loading this section/i.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 10) {
            const children = el.querySelectorAll('div, section, aside, span, p');
            let hasMatchingChild = false;
            children.forEach((child) => {
              if (/JSS component is missing|missing React implementation|developer console|There was a problem loading this section/i.test((child.innerText || '').trim())) {
                hasMatchingChild = true;
              }
            });
            if (!hasMatchingChild) {
              saved.push({ el, display: el.style.display, position: el.style.position, zIndex: el.style.zIndex, visibility: el.style.visibility });
              el.style.display = 'none';
            }
          }
        }
      });

      // I. Convert remaining fixed/sticky elements
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.style.display === 'none' && !el.dataset.__wasVisible__) continue;
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          saved.push({
            el, position: el.style.position, zIndex: el.style.zIndex,
            display: el.style.display, visibility: el.style.visibility,
            tagName: el.tagName.toLowerCase()
          });
          const isTopNav = (el.tagName === 'NAV' || el.tagName === 'HEADER' ||
            el.getAttribute('role') === 'navigation' ||
            el.classList.toString().match(/nav|header|menu/i)) &&
            el.getBoundingClientRect().top < 100;
          if (isTopNav) {
            el.style.position = 'absolute';
          } else {
            el.style.display = 'none';
          }
        }
      }

      // J. Ensure body is not in modal-open state
      document.body.classList.remove('modal-open');
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';

      window.__fixedElsBackup__ = saved;
    }).catch(() => {});
  },

  async _restoreFixedElements() {
    return this.page.evaluate(() => {
      const saved = window.__fixedElsBackup__ || [];
      for (const item of saved) {
        item.el.style.position = item.position || '';
        item.el.style.zIndex = item.zIndex || '';
        item.el.style.display = item.display || '';
        if (item.visibility !== undefined) item.el.style.visibility = item.visibility || '';
      }
      delete window.__fixedElsBackup__;
    }).catch(() => {});
  },

  async saveResponsiveScreenshots(basePath) {
    const originalViewport = this.page.viewportSize();
    const results = {};
    const ext = path.extname(basePath);
    const dir = path.dirname(basePath);
    const base = path.basename(basePath, ext);

    for (const device of RESPONSIVE_DEVICES) {
      await this.page.setViewportSize({ width: device.width, height: device.height });
      await waitForDomStable(this.page, { stableMs: 200, timeoutMs: 2000 });
      await this.nukeAllPopups();
      await this.page.evaluate(() => window.scrollTo(0, 0));
      await this._hideFixedElementsForScreenshot();
      await waitForDomStable(this.page, { stableMs: 80, timeoutMs: 800 });
      const filePath = path.join(dir, `${base}_${device.name}${ext}`);
      await this.page.screenshot({ path: filePath, fullPage: true });
      await this._restoreFixedElements();
      logger.debug('SCREENSHOT', `Captured ${device.name} (${device.width}x${device.height}) screenshot: ${filePath}`);
      results[device.name] = filePath;
    }

    if (originalViewport) {
      await this.page.setViewportSize(originalViewport);
      await waitForDomStable(this.page, { stableMs: 80, timeoutMs: 800 });
    }
    return results;
  },

  async saveMismatchScreenshot(filePath, highlightTexts = []) {
    const normalizedTexts = highlightTexts
      .map((item) => (item || '').toLowerCase().trim())
      .filter(Boolean);

    await this.page.evaluate((texts) => {
      const shouldHighlight = (value) => {
        const normalized = (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return normalized && texts.includes(normalized);
      };

      document.querySelectorAll('[data-ai-mismatch-highlight="1"]').forEach((el) => {
        el.removeAttribute('data-ai-mismatch-highlight');
        el.style.outline = '';
        el.style.backgroundColor = '';
      });

      const candidates = Array.from(document.querySelectorAll('a, h1, h2, h3, h4, h5, h6, button, p, span'));
      candidates.forEach((el) => {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!shouldHighlight(text)) return;
        el.setAttribute('data-ai-mismatch-highlight', '1');
        el.style.outline = '3px solid #ff3b30';
        el.style.backgroundColor = 'rgba(255, 59, 48, 0.15)';
      });
    }, normalizedTexts);

    await this._waitForPageStable();
    await this.nukeAllPopups();
    await this._hideFixedElementsForScreenshot();
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await waitForDomStable(this.page, { stableMs: 150, timeoutMs: 1500 });
    logger.debug('SCREENSHOT', `Capturing mismatch-highlight screenshot: ${filePath}`);
    await this.page.screenshot({ path: filePath, fullPage: true });
    await this._restoreFixedElements();

    await this.page.evaluate(() => {
      document.querySelectorAll('[data-ai-mismatch-highlight="1"]').forEach((el) => {
        el.removeAttribute('data-ai-mismatch-highlight');
        el.style.outline = '';
        el.style.backgroundColor = '';
      });
    });
  },
};
