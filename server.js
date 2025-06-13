require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");
const winston = require("winston");

const WEATHER_STATION_HOST = process.env.WEATHER_STATION_HOST || "myweather.ddns.net";
const WEATHER_STATION_PORT = parseInt(process.env.WEATHER_STATION_PORT) || 8899;
const PORT = process.env.PORT || 10000;

// Configure logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "weather.log" }),
    new winston.transports.Console(),
  ],
});

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

let cachedWeatherData = null;
let cachedDailyData = null;
let lastPollTime = null;
let lastDailyPollTime = null;

function parseWeatherData(csv) {
  try {
    const lines = csv.replace(/^r3\s*/, "").trim().split(",");
    if (lines.length < 31) {
      throw new Error(`Incomplete CSV: ${lines.length} fields received`);
    }
    return {
      date: lines[0],
      time: lines[1],
      windSpeed: parseFloat(lines[2]),
      windDirDeg: parseFloat(lines[3]),
      humidity: parseFloat(lines[4]),
      temperature: parseFloat(lines[5]),
      rainInLastMin: parseFloat(lines[6]),
      solarRad: parseFloat(lines[7]),
      pressure: parseFloat(lines[8]),
      gardenBedTemp: parseFloat(lines[9]),
      batteryVoltage: parseFloat(lines[10]),
      loadCurrent: parseFloat(lines[11]),
      solarVoltage: parseFloat(lines[12]),
      chargeCurrent: parseFloat(lines[13]),
      peakWindGust: parseFloat(lines[14]),
      vectorWindSpeed: parseFloat(lines[15]),
      vectorWindDir: parseFloat(lines[16]),
      rainSince9: parseFloat(lines[17]),
      evapRate: parseFloat(lines[18]),
      dailyEvap: parseFloat(lines[20]),
      dewPoint: parseFloat(lines[21]),
      soilTemp10: parseFloat(lines[22]),
      soilTemp20: parseFloat(lines[23]),
      soilTemp30: parseFloat(lines[24]),
      soilTemp40: parseFloat(lines[25]),
      moisture10: parseFloat(lines[26]),
      moisture20: parseFloat(lines[27]),
      moisture30: parseFloat(lines[28]),
      moisture40: parseFloat(lines[29]),
      blackGlobeTemp: parseFloat(lines[30]),
    };
  } catch (error) {
    logger.error(`CSV parsing error: ${error.message}`);
    return null;
  }
}

function fetchDailyData(attempt = 1, maxAttempts = 3) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let receivedData = "";

    client.setTimeout(5000);

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
      logger.info(`Connected to ${WEATHER_STATION_HOST}:${WEATHER_STATION_PORT} for daily data`);
      client.write("MEM 1 LAST\r\n");
    });

    client.on("data", (data) => {
      receivedData += data.toString();
    });

    client.on("close", () => {
      client.destroy();
      if (receivedData.trim().split(",").length === 41) {
        cachedDailyData = receivedData.trim();
        lastDailyPollTime = new Date();
        logger.info(`Daily data updated at ${lastDailyPollTime.toLocaleTimeString()}`);
      } else {
        logger.warn(`Invalid daily data format: ${receivedData.trim().split(",").length} fields received`);
      }
      resolve(); // Resolve promise regardless of success
    });

    client.on("error", (err) => {
      logger.error(`Daily polling error: ${err.message}`);
      client.destroy();
      if (attempt < maxAttempts) {
        logger.warn(`Retrying daily poll (${attempt}/${maxAttempts})`);
        setTimeout(() => fetchDailyData(attempt + 1, maxAttempts).then(resolve), 1000);
      } else {
        resolve(); // Resolve on max retries
      }
    });

    client.on("timeout", () => {
      logger.error("Daily connection timed out");
      client.destroy();
      if (attempt < maxAttempts) {
        logger.warn(`Retrying daily poll (${attempt}/${maxAttempts})`);
        setTimeout(() => fetchDailyData(attempt + 1, maxAttempts).then(resolve), 1000);
      } else {
        resolve(); // Resolve on max retries
      }
    });
  });
}

