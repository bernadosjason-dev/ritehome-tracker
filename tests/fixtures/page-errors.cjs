// Collects a page's uncaught errors for a test to assert on, minus one message that is not ours to fix:
// when Chromium cancels a page-to-page swap (@view-transition in shell.css) because the next page
// arrives mid-swap, it reports "Transition was aborted because of invalid state". With our setup (no
// animation) the new page simply shows without the swap; people see no difference. shell.js already
// catches the swap promises it can reach; this one is raised before any page script can. Every other
// error still fails the test.
const BENIGN = /^Transition was aborted because of invalid state\. ViewTransition opt-in disabled$/;
function collectErrors(page, list = []) {
  page.on('pageerror', (e) => { if (!BENIGN.test(e.message)) list.push(e.message); });
  return list;
}
module.exports = { collectErrors, BENIGN };
