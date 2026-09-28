require('module-alias/register');
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const config = require('@config/index');
const routes = require('@routes/index');
const Health = require('@src/Health');

const app = express();

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

app.post('/logapi/v1/check/penalty', (req, res) => {
    const gsid = req.body?.Player?.GSID || req.body?.GSID || req.body?.steamId || "";
    
    return res.status(200).json({
        data: {
            BanInSecond: 0,
            count: 243,
            GSID: gsid,
            PenaltyLevel: 0,
            UnbannedDateTime: "2026-09-27T15:37:20.557Z",
            UnBannedIn: 0
        },
        hasUnBannedIn: 0,
        message: "All transaction success",
        status: 1
    });
});

app.post('/logapi/v1/add/matchlog', (req, res) => {
    return res.status(200).json({
        data: null,
        error: null,
        status: 1
    });
});

app.post('/logapi/v1/check/serverdetect', (req, res) => {
    const playerIds = req.body?.playerIds || [];
    const gsid = playerIds.length > 0 ? playerIds[0] : "";

    return res.status(200).json({
        data: {
            GSID: gsid
        },
        error: null,
        status: 1
    });
});

app.use('/', routes);
app.use('/', Health);

async function start() {
  try {
    await mongoose.mongoose.connect(config.mongo.uri, {
      dbName: config.mongo.dbName,
    });
    console.log(`MongoDB connected to: ${config.mongo.dbName}`);

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Environment: ${config.env}`);
    });
  } catch (err) {
    console.error('Startup error:', err.message);
    process.exit(1);
  }
}

async function shutdown() {
  try {
    await mongoose.connection.close();
    console.log('Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
