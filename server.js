require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");
const winston = require("winston");

const WEATHER_STATION_HOST =
  process.env.WEATHER_STATION_HOST || "myweather.ddns.net";

const WEATHER_STATION_PORT =
  Number(process.env.WEATHER_STATION_PORT) || 8899;

const PORT = process.env.PORT || 10000;

// Warwick / Brisbane is UTC+10 year-round (no DST).
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
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

let cachedWeatherData = null;
let cachedDailyData = null;
let lastPollTime = null;
let lastDailyPollTime = null;
let dailyRefreshInFlight = null;

/* =========================================================
   TIME HELPERS
   ========================================================= */

function getBrisbaneNow() {
  return new Date(Date.now() + BRISBANE_OFFSET_MS);
}

function sameBrisbaneCalendarDay(a, b) {
  if (!a || !b) return false;

  const aa = new Date(a.getTime() + BRISBANE_OFFSET_MS);
  const bb = new Date(b.getTime() + BRISBANE_OFFSET_MS);

  return (
    aa.getUTCFullYear() === bb.getUTCFullYear() &&
    aa.getUTCMonth() === bb.getUTCMonth() &&
    aa.getUTCDate() === bb.getUTCDate()
  );
}

function isPastDailyCutoff() {
  const now = getBrisbaneNow();
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const cutoffMinutes = DAILY_FETCH_HOUR * 60 + DAILY_FETCH_MINUTE;
  return minutesNow >= cutoffMinutes;
}

function getDelayUntilNextDailyFetch() {
  const nowUtcMs = Date.now();
  const brisbaneNow = getBrisbaneNow();

  const year = brisbaneNow.getUTCFullYear();
  const month = brisbaneNow.getUTCMonth();
  const day = brisbaneNow.getUTCDate();

  let targetUtcMs =
    Date.UTC(
      year,
      month,
      day,
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

/* =========================================================
   CURRENT WEATHER (r3)
   ========================================================= */

function updateWeatherData(attempt = 1, maxAttempts = 3) {
  const client = new net.Socket();
  let receivedData = "";
  let settled = false;

  const finishAttempt = () => {
    if (settled) return false;
    settled = true;
    return true;
  };

  const retry = (reason) => {
    if (!finishAttempt()) return;

    client.destroy();

    logger.warn(
      `[CURRENT] ${reason} (attempt ${attempt}/${maxAttempts})`
    );

    if (attempt < maxAttempts) {
      setTimeout(
        () => updateWeatherData(attempt + 1, maxAttempts),
        1000
      );
    }
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
  });

  client.on("close", () => {
    if (!finishAttempt()) return;

    const cleaned = receivedData
      .replace(/^r3\s*/, "")
      .trim()
      .replace(/,?END$/, "");

    const fields = cleaned.split(",");

    // index.html reads fields[30], so at least 31 fields are required.
    if (fields.length >= 31) {
      cachedWeatherData = cleaned;
      lastPollTime = new Date();

      logger.info(
        `[CURRENT] Weather data cached (${fields.length} fields)`
      );

      return;
    }

    logger.warn(
      `[CURRENT] Invalid r3 data: ${fields.length} fields, expected at least 31`
    );

    if (attempt < maxAttempts) {
      setTimeout(
        () => updateWeatherData(attempt + 1, maxAttempts),
        1000
      );
    }
  });

  client.on("error", (err) => {
    retry(`Socket error: ${err.message}`);
  });

  client.on("timeout", () => {
    retry("Socket timeout");
  });
}

/* =========================================================
   DAILY SUMMARY - ONE NETWORK ATTEMPT ONLY

   Browser requests never wait through a long retry sequence.
   Longer retry sequences happen only in the background.
   ========================================================= */

function fetchDailyDataOnce() {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let receivedData = "";
    let settled = false;

    const finish = (value) => {
      if (settled) return;

      settled = true;
      client.destroy();
      resolve(value);
    };

    client.setTimeout(5000);

    client.connect(
      WEATHER_STATION_PORT,
      WEATHER_STATION_HOST,
      () => {
        logger.info("[DAILY] Connected for MEM 1 LAST");
        client.write("MEM 1 LAST\r\n");
      }
    );

    client.on("data", (data) => {
      receivedData += data.toString();
    });

    client.on("close", () => {
      if (settled) return;

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

      logger.info(
        `[DAILY] Valid summary cached (${fields.length} fields)`
      );

      finish(cleaned);
    });

    client.on("error", (err) => {
      logger.warn(`[DAILY] Socket error: ${err.message}`);
      finish("");
    });

    client.on("timeout", () => {
      logger.warn("[DAILY] Socket timeout");
      finish("");
    });
  });
}

