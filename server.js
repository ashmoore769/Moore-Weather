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
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

let cachedWeatherData = null;
let cachedDailyData = null;
let lastPollTime = null;
let lastDailyPollTime = null;
let dailyRefreshInFlight = null;

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

function updateWeatherData(attempt = 1, maxAttempts = 3) {
  const client = new net.Socket();
  let receivedData = "";
  let finished = false;

  const failAttempt = (reason) => {
    if (finished) return;
    finished = true;
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
    if (finished) return;
    finished = true;

    const cleaned = receivedData
      .replace(/^r3\s*/, "")
      .trim()
      .replace(/,?END$/, "");

    const fields = cleaned.split(",");

    // index.html consumes fields[0] through fields[30].
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
    failAttempt(`Socket error: ${err.message}`);
  });

  client.on("timeout", () => {
    failAttempt("Socket timeout");
  });
}

/* =========================================================
   DAILY SUMMARY - ONE STATION REQUEST

   This function is the ONLY place that sends MEM 1 LAST.
   Callers must perform the cache/date safety check first.
   ========================================================= */

function fetchDailyDataOnce() {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let receivedData = "";
    let finished = false;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      client.destroy();
      resolve(value);
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
    });

    client.on("close", () => {
      if (finished) return;

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
  if (cachedWeatherData) {
    return res.status(200).send(cachedWeatherData);
  }

  res.status(503).send("Weather data not available yet.");
});

app.get("/daily", async (req, res) => {
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

// Lightweight status endpoint. dailyUpToDate can later be used by
// daily.html to disable the Force Update button when the safety interlock
// says no station request is necessary.
app.get("/ping", (req, res) => {
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
