/**
 * DrugPage — Page Object for the Molina Medicare "Pharmacy and Prescription
 * Benefits Documents" page (e.g. https://.../medicare/<state>/drugs).
 *
 * The drug page has an IDENTICAL DOM to the plan-materials page (same
 * AccordionHC_* classes, same aria-expanded mechanism, same aria-label
 * anchors) — the only differences are:
 *
 *   • Section heading text is "<YEAR> Pharmacy and Prescription Benefits
 *     Documents" instead of "<YEAR> Plan Materials".
 *   • Accordion titles are formulary-specific (e.g. "Comprehensive
 *     Formulary", "Prior Authorization Grid", "Step Therapy Grid").
 *   • PDF URLs live under `.../2027-Drugs/English/…` instead of `.../2027-Materials/English/…`.
 *
 * Because the DOM is the same, this class simply extends PlanMaterialsPage
 * with the drug-specific section suffix. Every other method (accordion
 * expansion, plan-link discovery, screenshots) is reused unchanged.
 */

const { PlanMaterialsPage } = require('./planMaterialsPage');

class DrugPage extends PlanMaterialsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options] — same shape as PlanMaterialsPage options
   */
  constructor(page, options = {}) {
    super(page, {
      ...options,
      sectionSuffix: options.sectionSuffix || 'Pharmacy and Prescription Benefits Documents',
      logTag:        options.logTag        || 'DRUG',
    });
  }
}

module.exports = { DrugPage };
