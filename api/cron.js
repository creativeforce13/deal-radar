// Vercel Cron Job: /api/cron
// Runs every 5 minutes to scan Gumtree for new listings, build market data, and send email alerts
// Uses Vercel KV for persistent storage (or falls back to in-memory for demo)

const SCAN_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}/api/scan`
    : "http://localhost:3000/api/scan";

const ALERT_EMAIL = process.env.ALERT_EMAIL || "aaronannese@gmail.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const DEAL_THRESHOLD = parseInt(process.env.DEAL_THRESHOLD || "15");
const MIN_DATA_POINTS = parseInt(process.env.MIN_DATA_POINTS || "3");
const SCAN_LOCATION = process.env.SCAN_LOCATION || "adelaide";

// Known makes for auto-categorization
const KNOWN_MAKES = ["Toyota","Holden","Ford","Mazda","Hyundai","Kia","Mitsubishi","Nissan",
                       "Honda","Subaru","Volkswagen","BMW","Mercedes","Audi","Lexus","Suzuki","Isuzu","Jeep",
                       "Land Rover","Volvo","Peugeot","Renault","Skoda","Tesla","BYD","MG","GWM","Haval","LDV",
                       "Porsche","Mini","Chrysler","Dodge","RAM","Mahindra","Jaguar","Maserati"];

const KNOWN_MODELS = {
    toyota:["hilux","corolla","camry","rav4","landcruiser","land cruiser","prado","yaris","86","kluger","fortuner","hiace"],
    holden:["commodore","colorado","captiva","cruze","astra","barina","trax"],
    ford:["ranger","falcon","mustang","focus","fiesta","territory","everest","escape","transit"],
    mazda:["3","6","cx-3","cx-5","cx-9","bt-50","mx-5","cx-30"],
    hyundai:["i30","tucson","santa fe","kona","venue","staria","iload","accent","elantra"],
    nissan:["navara","patrol","x-trail","pathfinder","qashqai","juke","pulsar","leaf"],
    mitsubishi:["triton","outlander","pajero","asx","eclipse cross","lancer","express"],
    honda:["civic","cr-v","accord","hr-v","jazz","city","odyssey"],
    subaru:["wrx","forester","outback","impreza","xv","brz","liberty"],
    kia:["cerato","sportage","sorento","carnival","seltos","stinger","rio"],
    bmw:["3 series","5 series","x3","x5","1 series","m3","x1"],
    mercedes:["c class","e class","a class","gle","glc","amg","sprinter"],
    volkswagen:["golf","polo","tiguan","amarok","touareg","t-roc"],
    audi:["a3","a4","a5","q3","q5","q7"],
};

function categorize(title) {
    if (!title) return { make: null, model: null };
    const low = title.toLowerCase().replace(/[^a-z0-9\s\-]/g, " ");
    let make = null, model = null;
    for (const m of KNOWN_MAKES) {
          if (new RegExp(`\\b${m.toLowerCase()}\\b`).test(low)) { make = m; break; }
    }
    if (!make) return { make: null, model: null };
    const mods = KNOWN_MODELS[make.toLowerCase()];
    if (mods) {
          for (const mod of mods) {
                  if (new RegExp(`\\b${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low)) {
                            model = mod.charAt(0).toUpperCase() + mod.slice(1); break;
                  }
          }
    }
    return { make, model };
}

function mKey(make, model) {
    return `${(make || "").toLowerCase().trim()}_${(model || "").toLowerCase().trim()}`;
}

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Simple KV store using Vercel KV or environment-based persistence
let marketData = {};
let seenIds = new Set();
let kvStore = null;

async function getKV() {
    if (kvStore) return kvStore;
    // Try to use Vercel KV if available
  try {
        const { kv } = await import("@vercel/kv");
        kvStore = kv;
        return kv;
  } catch {
        return null;
  }
}

async function loadState() {
    const kv = await getKV();
    if (kv) {
          try {
                  marketData = (await kv.get("deal_radar_market")) || {};
                  const seenArr = (await kv.get("deal_radar_seen")) || [];
                  seenIds = new Set(seenArr);
          } catch (e) {
        console.error("KV load error:", e.message);
          }
    }
}

async function saveState() {
    const kv = await getKV();
    if (kv) {
          try {
                  await kv.set("deal_radar_market", marketData);
                  await kv.set("deal_radar_seen", Array.from(seenIds).slice(-5000));
          } catch (e) {
                  console.error("KV save error:", e.message);
          }
    }
}

