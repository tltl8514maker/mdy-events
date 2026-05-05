/**
 * moodys-scraper.js
 *
 * Phase 1: Load events.moodys.com, click "Load more" until exhausted
 * Phase 2: Visit each event detail page, extract structured fields using
 *          the exact Papillon platform DOM structure:
 *            - Type:     top badge text (e.g. "IN-PERSON CONFERENCE")
 *            - Date:     text after "schedule" icon
 *            - Location: text after "location_on" icon (in-person only)
 *
 * Writes events.json — no hardcoded event data.
 */

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const BASE_URL   = "https://events.moodys.com";
const OUT_FILE   = path.join(__dirname, "events.json");
const SETTLE_MS  = 3000;
const MAX_CLICKS = 40;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract just the date portion from a raw schedule string
// e.g. "Thursday, 26 February 2026 | 09:00 - 13:00 CET" → "Thursday, 26 February 2026"
// e.g. "Tuesday, 12 May 2026 | 09:00 VNT"               → "Tuesday, 12 May 2026"
function parseDate(raw) {
  if (!raw) return "";
  // Everything before the first "|" is the date
  const before = raw.split("|")[0].trim();
  // Remove any trailing time that crept in (e.g. no pipe separator)
  return before.replace(/\s+\d{1,2}:\d{2}.*$/, "").trim();
}

// Extract time from schedule string
// e.g. "Thursday, 26 Feb 2026 | 09:00 - 13:00 CET" → "09:00 - 13:00 CET"
// e.g. "Tuesday, 12 May 2026 | 09:00 VNT | 10:00 SGT" → "09:00 VNT"  (first tz only)
function parseTime(raw) {
  if (!raw) return "";
  const parts = raw.split("|").slice(1); // everything after first pipe
  if (!parts.length) return "";
  // First segment after pipe is the primary time
  return parts[0].trim();
}

// Extract city/country from a venue string
// e.g. "The Charles Hotel, Munich"           → "Munich, Germany" (via city lookup)
// e.g. "Marina Bay Sands, Singapore"         → "Singapore"
// e.g. "Mandarin Oriental, Kuala Lumpur, MY" → "Kuala Lumpur, Malaysia"
// Strategy: take the last comma-delimited segment; map known abbreviations
const COUNTRY_MAP = {
  "sg":"Singapore","my":"Malaysia","hk":"Hong Kong","jp":"Japan",
  "au":"Australia","cn":"China","kr":"South Korea","tw":"Taiwan",
  "in":"India","id":"Indonesia","th":"Thailand","ph":"Philippines",
  "vn":"Vietnam","nz":"New Zealand",
  "us":"United States","uk":"United Kingdom","gb":"United Kingdom",
  "de":"Germany","fr":"France","ch":"Switzerland","dk":"Denmark",
  "ae":"UAE","za":"South Africa","ng":"Nigeria","br":"Brazil",
  "es":"Spain","it":"Italy","nl":"Netherlands","se":"Sweden",
  "no":"Norway","at":"Austria","be":"Belgium","ie":"Ireland",
};

function parseLocation(raw) {
  if (!raw) return "";
  // Clean up map link artifact if present
  const clean = raw.replace(/\bMap\b.*$/i, "").trim();
  // Split by comma, take last meaningful parts
  const parts = clean.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];

  // Last part might be a 2-letter country code
  const last = parts[parts.length - 1];
  if (last.length <= 3 && COUNTRY_MAP[last.toLowerCase()]) {
    // Return second-to-last (city) + expanded country
    const city = parts[parts.length - 2];
    return `${city}, ${COUNTRY_MAP[last.toLowerCase()]}`;
  }

  // Otherwise return last two parts (usually "City, Country")
  return parts.slice(-2).join(", ");
}

