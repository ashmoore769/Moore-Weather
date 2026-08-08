require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");
const winston = require("winston"); // If you're using Winston logging

const WEATHER_STATION_HOST = process.env.WEATHER_STATION_HOST || 'myweather.ddns.net';
const WEATHER_STATION_PORT = Number(process.env.WEATHER_STATION_PORT) || 8899;
const PORT = process.env.PORT || 10000;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'weather.log', maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
  ],
});

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

let cachedWeatherData = null;
let cachedDailyData = null;
let lastPollTime = null;
let lastDailyPollTime = null;

// Fetch CURRENT readings (r3)
function updateWeatherData(attempt = 1, maxAttempts = 3) {
  const client = new net.Socket();
  let receivedData = '';

  client.setTimeout(5000);

  client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
    logger.info(`Connected for current weather (r3)`);
    client.write('r3\r\n');
  });

  client.on('data', (data) => {
    receivedData += data.toString();
  });

  client.on('close', () => {
    client.destroy();
    const cleaned = receivedData.replace(/^r3\s*/, '').trim().replace(/,?END$/, '');
    const fields = cleaned.split(',');

    if (fields.length >= 31) {
      cachedWeatherData = cleaned;
      lastPollTime = new Date();
      logger.info(`Weather data cached at ${lastPollTime.toLocaleTimeString()} (${fields.length} fields)`);
    } else {
      logger.warn(`Invalid r3 data: only ${fields.length} fields received`);
      if (attempt < maxAttempts) {
        setTimeout(() => updateWeatherData(attempt + 1, maxAttempts), 1000);
      }
    }
  });

  client.on('error', (err) => {
    logger.error(`r3 error: ${err.message}`);
    client.destroy();
    if (attempt < maxAttempts) {
      setTimeout(() => updateWeatherData(attempt + 1, maxAttempts), 1000);
    }
  });

  client.on('timeout', () => {
    logger.error('r3 timeout');
    client.destroy();
    if (attempt < maxAttempts) {
      setTimeout(() => updateWeatherData(attempt + 1, maxAttempts), 1000);
    }
  });
}

// Fetch DAILY summary (MEM 1 LAST)
function fetchDailyData(attempt = 1, maxAttempts = 5) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let receivedData = '';
    let settled = false;

    client.setTimeout(5000);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const retryOrFail = (reason) => {
      if (settled) return;
      client.destroy();
      logger.warn(`[DAILY] ${reason} (attempt ${attempt}/${maxAttempts})`);

      if (attempt < maxAttempts) {
        settled = true;
        const delay = Math.min(30000, 5000 * attempt);
        setTimeout(() => {
          fetchDailyData(attempt + 1, maxAttempts).then(resolve);
        }, delay);
      } else {
        finish('');
      }
    };

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
      logger.info(`Connected for daily summary (MEM 1 LAST, attempt ${attempt})`);
      client.write('MEM 1 LAST\r\n');
    });

    client.on('data', (data) => {
      receivedData += data.toString();
    });

    client.on('close', () => {
      if (settled) return;

      const lines = receivedData.split(/\r?\n/);
      const dataLine = lines.find(line => /^\d{4}\/\d{2}\/\d{2}/.test(line));

      if (!dataLine) {
        return retryOrFail('No valid dated data line received');
      }

      const cleaned = dataLine.trim().replace(/,?\s*\\?END.*$/i, '');
      const fields = cleaned.split(',');

      if (fields.length !== 43) {
        return retryOrFail(`Invalid field count (${fields.length}), expected 43`);
      }

      cachedDailyData = cleaned;
      lastDailyPollTime = new Date();
      logger.info(`[DAILY] Data cached @ ${lastDailyPollTime.toLocaleTimeString()} with ${fields.length} fields`);
      finish(cleaned);
    });

    client.on('error', (err) => {
      retryOrFail(`Socket error: ${err.message}`);
    });

    client.on('timeout', () => {
      retryOrFail('Socket timeout');
    });
  });
}

// Schedulers
function schedulePolling() {
  // Real-time data every minute
  setInterval(updateWeatherData, 60000);
  updateWeatherData();

  // Daily summary at 9:10 AM Australia/Brisbane time.
  // Recalculate after every run instead of assuming every day is exactly 24 hours.
  function scheduleNextDailyFetch() {
    const now = new Date();
    const brisbaneNow = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
    const next = new Date(brisbaneNow);
    next.setHours(9, 10, 0, 0);
    if (brisbaneNow >= next) next.setDate(next.getDate() + 1);

    const delay = next - brisbaneNow;
    logger.info(`Next daily summary poll in ${Math.round(delay / 1000)}s (scheduled for 09:10 Australia/Brisbane)`);

    setTimeout(async () => {
      await fetchDailyData();
      scheduleNextDailyFetch();
    }, delay);
  }

  scheduleNextDailyFetch();
}

// ROUTES

// Current readings (for index.html)
app.get('/weather', (req, res) => {
  if (cachedWeatherData) {
    res.status(200).send(cachedWeatherData);
  } else {
    res.status(503).send('Weather data not available yet.');
  }
});

// Daily summary (for daily.html)
app.get('/daily', async (req, res) => {
  const force = req.query.force === '1';

  // Before 9:10 AEST, yesterday's cached daily summary is expected.
  // After 9:10 AEST, only serve the cache if it was refreshed today.
  const brisbaneNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
  const cutoff = new Date(brisbaneNow);
  cutoff.setHours(9, 10, 0, 0);

  let cacheIsFresh = false;
  if (cachedDailyData && lastDailyPollTime) {
    const cachedBrisbane = new Date(lastDailyPollTime.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
    cacheIsFresh =
      cachedBrisbane.getFullYear() === brisbaneNow.getFullYear() &&
      cachedBrisbane.getMonth() === brisbaneNow.getMonth() &&
      cachedBrisbane.getDate() === brisbaneNow.getDate();
  }

  if (!force && cachedDailyData && (brisbaneNow < cutoff || cacheIsFresh)) {
    return res.status(200).send(cachedDailyData);
  }

  const data = await fetchDailyData();
  if (data && data.split(',').length === 43) {
    res.status(200).send(data);
  } else if (cachedDailyData) {
    // Fall back to the last known good summary rather than returning nothing.
    res.status(200).send(cachedDailyData);
  } else {
    res.status(503).send('Failed to retrieve valid daily summary.');
  }
});

// Diagnostics
app.get('/ping', (req, res) => {
  res.json({
    status: 'online',
    lastWeatherPoll: lastPollTime ? lastPollTime.toISOString() : null,
    lastDailyPoll: lastDailyPollTime ? lastDailyPollTime.toISOString() : null,
  });
});

// Default index page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running at http://localhost:${PORT}`);
  schedulePolling();
});