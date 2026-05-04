/**
 * moodys-scraper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Playwright scraper for events.moodys.com
 * Handles Cookiebot consent banner, clicks "Load more" until exhausted,
 * then writes all events to events.json
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
  console.log(`▶  Navigating to ${URL} …`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(4000); // let JS + Cookiebot fully render

  // ── 2. Handle Cookiebot consent banner ────────────────────────────────────
  // The banner has id="CybotCookiebotDialog" and blocks all pointer events
  // until dismissed. We try three approaches in order:
  //   A) Click the official "Allow all" / "Accept" button
  //   B) If that fails, forcefully remove the overlay from the DOM via JS
  console.log("▶  Handling Cookiebot consent banner…");

  try {
    // Wait for Cookiebot dialog to appear
    await page.waitForSelector("#CybotCookiebotDialog", { timeout: 10_000 });
    console.log("   Cookiebot dialog detected.");

    // Try clicking the Allow All button (Cookiebot's standard button IDs)
    const allowBtn = await page.$(
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, " +
      "#CybotCookiebotDialogBodyButtonAccept, " +
      "button[id*='Allow'], button[id*='Accept'], " +
      "a[id*='CybotCookiebotDialogBodyButtonAccept']"
    );

    if (allowBtn && await allowBtn.isVisible()) {
      await allowBtn.click();
      console.log("   ✓ Clicked Cookiebot Accept button.");
      await sleep(1500);
    } else {
      throw new Error("Accept button not found or not visible");
    }
  } catch (e) {
    console.log(`   Accept button approach failed (${e.message}) — force-removing overlay via JS…`);

    // Nuclear option: remove the dialog and underlay directly from the DOM
    await page.evaluate(() => {
      // Remove all Cookiebot-related elements
      const ids = [
        "CybotCookiebotDialog",
        "CybotCookiebotDialogBodyUnderlay",
        "CybotCookiebotDialogBodyOverlay",
        "cookiebanner",
      ];
      ids.forEach(id => document.getElementById(id)?.remove());

      // Also remove any fixed/sticky overlays that block pointer events
      document.querySelectorAll(
        "[id*='Cybot'], [id*='cookie'], [id*='consent'], [class*='cookie-banner'], [class*='consent-banner']"
      ).forEach(el => el.remove());

      // Restore body scroll/pointer if it was locked
      document.body.style.overflow = "";
      document.body.style.pointerEvents = "";
      document.documentElement.style.overflow = "";
    });

    console.log("   ✓ Overlay removed from DOM.");
    await sleep(1000);
  }

  // Verify overlay is gone before proceeding
  const overlayStillExists = await page.$("#CybotCookiebotDialogBodyUnderlay");
  if (overlayStillExists) {
    console.log("   Overlay still in DOM — forcing removal one more time…");
    await page.evaluate(() => {
      document.getElementById("CybotCookiebotDialogBodyUnderlay")?.remove();
      document.getElementById("CybotCookiebotDialog")?.remove();
    });
    await sleep(500);
  }

  console.log("   ✓ Page unblocked.");

  // ── 3. Wait for calendar to render ───────────────────────────────────────
  console.log("▶  Waiting for event calendar…");
  try {
    await page.waitForSelector(
      "[class*='calendar'], [class*='event'], article, li[class]",
      { timeout: 20_000 }
    );
  } catch {
    console.log("   (Calendar selector timed out — continuing anyway)");
  }
  await sleep(2000);

  // ── 4. Click "Load more" until exhausted ─────────────────────────────────
  console.log("▶  Clicking 'Load more' until exhausted…");
  let clicks = 0;

  async function getLoadMoreBtn() {
    const els = await page.$$(
      "button, a[role='button'], [class*='load-more'], [class*='loadmore']"
    );
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
    if (!btn) {
      console.log(`✓  No 'Load more' found — all events loaded after ${clicks} click(s).`);
      break;
    }

    const before = await page.$$eval(
      "a[href*='events.moodys.com']", els => els.length
    ).catch(() => 0);

    await btn.scrollIntoViewIfNeeded();
    await sleep(400);

    // Use dispatchEvent as fallback in case anything still intercepts the click
    try {
      await btn.click({ timeout: 5000 });
    } catch {
      console.log("   Regular click blocked — using JS click fallback…");
      await btn.evaluate(el => el.click());
    }

    clicks++;
    console.log(`   Click ${clicks} — waiting for new content…`);

    try {
      await page.waitForFunction(
        prev => document.querySelectorAll("a[href*='events.moodys.com']").length > prev,
        before,
        { timeout: SETTLE_MS }
      );
    } catch { /* timeout OK */ }

    await sleep(1500);
  }

  if (clicks >= MAX_CLICKS) console.warn(`⚠  Hit safety cap of ${MAX_CLICKS} clicks.`);

  // ── 5. Extract all events ─────────────────────────────────────────────────
  console.log("▶  Extracting events from DOM…");

  const raw = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    document.querySelectorAll("a[href]").forEach(link => {
      const href = link.href || "";
      if (
        !href.includes("events.moodys.com") ||
        href === "https://events.moodys.com/" ||
        href === "https://events.moodys.com" ||
        href.includes("#") ||
        href.includes("sign-in") ||
        href.includes("faq") ||
        href.includes("moodys.com/") && !href.includes("events.moodys.com") ||
        seen.has(href)
      ) return;

      seen.add(href);

      const card =
        link.closest("li, article, [class*='card'], [class*='event-item'], [class*='item']")
        || link.parentElement
        || link;

      const getText = sel => card.querySelector(sel)?.innerText?.trim() || "";

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

  console.log(`   Raw: ${raw.length} items`);

  // ── 6. Deduplicate ────────────────────────────────────────────────────────
  const seenUrls = new Set();
  const events = raw.filter(ev => {
    if (!ev.url || seenUrls.has(ev.url)) return false;
    seenUrls.add(ev.url);
    return true;
  });

  console.log(`✓  ${events.length} unique events`);

  // ── 7. Write output ───────────────────────────────────────────────────────
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    scrapedAt:   new Date().toISOString(),
    totalEvents: events.length,
    events,
  }, null, 2));

  console.log(`✓  Written → ${OUT_FILE}`);
  await browser.close();
  process.exit(0);
})();
