// Vercel Serverless Function: /api/scan
// Fetches Gumtree search pages server-side (no CORS needed) and returns parsed listings as JSON

const LOCATIONS = {
  adelaide:  { slug: "adelaide",  id: "3006878" },
  sydney:    { slug: "sydney",    id: "3003435" },
  melbourne: { slug: "melbourne", id: "3001317" },
  brisbane:  { slug: "brisbane",  id: "3005721" },
  perth:     { slug: "perth",     id: "3008303" },
  sa:        { slug: "sa",        id: "3008842" },
  australia: { slug: "australia", id: ""        },
};

function buildUrl(location, keyword, page) {
  const loc = LOCATIONS[location] || LOCATIONS.adelaide;
  const pg = page > 1 ? `page-${page}/` : "";
  const kw = keyword ? `${keyword.replace(/\s+/g, "+")}/k0` : "";
  if (kw) {
    return loc.id
      ? `https://www.gumtree.com.au/s-cars-vans-utes/${loc.slug}/${pg}${kw}c18320l${loc.id}?sort=date`
      : `https://www.gumtree.com.au/s-cars-vans-utes/${pg}${kw}c18320?sort=date`;
  }
  return loc.id
    ? `https://www.gumtree.com.au/s-cars-vans-utes/${loc.slug}/${pg}c18320l${loc.id}?sort=date`
    : `https://www.gumtree.com.au/s-cars-vans-utes/${pg}c18320?sort=date`;
}

function parseListings(html) {
  // Use regex-based parsing since we don't have DOMParser in Node
  const listings = [];
  const seen = new Set();

  // Match listing links: /s-ad/{suburb}/cars-vans-utes/{title-slug}/{id}
  const adPattern = /href="(\/s-ad\/[^"]*?\/(\d{7,}))"/g;
  let match;
  while ((match = adPattern.exec(html)) !== null) {
    const href = match[1];
    const guid = match[2];
    if (seen.has(guid)) continue;
    seen.add(guid);

    // Extract the title from the slug in the URL
    const parts = href.split("/");
    const titleSlug = parts[parts.length - 2] || "";
    const suburb = parts[2] || "";
    const titleFromSlug = titleSlug.replace(/-/g, " ");

    // Try to find the actual title near this link in the HTML
    // Look for the text content following this href
    const hrefPos = html.indexOf(href);
    const chunk = html.substring(hrefPos, hrefPos + 2000);

    // Extract title from title-section class
    let title = "";
    const titleMatch = chunk.match(/title[^>]*>(?:<[^>]*>)*\s*(?:Top)?\s*([^<]{5,120})/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }
    if (!title || title.length < 5) {
      title = titleFromSlug;
    }
    // Clean "Top" prefix from promoted listings
    title = title.replace(/^Top\s*/i, "").trim();

    // Extract price - look for $ followed by digits near this listing
    let price = null;
    const priceMatch = chunk.match(/\$\s*([\d,]+)/);
    if (priceMatch) {
      const p = parseFloat(priceMatch[1].replace(/,/g, ""));
      if (p > 500 && p < 5000000) price = p;
    }

    // Extract year from title
    let year = null;
    const yearMatch = title.match(/\b(19[89]\d|20[0-2]\d)\b/);
    if (yearMatch) year = parseInt(yearMatch[1]);

    // Extract km from nearby text
    let km = null;
    const kmMatch = chunk.match(/([d,]+)\s*km/i);
    if (kmMatch) km = kmMatch[1].replace(/,/g, "");

    // Extract image
    let thumbnail = null;
    const imgMatch = chunk.match(/src="(https?:\/\/[^"]*(?:img\.gumtree|i\.ebayimg)[^"]*)"/);
    if (imgMatch) thumbnail = imgMatch[1];

    const fullUrl = `https://www.gumtree.com.au${href}`;

    listings.push({
      guid,
      title,
      link: fullUrl,
      price,
      year,
      km,
      suburb,
      thumbnail,
      pubDate: new Date().toISOString(),
      description: `${title}${price ? " $" + price.toLocaleString() : ""}${km ? " " + km + "km" : ""}`,
    });
  }

  return listings;
}

export default async function handler(req, res) {
  // CORS headers for the frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { location = "adelaide", keyword, page = "1" } = req.query;

  const url = buildUrl(location, keyword, parseInt(page));

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Gumtree returned ${response.status}`,
        url,
      });
    }

    const html = await response.text();
    const listings = parseListings(html);

    return res.status(200).json({
      success: true,
      location,
      keyword: keyword || null,
      page: parseInt(page),
      count: listings.length,
      url,
      listings,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      url,
    });
  }
                                                                             }
