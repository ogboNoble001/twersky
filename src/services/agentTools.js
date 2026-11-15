const supabase = require('../db/client');
const { verifyQuoteInMessage } = require('../utils/helpers');

/**
 * Registry of tools available to the LLM Orchestrator
 */
const tools = {
  /**
   * Label a phone number/contact with a name and academic role
   */
  async save_contact({ phone_number, display_name, role, trusted_for_class_changes = false }) {
    const cleanPhone = (phone_number || '').replace(/[^0-9]/g, '');
    if (!cleanPhone) return { error: 'Invalid phone number provided' };

    const { data, error } = await supabase
      .from('contacts')
      .upsert({
        phone_number: cleanPhone,
        display_name: display_name || 'Unknown',
        role: role || 'contact',
        trusted_for_class_changes: Boolean(trusted_for_class_changes)
      })
      .select();

    if (error) return { error: error.message };
    return { success: true, contact: data[0] };
  },

  /**
   * Monitor or link groups (e.g. class group, youth group, crew group)
   */
  async configure_group({ chat_id, name, linked_to_group_name }) {
    let linked_chat_id = null;
    if (linked_to_group_name) {
      const { data: parent } = await supabase
        .from('monitored_chats')
        .select('chat_id')
        .ilike('name', `%${linked_to_group_name}%`)
        .maybeSingle();
      if (parent) linked_chat_id = parent.chat_id;
    }

    const { data, error } = await supabase
      .from('monitored_chats')
      .upsert({
        chat_id: chat_id || `group_${Date.now()}`,
        name: name,
        is_active: true,
        linked_chat_id
      })
      .select();

    if (error) return { error: error.message };
    return { success: true, group: data[0] };
  },

  /**
   * Save or update an assignment or deadline
   * Strict Rule: Validates that source_quote is a verbatim excerpt
   */
  async track_assignment({ course_code, title, deadline_text, description, source_quote, original_message }) {
    if (source_quote && original_message) {
      const isValid = verifyQuoteInMessage(original_message, source_quote);
      if (!isValid) {
        return {
          error: 'Quote verification failed. The claimed detail was not found verbatim in the message.'
        };
      }
    }

    const { data, error } = await supabase
      .from('assignments')
      .insert({
        course_code: course_code ? course_code.toUpperCase() : null,
        title: title || `${course_code} Assignment`,
        deadline_text: deadline_text || 'not stated',
        description: description || null,
        source_quote: source_quote || null,
        status: 'pending'
      })
      .select();

    if (error) return { error: error.message };
    return { success: true, assignment: data[0] };
  },

  /**
   * Schedule or update a reminder
   */
  async set_reminder({ course_code, topic, interval_minutes, scheduled_time, quiet_hours_start, quiet_hours_end }) {
    const nextRun = new Date();
    nextRun.setMinutes(nextRun.getMinutes() + (interval_minutes || 60));

    const { data, error } = await supabase
      .from('reminders')
      .insert({
        course_code: course_code ? course_code.toUpperCase() : null,
        topic: topic || 'Review deadline',
        interval_minutes: interval_minutes || 60,
        scheduled_times: scheduled_time ? [scheduled_time] : null,
        quiet_hours_start: quiet_hours_start || '23:00:00',
        quiet_hours_end: quiet_hours_end || '06:00:00',
        next_run_at: nextRun.toISOString()
      })
      .select();

    if (error) return { error: error.message };
    return { success: true, reminder: data[0] };
  },

  /**
   * Cancel, move, or restore a class
   */
  async update_class_status({ course_code, is_cancelled, reason }) {
    const code = (course_code || '').toUpperCase();
    const { data, error } = await supabase
      .from('timetable_entries')
      .update({ is_cancelled_this_week: Boolean(is_cancelled) })
      .ilike('course_code', `%${code}%`)
      .select();

    // If cancelled, pause associated reminders
    if (is_cancelled) {
      await supabase
        .from('reminders')
        .update({ is_stopped: true })
        .ilike('course_code', `%${code}%`);
    } else {
      await supabase
        .from('reminders')
        .update({ is_stopped: false })
        .ilike('course_code', `%${code}%`);
    }

    if (error) return { error: error.message };
    return { success: true, updated: data };
  },

  /**
   * Stop active reminders ("stop")
   */
  async stop_reminders({ course_code }) {
    let query = supabase.from('reminders').update({ is_stopped: true }).eq('is_stopped', false);
    if (course_code) {
      query = query.ilike('course_code', `%${course_code.toUpperCase()}%`);
    }
    const { data, error } = await query.select();
    if (error) return { error: error.message };
    return { success: true, stopped_count: data?.length || 0 };
  },

  /**
   * Search past messages, announcements, deadlines, payments, and reactions
   */
  async query_context({ person_name, course_code, group_name, query_type = 'general' }) {
    const results = {};

    // 1. Fetch relevant announcements or messages
    let msgQuery = supabase
      .from('raw_messages')
      .select('body, sender_name, timestamp, created_at, chat_id')
      .order('timestamp', { ascending: false })
      .limit(20);

    if (group_name) {
      // Find group chat_id if monitored
      const { data: group } = await supabase
        .from('monitored_chats')
        .select('chat_id')
        .ilike('name', `%${group_name}%`)
        .maybeSingle();
      if (group) {
        msgQuery = msgQuery.eq('chat_id', group.chat_id);
      }
    }

    const { data: messages } = await msgQuery;
    results.recent_group_messages = messages || [];

    // 2. Fetch all current deadlines & assignments
    const { data: assignments } = await supabase
      .from('assignments')
      .select('*')
      .order('created_at', { ascending: false });
    results.assignments = assignments || [];

    // 3. Fetch active reminders
    const { data: reminders } = await supabase
      .from('reminders')
      .select('*')
      .eq('is_stopped', false);
    results.active_reminders = reminders || [];

    // 4. Fetch timetable
    const { data: timetable } = await supabase
      .from('timetable_entries')
      .select('*');
    results.timetable = timetable || [];

    return results;
  }
};

module.exports = {
  tools
};
