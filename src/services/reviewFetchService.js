const REVIEW_THEME_PATTERNS = {
  response_time: /slow(?:er|ly|ness)?|waited|never heard back|had to chase|took (?:too )?long|unresponsive|days? to respond/i,
  scheduling: /hard(?:er)? to book|scheduling (?:issue|problem)|no appointment|rescheduled|couldn't book/i,
  support: /(?:no |poor |bad )?(?:customer )?support|no reply|ticket ignored|couldn't reach|no response to|reached out.*never/i,
  onboarding: /onboard(?:ing)?|set(?:ting )?up|confus(?:ing|ed) (?:at first|to start)|learning curve|hard to get started/i,
  billing_admin: /bill(?:ing|ed)|invoic(?:e|ing)|charg(?:ed|ing) (?:wrong|incorrectly)|overcharg|refund|payment issue/i,
  comms: /no update|kept (?:in )?(?:the )?dark|no communication|didn't hear(?:back| from)|out of (?:the )?loop|proactive.*missing/i,
  followthrough: /forgot|fell through|dropped (?:the ball|it)|follow.?up|didn't (?:do|complete|follow)|never completed/i,
};

const BUSINESS_TYPE_SOURCES = {
  saas:      (name) => [`https://www.g2.com/search#q=${encodeURIComponent(name)}&t=products`, `https://www.capterra.com/search/#q=${encodeURIComponent(name)}`],
  agency:    (name) => [`https://clutch.co/profile/${name.toLowerCase().replace(/\s+/g, "-")}`, `https://www.g2.com/search#q=${encodeURIComponent(name)}&t=products`],
  ecommerce: (name) => [`https://www.trustpilot.com/search?query=${encodeURIComponent(name)}`],
  clinic:    (name) => [`https://www.healthgrades.com/group-directory/search?q=${encodeURIComponent(name)}`, `https://www.yelp.com/search?find_desc=${encodeURIComponent(name)}`],
  default:   (name) => [`https://www.trustpilot.com/search?query=${encodeURIComponent(name)}`, `https://www.g2.com/search#q=${encodeURIComponent(name)}&t=products`],
};

function detectBusinessType(industry) {
  const lower = String(industry || "").toLowerCase();
  if (/saas|software|fintech|tech|ai\b|platform|api|devops|cloud/.test(lower)) return "saas";
  if (/agenc|marketing|consult|design|creative|pr\b|media|branding/.test(lower)) return "agency";
  if (/ecommerc|retail|dtc|direct.to.consumer|online.?shop/.test(lower)) return "ecommerce";
  if (/clinic|dental|medic|health|therap|wellness|hospital/.test(lower)) return "clinic";
  return "default";
}

function themeTagReviews(text) {
  const content = String(text || "");
  const negativeThemes = {};
  for (const [theme, pattern] of Object.entries(REVIEW_THEME_PATTERNS)) {
    const matches = content.match(new RegExp(pattern.source, "gi"));
    if (matches && matches.length > 0) {
      negativeThemes[theme] = matches.length;
    }
  }
  return negativeThemes;
}

const JINA_BASE = "https://r.jina.ai/";
const FETCH_TIMEOUT_MS = 12000;
const MAX_REVIEW_CHARS = 8000;

async function tryJinaFetch(url, abortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(`${JINA_BASE}${url}`, { signal: controller.signal });
    if (!response.ok) return "";
    const text = await response.text();
    return String(text || "").slice(0, MAX_REVIEW_CHARS);
  } catch (_err) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReviews(companyName, industry, abortSignal) {
  const company = String(companyName || "").trim();
  if (!company) {
    return { reviewText: "", reviewThemesNegative: {}, reviewThemesPositive: {}, reviewSignal: "none" };
  }

  const businessType = detectBusinessType(industry);
  const urlBuilders = BUSINESS_TYPE_SOURCES[businessType] || BUSINESS_TYPE_SOURCES.default;
  const urls = urlBuilders(company);

  let reviewText = "";
  for (const url of urls) {
    if (reviewText.length >= MAX_REVIEW_CHARS) break;
    const content = await tryJinaFetch(url, abortSignal);
    if (content && content.length > 200) {
      reviewText += "\n" + content;
    }
  }

  reviewText = reviewText.trim().slice(0, MAX_REVIEW_CHARS);
  const reviewThemesNegative = themeTagReviews(reviewText);
  const reviewSignal = Object.keys(reviewThemesNegative).length > 0 ? "evidence" : "none";

  return {
    reviewText,
    reviewThemesNegative,
    reviewThemesPositive: {},
    reviewSignal,
  };
}

module.exports = { fetchReviews, themeTagReviews, detectBusinessType };
