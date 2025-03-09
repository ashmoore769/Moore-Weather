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

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000;

app.get("/weather", (req, res) => {
    const now = Date.now();
    if (now - lastRequestTime < MIN_REQUEST_INTERVAL) {
        return res.status(429).send("Too many requests. Slow down.");
    }
    lastRequestTime = now;

    const client = new net.Socket();
    let receivedData = "";
    let isResponseSent = false;

    client.setTimeout(3000);
    
    function sendResponse(status, message) {
        if (!isResponseSent) {
            res.status(status).send(message);
            isResponseSent = true;
            client.destroy();
        }
    }

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log(`✅ Connected to ${WEATHER_STATION_HOST}:${WEATHER_STATION_PORT}`);
        client.write("r3\r\n");
    });

    client.on("data", (data) => {
        receivedData += data.toString();
        client.end();  // Gracefully close connection after receiving data
    });

    client.on("close", () => {
        console.log("✅ Connection closed.");
        sendResponse(200, receivedData || "No data received");
    });

    client.on("error", (err) => {
        console.error(`❌ Connection error: ${err.message}`);
        sendResponse(500, "Error connecting to weather station");
    });

    client.on("timeout", () => {
        console.error("❌ Connection timed out.");
        sendResponse(504, "Weather station timeout");
    });
});

// Add a simple ping check
app.get("/ping", (req, res) => {
    res.send("Weather station proxy is online.");
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT} (or Render-assigned URL)`);
});
