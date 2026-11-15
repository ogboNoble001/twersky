require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook');
const { initReminderScheduler } = require('./services/reminderScheduler');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'twersky-assistant', timestamp: new Date().toISOString() });
});

// WAHA Webhook route
app.use('/webhooks', webhookRoutes);

app.listen(PORT, () => {
  console.log(`[Twersky] Server running on port ${PORT}`);
  // Start background reminder daemon
  initReminderScheduler();
});
