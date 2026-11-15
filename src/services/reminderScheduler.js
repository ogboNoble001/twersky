const cron = require('node-cron');
const supabase = require('../db/client');
const { sendTextMessage } = require('./waha');
require('dotenv').config();

const OWNER_PHONE = process.env.USER_PHONE_NUMBER || '2349150573885';

/**
 * Checks if current time is within quiet hours (e.g. 23:00 to 06:00)
 */
function isWithinQuietHours(startTimeStr = '23:00:00', endTimeStr = '06:00:00') {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = (startTimeStr || '23:00:00').split(':').map(Number);
  const [endH, endM] = (endTimeStr || '06:00:00').split(':').map(Number);

  const startTotal = startH * 60 + (startM || 0);
  const endTotal = endH * 60 + (endM || 0);

  if (startTotal > endTotal) {
    // Overnight window (e.g. 23:00 to 06:00)
    return currentMinutes >= startTotal || currentMinutes < endTotal;
  } else {
    return currentMinutes >= startTotal && currentMinutes < endTotal;
  }
}

/**
 * Computes the next run time after quiet hours finish (e.g. next 06:00 AM)
 */
function getEndOfQuietHoursTime(endTimeStr = '06:00:00') {
  const [endH, endM] = (endTimeStr || '06:00:00').split(':').map(Number);
  const nextTime = new Date();
  if (nextTime.getHours() >= endH) {
    nextTime.setDate(nextTime.getDate() + 1);
  }
  nextTime.setHours(endH, endM || 0, 0, 0);
  return nextTime;
}

/**
 * Calculates dynamic escalating interval in minutes based on time left until deadline
 */
function calculateEscalatingInterval(baseIntervalMinutes, deadlineTimestamp) {
  if (!deadlineTimestamp) {
    return baseIntervalMinutes || 60;
  }

  const now = Date.now();
  const deadline = new Date(deadlineTimestamp).getTime();
  const hoursRemaining = (deadline - now) / (1000 * 60 * 60);

  if (hoursRemaining > 48) {
    // Over 2 days away: normal pace (every 24h or user's base interval)
    return Math.max(baseIntervalMinutes || 1440, 720);
  } else if (hoursRemaining > 24) {
    // 1 to 2 days away: every 6 hours
    return 360;
  } else if (hoursRemaining > 6) {
    // 6 to 24 hours away: every 2 hours
    return 120;
  } else if (hoursRemaining > 0) {
    // Under 6 hours: every 30 minutes
    return 30;
  } else {
    // Past deadline: daily follow-up
    return 1440;
  }
}

/**
 * Main tick function executing every minute
 */
async function processDueReminders() {
  try {
    const nowIso = new Date().toISOString();

    // 1. Fetch active, uncompleted reminders that are due
    const { data: dueReminders, error } = await supabase
      .from('reminders')
      .select('*, assignments (*)')
      .eq('is_done', false)
      .eq('is_stopped', false)
      .lte('next_run_at', nowIso);

    if (error || !dueReminders || dueReminders.length === 0) {
      return;
    }

    console.log(`[Scheduler] Found ${dueReminders.length} reminder(s) due for processing.`);

    // Fetch user's preferred name and formatting
    const { data: prefRow } = await supabase
      .from('monitored_chats')
      .select('name')
      .eq('chat_id', 'user_preferences')
      .maybeSingle();

    let userName = 'Noble';
    if (prefRow && prefRow.name) {
      try { userName = JSON.parse(prefRow.name).user_name || 'Noble'; } catch (e) {}
    }

    for (const reminder of dueReminders) {
      const { quiet_hours_start, quiet_hours_end, interval_minutes, course_code, topic } = reminder;

      // 2. Check Quiet Hours
      if (isWithinQuietHours(quiet_hours_start, quiet_hours_end)) {
        const postponeTime = getEndOfQuietHoursTime(quiet_hours_end);
        console.log(`[Scheduler] Reminder ${reminder.id} is inside quiet hours. Postponing until ${postponeTime.toISOString()}`);
        await supabase
          .from('reminders')
          .update({ next_run_at: postponeTime.toISOString() })
          .eq('id', reminder.id);
        continue;
      }

      // 3. Compose the reminder message
      const assignment = reminder.assignments;
      const deadlineInfo = assignment?.deadline_text ? `Deadline is ${assignment.deadline_text}.` : 'Deadline details not specified.';
      const coursePrefix = course_code ? `[${course_code}] ` : '';

      const reminderText = `${userName}, this is your reminder for ${coursePrefix}${topic}.

${deadlineInfo}

Reply "done" when you complete it, or "stop" to pause reminders for this.`;

      // 4. Send via WAHA to the owner
      try {
        const targetChat = OWNER_PHONE.includes('@') ? OWNER_PHONE : `${OWNER_PHONE}@c.us`;
        await sendTextMessage(targetChat, reminderText);
        console.log(`[Scheduler] Reminder sent successfully to ${targetChat} for "${topic}".`);
      } catch (sendErr) {
        console.error(`[Scheduler] Failed to dispatch reminder ${reminder.id}:`, sendErr.message);
      }

      // 5. Calculate escalating interval and schedule the next run
      const nextInterval = calculateEscalatingInterval(interval_minutes, assignment?.deadline_timestamp);
      const nextRunAt = new Date(Date.now() + nextInterval * 60 * 1000);

      await supabase
        .from('reminders')
        .update({
          last_sent_at: nowIso,
          next_run_at: nextRunAt.toISOString()
        })
        .eq('id', reminder.id);
    }
  } catch (err) {
    console.error('[Scheduler] Error in processDueReminders:', err.message);
  }
}

/**
 * Initializes and starts the background reminder cron daemon
 */
function initReminderScheduler() {
  console.log('[Scheduler] Initializing background reminder daemon (every minute)...');
  // Run every minute
  cron.schedule('* * * * *', async () => {
    await processDueReminders();
  });
}

module.exports = {
  initReminderScheduler,
  processDueReminders
};
