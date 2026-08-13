require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const winston = require("winston");

const WEATHER_STATION_HOST =
  process.env.WEATHER_STATION_HOST || "myweather.ddns.net";

const WEATHER_STATION_PORT =
  Number(process.env.WEATHER_STATION_PORT) || 8899;

const PORT = process.env.PORT || 10000;

const SKYCAM_ORIGIN_BASE_URL =
  process.env.SKYCAM_ORIGIN_BASE_URL || "http://149.28.187.169";
const SKYCAM_ORIGIN_TOKEN = process.env.SKYCAM_ORIGIN_TOKEN || "";
const SKYCAM_ORIGIN_CA_CERT_B64 =
  process.env.SKYCAM_ORIGIN_CA_CERT_B64 || "";
const SKYCAM_HISTORY_CACHE_TTL_MS = Math.max(5000,
  Number(process.env.SKYCAM_HISTORY_CACHE_TTL_MS) || 10000
);
const SKYCAM_ORIGIN_TIMEOUT_MS = Math.max(3000,
  Number(process.env.SKYCAM_ORIGIN_TIMEOUT_MS) || 10000
);
const SKYCAM_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SKYCAM_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const SKYCAM_MAX_HISTORY_IMAGES = 1000;

let SKYCAM_ORIGIN_URL;
try {
  SKYCAM_ORIGIN_URL = new URL(SKYCAM_ORIGIN_BASE_URL);
} catch (error) {
  throw new Error("SKYCAM_ORIGIN_BASE_URL is not a valid URL.");
}

if (!["http:", "https:"].includes(SKYCAM_ORIGIN_URL.protocol)) {
  throw new Error("SKYCAM_ORIGIN_BASE_URL must use http:// or https://.");
}

const IS_RENDER = process.env.RENDER === "true";
if (IS_RENDER && SKYCAM_ORIGIN_URL.protocol !== "https:") {
  throw new Error(
    "Render must use an HTTPS SkyCam origin. Set SKYCAM_ORIGIN_BASE_URL to the protected Vultr HTTPS endpoint."
  );
}
if (IS_RENDER && SKYCAM_ORIGIN_TOKEN.length < 32) {
  throw new Error(
    "SKYCAM_ORIGIN_TOKEN is missing or too short. Run the Vultr origin installer first and save its generated token in Render."
  );
}

let skycamOriginCa = null;
if (SKYCAM_ORIGIN_CA_CERT_B64) {
  try {
    skycamOriginCa = Buffer.from(SKYCAM_ORIGIN_CA_CERT_B64, "base64").toString("utf8");
  } catch (error) {
    throw new Error("SKYCAM_ORIGIN_CA_CERT_B64 could not be decoded.");
  }

  if (!skycamOriginCa.includes("BEGIN CERTIFICATE")) {
    throw new Error("SKYCAM_ORIGIN_CA_CERT_B64 did not decode to a PEM certificate.");
  }
}

if (SKYCAM_ORIGIN_URL.protocol === "https:" && !skycamOriginCa) {
  throw new Error(
    "SKYCAM_ORIGIN_CA_CERT_B64 is required for the self-signed HTTPS SkyCam origin."
  );
}

const skycamHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const skycamHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  ca: skycamOriginCa || undefined,
  rejectUnauthorized: true,
});

// Queensland / Brisbane is UTC+10 year-round (no daylight saving).
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000;
const DAILY_FETCH_HOUR = 9;
const DAILY_FETCH_MINUTE = 10;

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: "weather.log",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.urlencoded({ extended: false, limit: "2kb" }));

/* =========================================================
   SHARED-PASSWORD AUTHENTICATION

   The password hash and cookie signing secret live ONLY in Render
   environment variables. No password is embedded in HTML or source.
   ========================================================= */

const AUTH_COOKIE_NAME = "moore_auth";
const AUTH_VERSION = process.env.MOORE_AUTH_VERSION || "1";
const configuredAuthMaxAgeDays = Number(process.env.MOORE_AUTH_MAX_AGE_DAYS);
// This portal deliberately uses a remembered-device login. Treat an old
// one-day environment value as stale configuration rather than unexpectedly
// signing every user out overnight. Explicit lifetimes of 30–3650 days remain
// configurable; otherwise the secure default is two years.
const AUTH_MAX_AGE_DAYS =
  Number.isFinite(configuredAuthMaxAgeDays) && configuredAuthMaxAgeDays >= 30
    ? Math.min(3650, configuredAuthMaxAgeDays)
    : 730;
if (Number.isFinite(configuredAuthMaxAgeDays) && configuredAuthMaxAgeDays < 30) {
  logger.warn(
    `[AUTH] Ignoring short MOORE_AUTH_MAX_AGE_DAYS=${configuredAuthMaxAgeDays}; using ${AUTH_MAX_AGE_DAYS} days`
  );
}
const AUTH_MAX_AGE_MS = AUTH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const AUTH_REFRESH_AFTER_MS = Math.min(
  AUTH_MAX_AGE_MS / 4,
  30 * 24 * 60 * 60 * 1000
);
const AUTH_PASSWORD_HASH = process.env.MOORE_AUTH_PASSWORD_HASH || "";
const AUTH_COOKIE_SECRET = process.env.MOORE_AUTH_COOKIE_SECRET || "";
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_LOCKOUT_MS = 30 * 60 * 1000;
const AUTH_MAX_FAILURES = 8;

