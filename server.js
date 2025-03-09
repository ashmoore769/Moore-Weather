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

const PORT = 3000; 

// Handle weather data request
app.get("/weather", (req, res) => {
    const client = new net.Socket();
    let receivedData = "";  // Store received data

    client.connect(WEATHER_STATION_PORT, WEATHER_STATION_HOST, () => {
        console.log("Connected to weather station");
        client.write("r3\r\n");
    });

    client.on("data", (data) => {
        receivedData += data.toString(); // Append received data

        // Close the client when done
        client.destroy();
    });

    client.on("close", () => {
        console.log("Connection closed");
        res.send(receivedData); // Send response after closing
    });

    client.on("error", (err) => {
        console.error("Connection error:", err.message);
        res.status(500).send("Error connecting to weather station");
        client.destroy();
    });
});

// Serve index.html when visiting localhost:3000
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
