/**
 * moodys-scraper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Playwright scraper for events.moodys.com
 * Clicks "Load more" until exhausted, then dumps all event cards to events.json
 * Runs headlessly in GitHub Actions or locally.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const URL        = "https://events.moodys.com";
const OUT_FILE   = path.join(__dirname, "events.json");
const SETTLE_MS  = 3000;
const MAX_CLICKS = 40;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log("▶  Launching Chromium (headless)…");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });

  const page = await context.newPage();
  page.on("console", () => {});
  page.on("pageerror", () => {});

  // 1. Navigate
  console.log(`▶  Navigating to ${URL} …`);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });
  await sleep(3000);

  // 2. Dismiss cookie/consent banner if present
  try {
    const btn = await page.$("button:has-text('Accept'), button:has-text('Accept All')");
    if (btn) { await btn.click(); await sleep(800); console.log("   Dismissed consent banner."); }
  } catch { /* none */ }

  // 3. Click "Load more" until it disappears
  console.log("▶  Clicking 'Load more' until exhausted…");
  let clicks = 0;

  async function getLoadMoreBtn() {
    const els = await page.$$("button, a[role='button']");
    for (const el of els) {
      try {
        const txt = (await el.innerText()).trim().toLowerCase();
        const vis = await el.isVisible();
        if (vis && /^(load more|show more|view more|more events)$/.test(txt)) return el;
      } catch { /* stale */ }
    }
    return null;
  }

  while (clicks < MAX_CLICKS) {
    const btn = await getLoadMoreBtn();
    if (!btn) { console.log(`✓  Done — all events loaded after ${clicks} click(s).`); break; }

    const before = await page.$$eval(
      "[class*='event'], [class*='card'], article, li",
      els => els.length
    ).catch(() => 0);

    await btn.scrollIntoViewIfNeeded();
    await sleep(300);
    await btn.click();
    clicks++;
    console.log(`   Click ${clicks}…`);

    try {
      await page.waitForFunction(
        prev => document.querySelectorAll(
          "[class*='event'], [class*='card'], article, li"
        ).length > prev,
        before,
        { timeout: SETTLE_MS }
      );
    } catch { /* timeout OK */ }

    await sleep(1000);
  }

  // 4. Extract events
  console.log("▶  Extracting events…");

  const raw = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    document.querySelectorAll("a[href*='events.moodys.com']").forEach(link => {
      const href = link.href;
      if (!href || seen.has(href)) return;
      seen.add(href);

      const card = link.closest("li, article, [class*='card'], [class*='event-item']") || link;

      results.push({
        title: card.querySelector("h2,h3,h4,[class*='title']")?.innerText?.trim() || link.innerText?.trim() || "",
        date:  card.querySelector("[class*='date'],[class*='schedule'],time")?.innerText?.trim() || "",
        type:  card.querySelector("[class*='type'],[class*='badge'],[class*='label'],[class*='format']")?.innerText?.trim() || "",
        description: card.querySelector("[class*='desc'],[class*='subtitle'],p")?.innerText?.trim() || "",
        url: href,
      });
    });

    return results;
  });

  // 5. Dedup
  const seenUrls = new Set();
  const events = raw.filter(ev => {
    if (!ev.url || seenUrls.has(ev.url)) return false;
    seenUrls.add(ev.url);
    return true;
  });

  console.log(`✓  ${events.length} unique events extracted`);

  // 6. Write
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    totalEvents: events.length,
    events,
  }, null, 2));

  console.log(`✓  Written → ${OUT_FILE}`);
  await browser.close();
  process.exit(0);
})();