function parsePasswordHash(value) {
  const parts = String(value).split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;

  try {
    const salt = Buffer.from(parts[1], "base64url");
    const hash = Buffer.from(parts[2], "base64url");

    if (salt.length < 16 || hash.length < 32) return null;
    return { salt, hash };
  } catch (error) {
    return null;
  }
}

const AUTH_PASSWORD_CONFIG = parsePasswordHash(AUTH_PASSWORD_HASH);

if (!AUTH_PASSWORD_CONFIG) {
  throw new Error(
    "MOORE_AUTH_PASSWORD_HASH is missing or invalid. Run tools/generate-auth-env.js and save the generated value in Render before deploying."
  );
}

if (AUTH_COOKIE_SECRET.length < 32) {
  throw new Error(
    "MOORE_AUTH_COOKIE_SECRET is missing or too short. Run tools/generate-auth-env.js and save the generated value in Render before deploying."
  );
}

function verifySharedPassword(password) {
  if (typeof password !== "string" || password.length === 0 || password.length > 256) {
    return false;
  }

  try {
    const derived = crypto.scryptSync(
      password,
      AUTH_PASSWORD_CONFIG.salt,
      AUTH_PASSWORD_CONFIG.hash.length
    );

    return crypto.timingSafeEqual(derived, AUTH_PASSWORD_CONFIG.hash);
  } catch (error) {
    return false;
  }
}

function signAuthBody(body) {
  return crypto
    .createHmac("sha256", AUTH_COOKIE_SECRET)
    .update(body)
    .digest("base64url");
}