function updateWeatherData(attempt = 1, maxAttempts = 3) {
  const client = new net.Socket();
  let receivedData = "";

  client.setTimeout(5000);

  client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
    logger.info(`Connected to ${WEATHER_STATION_HOST}:${WEATHER_STATION_PORT}`);
    client.write("r3\r\n");
  });

  client.on("data", (data) => {
    receivedData += data.toString();
    client.end();
  });

  client.on("close", () => {
    client.destroy();
    const parsedData = parseWeatherData(receivedData);
    if (parsedData && Object.values(parsedData).every(val => !isNaN(val) || typeof val === "string")) {
      cachedWeatherData = parsedData;
      lastPollTime = new Date();
      logger.info(`Cache updated at ${lastPollTime.toLocaleTimeString()}`);
    } else if (attempt < maxAttempts) {
      logger.warn(`Retrying poll (${attempt}/${maxAttempts})`);
      setTimeout(() => updateWeatherData(attempt + 1, maxAttempts), 1000);
    } else {
      logger.warn("Max retries reached. No valid data received.");
    }
  });

  client.on("error", (err) => {
    logger.error(`Polling error: ${err.message}`);
    client.destroy();
    if (attempt < maxAttempts) {
      logger.warn(`Retrying poll (${attempt}/${maxAttempts})`);
      setTimeout(() => updateWeatherData(attempt + 1, maxAttempts), 1000);
    }
  });

  client.on("timeout", () => {
    logger.error("Connection timed out");
    client.destroy();
    if (attempt < maxAttempts) {
      logger.warn(`Retrying poll (${attempt}/${maxAttempts})`);
      setTimeout(() => updateWeatherData(attempt + 1, maxAttempts), 1000);
    }
  });
}

function schedulePolling() {
  const now = new Date();
  let nextPoll = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    15,
    0
  );
  if (now >= nextPoll) {
    nextPoll.setMinutes(nextPoll.getMinutes() + 1);
  }
  const delay = nextPoll - now;
  logger.info(`First weather poll in ${delay}ms`);

  setTimeout(() => {
    updateWeatherData();
    setInterval(updateWeatherData, 60000); // Poll every minute for current data
  }, delay);

  // Schedule daily data poll after 9 AM
  const nextDailyPoll = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    9,
    0,
    0,
    0
  );
  if (now >= nextDailyPoll || now.getHours() >= 9) {
    nextDailyPoll.setDate(nextDailyPoll.getDate() + 1);
  }
  const dailyDelay = nextDailyPoll - now;
  logger.info(`First daily poll in ${dailyDelay}ms`);

  setTimeout(() => {
    fetchDailyData();
    setInterval(fetchDailyData, 24 * 60 * 60 * 1000); // Poll daily at 9 AM
  }, dailyDelay);
}

app.get("/weather", (req, res) => {
  if (cachedWeatherData && lastPollTime) {
    res.status(200).json({
      data: cachedWeatherData,
      lastUpdated: lastPollTime.toISOString(),
    });
  } else if (!lastPollTime) {
    res.status(503).json({ error: "Weather data not available: Initial poll in progress." });
  } else {
    res.status(503).json({ error: `Weather data unavailable since ${lastPollTime.toLocaleTimeString()}.` });
  }
});

app.get("/daily", async (req, res) => {
  const forceFetch = req.query.force === "1";

  if (!forceFetch && cachedDailyData && lastDailyPollTime) {
    return res.status(200).send(cachedDailyData);
  }

  try {
    await fetchDailyData(1, 3); // Force fresh fetch
    if (cachedDailyData) {
      res.status(200).send(cachedDailyData);
    } else {
      res.status(503).json({ error: "Failed to fetch daily data on demand." });
    }
  } catch (error) {
    res.status(503).json({ error: `Error fetching daily data: ${error.message}` });
  }
});

app.get("/ping", (req, res) => {
  res.json({
    status: "Weather station proxy is online",
    lastWeatherPoll: lastPollTime ? lastPollTime.toISOString() : "No data yet",
    lastDailyPoll: lastDailyPollTime ? lastDailyPollTime.toISOString() : "No data yet",
    weatherDataAvailable: !!cachedWeatherData,
    dailyDataAvailable: !!cachedDailyData,
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
  updateWeatherData();
  schedulePolling();
});