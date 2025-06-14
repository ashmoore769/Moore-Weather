require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");
const winston = require("winston"); // If you're using Winston logging

const WEATHER_STATION_HOST = 'myweather.ddns.net';
const WEATHER_STATION_PORT = 8899;
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
    new winston.transports.File({ filename: 'weather.log' }),
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

    if (fields.length >= 30) {
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
function fetchDailyData(attempt = 1, maxAttempts = 3) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let receivedData = '';

    client.setTimeout(5000);

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
      logger.info(`Connected for daily summary (MEM 1 LAST, attempt ${attempt})`);
      client.write('MEM 1 LAST\r\n');
    });

    client.on('data', (data) => {
      receivedData += data.toString();
    });

    client.on('close', () => {
      client.destroy();
    
      // Split into lines and find the line that starts with a date (yyyy/mm/dd)
      const lines = receivedData.split(/\r?\n/);
      const dataLine = lines.find(line => /^\d{4}\/\d{2}\/\d{2}/.test(line));
    
      if (!dataLine) {
        logger.warn(`[DAILY] No valid data line found in response:\n${receivedData}`);
        return resolve('');
      }
    
      const cleaned = dataLine.trim().replace(/,?\s*\\?END.*$/i, '');
      const fields = cleaned.split(',');
    
      if (fields.length === 41) {
        cachedDailyData = cleaned;
        lastDailyPollTime = new Date();
        logger.info(`[DAILY] ✅ Data cached @ ${lastDailyPollTime.toLocaleTimeString()} with ${fields.length} fields`);
        resolve(cleaned);
      } else {
        logger.warn(`[DAILY] ❌ Invalid field count (${fields.length}), expected 41.\nCleaned line: ${cleaned}`);
        resolve('');
      }
    });

    client.on('error', (err) => {
      logger.error(`Daily fetch error: ${err.message} (attempt ${attempt})`);
      client.destroy();
      if (attempt < maxAttempts) {
        setTimeout(() => fetchDailyData(attempt + 1, maxAttempts).then(resolve), 1000);
      } else {
        resolve(''); // Resolve with empty string on failure
      }
    });

    client.on('timeout', () => {
      logger.error(`Daily fetch timeout (attempt ${attempt})`);
      client.destroy();
      if (attempt < maxAttempts) {
        setTimeout(() => fetchDailyData(attempt + 1, maxAttempts).then(resolve), 1000);
      } else {
        resolve(''); // Resolve with empty string on timeout
      }
    });
  });
}

// Schedulers
function schedulePolling() {
  // Real-time data every minute
  setInterval(updateWeatherData, 60000);
  updateWeatherData();

  // Daily summary at 9:01 AM
  const now = new Date();
  const next9am = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 1, 0);
  if (now >= next9am) next9am.setDate(next9am.getDate() + 1);
  const delay = next9am - now;

  logger.info(`Next daily summary poll in ${Math.round(delay / 1000)}s`);

  setTimeout(() => {
    fetchDailyData();
    setInterval(fetchDailyData, 24 * 60 * 60 * 1000); // 24h
  }, delay);
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

  if (!force && cachedDailyData) {
    return res.status(200).send(cachedDailyData);
  }

  const data = await fetchDailyData();
  if (data && data.split(',').length === 41) {
    res.status(200).send(data);
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