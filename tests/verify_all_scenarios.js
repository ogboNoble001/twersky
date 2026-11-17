require('dotenv').config();
const { tools } = require('../src/services/agentTools');
const { extractAssignmentFromMessage } = require('../src/services/llm');
const { verifyQuoteInMessage } = require('../src/utils/helpers');
const supabase = require('../src/db/client');
const axios = require('axios');

async function runTestSuite() {
  console.log('====================================================');
  console.log('   TWERSKY COMPREHENSIVE VERIFICATION TEST SUITE    ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} - ${details}`);
      failed++;
    }
  }

  // ----------------------------------------------------
  // TEST SUITE 1: Natural Language Date Parser
  // ----------------------------------------------------
  console.log('--- SUITE 1: Natural Language Date Parsing ---');

  const now = new Date();

  // Test 1.1: "tomorrow" / "tomorrow morning"
  const tomorrowRes = await tools.set_reminder({
    course_code: 'TEST101',
    topic: 'test tomorrow parsing',
    target_date: 'tomorrow morning'
  });
  const tDate = new Date(tomorrowRes.reminder.next_run_at);
  const expectedTomorrow = new Date(now);
  expectedTomorrow.setDate(expectedTomorrow.getDate() + 1);
  assert(
    tDate.getDate() === expectedTomorrow.getDate() && tDate.getHours() === 8,
    'Natural Date: "tomorrow morning" targets tomorrow at 8:00 AM',
    `Got ${tDate.toISOString()}`
  );

  // Test 1.2: "in the next two days"
  const twoDaysRes = await tools.set_reminder({
    course_code: 'TEST102',
    topic: 'test two days parsing',
    target_date: 'in the next two days'
  });
  const twoDaysDate = new Date(twoDaysRes.reminder.next_run_at);
  const expectedTwoDays = new Date(now);
  expectedTwoDays.setDate(expectedTwoDays.getDate() + 2);
  assert(
    twoDaysDate.getDate() === expectedTwoDays.getDate() && twoDaysDate.getHours() === 9,
    'Natural Date: "in the next two days" targets 2 days out at 9:00 AM',
    `Got ${twoDaysDate.toISOString()}`
  );

  // Test 1.3: "in four months time"
  const fourMonthsRes = await tools.set_reminder({
    course_code: 'TEST103',
    topic: 'test four months parsing',
    target_date: 'in four months time'
  });
  const fourMonthsDate = new Date(fourMonthsRes.reminder.next_run_at);
  const expectedMonth = (now.getMonth() + 4) % 12;
  assert(
    fourMonthsDate.getMonth() === expectedMonth && fourMonthsDate.getHours() === 9,
    'Natural Date: "in four months time" targets +4 months at 9:00 AM',
    `Got ${fourMonthsDate.toISOString()}`
  );

  // Test 1.4: "next two weeks"
  const twoWeeksRes = await tools.set_reminder({
    course_code: 'TEST104',
    topic: 'test two weeks parsing',
    target_date: 'next two weeks'
  });
  const twoWeeksDate = new Date(twoWeeksRes.reminder.next_run_at);
  const expectedTwoWeeks = new Date(now);
  expectedTwoWeeks.setDate(expectedTwoWeeks.getDate() + 14);
  assert(
    twoWeeksDate.getDate() === expectedTwoWeeks.getDate(),
    'Natural Date: "next two weeks" targets +14 days',
    `Got ${twoWeeksDate.toISOString()}`
  );

  // Test 1.5: Direct ISO target_timestamp with adaptive escalating interval
  const tomorrowIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const isoRes = await tools.set_reminder({
    course_code: 'TEST105',
    topic: 'test iso timestamp anchoring',
    target_timestamp: tomorrowIso
  });
  const isoDate = new Date(isoRes.reminder.next_run_at);
  const expectedIsoDate = new Date(tomorrowIso);
  assert(
    isoRes.success === true && isoDate.getTime() === expectedIsoDate.getTime(),
    'Semantic Date: Direct ISO target_timestamp sets exact timestamp without regex',
    JSON.stringify(isoRes)
  );

  // ----------------------------------------------------
  // TEST SUITE 2: Reminder Collision & Auto-Cancellation
  // ----------------------------------------------------
  console.log('\n--- SUITE 2: Reminder Collisions & Auto-Cancellation ---');

  // Setting a new reminder for TEST101 should have deactivated the earlier one
  const newReminderRes = await tools.set_reminder({
    course_code: 'TEST101',
    topic: 'updated reminder for test101',
    interval_minutes: 30
  });

  const { data: test101Reminders } = await supabase
    .from('reminders')
    .select('id, is_stopped, topic')
    .ilike('course_code', '%TEST101%');

  const activeCount = test101Reminders.filter(r => !r.is_stopped).length;
  assert(
    activeCount === 1,
    'Auto-Cancel: Previous active reminder for course auto-deactivated on new schedule',
    `Expected 1 active, found ${activeCount}`
  );

  // ----------------------------------------------------
  // TEST SUITE 3: "done" and "stop" with Null / "General" Course Codes
  // ----------------------------------------------------
  console.log('\n--- SUITE 3: "Done" and "Stop" Robust Resolution ---');

  // Create an untied general reminder (course_code: null)
  const generalReminder = await tools.set_reminder({
    topic: 'general task with no course code',
    interval_minutes: 15
  });

  // Test 3.1: Calling mark_assignment_done with "General" placeholder string
  const doneResult = await tools.mark_assignment_done({ course_code: 'General' });
  const { data: checkedDone } = await supabase
    .from('reminders')
    .select('is_done')
    .eq('id', generalReminder.reminder.id)
    .single();

  assert(
    checkedDone.is_done === true,
    'Mark Done: Successfully marks reminder done even when course is "General" / null',
    `is_done is ${checkedDone.is_done}`
  );

  // Create another general reminder to test stop_reminders
  const generalReminder2 = await tools.set_reminder({
    topic: 'second general task to test stop',
    interval_minutes: 15
  });

  // Test 3.2: Calling stop_reminders without course_code
  const stopResult = await tools.stop_reminders({});
  const { data: checkedStop } = await supabase
    .from('reminders')
    .select('is_stopped')
    .eq('id', generalReminder2.reminder.id)
    .single();

  assert(
    checkedStop.is_stopped === true,
    'Stop Reminders: Successfully stops reminder when no course code is specified',
    `is_stopped is ${checkedStop.is_stopped}`
  );

  // ----------------------------------------------------
  // TEST SUITE 4: Group Name Auto-Resolution
  // ----------------------------------------------------
  console.log('\n--- SUITE 4: Group Name Auto-Resolution ---');

  // Test 4.1: Known group name matches real group ID
  const knownGroupRes = await tools.configure_group({ name: 'Testing_meez' });
  assert(
    knownGroupRes.success === true && knownGroupRes.group.chat_id.endsWith('@g.us'),
    'Group Resolver: Correctly resolves "Testing_meez" to real WhatsApp group ID',
    JSON.stringify(knownGroupRes)
  );

  // Test 4.2: Official class group matches
  const officialGroupRes = await tools.configure_group({ name: 'OFFICIAL COMPUTER ENGINEERING 300LVL' });
  assert(
    officialGroupRes.success === true && officialGroupRes.group.chat_id === '120363427954073209@g.us',
    'Group Resolver: Correctly matches "OFFICIAL COMPUTER ENGINEERING 300LVL" to 120363427954073209@g.us',
    JSON.stringify(officialGroupRes)
  );

  // Test 4.3: Completely bogus group name returns honest error without hallucinating
  const bogusGroupRes = await tools.configure_group({ name: 'NonExistentGhostGroup999' });
  assert(
    Boolean(bogusGroupRes.error),
    'Group Resolver: Returns honest error when group name does not exist in live groups',
    JSON.stringify(bogusGroupRes)
  );

  // Test 4.4: Direct semantic chat_id selection from available groups
  const directChatIdRes = await tools.configure_group({
    chat_id: '120363427491645104@g.us',
    name: 'Testing_meez'
  });
  assert(
    directChatIdRes.success === true && directChatIdRes.group.chat_id === '120363427491645104@g.us',
    'Semantic Group: Direct chat_id selection resolves cleanly without regex hacks',
    JSON.stringify(directChatIdRes)
  );

  // ----------------------------------------------------
  // TEST SUITE 5: Preferences (No Name-Calling)
  // ----------------------------------------------------
  console.log('\n--- SUITE 5: User Preferences (No Name-Calling) ---');

  const { data: prefRow } = await supabase
    .from('monitored_chats')
    .select('name')
    .eq('chat_id', 'user_preferences')
    .single();

  let prefs = {};
  try { prefs = JSON.parse(prefRow.name); } catch(e) {}

  assert(
    prefs.use_name === false,
    'Preferences: use_name is explicitly set to false in database',
    JSON.stringify(prefs)
  );

  // ----------------------------------------------------
  // TEST SUITE 6: Render Endpoints & Keep-Alive
  // ----------------------------------------------------
  console.log('\n--- SUITE 6: Render Health & Keep-Alive Endpoints ---');

  try {
    const backendHealth = await axios.get('https://twersky-backend.onrender.com/health', { timeout: 15000 });
    assert(
      backendHealth.status === 200 && backendHealth.data.status === 'ok',
      'Render Endpoint: Backend /health responds 200 OK',
      `Status ${backendHealth.status}`
    );
  } catch (err) {
    assert(false, 'Render Endpoint: Backend /health responds 200 OK', err.message);
  }

  try {
    const wahaPing = await axios.get('https://twersky-waha.onrender.com/ping', { timeout: 15000 });
    assert(
      wahaPing.status === 200,
      'Render Endpoint: WAHA /ping responds 200 OK',
      `Status ${wahaPing.status}`
    );
  } catch (err) {
    assert(false, 'Render Endpoint: WAHA /ping responds 200 OK', err.message);
  }

  // ----------------------------------------------------
  // TEST SUITE 7: Proactive Alert Pipeline Gate Checks
  // ----------------------------------------------------
  console.log('\n--- SUITE 7: Proactive Alert Pipeline Gate Checks ---');

  // Test 7.1: Casual Chatter produces null (zero spam)
  const casualResult = await extractAssignmentFromMessage('lol who is coming to the cafeteria right now?');
  assert(
    casualResult === null,
    'Zero Spam Gate: Casual chatter is completely ignored (returns null)',
    JSON.stringify(casualResult)
  );

  // Test 7.2: Academic Announcement produces verified extraction
  const academicResult = await extractAssignmentFromMessage(
    'GET 301 report submission has been fixed for Friday morning at 9:00 AM'
  );
  assert(
    academicResult !== null && academicResult.is_important === true && academicResult.course_code === 'GET 301',
    'Proactive Alert Gate: Academic announcement correctly flagged as important with course code',
    JSON.stringify(academicResult)
  );

  // Test 7.3: Verbatim quote verification prevents hallucinated quotes
  const quoteCheckPass = verifyQuoteInMessage(
    'GET 301 report submission has been fixed for Friday morning at 9:00 AM',
    'report submission has been fixed'
  );
  const quoteCheckFail = verifyQuoteInMessage(
    'GET 301 report submission has been fixed for Friday morning at 9:00 AM',
    'submission is on Monday at 2:00 PM'
  );
  assert(
    quoteCheckPass === true && quoteCheckFail === false,
    'Quote Verification: Verbatim quotes succeed, hallucinated quotes rejected'
  );

  // ----------------------------------------------------
  // Cleanup Test Data
  // ----------------------------------------------------
  console.log('\n--- Cleaning up test artifacts from database ---');
  await supabase.from('reminders').delete().ilike('course_code', 'TEST%');
  await supabase.from('reminders').delete().ilike('topic', '%general task%');

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');
}

runTestSuite().catch(console.error);
