/**
 * moodys-scraper.js
 *
 * Phase 1 — Listing page: load events.moodys.com, click "Load more" until gone,
 *            collect all event URLs.
 * Phase 2 — Detail pages: visit each URL, extract:
 *              - name        (h1)
 *              - type        (badge text before h1, e.g. "IN-PERSON CONFERENCE")
 *              - date        (text after "schedule" Material Icon)
 *              - location    (text after "location_on" Material Icon)
 *   The Papillon platform renders Material Icons as literal text nodes containing
 *   "schedule" or "location_on" inside icon wrapper elements. We wait for them
 *   explicitly so JS has time to render.
 *
 * Writes events.json — zero hardcoded event data.
 */

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const BASE_URL   = "https://events.moodys.com";
const OUT_FILE   = path.join(__dirname, "events.json");
const MAX_CLICKS = 40;

// How long to wait for new cards to appear after each "Load more" click.
// The page takes ~3s to load new content, so we poll for up to 8s to be safe.
const LOAD_MORE_POLL_MS  = 8000;  // max time to wait for new links to appear
const LOAD_MORE_EXTRA_MS = 2500;  // additional settle after new links detected

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Parse helpers ─────────────────────────────────────────────────────────────

// "Wednesday, 14 May 2026 | 09:00 – 13:45 MYT" → "14 May 2026"
function parseDate(raw) {
  if (!raw) return "";
  const before = raw.split("|")[0]
    .replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s*/i, "")
    .trim();
  // Remove any time that crept in without a pipe
  return before.replace(/\s+\d{1,2}:\d{2}.*$/i, "").trim();
}

// "Wednesday, 14 May 2026 | 09:00 – 13:45 MYT | 16:00 SGT" → "09:00 – 13:45 MYT"
function parseTime(raw) {
  if (!raw) return "";
  const parts = raw.split("|");
  return parts.length > 1 ? parts[1].trim() : "";
}

// "Mandarin Oriental, Kuala Lumpur" → "Kuala Lumpur, Malaysia"
// "Marina Bay Sands, Singapore"     → "Singapore"
// "Tokyo, JP"                       → "Tokyo, Japan"
const CC = {
  sg:"Singapore", my:"Malaysia", hk:"Hong Kong", jp:"Japan",
  au:"Australia", cn:"China", kr:"South Korea", tw:"Taiwan",
  in:"India", id:"Indonesia", th:"Thailand", ph:"Philippines",
  vn:"Vietnam", nz:"New Zealand",
};
function parseLocation(raw) {
  if (!raw) return "";
  // Strip "Map" link text that Playwright sometimes picks up
  const s = raw.replace(/\s*Map\s*$/i, "").replace(/\n.*/s, "").trim();
  const parts = s.split(",").map(p => p.trim()).filter(Boolean);
  if (!parts.length) return s;
  const last = parts[parts.length - 1];
  // Country code → full name
  if (last.length <= 3 && CC[last.toLowerCase()]) {
    const city = parts.slice(0, -1).slice(-1)[0] || "";
    return city ? `${city}, ${CC[last.toLowerCase()]}` : CC[last.toLowerCase()];
  }
  // Return last two segments (usually "City, Country")
  return parts.length >= 2 ? parts.slice(-2).join(", ") : parts[0];
}