function createAuthToken(now = Date.now()) {
  const payload = {
    v: AUTH_VERSION,
    iat: now,
    exp: now + AUTH_MAX_AGE_MS,
  };

  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signAuthBody(body)}`;
}

function verifyAuthToken(token) {
  if (typeof token !== "string" || token.length > 2048) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const body = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = signAuthBody(body);

  let supplied;
  let expected;

  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
    expected = Buffer.from(expectedSignature, "base64url");
  } catch (error) {
    return null;
  }

  if (supplied.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

    if (!payload || payload.v !== AUTH_VERSION) return null;
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;
    if (payload.iat > Date.now() + 5 * 60 * 1000) return null;
    if (payload.exp <= Date.now()) return null;
    if (payload.exp - payload.iat > AUTH_MAX_AGE_MS + 60 * 1000) return null;

    return payload;
  } catch (error) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = Object.create(null);

  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }

  return cookies;
}

function authCookieOptions(maxAge = AUTH_MAX_AGE_MS, now = Date.now()) {
  return {
    httpOnly: true,
    secure: process.env.RENDER === "true" || process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
    expires: new Date(now + maxAge),
  };
}

function setAuthCookie(res) {
  const now = Date.now();
  res.cookie(
    AUTH_COOKIE_NAME,
    createAuthToken(now),
    authCookieOptions(AUTH_MAX_AGE_MS, now)
  );
}

function clearAuthCookie(res) {
  const options = authCookieOptions();
  delete options.maxAge;
  delete options.expires;
  res.clearCookie(AUTH_COOKIE_NAME, options);
}

function authenticatedPayload(req) {
  const cookies = parseCookies(req);
  return verifyAuthToken(cookies[AUTH_COOKIE_NAME]);
}

function safeReturnPath(value) {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith("/login") || value.startsWith("/logout")) return "/";
  if (value.includes("\\") || /[\r\n]/.test(value)) return "/";
  return value;
}

function isHtmlNavigation(req) {
  if (req.method !== "GET") return false;
  const accept = req.get("accept") || "";
  return accept.includes("text/html");
}

const authFailures = new Map();

function clientKey(req) {
  return String(req.ip || req.socket.remoteAddress || "unknown");
}

function sweepAuthFailures(now = Date.now()) {
  if (authFailures.size < 100) return;

  for (const [key, state] of authFailures) {
    const staleAfter = Math.max(state.windowStartedAt + AUTH_FAILURE_WINDOW_MS, state.lockedUntil || 0);
    if (staleAfter < now) authFailures.delete(key);
  }
}

function loginIsLocked(req, now = Date.now()) {
  const state = authFailures.get(clientKey(req));
  return Boolean(state && state.lockedUntil && state.lockedUntil > now);
}

function recordLoginFailure(req, now = Date.now()) {
  const key = clientKey(req);
  let state = authFailures.get(key);

  if (!state || now - state.windowStartedAt > AUTH_FAILURE_WINDOW_MS) {
    state = { count: 0, windowStartedAt: now, lockedUntil: 0 };
  }

  state.count += 1;

  if (state.count >= AUTH_MAX_FAILURES) {
    state.lockedUntil = now + AUTH_LOCKOUT_MS;
  }

  authFailures.set(key, state);
  sweepAuthFailures(now);
  return state;
}

function clearLoginFailures(req) {
  authFailures.delete(clientKey(req));
}

// Search engines should not index this private portal, even if they discover it.
app.use((req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  next();
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.set("Cache-Control", "public, max-age=86400");
  res.send("User-agent: *\nDisallow: /\n");
});

// Public branding metadata lets browsers install the portal before/after the
// authenticated application shell without exposing readings or SkyCam data.
const PUBLIC_APP_ASSETS = new Map([
  ["/Weather_Station_App.png", "Weather_Station_App.png"],
  ["/moore-weather-touch-icon.png", "moore-weather-touch-icon.png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png"],
  ["/icon-192.png", "icon-192.png"],
  ["/icon-512.png", "icon-512.png"],
  ["/favicon.png", "favicon.png"],
  ["/favicon.ico", "favicon.png"],
  ["/site.webmanifest", "site.webmanifest"],
]);

for (const [route, filename] of PUBLIC_APP_ASSETS) {
  app.get(route, (req, res) => {
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(path.join(__dirname, "public", filename));
  });
}

app.get("/login", (req, res) => {
  const nextPath = safeReturnPath(req.query.next);

  if (authenticatedPayload(req)) {
    return res.redirect(302, nextPath);
  }

  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const nextPath = safeReturnPath(req.body.next);

  if (loginIsLocked(req)) {
    return res.redirect(
      303,
      `/login?error=locked&next=${encodeURIComponent(nextPath)}`
    );
  }

  if (!verifySharedPassword(req.body.password)) {
    const state = recordLoginFailure(req);
    const errorCode = state.lockedUntil > Date.now() ? "locked" : "invalid";

    return res.redirect(
      303,
      `/login?error=${errorCode}&next=${encodeURIComponent(nextPath)}`
    );
  }

  clearLoginFailures(req);
  setAuthCookie(res);
  logger.info("[AUTH] Device authorised");
  res.redirect(303, nextPath);
});

function handleLogout(req, res) {
  clearAuthCookie(res);
  res.set("Cache-Control", "no-store");
  res.redirect(req.method === "POST" ? 303 : 302, "/login?loggedOut=1");
}

app.get("/logout", handleLogout);
app.post("/logout", handleLogout);

app.use((req, res, next) => {
  const payload = authenticatedPayload(req);

  if (!payload) {
    clearAuthCookie(res);
    res.set("Cache-Control", "no-store");

    if (isHtmlNavigation(req)) {
      const nextPath = safeReturnPath(req.originalUrl || req.url || "/");
      return res.redirect(302, `/login?next=${encodeURIComponent(nextPath)}`);
    }

    return res.status(401).send("Authentication required.");
  }

  // Long-lived cookie with sliding renewal. Also upgrade any still-valid token
  // issued under the former one-day configuration as soon as that device next
  // uses the portal, so active users do not have to wait for it to expire.
  const issuedLifetime = payload.exp - payload.iat;
  const hasLegacyShortLifetime = issuedLifetime < AUTH_MAX_AGE_MS - 60 * 1000;
  if (hasLegacyShortLifetime || Date.now() - payload.iat >= AUTH_REFRESH_AFTER_MS) {
    setAuthCookie(res);
  }

  req.mooreAuth = payload;
  next();
});

// Static application files are intentionally mounted AFTER authentication.
// This protects index.html, daily.html, station branding and every other asset.
app.use(express.static(path.join(__dirname, "public")));

let cachedWeatherData = null;
let cachedDailyData = null;
let lastPollTime = null;
let lastDailyPollTime = null;
let dailyRefreshInFlight = null;
let dailyStationRequestInFlight = null;

// All commands share one physical UART/RS232 path through the EW10.
// Serialize CURRENT and DAILY transactions so replies can never cross between
// separate TCP clients.
let stationTransactionTail = Promise.resolve();
let stationTransactionActive = null;

function runStationTransaction(label, task) {
  const run = stationTransactionTail.then(async () => {
    stationTransactionActive = label;
    logger.info(`[STATION] Starting ${label}`);

    try {
      return await task();
    } finally {
      logger.info(`[STATION] Finished ${label}`);
      stationTransactionActive = null;
    }
  });

  // Keep the queue usable even if a transaction throws. The caller still gets
  // the original rejection from `run`; only the queue tail is recovered.
  stationTransactionTail = run.catch((err) => {
    logger.error(`[STATION] ${label} failed: ${err.message}`);
  });

  return run;
}

let skycamManifestCache = null;
let skycamManifestFetchedAt = 0;
let skycamManifestInFlight = null;

/* =========================================================
   BRISBANE DATE HELPERS
   ========================================================= */

function getBrisbaneDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + BRISBANE_OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function formatYmdSlash(year, month, day) {
  return `${String(year).padStart(4, "0")}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function getExpectedSummaryDate(date = new Date()) {
  // The page displays the daily summary as the PREVIOUS Brisbane calendar day.
  const now = getBrisbaneDateParts(date);
  const todayAtMidnightUtc = Date.UTC(now.year, now.month - 1, now.day);
  const yesterday = new Date(todayAtMidnightUtc - 24 * 60 * 60 * 1000);

  return formatYmdSlash(
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth() + 1,
    yesterday.getUTCDate()
  );
}