async function sendEmailAlert(deals) {
    if (!RESEND_API_KEY || deals.length === 0) return false;

  const dealRows = deals.map(d => {
        const priceFmt = d.price ? `$${d.price.toLocaleString()}` : "Contact seller";
        const below = d.belowMarket ? ` (${d.belowMarket}% below market)` : "";
        return `
              <tr style="border-bottom:1px solid #e5e7eb;">
                      <td style="padding:12px 8px;">
                                <strong>${d.title}</strong><br/>
                                          <span style="color:#6b7280;font-size:13px;">${d.make || ""}${d.model ? " " + d.model : ""}${d.year ? " · " + d.year : ""}</span>
                                                  </td>
                                                          <td style="padding:12px 8px;text-align:right;">
                                                                    <span style="font-size:18px;font-weight:bold;color:#059669;">${priceFmt}</span>
                                                                              <br/><span style="color:#059669;font-size:12px;">${below}</span>
                                                                                      </td>
                                                                                              <td style="padding:12px 8px;text-align:center;">
                                                                                                        <a href="${d.link}" style="background:#2563eb;color:white;padding:6px 16px;border-radius:6px;text-decoration:none;font-size:13px;">View</a>
                                                                                                                </td>
                                                                                                                      </tr>`;
  }).join("");

  const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#1f2937;padding:20px;border-radius:12px 12px 0 0;">
                    <h1 style="color:white;margin:0;font-size:20px;">🚗 Deal Radar Alert</h1>
                            <p style="color:#9ca3af;margin:4px 0 0;font-size:14px;">${deals.length} underpriced vehicle${deals.length > 1 ? "s" : ""} found in ${SCAN_LOCATION}</p>
                                  </div>
                                        <table style="width:100%;border-collapse:collapse;background:white;">
                                                ${dealRows}
                                                      </table>
                                                            <div style="background:#f9fafb;padding:16px;border-radius:0 0 12px 12px;text-align:center;">
                                                                    <p style="color:#6b7280;font-size:12px;margin:0;">Deal Radar · Automated vehicle price monitoring</p>
                                                                          </div>
                                                                              </div>`;

  try {
        const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                          from: "Deal Radar <onboarding@resend.dev>",
                          to: [ALERT_EMAIL],
                          subject: `🔥 ${deals.length} Deal${deals.length > 1 ? "s" : ""} Found — ${deals[0].title.substring(0, 40)}`,
                          html,
                }),
        });
        const result = await res.json();
        console.log("Email sent:", result);
        return res.ok;
  } catch (e) {
        console.error("Email error:", e.message);
        return false;
  }
}

export default async function handler(req, res) {
    // Verify cron secret if configured
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
  }

  const startTime = Date.now();
    await loadState();

  try {
        // Fetch latest listings from our scan API
      const scanRes = await fetch(`${SCAN_URL}?location=${SCAN_LOCATION}`);
        if (!scanRes.ok) throw new Error(`Scan API returned ${scanRes.status}`);
        const scanData = await scanRes.json();
        const listings = scanData.listings || [];

      let newListings = 0;
        let newDataPoints = 0;
        const deals = [];

      for (const listing of listings) {
              const { make, model } = categorize(listing.title);
              if (!make) continue;

          const price = listing.price;
              const year = listing.year;
              const key = mKey(make, model);

          // Add data point to market intelligence
          if (price && price > 500) {
                    if (!marketData[key]) marketData[key] = { points: [] };
                    if (!marketData[key].points.find(p => p.guid === listing.guid)) {
                                marketData[key].points.push({
                                              guid: listing.guid, price, year,
                                              date: new Date().toISOString(),
                                });
                                // Keep last 500 data points per vehicle type
                      if (marketData[key].points.length > 500) {
                                    marketData[key].points = marketData[key].points.slice(-500);
                      }
                                newDataPoints++;
                    }
          }

          // Check if this is a new listing we haven't seen
          if (seenIds.has(listing.guid)) continue;
              seenIds.add(listing.guid);
              newListings++;

          // Evaluate deal quality
          if (!price || !marketData[key] || marketData[key].points.length < MIN_DATA_POINTS) continue;

          const prices = marketData[key].points.map(p => p.price).filter(p => p > 0);
              const med = median(prices);
              if (med <= 0) continue;

          const belowMarket = Math.round(((med - price) / med) * 100);
              if (belowMarket >= DEAL_THRESHOLD) {
                        deals.push({
                                    ...listing, make, model,
                                    marketMedian: med,
                                    belowMarket,
                                    dataPoints: prices.length,
                        });
              }
      }

      // Send email if deals found
      let emailSent = false;
        if (deals.length > 0) {
                deals.sort((a, b) => (b.belowMarket || 0) - (a.belowMarket || 0));
                emailSent = await sendEmailAlert(deals.slice(0, 10));
        }

      // Trim seen IDs
      if (seenIds.size > 10000) {
              const arr = Array.from(seenIds);
              seenIds = new Set(arr.slice(-5000));
      }

      await saveState();

      const totalVehicles = Object.keys(marketData).length;
        const totalPoints = Object.values(marketData).reduce((s, d) => s + (d.points?.length || 0), 0);

      return res.status(200).json({
              success: true,
              duration: Date.now() - startTime,
              scanned: listings.length,
              newListings,
              newDataPoints,
              dealsFound: deals.length,
              emailSent,
              marketStats: { vehicles: totalVehicles, dataPoints: totalPoints },
              deals: deals.slice(0, 5).map(d => ({
                        title: d.title, price: d.price, belowMarket: d.belowMarket,
                        make: d.make, model: d.model, link: d.link,
              })),
              timestamp: new Date().toISOString(),
      });
  } catch (error) {
        return res.status(500).json({ error: error.message });
  }
}
