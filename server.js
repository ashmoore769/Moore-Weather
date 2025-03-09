const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");

const WEATHER_STATION_HOST = "myweather.ddns.net";
const WEATHER_STATION_PORT = 8899;

const app = express();
app.use(cors());

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;  // Use Render's assigned port

// Debug route to check if Render can reach the weather station
app.get("/test-connection", (req, res) => {
    const client = new net.Socket();
    let receivedData = "";
    let responded = false; // Ensure only one response is sent

    console.log("🔍 Testing connection to weather station...");

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log("✅ Connected to weather station.");
        client.write("r3\r\n");
    });

    client.on("data", (data) => {
        receivedData += data.toString();
        console.log("📡 Received data:", receivedData);
        client.end(); // Close connection after receiving data
    });

    client.on("close", () => {
        console.log("✅ Connection closed.");
        if (!responded) {
            responded = true;
            res.send(`Weather station responded: ${receivedData}`);
        }
    });

    client.on("error", (err) => {
        console.error("❌ Connection error:", err.message);
        if (!responded) {
            responded = true;
            res.status(500).send(`Error connecting to weather station: ${err.message}`);
        }
        client.destroy();
    });
});

// Default weather route
app.get("/weather", (req, res) => {
    const client = new net.Socket();
    let receivedData = "";
    let responded = false; // Prevent multiple responses

    console.log(`🌍 Connecting to weather station at ${WEATHER_STATION_HOST}:${WEATHER_STATION_PORT}`);

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log("✅ Connected to weather station.");
        client.write("r3\r\n");
    });

    client.on("data", (data) => {
        receivedData += data.toString();
        console.log("📡 Received data:", receivedData);
        client.end(); // Close connection after receiving data
    });

    client.on("close", () => {
        console.log("✅ Connection closed.");
        if (!responded) {
            responded = true;
            res.send(receivedData);
        }
    });

    client.on("error", (err) => {
        console.error("❌ Weather Station Connection Error:", err.message);
        if (!responded) {
            responded = true;
            res.status(500).send(`Error: ${err.message}`);
        }
        client.destroy();
    });
});

// Serve index.html on root URL
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT} (or Render-assigned URL)`);
});