function getDisplayedSummaryDateFromDailyData(data) {
  if (!data) return null;

  const rawDate = String(data).split(",", 1)[0].trim();
  const match = rawDate.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);

  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // IMPORTANT:
  // daily.html subtracts one day from the first CSV date field before
  // displaying "Daily Summary for". Mirror that exact convention here.
  const displayed = new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000);

  return formatYmdSlash(
    displayed.getUTCFullYear(),
    displayed.getUTCMonth() + 1,
    displayed.getUTCDate()
  );
}

function isDailyDataCurrent(data, date = new Date()) {
  const displayedDate = getDisplayedSummaryDateFromDailyData(data);
  const expectedDate = getExpectedSummaryDate(date);

  return Boolean(displayedDate && displayedDate === expectedDate);
}

function isPastDailyCutoff(date = new Date()) {
  const now = getBrisbaneDateParts(date);
  const currentMinutes = now.hour * 60 + now.minute;
  const cutoffMinutes = DAILY_FETCH_HOUR * 60 + DAILY_FETCH_MINUTE;

  return currentMinutes >= cutoffMinutes;
}

function getDelayUntilNextDailyFetch(date = new Date()) {
  const nowUtcMs = date.getTime();
  const brisbaneNow = getBrisbaneDateParts(date);

  let targetUtcMs =
    Date.UTC(
      brisbaneNow.year,
      brisbaneNow.month - 1,
      brisbaneNow.day,
      DAILY_FETCH_HOUR,
      DAILY_FETCH_MINUTE,
      0,
      0
    ) - BRISBANE_OFFSET_MS;

  if (targetUtcMs <= nowUtcMs) {
    targetUtcMs += 24 * 60 * 60 * 1000;
  }

  return targetUtcMs - nowUtcMs;
}

function dailyCacheStatus() {
  return {
    available: Boolean(cachedDailyData),
    current: isDailyDataCurrent(cachedDailyData),
    displayedDate: getDisplayedSummaryDateFromDailyData(cachedDailyData),
    expectedDate: getExpectedSummaryDate(),
  };
}

/* =========================================================
   CURRENT WEATHER (r3)
   ========================================================= */

function runCurrentWeatherAttempt(attempt = 1, maxAttempts = 3) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let receivedData = "";
    let finished = false;

    const complete = (success) => {
      if (finished) return;
      finished = true;
      client.destroy();
      resolve(success);
    };

    // The EW10 can leave TCP open after the complete logger reply has arrived.
    // Validate/cache received data before treating timeout/close as failure.
    // Also reject a 43-field daily-summary response so it can never poison the
    // current-weather cache even if unexpected serial data is encountered.
    const cacheReceivedDataIfValid = () => {
      if (finished || !receivedData) return false;

      const cleaned = receivedData
        .replace(/^r3\s*/, "")
        .trim()
        .replace(/,?\s*\\?END.*$/i, "");

      const fields = cleaned.split(",");
      const hasCurrentShape =
        fields.length >= 31 &&
        fields.length !== 43 &&
        /^\d{4}\/\d{2}\/\d{2}$/.test(fields[0] || "") &&
        /^\d{2}:\d{2}:\d{2}$/.test(fields[1] || "");

      if (!hasCurrentShape) return false;

      cachedWeatherData = cleaned;
      lastPollTime = new Date();

      logger.info(
        `[CURRENT] Weather data cached (${fields.length} fields)`
      );

      complete(true);
      return true;
    };

    client.setTimeout(5000);

    client.connect(
      WEATHER_STATION_PORT,
      WEATHER_STATION_HOST,
      () => {
        logger.info(
          `[CURRENT] Connected for r3 (attempt ${attempt}/${maxAttempts})`
        );
        client.write("r3\r\n");
      }
    );

    client.on("data", (data) => {
      receivedData += data.toString();

      if (/\\?END\b/i.test(receivedData)) {
        cacheReceivedDataIfValid();
      }
    });

    client.on("close", () => {
      if (finished) return;
      if (cacheReceivedDataIfValid()) return;

      logger.warn(
        `[CURRENT] Invalid r3 response (attempt ${attempt}/${maxAttempts}); response rejected`
      );
      complete(false);
    });

    client.on("error", (err) => {
      if (cacheReceivedDataIfValid()) return;
      logger.warn(
        `[CURRENT] Socket error: ${err.message} (attempt ${attempt}/${maxAttempts})`
      );
      complete(false);
    });

    client.on("timeout", () => {
      if (cacheReceivedDataIfValid()) return;
      logger.warn(
        `[CURRENT] Socket timeout (attempt ${attempt}/${maxAttempts})`
      );
      complete(false);
    });
  });
}

