/**
 * moodys-scraper.js
 * 1. Opens events.moodys.com and clicks "Load more" until exhausted
 * 2. Collects every event card (name, type, URL) from the listing
 * 3. Visits each event's detail page to extract date, time, location
 * 4. Writes structured events.json
 */

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const BASE_URL   = "https://events.moodys.com";
const OUT_FILE   = path.join(__dirname, "events.json");
const SETTLE_MS  = 3000;
const MAX_CLICKS = 40;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Cookiebot dismissal (reusable) ────────────────────────────────────────────
async function dismissCookiebot(page) {
  try {
    await page.waitForSelector("#CybotCookiebotDialog", { timeout: 8000 });
    const btn = await page.$(
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll," +
      "#CybotCookiebotDialogBodyButtonAccept," +
      "button[id*='Allow'],button[id*='Accept']"
    );
    if (btn && await btn.isVisible()) {
      await btn.click();
      await sleep(1200);
      return;
    }
  } catch { /* fall through to force remove */ }

  await page.evaluate(() => {
    document.querySelectorAll(
      "#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay," +
      "#CybotCookiebotDialogBodyOverlay,[id*='Cybot'],[class*='cookie-banner']"
    ).forEach(el => el.remove());
    document.body.style.overflow = "";
    document.body.style.pointerEvents = "";
  }).catch(() => {});
  await sleep(600);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("▶  Launching Chromium…");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });

  // ── PHASE 1: Listing page ─────────────────────────────────────────────────
  console.log("▶  Phase 1: Scraping event listing…");
  const listPage = await context.newPage();
  listPage.on("console", () => {});
  listPage.on("pageerror", () => {});

  await listPage.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4000);
  await dismissCookiebot(listPage);

  // Wait for any event content
  try {
    await listPage.waitForSelector("a[href*='events.moodys.com/']", { timeout: 20000 });
  } catch { console.log("  (Initial event link wait timed out — continuing)"); }
  await sleep(2000);

  // Click "Load more" until gone
  console.log("▶  Clicking 'Load more'…");
  let clicks = 0;

  async function getLoadMoreBtn() {
    const els = await listPage.$$("button, a[role='button']");
    for (const el of els) {
      try {
        const txt = (await el.innerText()).trim().toLowerCase();
        if (await el.isVisible() && /^(load more|show more|view more|more events)$/.test(txt))
          return el;
      } catch { /* stale */ }
    }
    return null;
  }

  while (clicks < MAX_CLICKS) {
    const btn = await getLoadMoreBtn();
    if (!btn) { console.log(`  ✓ All loaded after ${clicks} click(s).`); break; }

    const before = await listPage.$$eval("a[href*='events.moodys.com/']", e => e.length).catch(() => 0);
    await btn.scrollIntoViewIfNeeded();
    await sleep(400);
    try { await btn.click({ timeout: 5000 }); }
    catch { await btn.evaluate(el => el.click()); }
    clicks++;
    console.log(`  Click ${clicks}…`);

    try {
      await listPage.waitForFunction(
        prev => document.querySelectorAll("a[href*='events.moodys.com/']").length > prev,
        before, { timeout: SETTLE_MS }
      );
    } catch { /* timeout OK */ }
    await sleep(1500);
  }

  // ── Extract all event cards from the listing ──────────────────────────────
  console.log("▶  Extracting event cards from listing page…");

  const cards = await listPage.evaluate((baseUrl) => {
    const results = [];
    const seen = new Set();

    // Strategy: find all links that look like event sub-pages
    document.querySelectorAll("a[href]").forEach(link => {
      const href = link.href || "";

      // Must be an events.moodys.com sub-page (not root, not anchor, not utility pages)
      if (!href.startsWith(baseUrl + "/")) return;
      const slug = href.replace(baseUrl + "/", "").split("?")[0].split("#")[0];
      if (!slug || slug.length < 3) return;
      if (/^(faq|sign-in|register|contact|about|search|privacy|terms|accessibility)/.test(slug)) return;
      if (href.includes("#") || seen.has(href)) return;
      seen.add(href);

      // Walk up to find the card container
      const card = link.closest(
        "li, article, [class*='event'], [class*='card'], [class*='item'], [class*='tile']"
      ) || link.parentElement || link;

      // ── Event name ──
      // Priority: explicit heading > link text
      // Exclude elements that look like type badges (short, all-caps)
      let name = "";
      const headings = card.querySelectorAll("h1,h2,h3,h4,h5,[class*='title'],[class*='heading'],[class*='name']");
      for (const h of headings) {
        const t = h.innerText?.trim() || "";
        // Skip if it looks like a type badge (short, no spaces, or all caps keyword)
        if (t.length > 5 && !/^(webinar|conference|briefing|summit|in-person|sponsorship)$/i.test(t)) {
          name = t;
          break;
        }
      }
      if (!name) name = link.innerText?.trim() || "";

      // ── Type badge ──
      const typeBadge = card.querySelector(
        "[class*='type'],[class*='badge'],[class*='label'],[class*='format'],[class*='tag'],[class*='category']"
      )?.innerText?.trim() || "";

      // ── Listing-level date (partial — detail page will have full info) ──
      const listDate = card.querySelector(
        "[class*='date'],[class*='schedule'],[class*='time'],time"
      )?.innerText?.trim() || "";

      if (!name || name.length < 3) return;

      results.push({ name, type: typeBadge, listDate, url: href });
    });

    return results;
  }, BASE_URL);

  console.log(`  Found ${cards.length} event cards on listing page`);
  await listPage.close();

  if (cards.length === 0) {
    console.error("❌ No event cards found — check selector logic");
    await browser.close();
    process.exit(1);
  }

  // ── PHASE 2: Visit each event detail page ────────────────────────────────
  console.log(`▶  Phase 2: Scraping detail pages for ${cards.length} events…`);

  const detailPage = await context.newPage();
  detailPage.on("console", () => {});
  detailPage.on("pageerror", () => {});

  const events = [];

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    console.log(`  [${i + 1}/${cards.length}] ${card.url}`);

    let date = "", time = "", location = "", description = "";

    try {
      await detailPage.goto(card.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(2000);
      await dismissCookiebot(detailPage);

      // Extract structured fields from the detail page
      const detail = await detailPage.evaluate(() => {
        const get = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
        const getAll = (sel) => [...document.querySelectorAll(sel)]
          .map(el => el.innerText?.trim()).filter(Boolean);

        // ── Date ──
        // Look for a date pattern in structured elements first
        let date = get("[class*='date']:not([class*='update']):not([class*='post'])") ||
                   get("time") ||
                   get("[class*='when']") ||
                   get("[class*='schedule']");

        // ── Time ──
        let time = get("[class*='time']:not([class*='update'])") || "";

        // If date and time are combined in one element, try to split them
        // Pattern: "Wednesday, 14 May 2026 | 09:00 – 13:45 SGT"
        const combined = date || time;
        const timeMatch = combined.match(/\d{1,2}:\d{2}(?:\s*[–\-]\s*\d{1,2}:\d{2})?\s*[A-Z]{2,5}/);
        if (timeMatch) {
          time = timeMatch[0].trim();
          date = combined.replace(timeMatch[0], "").replace(/\s*\|\s*$/, "").trim();
        }

        // ── Location / Venue ──
        // Moody's typically shows venue name + city in a location block
        const locationCandidates = [
          get("[class*='location']"),
          get("[class*='venue']"),
          get("[class*='address']"),
          get("[class*='city']"),
          get("[class*='place']"),
        ].filter(Boolean);

        // Also try to find it after a pipe separator in the date line
        const rawDateLine = get("[class*='date']") || get("time") || "";
        const pipeParts = rawDateLine.split("|").map(s => s.trim());
        // Pipe parts that aren't a date or time are likely location
        const pipeLocation = pipeParts
          .slice(1)
          .find(p => !/^\d{1,2}:\d{2}/.test(p) && !/^[A-Z]{2,5}$/.test(p));

        const location = locationCandidates[0] || pipeLocation || "";

        // ── Description ──
        const description =
          get("[class*='desc']:not([class*='meta'])") ||
          get("[class*='intro']") ||
          get("[class*='summary']") ||
          get("main p") ||
          get("article p") || "";

        return { date, time, location, description };
      });

      date        = detail.date;
      time        = detail.time;
      location    = detail.location;
      description = detail.description?.slice(0, 300) || ""; // cap length

    } catch (err) {
      console.log(`    ⚠ Detail fetch failed: ${err.message}`);
      // Fall back to listing-level date
      date = card.listDate;
    }

    events.push({
      name:        card.name,
      type:        card.type,
      date:        date,
      time:        time,
      location:    location,
      description: description,
      url:         card.url,
    });

    // Small delay between detail page requests to be polite
    await sleep(800);
  }

  await detailPage.close();

  console.log(`✓  ${events.length} events with full detail`);

  // ── Write output ──────────────────────────────────────────────────────────
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    scrapedAt:   new Date().toISOString(),
    totalEvents: events.length,
    events,
  }, null, 2));

  console.log(`✓  Written → ${OUT_FILE}`);
  await browser.close();
  process.exit(0);
})();