// ── Cookiebot ─────────────────────────────────────────────────────────────────
async function dismissCookiebot(page) {
  try {
    await page.waitForSelector("#CybotCookiebotDialog", { timeout: 7000 });
    const btn = await page.$(
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll," +
      "#CybotCookiebotDialogBodyButtonAccept," +
      "button[id*='Allow'],button[id*='Accept']"
    );
    if (btn && await btn.isVisible()) { await btn.click(); await sleep(1000); return; }
  } catch { /* fall through */ }
  await page.evaluate(() => {
    document.querySelectorAll(
      "#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay," +
      "#CybotCookiebotDialogBodyOverlay,[id*='Cybot']"
    ).forEach(el => el.remove());
    document.body.style.overflow = "";
    document.body.style.pointerEvents = "";
  }).catch(() => {});
  await sleep(500);
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
  console.log("▶  Phase 1: Loading event listing…");
  const listPage = await context.newPage();
  listPage.on("console", () => {});
  listPage.on("pageerror", () => {});

  await listPage.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4000);
  await dismissCookiebot(listPage);

  try {
    await listPage.waitForSelector("a[href*='events.moodys.com/2026']", { timeout: 20000 });
  } catch { console.log("  (Link wait timed out — continuing)"); }
  await sleep(2000);

  // Click Load More until gone
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

    const before = await listPage.$$eval("a[href*='events.moodys.com/2026']", e => e.length).catch(() => 0);
    await btn.scrollIntoViewIfNeeded();
    await sleep(400);
    try { await btn.click({ timeout: 5000 }); }
    catch { await btn.evaluate(el => el.click()); }
    clicks++;
    console.log(`  Click ${clicks} (${before} events so far)…`);

    try {
      await listPage.waitForFunction(
        prev => document.querySelectorAll("a[href*='events.moodys.com/2026']").length > prev,
        before, { timeout: SETTLE_MS }
      );
    } catch { /* timeout OK */ }
    await sleep(1500);
  }

  // Collect all unique event URLs from listing page
  const eventUrls = await listPage.evaluate((base) => {
    const seen = new Set();
    const urls = [];
    document.querySelectorAll("a[href]").forEach(a => {
      const href = a.href || "";
      if (!href.startsWith(base + "/")) return;
      const slug = href.replace(base + "/", "").split(/[?#]/)[0];
      if (!slug || slug.length < 5) return;
      if (/^(faq|sign-in|register|contact|about|search|privacy|terms|sample|event-series)/.test(slug)) return;
      if (seen.has(href)) return;
      seen.add(href);
      urls.push(href);
    });
    return urls;
  }, BASE_URL);

  console.log(`  Found ${eventUrls.length} unique event URLs`);
  await listPage.close();

  // ── PHASE 2: Visit each detail page ──────────────────────────────────────
  console.log(`▶  Phase 2: Fetching detail pages…`);
  const detailPage = await context.newPage();
  detailPage.on("console", () => {});
  detailPage.on("pageerror", () => {});

  const events = [];

  for (let i = 0; i < eventUrls.length; i++) {
    const url = eventUrls[i];
    console.log(`  [${i + 1}/${eventUrls.length}] ${url}`);

    try {
      await detailPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(1800);
      await dismissCookiebot(detailPage);

      // Extract using Papillon's known DOM structure
      // The page always has:
      //   - An h1 for the event name
      //   - A "schedule" material icon followed by date/time text
      //   - A "location_on" material icon followed by venue text (in-person only)
      //   - A type badge near the top ("IN-PERSON CONFERENCE", "VIRTUAL EVENT", etc.)
      const detail = await detailPage.evaluate(() => {
        // ── Name: always the h1 ──
        const name = document.querySelector("h1")?.innerText?.trim() || "";

        // ── Type badge: small caps text near the top, before the h1 ──
        // On Papillon it's typically a <span> or <p> with class containing 'type', 'badge', 'label'
        // It also appears as plain text directly above the h1
        let type = "";
        const typeSelectors = [
          "[class*='event-type']","[class*='event_type']",
          "[class*='type-badge']","[class*='type_badge']",
          "[class*='format']","[class*='badge']",
        ];
        for (const sel of typeSelectors) {
          const el = document.querySelector(sel);
          if (el) { type = el.innerText?.trim(); break; }
        }
        // Fallback: look for text immediately before h1 that looks like a type
        if (!type) {
          const h1 = document.querySelector("h1");
          if (h1) {
            let prev = h1.previousElementSibling;
            while (prev) {
              const t = prev.innerText?.trim() || "";
              if (t && t.length < 60 && /conference|briefing|webinar|virtual|in.person|summit|forum/i.test(t)) {
                type = t; break;
              }
              prev = prev.previousElementSibling;
            }
          }
        }

        // ── Schedule (date + time): text node after the "schedule" icon ──
        // Material Icons render "schedule" as text content of a <i> or <span>
        let scheduleRaw = "";
        const allEls = document.querySelectorAll("*");
        for (const el of allEls) {
          if (el.children.length === 0 && el.innerText?.trim() === "schedule") {
            // Get the next sibling text or parent's text after the icon
            const parent = el.parentElement;
            if (parent) {
              const fullText = parent.innerText?.trim() || "";
              // Remove the "schedule" icon text itself
              scheduleRaw = fullText.replace(/^schedule\s*/i, "").trim();
            }
            if (!scheduleRaw) {
              // Try next sibling
              scheduleRaw = el.nextSibling?.textContent?.trim() ||
                            el.nextElementSibling?.innerText?.trim() || "";
            }
            if (scheduleRaw) break;
          }
        }

        // ── Location: text node after the "location_on" icon ──
        let locationRaw = "";
        for (const el of allEls) {
          if (el.children.length === 0 && el.innerText?.trim() === "location_on") {
            const parent = el.parentElement;
            if (parent) {
              locationRaw = parent.innerText?.trim().replace(/^location_on\s*/i, "").trim() || "";
            }
            if (!locationRaw) {
              locationRaw = el.nextSibling?.textContent?.trim() ||
                            el.nextElementSibling?.innerText?.trim() || "";
            }
            if (locationRaw) break;
          }
        }

        // ── Description: first meaningful paragraph after heading ──
        const description = document.querySelector("main p, article p, [class*='description'] p, [class*='intro'] p")
          ?.innerText?.trim()?.slice(0, 250) || "";

        return { name, type, scheduleRaw, locationRaw, description };
      });

      if (!detail.name) {
        console.log("    ⚠ No name found — skipping");
        continue;
      }

      events.push({
        name:        detail.name,
        type:        detail.type,
        date:        parseDate(detail.scheduleRaw),
        time:        parseTime(detail.scheduleRaw),
        location:    parseLocation(detail.locationRaw),
        description: detail.description,
        url,
      });

    } catch (err) {
      console.log(`    ⚠ Failed: ${err.message}`);
    }

    await sleep(600);
  }

  await detailPage.close();
  console.log(`✓  ${events.length} events extracted`);

  // ── Write ─────────────────────────────────────────────────────────────────
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    scrapedAt:   new Date().toISOString(),
    totalEvents: events.length,
    events,
  }, null, 2));

  console.log(`✓  Written → ${OUT_FILE}`);
  await browser.close();
  process.exit(0);
})();