async function updateWeatherData(attempt = 1, maxAttempts = 3) {
  const success = await runStationTransaction(
    `CURRENT r3 attempt ${attempt}/${maxAttempts}`,
    () => runCurrentWeatherAttempt(attempt, maxAttempts)
  );

  if (success || attempt >= maxAttempts) {
    return success;
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  return updateWeatherData(attempt + 1, maxAttempts);
}

/* =========================================================
   DAILY SUMMARY - ONE STATION REQUEST

   This function is the ONLY place that sends MEM 1 LAST.
   Callers must perform the cache/date safety check first.
   ========================================================= */

function fetchDailyDataOnce() {
  // Serialize the actual weather-station transaction. If a scheduled refresh,
  // page load and/or Force Update arrive together, they all share ONE request.
  if (dailyStationRequestInFlight) {
    logger.info("[DAILY] Joining existing MEM 1 LAST request");
    return dailyStationRequestInFlight;
  }

  const requestPromise = runStationTransaction("DAILY MEM 1 LAST", () =>
    new Promise((resolve) => {
    const client = new net.Socket();
    let receivedData = "";
    let finished = false;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      client.destroy();
      resolve(value);
    };

    // As with r3, the EW10 may leave TCP open after the complete logger reply
    // has arrived. Validate/cache the received summary before declaring a
    // timeout, and finish immediately when END is seen.
    const acceptReceivedDailyDataIfValid = () => {
      if (finished || !receivedData) return false;

      const lines = receivedData.split(/\r?\n/);
      const dataLine = lines.find((line) =>
        /^\d{4}\/\d{2}\/\d{2}/.test(line)
      );

      if (!dataLine) return false;

      const cleaned = dataLine
        .trim()
        .replace(/,?\s*\\?END.*$/i, "");

      const fields = cleaned.split(",");
      if (fields.length !== 43) return false;

      cachedDailyData = cleaned;
      lastDailyPollTime = new Date();

      const status = dailyCacheStatus();
      logger.info(
        `[DAILY] Valid summary cached; displayed=${status.displayedDate}, expected=${status.expectedDate}, current=${status.current}`
      );

      finish(cleaned);
      return true;
    };

    client.setTimeout(5000);

    client.connect(
      WEATHER_STATION_PORT,
      WEATHER_STATION_HOST,
      () => {
        logger.info("[DAILY] Sending MEM 1 LAST to weather station");
        client.write("MEM 1 LAST\r\n");
      }
    );

    client.on("data", (data) => {
      receivedData += data.toString();

      if (/\\?END\b/i.test(receivedData)) {
        acceptReceivedDailyDataIfValid();
      }
    });

    client.on("close", () => {
      if (finished) return;
      if (acceptReceivedDailyDataIfValid()) return;

      const lines = receivedData.split(/\r?\n/);
      const dataLine = lines.find((line) =>
        /^\d{4}\/\d{2}\/\d{2}/.test(line)
      );

      if (!dataLine) {
        logger.warn("[DAILY] No valid dated data line received");
        return finish("");
      }

      const cleaned = dataLine
        .trim()
        .replace(/,?\s*\\?END.*$/i, "");

      const fields = cleaned.split(",");

      if (fields.length !== 43) {
        logger.warn(
          `[DAILY] Invalid field count (${fields.length}), expected 43`
        );
        return finish("");
      }

      cachedDailyData = cleaned;
      lastDailyPollTime = new Date();

      const status = dailyCacheStatus();

      logger.info(
        `[DAILY] Valid summary cached; displayed=${status.displayedDate}, expected=${status.expectedDate}, current=${status.current}`
      );

      finish(cleaned);
    });

    client.on("error", (err) => {
      if (acceptReceivedDailyDataIfValid()) return;
      logger.warn(`[DAILY] Socket error: ${err.message}`);
      finish("");
    });

    client.on("timeout", () => {
      if (acceptReceivedDailyDataIfValid()) return;
      logger.warn("[DAILY] Socket timeout");
      finish("");
    });
  })
  );

  dailyStationRequestInFlight = requestPromise;

  return requestPromise.finally(() => {
    if (dailyStationRequestInFlight === requestPromise) {
      dailyStationRequestInFlight = null;
    }
  });
}

/* =========================================================
   DAILY SUMMARY - SAFE REFRESH INTERLOCK

   Rule:
   If the cached DISPLAYED summary date already equals
   Brisbane TODAY - 1 day, do NOT contact the station.
   ========================================================= */

async function refreshDailyDataIfNeeded() {
  const statusBefore = dailyCacheStatus();

  if (statusBefore.current) {
    logger.info(
      `[DAILY] Safety interlock: summary already current for ${statusBefore.expectedDate}; MEM 1 LAST skipped`
    );

    return cachedDailyData;
  }

  logger.info(
    `[DAILY] Refresh required; cached=${statusBefore.displayedDate || "none"}, expected=${statusBefore.expectedDate}`
  );

  return fetchDailyDataOnce();
}

/* =========================================================
   DAILY SUMMARY - BACKGROUND RETRIES

   Browser requests never wait through this retry chain.
   Each retry re-checks the safety interlock FIRST, so once
   the correct date is cached no more station commands are sent.
   ========================================================= */

