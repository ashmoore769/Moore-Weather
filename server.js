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

    console.log("Testing connection to weather station...");

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log("✅ Render connected to weather station.");
        client.write("r3\r\n");
    });

    client.on("data", (data) => {
        receivedData += data.toString();
        console.log("✅ Received data:", receivedData);
        client.destroy();
    });

    client.on("close", () => {
        console.log("✅ Connection closed, sending response...");
        res.send(`Weather station responded: ${receivedData}`);
    });

    client.on("error", (err) => {
        console.error("❌ Connection error:", err.message);
        res.status(500).send(`Error connecting to weather station: ${err.message}`);
        client.destroy();
    });
});

// Default weather route
app.get("/weather", (req, res) => {
    const client = new net.Socket();
    let receivedData = "";

    console.log(`🌐 Connecting to weather station at ${WEATHER_STATION_HOST}:${WEATHER_STATION_PORT}`);

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log("✅ Connected to weather station.");
        client.write("r3\r\n");
    });

    client.on("data", (data) => {
        receivedData += data.toString();
        console.log("✅ Received data:", receivedData);
        client.destroy();
    });

    client.on("close", () => {
        console.log("✅ Connection closed.");
        if (receivedData) {
            res.send(receivedData);
        } else {
            res.status(500).send("Weather station did not respond with data.");
        }
    });

    client.on("error", (err) => {
        console.error("❌ Weather Station Connection Error:", err.message);
        res.status(500).send(`Error: ${err.message}`);
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
