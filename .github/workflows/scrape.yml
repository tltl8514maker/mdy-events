/**
 * moodys-scraper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Playwright scraper for events.moodys.com
 * Clicks "Load more" until exhausted, then dumps all event cards to events.json
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

  // ── 1. Navigate ───────────────────────────────────────────────────────────
  // Use "domcontentloaded" — "networkidle" times out because the page
  // continuously polls in the background and never fully goes quiet.
  console.log(`▶  Navigating to ${URL} …`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Wait for the event calendar section to appear in the DOM
  console.log("▶  Waiting for calendar to render…");
  try {
    await page.waitForSelector(
      "[class*='calendar'], [class*='event'], article, li[class]",
      { timeout: 30_000 }
    );
  } catch {
    console.log("   (Selector wait timed out — continuing anyway)");
  }

  // Extra settle for JS-rendered content
  await sleep(4000);

  // ── 2. Dismiss cookie / consent banner ───────────────────────────────────
  try {
    const btn = await page.$(
      "button:has-text('Accept'), button:has-text('Accept All'), button:has-text('I Agree')"
    );
    if (btn && await btn.isVisible()) {
      await btn.click();
      await sleep(800);
      console.log("   Dismissed consent banner.");
    }
  } catch { /* none */ }

  // ── 3. Click "Load more" until it disappears ──────────────────────────────
  console.log("▶  Clicking 'Load more' until exhausted…");
  let clicks = 0;

  async function getLoadMoreBtn() {
    const els = await page.$$("button, a[role='button'], [class*='load-more'], [class*='loadmore']");
    for (const el of els) {
      try {
        const txt = (await el.innerText()).trim().toLowerCase();
        const vis = await el.isVisible();
        if (vis && /^(load more|show more|view more|more events)$/.test(txt)) return el;
      } catch { /* stale handle */ }
    }
    return null;
  }

  while (clicks < MAX_CLICKS) {
    const btn = await getLoadMoreBtn();
    if (!btn) {
      console.log(`✓  No 'Load more' found — all events loaded after ${clicks} click(s).`);
      break;
    }

    const before = await page.$$eval(
      "a[href*='events.moodys.com']",
      els => els.length
    ).catch(() => 0);

    await btn.scrollIntoViewIfNeeded();
    await sleep(400);
    await btn.click();
    clicks++;
    console.log(`   Click ${clicks} — waiting for new content…`);

    // Wait until new event links appear, or timeout after SETTLE_MS
    try {
      await page.waitForFunction(
        prev => document.querySelectorAll("a[href*='events.moodys.com']").length > prev,
        before,
        { timeout: SETTLE_MS }
      );
    } catch { /* timeout OK — content may have loaded differently */ }

    await sleep(1500);
  }

  if (clicks >= MAX_CLICKS) console.warn(`⚠  Hit safety cap of ${MAX_CLICKS} clicks.`);

  // ── 4. Extract events ─────────────────────────────────────────────────────
  console.log("▶  Extracting events from DOM…");

  const raw = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Target all anchor tags that link to Moody's event sub-pages
    document.querySelectorAll("a[href]").forEach(link => {
      const href = link.href || "";

      // Only keep links to actual event pages (have a path segment after the domain)
      if (
        !href.includes("events.moodys.com") ||
        href === "https://events.moodys.com/" ||
        href === "https://events.moodys.com" ||
        href.includes("#") ||
        href.includes("sign-in") ||
        href.includes("faq") ||
        seen.has(href)
      ) return;

      seen.add(href);

      // Walk up the DOM to find the enclosing card element
      const card =
        link.closest("li, article, [class*='card'], [class*='event-item'], [class*='item']")
        || link.parentElement
        || link;

      const getText = (sel) =>
        card.querySelector(sel)?.innerText?.trim() || "";

      results.push({
        title:       getText("h2,h3,h4,[class*='title'],[class*='heading'],[class*='name']")
                     || link.innerText?.trim() || "",
        date:        getText("[class*='date'],[class*='schedule'],[class*='time'],time"),
        type:        getText("[class*='type'],[class*='badge'],[class*='label'],[class*='format'],[class*='tag']"),
        description: getText("[class*='desc'],[class*='subtitle'],[class*='intro'],p"),
        url:         href,
      });
    });

    return results;
  });

  console.log(`   Raw extraction: ${raw.length} items`);

  // ── 5. Deduplicate ────────────────────────────────────────────────────────
  const seenUrls = new Set();
  const events = raw.filter(ev => {
    if (!ev.url || seenUrls.has(ev.url)) return false;
    seenUrls.add(ev.url);
    return true;
  });

  console.log(`✓  ${events.length} unique events after dedup`);

  // ── 6. Write output ───────────────────────────────────────────────────────
  const output = {
    scrapedAt:   new Date().toISOString(),
    totalEvents: events.length,
    events,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`✓  Written → ${OUT_FILE}`);

  await browser.close();
  process.exit(0);
})();
