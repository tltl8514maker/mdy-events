/**
 * moodys-scraper.js
 * Playwright scraper for events.moodys.com
 * Clicks "Load more" until exhausted, extracts structured event fields,
 * writes events.json — no hardcoded event data anywhere.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const URL        = "https://events.moodys.com";
const OUT_FILE   = path.join(__dirname, "events.json");
const SETTLE_MS  = 3000;
const MAX_CLICKS = 40;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse a raw date string like:
//   "Wednesday, 15 April | 09:00 - 13:45 MYT"
//   "Tuesday, 12 May 2026 | VNT"
//   "Monday, May 4 - Wednesday, May 6, 2026 | Manchester Grand Hyatt | San Diego, CA"
// into { date, time, location }
function parseDateField(raw = "") {
  if (!raw) return { date: "", time: "", location: "" };

  const parts = raw.split("|").map(s => s.trim());
  const datePart = parts[0] || "";

  // Look for a time pattern like "09:00 - 13:45 MYT" or "14:00 BST"
  const timeMatch = raw.match(/\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?\s*[A-Z]{2,4}/);
  const time = timeMatch ? timeMatch[0].trim() : "";

  // The second pipe-separated segment sometimes contains venue/city
  // e.g. "Manchester Grand Hyatt | San Diego, CA"
  let location = "";
  if (parts.length >= 3) {
    location = parts.slice(1).filter(p => !p.match(/^\d{1,2}:\d{2}/)).join(", ");
  } else if (parts.length === 2 && !parts[1].match(/^\d{1,2}:\d{2}/)) {
    // Not a time — could be a timezone-only like "VNT" or a location
    const tzOnly = /^[A-Z]{2,5}$/.test(parts[1]);
    if (!tzOnly) location = parts[1];
  }

  // Clean date: remove the time portion from datePart
  const date = datePart.replace(timeMatch ? timeMatch[0] : "", "").trim().replace(/\s+/g, " ");

  return { date, time, location };
}

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
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(4000);

  // 2. Dismiss Cookiebot
  console.log("▶  Handling Cookiebot consent banner…");
  try {
    await page.waitForSelector("#CybotCookiebotDialog", { timeout: 10_000 });
    const allowBtn = await page.$(
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, " +
      "#CybotCookiebotDialogBodyButtonAccept, " +
      "button[id*='Allow'], button[id*='Accept']"
    );
    if (allowBtn && await allowBtn.isVisible()) {
      await allowBtn.click();
      console.log("   ✓ Clicked Accept button.");
      await sleep(1500);
    } else throw new Error("button not visible");
  } catch (e) {
    console.log(`   Falling back to DOM removal (${e.message})…`);
    await page.evaluate(() => {
      ["CybotCookiebotDialog", "CybotCookiebotDialogBodyUnderlay",
       "CybotCookiebotDialogBodyOverlay"].forEach(id => document.getElementById(id)?.remove());
      document.querySelectorAll("[id*='Cybot'],[class*='cookie-banner'],[class*='consent']")
        .forEach(el => el.remove());
      document.body.style.overflow = "";
      document.body.style.pointerEvents = "";
    });
    await sleep(800);
  }
  console.log("   ✓ Page unblocked.");

  // 3. Wait for calendar
  try {
    await page.waitForSelector("[class*='calendar'], [class*='event'], article", { timeout: 20_000 });
  } catch { console.log("   (Calendar wait timed out — continuing)"); }
  await sleep(2000);

  // 4. Click Load More until gone
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
    if (!btn) { console.log(`✓  All events loaded after ${clicks} click(s).`); break; }

    const before = await page.$$eval("a[href*='events.moodys.com']", els => els.length).catch(() => 0);
    await btn.scrollIntoViewIfNeeded();
    await sleep(400);

    try { await btn.click({ timeout: 5000 }); }
    catch { await btn.evaluate(el => el.click()); }

    clicks++;
    console.log(`   Click ${clicks}…`);

    try {
      await page.waitForFunction(
        prev => document.querySelectorAll("a[href*='events.moodys.com']").length > prev,
        before, { timeout: SETTLE_MS }
      );
    } catch { /* timeout OK */ }

    await sleep(1500);
  }

  // 5. Extract structured event data
  console.log("▶  Extracting events…");

  const raw = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    document.querySelectorAll("a[href]").forEach(link => {
      const href = link.href || "";

      // Only keep links to actual event sub-pages
      if (
        !href.includes("events.moodys.com") ||
        href.replace(/\/$/, "") === "https://events.moodys.com" ||
        href.includes("#") ||
        href.includes("sign-in") ||
        href.includes("faq") ||
        href.includes("moodys.com/") && !href.includes("events.moodys.com") ||
        seen.has(href)
      ) return;
      seen.add(href);

      const card =
        link.closest("li, article, [class*='card'], [class*='event-item'], [class*='item']")
        || link.parentElement || link;

      const get = sel => card.querySelector(sel)?.innerText?.trim() || "";

      // Event name: h2/h3/h4 inside card, NOT the type badge
      const name = get("h2, h3, h4, [class*='title'], [class*='heading']")
                   || link.innerText?.trim() || "";

      // Type badge (e.g. "In-Person Conference", "Webinar")
      const type = get("[class*='type'],[class*='badge'],[class*='label'],[class*='format'],[class*='tag']");

      // Raw date/time/location string
      const dateRaw = get("[class*='date'],[class*='schedule'],[class*='time'],time");

      // Description
      const description = get("[class*='desc'],[class*='subtitle'],[class*='intro'],p");

      // Location may appear explicitly in a location/venue element
      const locationRaw = get("[class*='location'],[class*='venue'],[class*='place'],[class*='city']");

      results.push({ name, type, dateRaw, locationRaw, description, url: href });
    });

    return results;
  });

  console.log(`   Raw: ${raw.length} items`);

  // 6. Dedup by URL
  const seenUrls = new Set();
  const deduped = raw.filter(ev => {
    if (!ev.url || seenUrls.has(ev.url)) return false;
    seenUrls.add(ev.url);
    return true;
  });

  // 7. Parse structured date/time/location fields
  const events = deduped.map(ev => {
    const { date, time, location } = parseDateField(ev.dateRaw);
    return {
      name:        ev.name,
      type:        ev.type,
      date:        date,
      time:        time,
      location:    ev.locationRaw || location,
      description: ev.description,
      url:         ev.url,
    };
  });

  // 8. Filter out entries with no meaningful name
  const filtered = events.filter(ev => ev.name && ev.name.length > 3);

  console.log(`✓  ${filtered.length} unique events after dedup + filter`);

  // 9. Write output
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    scrapedAt:   new Date().toISOString(),
    totalEvents: filtered.length,
    events:      filtered,
  }, null, 2));

  console.log(`✓  Written → ${OUT_FILE}`);
  await browser.close();
  process.exit(0);
})();