async function refreshDailyDataWithRetries(
  maxAttempts = 5,
  delaysMs = [0, 10000, 20000, 30000, 60000]
) {
  if (dailyRefreshInFlight) {
    return dailyRefreshInFlight;
  }

  dailyRefreshInFlight = (async () => {
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Safety check before waiting and before every possible station call.
        if (isDailyDataCurrent(cachedDailyData)) {
          const status = dailyCacheStatus();
          logger.info(
            `[DAILY] Background refresh stopped: summary is current for ${status.expectedDate}`
          );
          return cachedDailyData;
        }

        const delay = delaysMs[attempt - 1] || 0;

        if (delay > 0) {
          logger.info(
            `[DAILY] Background retry ${attempt}/${maxAttempts} in ${Math.round(delay / 1000)}s`
          );

          await new Promise((resolve) => setTimeout(resolve, delay));

          // Re-check after the wait: another request may have updated the cache.
          if (isDailyDataCurrent(cachedDailyData)) {
            const status = dailyCacheStatus();
            logger.info(
              `[DAILY] Background retry cancelled: summary became current for ${status.expectedDate}`
            );
            return cachedDailyData;
          }
        }

        logger.info(
          `[DAILY] Background refresh attempt ${attempt}/${maxAttempts}`
        );

        const data = await refreshDailyDataIfNeeded();

        if (data && isDailyDataCurrent(data)) {
          logger.info(
            `[DAILY] Background refresh successful on attempt ${attempt}`
          );
          return data;
        }

        if (data) {
          const got = getDisplayedSummaryDateFromDailyData(data);
          logger.warn(
            `[DAILY] Station returned valid but stale summary date ${got}; expected ${getExpectedSummaryDate()}`
          );
        }
      }

      logger.error(
        `[DAILY] Background refresh exhausted ${maxAttempts} attempts; expected summary date ${getExpectedSummaryDate()}`
      );

      return cachedDailyData || "";
    } finally {
      dailyRefreshInFlight = null;
    }
  })();

  return dailyRefreshInFlight;
}

/* =========================================================
   SKYCAM PERSISTENT ORIGIN

   Vultr is the source of truth for SkyCam history. Render keeps only a
   short-lived JSON manifest cache; JPEGs are fetched on demand and never
   accumulated in process RAM. A Render restart therefore does not erase
   history.
   ========================================================= */

function skyCamOriginTarget(relativePath) {
  const pathValue = String(relativePath || "");
  if (!pathValue.startsWith("/")) {
    throw new Error("SkyCam origin paths must begin with '/'.");
  }
  return new URL(pathValue, SKYCAM_ORIGIN_URL.origin);
}

function fetchSkyCamOriginBuffer(relativePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const target = skyCamOriginTarget(relativePath);
    const transport = target.protocol === "https:" ? https : http;
    const agent = target.protocol === "https:" ? skycamHttpsAgent : skycamHttpAgent;
    const headers = {
      Accept: "*/*",
      "User-Agent": "Moore-Weather-Render/2",
    };

    if (SKYCAM_ORIGIN_TOKEN) {
      headers["X-SkyCam-Origin-Token"] = SKYCAM_ORIGIN_TOKEN;
    }

    const request = transport.request(
      target,
      {
        method: "GET",
        headers,
        agent,
      },
      (upstream) => {
        if (upstream.statusCode !== 200) {
          upstream.resume();
          reject(new Error(`SkyCam origin ${relativePath} returned HTTP ${upstream.statusCode}`));
          return;
        }

        const chunks = [];
        let totalBytes = 0;

        upstream.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            request.destroy(
              new Error(`SkyCam origin response exceeded ${maxBytes} byte safety limit`)
            );
            return;
          }
          chunks.push(chunk);
        });

        upstream.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            headers: upstream.headers,
          });
        });
      }
    );

    request.setTimeout(SKYCAM_ORIGIN_TIMEOUT_MS, () => {
      request.destroy(new Error(`SkyCam origin timeout for ${relativePath}`));
    });
    request.on("error", reject);
    request.end();
  });
}

function skyCamArchivePathFromId(id) {
  const match = String(id || "").match(/^SkyCam_00_(\d{4})(\d{2})(\d{2})(\d{6})$/);
  if (!match) return null;
  return `/archive/${match[1]}/${match[2]}/${match[3]}/${id}.jpg`;
}

function normalizeSkyCamManifest(payload) {
  if (!payload || !Array.isArray(payload.images)) {
    throw new Error("SkyCam history manifest did not contain an images array");
  }

  const images = [];
  const seen = new Set();

  for (const raw of payload.images) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "");
    if (!skyCamArchivePathFromId(id) || seen.has(id)) continue;

    const captured = new Date(raw.capturedAt);
    if (Number.isNaN(captured.getTime())) continue;

    seen.add(id);
    images.push({
      id,
      capturedAt: captured.toISOString(),
      size: Number.isFinite(Number(raw.size)) ? Number(raw.size) : null,
    });
  }

  images.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  if (images.length > SKYCAM_MAX_HISTORY_IMAGES) {
    images.splice(0, images.length - SKYCAM_MAX_HISTORY_IMAGES);
  }

  return {
    generatedAt: payload.generatedAt || null,
    maxImages: Math.min(SKYCAM_MAX_HISTORY_IMAGES, Number(payload.maxImages) || SKYCAM_MAX_HISTORY_IMAGES),
    count: images.length,
    latestId: images.length ? images[images.length - 1].id : null,
    images,
  };
}