/* =========================================================
   DAILY SUMMARY - BACKGROUND RETRY ENGINE
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
        const delay = delaysMs[attempt - 1] || 0;

        if (delay > 0) {
          logger.info(
            `[DAILY] Background retry ${attempt}/${maxAttempts} in ${Math.round(
              delay / 1000
            )}s`
          );

          await new Promise((resolve) =>
            setTimeout(resolve, delay)
          );
        }

        logger.info(
          `[DAILY] Background fetch attempt ${attempt}/${maxAttempts}`
        );

        const data = await fetchDailyDataOnce();

        if (data) {
          logger.info(
            `[DAILY] Background refresh successful on attempt ${attempt}`
          );

          return data;
        }
      }

      logger.error(
        "[DAILY] Background refresh failed after all attempts"
      );

      return "";
    } finally {
      dailyRefreshInFlight = null;
    }
  })();

  return dailyRefreshInFlight;
}

/* =========================================================
   SCHEDULERS
   ========================================================= */

function scheduleNextDailyFetch() {
  const delay = getDelayUntilNextDailyFetch();

  logger.info(
    `[DAILY] Next automatic summary refresh in ${Math.round(
      delay / 1000
    )}s (09:10 Australia/Brisbane)`
  );

  setTimeout(async () => {
    await refreshDailyDataWithRetries();
    scheduleNextDailyFetch();
  }, delay);
}

function schedulePolling() {
  // Current readings every minute.
  setInterval(updateWeatherData, 60000);
  updateWeatherData();

  // If Render starts/restarts after 09:10 Brisbane time,
  // populate the daily cache in the background.
  if (isPastDailyCutoff()) {
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

// Current readings
app.get("/weather", (req, res) => {
  if (cachedWeatherData) {
    return res.status(200).send(cachedWeatherData);
  }

  res.status(503).send("Weather data not available yet.");
});

// Daily summary
app.get("/daily", async (req, res) => {
  const force = req.query.force === "1";

  const cacheIsFreshToday =
    cachedDailyData &&
    lastDailyPollTime &&
    sameBrisbaneCalendarDay(lastDailyPollTime, new Date());

  // Manual Force Update:
  // ONE network attempt only, so the browser does not hang.
  if (force) {
    const data = await fetchDailyDataOnce();

    if (data) {
      return res.status(200).send(data);
    }

    if (cachedDailyData) {
      logger.warn(
        "[DAILY] Force update failed; serving last known good cached summary"
      );

      return res.status(200).send(cachedDailyData);
    }

    return res
      .status(503)
      .send("Failed to retrieve valid daily summary.");
  }

  // Normal page load:
  // serve good cached data immediately.
  // If stale after 09:10, refresh in the background.
  if (cachedDailyData) {
    if (isPastDailyCutoff() && !cacheIsFreshToday) {
      refreshDailyDataWithRetries().catch((err) => {
        logger.error(
          `[DAILY] Background refresh error: ${err.message}`
        );
      });
    }

    return res.status(200).send(cachedDailyData);
  }

  // No cache exists, e.g. just after a Render restart:
  // allow ONE quick attempt.
  const data = await fetchDailyDataOnce();

  if (data) {
    return res.status(200).send(data);
  }

  // Continue recovery after replying to the browser.
  refreshDailyDataWithRetries().catch((err) => {
    logger.error(
      `[DAILY] Recovery background refresh error: ${err.message}`
    );
  });

  res.status(503).send("Failed to retrieve valid daily summary.");
});

// Diagnostics
app.get("/ping", (req, res) => {
  res.json({
    status: "online",
    weatherStationHost: WEATHER_STATION_HOST,
    weatherStationPort: WEATHER_STATION_PORT,

    lastWeatherPoll: lastPollTime
      ? lastPollTime.toISOString()
      : null,

    lastDailyPoll: lastDailyPollTime
      ? lastDailyPollTime.toISOString()
      : null,

    dailyCacheAvailable: Boolean(cachedDailyData),
    dailyRefreshInProgress: Boolean(dailyRefreshInFlight),
    dailySchedule: "09:10 Australia/Brisbane",
  });
});

// Default index page
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running at http://localhost:${PORT}`);
  schedulePolling();
});
