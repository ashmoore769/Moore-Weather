const express = require("express");
const cors = require("cors");
const path = require("path");
const net = require("net");

const WEATHER_STATION_HOST = "myweather.ddns.net";  // Your actual DDNS host
const WEATHER_STATION_PORT = 8899;

const app = express();
app.use(cors());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;  // Render requires process.env.PORT

// Handle weather data request
app.get("/weather", (req, res) => {
    const client = new net.Socket();
    let receivedData = "";

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log(`Connected to weather station at ${WEATHER_STATION_HOST}:${WEATHER_STATION_PORT}`);
        client.write("r3\r\n"); // Send command
    });

    client.on("data", (data) => {
        receivedData += data.toString();
    });

    client.on("end", () => {
        console.log("Received full weather data.");
        res.send(receivedData || "No data received from the weather station.");
    });

    client.on("error", (err) => {
        console.error("Weather Station Connection Error:", err.message);
        res.status(500).send(`Error connecting to weather station: ${err.message}`);
    });

    client.on("close", () => {
        console.log("Weather station connection closed.");
        client.destroy();
    });
});

// Serve index.html when visiting the base URL
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT} (or Render-assigned URL)`);
});
