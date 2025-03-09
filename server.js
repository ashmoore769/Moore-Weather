const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");

const WEATHER_STATION_HOST = "myweather.ddns.net";  // Your actual DDNS host
const WEATHER_STATION_PORT = 8899;
const PORT = process.env.PORT || 10000;  // Render auto-assigns port

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

let lastRequestTime = 0;  // Track last request timestamp
const MIN_REQUEST_INTERVAL = 5000;  // 5 seconds delay to prevent hammering

app.get("/weather", (req, res) => {
    const now = Date.now();

    // Prevent too many requests in a short time
    if (now - lastRequestTime < MIN_REQUEST_INTERVAL) {
        return res.status(429).send("Too many requests. Slow down.");
    }
    lastRequestTime = now;

    const client = new net.Socket();
    let receivedData = "";
    let isResponseSent = false;  // Prevent duplicate responses

    client.setTimeout(3000);  // Set timeout to 3 seconds

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log(`✅ Connected to weather station at ${WEATHER_STATION_HOST}:${WEATHER_STATION_PORT}`);
        client.write("r3\r\n");
    });

    client.on("data", (data) => {
        receivedData += data.toString();
    });

    client.on("close", () => {
        console.log("✅ Weather station connection closed.");
        if (!isResponseSent) {
            res.send(receivedData || "No data received");
            isResponseSent = true;
        }
    });

    client.on("error", (err) => {
        console.error(`❌ Weather Station Connection Error: ${err.message}`);
        if (!isResponseSent) {
            res.status(500).send("Error connecting to weather station");
            isResponseSent = true;
        }
        client.destroy();
    });

    client.on("timeout", () => {
        console.error("❌ Connection timed out.");
        if (!isResponseSent) {
            res.status(504).send("Weather station timeout");
            isResponseSent = true;
        }
        client.destroy();
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT} (or Render-assigned URL)`);
});
