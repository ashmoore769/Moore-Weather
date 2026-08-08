require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const winston = require("winston");

const WEATHER_STATION_HOST =
  process.env.WEATHER_STATION_HOST || "myweather.ddns.net";

const WEATHER_STATION_PORT =
  Number(process.env.WEATHER_STATION_PORT) || 8899;

const PORT = process.env.PORT || 10000;

const SKYCAM_UPSTREAM_URL =
  process.env.SKYCAM_UPSTREAM_URL || "http://149.28.187.169/latest.jpg";

// Rolling SkyCam cache. The byte cap protects the Render process from
// unbounded memory growth; the oldest images are discarded first.
const SKYCAM_HISTORY_INTERVAL_MS =
  Number(process.env.SKYCAM_HISTORY_INTERVAL_MS) || 60000;
const SKYCAM_HISTORY_MAX_IMAGES =
  Number(process.env.SKYCAM_HISTORY_MAX_IMAGES) || 1000;
const SKYCAM_HISTORY_MAX_BYTES =
  Number(process.env.SKYCAM_HISTORY_MAX_BYTES) || 128 * 1024 * 1024;

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

const skycamHistory = [];
let skycamHistoryBytes = 0;
let skycamLastHash = null;
let skycamSnapshotInFlight = null;

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
   SKYCAM ROLLING HISTORY CACHE
   ========================================================= */

function fetchSkyCamBuffer() {
  return new Promise((resolve, reject) => {
    const request = http.get(SKYCAM_UPSTREAM_URL, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        return reject(
          new Error(`Upstream returned HTTP ${upstream.statusCode}`)
        );
      }

      const chunks = [];
      let totalBytes = 0;
      const MAX_SINGLE_IMAGE_BYTES = 10 * 1024 * 1024;

      upstream.on("data", (chunk) => {
        totalBytes += chunk.length;

        if (totalBytes > MAX_SINGLE_IMAGE_BYTES) {
          request.destroy(new Error("SkyCam image exceeded 10 MB safety limit"));
          return;
        }

        chunks.push(chunk);
      });

      upstream.on("end", () => {
        resolve({
          buffer: Buffer.concat(chunks),
          lastModified: upstream.headers["last-modified"] || null,
        });
      });
    });

    request.setTimeout(5000, () => {
      request.destroy(new Error("SkyCam upstream timeout"));
    });

    request.on("error", reject);
  });
}

function addSkyCamSnapshot(buffer, capturedAt = new Date()) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");

  // The camera may leave latest.jpg unchanged between captures.
  // Do not waste memory storing duplicate frames.
  if (hash === skycamLastHash) {
    return false;
  }

  const timestamp = capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime())
    ? capturedAt
    : new Date();

  const entry = {
    id: `${timestamp.getTime()}-${hash.slice(0, 12)}`,
    capturedAt: timestamp.toISOString(),
    hash,
    size: buffer.length,
    buffer,
  };

  skycamHistory.push(entry);
  skycamHistoryBytes += entry.size;
  skycamLastHash = hash;

  while (
    skycamHistory.length > SKYCAM_HISTORY_MAX_IMAGES ||
    skycamHistoryBytes > SKYCAM_HISTORY_MAX_BYTES
  ) {
    const removed = skycamHistory.shift();
    if (!removed) break;
    skycamHistoryBytes -= removed.size;
  }

  logger.info(
    `[SKYCAM] Cached frame ${entry.id}; ${skycamHistory.length} images, ${Math.round(skycamHistoryBytes / 1024 / 1024)} MB`
  );

  return true;
}

function captureSkyCamSnapshot() {
  if (skycamSnapshotInFlight) {
    return skycamSnapshotInFlight;
  }

  skycamSnapshotInFlight = (async () => {
    try {
      const { buffer, lastModified } = await fetchSkyCamBuffer();
      const parsedLastModified = lastModified ? new Date(lastModified) : new Date();
      addSkyCamSnapshot(buffer, parsedLastModified);
    } catch (err) {
      logger.warn(`[SKYCAM] History capture failed: ${err.message}`);
    } finally {
      skycamSnapshotInFlight = null;
    }
  })();

  return skycamSnapshotInFlight;
}

function scheduleSkyCamHistory() {
  captureSkyCamSnapshot();
  setInterval(captureSkyCamSnapshot, SKYCAM_HISTORY_INTERVAL_MS);
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
  scheduleSkyCamHistory();
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
app.get("/skycam/latest.jpg", (req, res) => {
  const request = http.get(SKYCAM_UPSTREAM_URL, (upstream) => {
    if (upstream.statusCode !== 200) {
      upstream.resume();
      logger.error(
        `[SKYCAM] Upstream returned HTTP ${upstream.statusCode}`
      );
      return res.status(502).send("SkyCam image unavailable.");
    }

    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("X-Content-Type-Options", "nosniff");

    if (upstream.headers["content-length"]) {
      res.set("Content-Length", upstream.headers["content-length"]);
    }

    upstream.pipe(res);
  });

  request.setTimeout(5000, () => {
    request.destroy(new Error("SkyCam upstream timeout"));
  });

  request.on("error", (err) => {
    logger.error(`[SKYCAM] ${err.message}`);

    if (!res.headersSent) {
      res.status(502).send("SkyCam image unavailable.");
    } else {
      res.destroy();
    }
  });
});

app.get("/skycam/history", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    count: skycamHistory.length,
    bytes: skycamHistoryBytes,
    maxImages: SKYCAM_HISTORY_MAX_IMAGES,
    maxBytes: SKYCAM_HISTORY_MAX_BYTES,
    images: skycamHistory.map((entry) => ({
      id: entry.id,
      capturedAt: entry.capturedAt,
      url: `/skycam/history/${encodeURIComponent(entry.id)}`,
    })),
  });
});

app.get("/skycam/history/:id", (req, res) => {
  const entry = skycamHistory.find((item) => item.id === req.params.id);

  if (!entry) {
    return res.status(404).send("SkyCam history image not found.");
  }

  res.set("Content-Type", "image/jpeg");
  res.set("Content-Length", String(entry.size));
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.set("X-Content-Type-Options", "nosniff");
  res.send(entry.buffer);
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