async function fetchSkyCamManifestFromOrigin() {
  const { buffer } = await fetchSkyCamOriginBuffer(
    "/history.json",
    SKYCAM_MAX_MANIFEST_BYTES
  );

  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error("SkyCam origin history.json was not valid JSON");
  }

  const manifest = normalizeSkyCamManifest(parsed);
  skycamManifestCache = manifest;
  skycamManifestFetchedAt = Date.now();
  logger.info(`[SKYCAM] Origin manifest refreshed (${manifest.count} images)`);
  return manifest;
}

async function getSkyCamManifest(force = false) {
  const age = Date.now() - skycamManifestFetchedAt;
  if (!force && skycamManifestCache && age < SKYCAM_HISTORY_CACHE_TTL_MS) {
    return skycamManifestCache;
  }

  if (skycamManifestInFlight) return skycamManifestInFlight;

  skycamManifestInFlight = fetchSkyCamManifestFromOrigin()
    .catch((error) => {
      if (skycamManifestCache) {
        logger.warn(`[SKYCAM] Manifest refresh failed; serving stale manifest: ${error.message}`);
        return skycamManifestCache;
      }
      throw error;
    })
    .finally(() => {
      skycamManifestInFlight = null;
    });

  return skycamManifestInFlight;
}

/* =========================================================
   SCHEDULERS
   ========================================================= */

function scheduleNextDailyFetch() {
  const delay = getDelayUntilNextDailyFetch();

  logger.info(
    `[DAILY] Next automatic check in ${Math.round(delay / 1000)}s (09:10 Australia/Brisbane)`
  );

  setTimeout(async () => {
    // This is a CHECK first, not a blind station poll.
    await refreshDailyDataWithRetries();
    scheduleNextDailyFetch();
  }, delay);
}

function schedulePolling() {
  // Current readings every minute.
  setInterval(updateWeatherData, 60000);
  updateWeatherData();

  // If Render starts/restarts after 09:10 Brisbane time and there is
  // no current daily cache, recover it in the background.
  if (isPastDailyCutoff() && !isDailyDataCurrent(cachedDailyData)) {
    refreshDailyDataWithRetries().catch((err) => {
      logger.error(
        `[DAILY] Startup background refresh error: ${err.message}`
      );
    });
  }

  scheduleNextDailyFetch();
}

/* =========================================================
   ROUTES
   ========================================================= */

app.get("/weather", (req, res) => {
  res.set("Cache-Control", "no-store");

  if (cachedWeatherData) {
    return res.status(200).send(cachedWeatherData);
  }

  res.status(503).send("Weather data not available yet.");
});

app.get("/daily", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const force = req.query.force === "1";
  const status = dailyCacheStatus();

  // HARD SAFETY INTERLOCK:
  // If yesterday's summary is already cached, NEVER send MEM 1 LAST,
  // even when the user presses Force Update.
  if (status.current) {
    logger.info(
      `[DAILY] ${force ? "Force update" : "Page load"}: cache already current for ${status.expectedDate}; station not contacted`
    );

    return res.status(200).send(cachedDailyData);
  }

  // Force Update is allowed only when the cached summary is missing/stale.
  // Perform ONE bounded request (~5 seconds maximum), never a long retry chain.
  if (force) {
    const data = await refreshDailyDataIfNeeded();

    if (data) {
      // If the station still returns an older valid record, return it but
      // start recovery attempts in the background.
      if (!isDailyDataCurrent(data)) {
        refreshDailyDataWithRetries().catch((err) => {
          logger.error(
            `[DAILY] Post-force background refresh error: ${err.message}`
          );
        });
      }

      return res.status(200).send(data);
    }

    if (cachedDailyData) {
      return res.status(200).send(cachedDailyData);
    }

    return res
      .status(503)
      .send("Failed to retrieve valid daily summary.");
  }

  // Normal page load with a stale but valid cache:
  // return it instantly; update it in the background after 09:10.
  if (cachedDailyData) {
    if (isPastDailyCutoff()) {
      refreshDailyDataWithRetries().catch((err) => {
        logger.error(
          `[DAILY] Background refresh error: ${err.message}`
        );
      });
    }

    return res.status(200).send(cachedDailyData);
  }

  // No cache at all (typically after a Render restart):
  // one bounded station request is necessary because the server has
  // nothing local to compare against.
  const data = await refreshDailyDataIfNeeded();

  if (data) {
    if (!isDailyDataCurrent(data) && isPastDailyCutoff()) {
      refreshDailyDataWithRetries().catch((err) => {
        logger.error(
          `[DAILY] Recovery background refresh error: ${err.message}`
        );
      });
    }

    return res.status(200).send(data);
  }

  // Do not make the browser wait while further recovery happens.
  if (isPastDailyCutoff()) {
    refreshDailyDataWithRetries().catch((err) => {
      logger.error(
        `[DAILY] Recovery background refresh error: ${err.message}`
      );
    });
  }

  res.status(503).send("Failed to retrieve valid daily summary.");
});