// ── Cookiebot ─────────────────────────────────────────────────────────────────
async function dismissCookiebot(page) {
  try {
    await page.waitForSelector("#CybotCookiebotDialog", { timeout: 6000 });
    const btn = await page.$(
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll," +
      "#CybotCookiebotDialogBodyButtonAccept," +
      "button[id*='Allow'],button[id*='Accept']"
    );
    if (btn && await btn.isVisible()) { await btn.click(); await sleep(1000); return; }
  } catch {}
  await page.evaluate(() => {
    document.querySelectorAll(
      "#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay," +
      "#CybotCookiebotDialogBodyOverlay,[id*='Cybot']"
    ).forEach(el => el.remove());
    document.body.style.overflow = "";
    document.body.style.pointerEvents = "";
  }).catch(() => {});
  await sleep(400);
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

  // ═══════════════════════════════════════════════════════ PHASE 1: LISTING
  console.log("\n▶  PHASE 1 — Listing page");
  const listPage = await context.newPage();
  listPage.on("console", () => {});
  listPage.on("pageerror", () => {});

  await listPage.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(5000);
  await dismissCookiebot(listPage);

  try {
    await listPage.waitForSelector("a[href*='events.moodys.com/']", { timeout: 15000 });
  } catch {}
  await sleep(2000);

  // Click Load More until gone
  let clicks = 0;
  async function findLoadMore() {
    for (const el of await listPage.$$("button, a[role='button']")) {
      try {
        const t = (await el.innerText()).trim().toLowerCase();
        if (await el.isVisible() && /^(load more|show more|view more|more events)$/.test(t))
          return el;
      } catch {}
    }
    return null;
  }

  while (clicks < MAX_CLICKS) {
    const btn = await findLoadMore();
    if (!btn) { console.log(`  ✓ Load more exhausted after ${clicks} click(s)`); break; }
    const before = await listPage.$$eval("a[href*='events.moodys.com/']", e => e.length).catch(() => 0);
    await btn.scrollIntoViewIfNeeded();
    await sleep(600);  // brief pause before clicking so button is fully stable
    try { await btn.click({ timeout: 5000 }); }
    catch { await btn.evaluate(el => el.click()); }
    clicks++;
    console.log(`  Click ${clicks} (${before} links visible before click)…`);

    // Wait up to LOAD_MORE_POLL_MS for new event links to appear in the DOM.
    // If links appear sooner, we detect it immediately via polling.
    // Either way we add LOAD_MORE_EXTRA_MS afterward for lazy-loaded content to settle.
    let appeared = false;
    try {
      await listPage.waitForFunction(
        prev => document.querySelectorAll("a[href*='events.moodys.com/']").length > prev,
        before,
        { timeout: LOAD_MORE_POLL_MS, polling: 300 }
      );
      appeared = true;
    } catch {
      // Timed out — new links didn't appear. Could mean no more pages,
      // or the page is very slow. We still settle before checking for the button.
    }

    const after = await listPage.$$eval("a[href*='events.moodys.com/']", e => e.length).catch(() => 0);
    console.log(`  → ${appeared ? "New links detected" : "No new links detected"} (now ${after} total). Settling…`);
    await sleep(LOAD_MORE_EXTRA_MS);
  }

  // Collect URLs
  const eventUrls = await listPage.evaluate((base) => {
    const seen = new Set();
    const SKIP = /^(faq|sign-in|register|contact|about|search|privacy|terms|sample|event-series|on-demand|agenda|replay|resources)/;
    return [...document.querySelectorAll("a[href]")]
      .map(a => a.href || "")
      .filter(href => {
        if (!href.startsWith(base + "/")) return false;
        const slug = href.replace(base + "/", "").split(/[?#]/)[0];
        if (!slug || slug.length < 4 || SKIP.test(slug)) return false;
        if (seen.has(href)) return false;
        seen.add(href);
        return true;
      });
  }, BASE_URL);

  console.log(`  → ${eventUrls.length} unique event URLs collected`);
  await listPage.close();

  // ═══════════════════════════════════════════════════════ PHASE 2: DETAILS
  console.log(`\n▶  PHASE 2 — Detail pages (${eventUrls.length} events)`);
  const dp = await context.newPage();
  dp.on("console", () => {});
  dp.on("pageerror", () => {});

  const events = [];

  for (let i = 0; i < eventUrls.length; i++) {
    const url = eventUrls[i];
    console.log(`  [${i+1}/${eventUrls.length}] ${url}`);

    try {
      await dp.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Wait for the h1 AND the schedule icon to appear — ensures JS has rendered
      await Promise.race([
        dp.waitForSelector("h1", { timeout: 10000 }),
        sleep(10000),
      ]);
      // Extra wait for Material Icons to render
      await sleep(2500);
      await dismissCookiebot(dp);

      const detail = await dp.evaluate(() => {
        // ── Name ──
        const name = document.querySelector("h1")?.innerText?.trim() || "";

        // ── Type badge ──
        // On Papillon the type sits just above the h1 in a small-caps element.
        // Try several strategies.
        let type = "";
        // Strategy A: explicit class selectors
        for (const sel of ["[class*='event-type']","[class*='event_type']",
                            "[class*='type-label']","[class*='format']",
                            "[class*='badge']","[class*='label']"]) {
          const el = document.querySelector(sel);
          if (el) { type = el.innerText?.trim() || ""; if (type) break; }
        }
        // Strategy B: sibling/parent text immediately before h1
        if (!type) {
          const h1 = document.querySelector("h1");
          if (h1) {
            // Walk up and check previous siblings
            const parent = h1.parentElement;
            if (parent) {
              let prev = h1.previousElementSibling;
              while (prev && !type) {
                const t = prev.innerText?.trim() || "";
                if (t && t.length < 80 &&
                    /conference|briefing|webinar|virtual|in.?person|summit|forum|event/i.test(t)) {
                  type = t;
                }
                prev = prev.previousElementSibling;
              }
            }
          }
        }
        // Clean type — strip long descriptions if it bled over
        if (type.length > 60) type = type.slice(0, 60);

        // ── Schedule & Location via Material Icons ──
        // Material Icons render as a text node equal to the icon name inside
        // an <i class="material-icons"> or <span class="material-icons"> element.
        // We find these by their text content.
        let scheduleRaw = "";
        let locationRaw = "";

        // First try: find elements whose ONLY text is "schedule" or "location_on"
        const allEls = [...document.querySelectorAll("*")];
        for (const el of allEls) {
          // Only leaf-level or icon wrapper elements
          const text = el.innerText?.trim() || "";
          const directText = [...el.childNodes]
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent?.trim())
            .join("") || "";

          if (!scheduleRaw && (text === "schedule" || directText === "schedule")) {
            // The parent or next sibling has the date text
            const parent = el.parentElement;
            if (parent) {
              const full = parent.innerText?.trim() || "";
              scheduleRaw = full.replace(/^schedule\s*/i, "").trim();
            }
            if (!scheduleRaw) {
              const sib = el.nextSibling;
              scheduleRaw = (sib?.textContent?.trim() || el.nextElementSibling?.innerText?.trim() || "");
            }
          }

          if (!locationRaw && (text === "location_on" || directText === "location_on")) {
            const parent = el.parentElement;
            if (parent) {
              const full = parent.innerText?.trim() || "";
              locationRaw = full.replace(/^location_on\s*/i, "").trim();
            }
            if (!locationRaw) {
              const sib = el.nextSibling;
              locationRaw = (sib?.textContent?.trim() || el.nextElementSibling?.innerText?.trim() || "");
            }
          }

          if (scheduleRaw && locationRaw) break;
        }

        // Fallback: search all text nodes for date-like patterns
        if (!scheduleRaw) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const t = node.textContent?.trim() || "";
            // Match "Monday, 12 May 2026" type patterns
            if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+\d/i.test(t)) {
              scheduleRaw = t;
              break;
            }
          }
        }

        // ── Description ──
        const desc = document.querySelector("main p, [class*='description'] p, [class*='intro'] p, article p")
          ?.innerText?.trim()?.slice(0, 250) || "";

        return { name, type, scheduleRaw, locationRaw, desc };
      });

      if (!detail.name) { console.log("    ⚠ No name — skipping"); continue; }

      const date     = parseDate(detail.scheduleRaw);
      const time     = parseTime(detail.scheduleRaw);
      const location = parseLocation(detail.locationRaw);

      console.log(`    name: ${detail.name}`);
      console.log(`    type: ${detail.type}`);
      console.log(`    date: ${date} | time: ${time} | location: ${location}`);

      events.push({
        name: detail.name,
        type: detail.type,
        date,
        time,
        location,
        description: detail.desc,
        url,
      });

    } catch (err) {
      console.log(`    ⚠ Error: ${err.message}`);
    }

    await sleep(700);
  }

  await dp.close();
  console.log(`\n✓  ${events.length} events extracted`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    scrapedAt:   new Date().toISOString(),
    totalEvents: events.length,
    events,
  }, null, 2));

  console.log(`✓  Written → ${OUT_FILE}`);
  await browser.close();
  process.exit(0);
})();
