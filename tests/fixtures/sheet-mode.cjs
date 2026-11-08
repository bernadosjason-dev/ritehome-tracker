// The browser suites written against the Apps Script backend (script.google.com routes and
// the access-key gate) keep running against it: this serves tracker.html with BACKEND set
// to "sheet". Everything above the transport is the same code either way; the Supabase
// path has its own suite (supabase-login.browser.cjs).
async function useSheetBackend(page) {
  await page.route(/\/tracker\.html(\?(?!check=).*)?$/, async route => {
    const res = await route.fetch();
    const body = (await res.text()).replace('var BACKEND = "supabase";', 'var BACKEND = "sheet";');
    if (!body.includes('var BACKEND = "sheet";')) throw Error('BACKEND line not found in tracker.html');
    await route.fulfill({response: res, body});
  });
}
module.exports = {useSheetBackend};