// Lightweight status endpoint used by daily.html to reflect the
// safety interlock and background/station refresh state.
app.get("/skycam/latest.jpg", async (req, res) => {
  try {
    const { buffer, headers } = await fetchSkyCamOriginBuffer(
      "/latest.jpg",
      SKYCAM_MAX_IMAGE_BYTES
    );

    res.set("Content-Type", headers["content-type"] || "image/jpeg");
    res.set("Content-Length", String(buffer.length));
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  } catch (error) {
    logger.error(`[SKYCAM] Latest image failed: ${error.message}`);
    res.status(502).send("SkyCam image unavailable.");
  }
});

app.get("/skycam/history", async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const manifest = await getSkyCamManifest(req.query.refresh === "1");
    res.json({
      count: manifest.count,
      maxImages: manifest.maxImages,
      generatedAt: manifest.generatedAt,
      persistent: true,
      images: manifest.images.map((entry) => ({
        id: entry.id,
        capturedAt: entry.capturedAt,
        url: `/skycam/history/${encodeURIComponent(entry.id)}`,
      })),
    });
  } catch (error) {
    logger.error(`[SKYCAM] History manifest failed: ${error.message}`);
    res.status(502).json({ error: "SkyCam history unavailable." });
  }
});

app.get("/skycam/history/:id", async (req, res) => {
  const archivePath = skyCamArchivePathFromId(req.params.id);
  if (!archivePath) {
    return res.status(404).send("SkyCam history image not found.");
  }

  try {
    const manifest = await getSkyCamManifest(false);
    const entry = manifest.images.find((item) => item.id === req.params.id);
    if (!entry) {
      return res.status(404).send("SkyCam history image not found.");
    }

    const { buffer, headers } = await fetchSkyCamOriginBuffer(
      archivePath,
      SKYCAM_MAX_IMAGE_BYTES
    );

    res.set("Content-Type", headers["content-type"] || "image/jpeg");
    res.set("Content-Length", String(buffer.length));
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  } catch (error) {
    logger.error(`[SKYCAM] History image ${req.params.id} failed: ${error.message}`);
    res.status(502).send("SkyCam history image unavailable.");
  }
});

app.get("/skycam/download/:id", async (req, res) => {
  const archivePath = skyCamArchivePathFromId(req.params.id);
  if (!archivePath) {
    return res.status(404).send("SkyCam history image not found.");
  }

  try {
    const manifest = await getSkyCamManifest(false);
    const entry = manifest.images.find((item) => item.id === req.params.id);
    if (!entry) {
      return res.status(404).send("SkyCam history image not found.");
    }

    const { buffer, headers } = await fetchSkyCamOriginBuffer(
      archivePath,
      SKYCAM_MAX_IMAGE_BYTES
    );

    // The strict ID validator above makes this filename header-safe.
    const filename = entry.id.replace(
      /^SkyCam_00_(\d{8})(\d{6})$/,
      "SkyCam_$1_$2"
    ) + ".jpg";

    res.set("Content-Type", headers["content-type"] || "image/jpeg");
    res.set("Content-Length", String(buffer.length));
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  } catch (error) {
    logger.error(`[SKYCAM] Download ${req.params.id} failed: ${error.message}`);
    res.status(502).send("SkyCam image download unavailable.");
  }
});

app.get("/ping", (req, res) => {
  res.set("Cache-Control", "no-store");

  const dailyStatus = dailyCacheStatus();

  res.json({
    status: "online",
    weatherStationHost: WEATHER_STATION_HOST,
    weatherStationPort: WEATHER_STATION_PORT,
    lastWeatherPoll: lastPollTime ? lastPollTime.toISOString() : null,
    lastDailyPoll: lastDailyPollTime ? lastDailyPollTime.toISOString() : null,
    dailyCacheAvailable: dailyStatus.available,
    dailyUpToDate: dailyStatus.current,
    dailySummaryDate: dailyStatus.displayedDate,
    expectedDailySummaryDate: dailyStatus.expectedDate,
    dailyRefreshInProgress: Boolean(dailyRefreshInFlight),
    dailyStationRequestInProgress: Boolean(dailyStationRequestInFlight),
    stationTransactionActive,
    skycamHistoryCount: skycamManifestCache ? skycamManifestCache.count : null,
    skycamManifestLastRefresh: skycamManifestFetchedAt
      ? new Date(skycamManifestFetchedAt).toISOString()
      : null,
    skycamHistoryPersistent: true,
    dailySchedule: "09:10 Australia/Brisbane",
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  logger.info(`Server running at http://localhost:${PORT}`);
  schedulePolling();
});
