const supabase = require('../db/client');
const { verifyQuoteInMessage } = require('../utils/helpers');
const { getWhatsAppGroups, getChatMessages } = require('./waha');

/**
 * Registry of tools available to the LLM Orchestrator
 */
const tools = {
  /**
   * Label a phone number/contact with a name and academic role
   */
  async save_contact({ phone_number, display_name, role, trusted_for_class_changes = false }) {
    let cleanPhone = (phone_number || '').replace(/[^0-9]/g, '');

    // If phone number is omitted (e.g. user says "save that number as Wisdom"), grab sender from latest raw message
    if (!cleanPhone) {
      const { data: latestMsg } = await supabase
        .from('raw_messages')
        .select('sender_id')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestMsg && latestMsg.sender_id) {
        cleanPhone = latestMsg.sender_id.replace(/[^0-9]/g, '');
      }
    }

    if (!cleanPhone) return { error: 'No phone number provided and no recent messages found.' };

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
   * Delete or remove a stored contact by name or phone number
   */
  async delete_contact({ display_name, phone_number }) {
    let query = supabase.from('contacts').delete();

    if (display_name) {
      query = query.ilike('display_name', `%${display_name.trim()}%`);
    } else if (phone_number) {
      const cleanPhone = phone_number.replace(/[^0-9]/g, '');
      query = query.ilike('phone_number', `%${cleanPhone}%`);
    } else {
      return { error: 'Please specify the name or phone number of the contact to delete.' };
    }

    const { data, error } = await query.select();
    if (error) return { error: error.message };
    return { success: true, deleted: data };
  },

  /**
   * Update the owner's personal preferences (preferred name, response formatting style, name usage)
   */
  async update_user_preference({ user_name, formatting_style, use_name }) {
    const { data: prefRow } = await supabase
      .from('monitored_chats')
      .select('name')
      .eq('chat_id', 'user_preferences')
      .maybeSingle();

    let current = { user_name: 'Noble', formatting_style: 'double_newline', use_name: true };
    if (prefRow && prefRow.name) {
      try { current = { ...current, ...JSON.parse(prefRow.name) }; } catch (e) {}
    }

    if (typeof use_name === 'boolean') {
      current.use_name = use_name;
    }
    if (user_name !== undefined) {
      if (user_name === '' || user_name === null) {
        current.use_name = false;
      } else {
        current.user_name = user_name.trim();
        current.use_name = true;
      }
    }
    if (formatting_style) current.formatting_style = formatting_style.trim();

    const { data, error } = await supabase
      .from('monitored_chats')
      .upsert({
        chat_id: 'user_preferences',
        name: JSON.stringify(current),
        is_active: false
      })
      .select();

    const ownerPhone = process.env.USER_PHONE_NUMBER || '2349150573885';
    if (user_name && current.use_name) {
      await supabase.from('contacts').upsert({
        phone_number: ownerPhone,
        display_name: current.user_name,
        role: 'owner',
        trusted_for_class_changes: true
      });
    }

    if (error) return { error: error.message };
    return { success: true, preferences: current };
  },

  /**
   * Monitor or link groups (e.g. class group, youth group, crew group)
   */
  async configure_group({ chat_id, name, linked_to_group_name }) {
    let targetChatId = chat_id;

    // If chat_id not provided, try to find a matching WhatsApp group by name
    if (!targetChatId && name) {
      const liveGroups = await getWhatsAppGroups();
      const matched = liveGroups.find(g => 
        g.name.toLowerCase().includes(name.toLowerCase()) || 
        name.toLowerCase().includes(g.name.toLowerCase())
      );
      if (matched) {
        targetChatId = matched.chat_id;
      }
    }

    // Fallback: Bind to the most recent group chat discovered in messages
    if (!targetChatId) {
      const { data: recentGroupMsg } = await supabase
        .from('raw_messages')
        .select('chat_id')
        .ilike('chat_id', '%@g.us%')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recentGroupMsg && recentGroupMsg.chat_id) {
        targetChatId = recentGroupMsg.chat_id;
      }
    }

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
        chat_id: targetChatId || `group_${Date.now()}`,
        name: name,
        is_active: true,
        linked_chat_id
      })
      .select();

    if (error) return { error: error.message };
    return { success: true, group: data[0] };
  },

  /**
   * Mark an assignment as completed ("done") and resolve its reminders
   */
  async mark_assignment_done({ course_code, title }) {
    let query = supabase.from('assignments').update({ status: 'completed' });
    let reminderQuery = supabase.from('reminders').update({ is_done: true });

    if (course_code) {
      const code = course_code.toUpperCase();
      query = query.ilike('course_code', `%${code}%`);
      reminderQuery = reminderQuery.ilike('course_code', `%${code}%`);
    } else if (title) {
      query = query.ilike('title', `%${title}%`);
      reminderQuery = reminderQuery.ilike('topic', `%${title}%`);
    }

    const { data: updatedAssignments } = await query.select();
    await reminderQuery;

    return {
      success: true,
      message: 'Assignment marked as completed and reminders resolved.',
      completed: updatedAssignments
    };
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
  async set_reminder({ course_code, topic, interval_minutes, scheduled_time, target_date }) {
    let nextRun = new Date();

    if (target_date) {
      const lower = target_date.toLowerCase();
      if (lower.includes('weekend') || lower.includes('sunday') || lower.includes('saturday')) {
        const day = nextRun.getDay();
        const daysUntilSunday = (7 - day) % 7 || 7;
        nextRun.setDate(nextRun.getDate() + daysUntilSunday);
        nextRun.setHours(12, 0, 0, 0); // Sunday noon
      } else {
        const parsed = new Date(target_date);
        if (!isNaN(parsed.getTime())) {
          nextRun = parsed;
        } else {
          nextRun.setMinutes(nextRun.getMinutes() + (interval_minutes || 60));
        }
      }
    } else {
      nextRun.setMinutes(nextRun.getMinutes() + (interval_minutes || 60));
    }

    const { data, error } = await supabase
      .from('reminders')
      .insert({
        course_code: course_code ? course_code.toUpperCase() : null,
        topic: topic || 'Review deadline',
        interval_minutes: interval_minutes || 60,
        scheduled_times: scheduled_time ? [scheduled_time] : null,
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
   * Delete or clear assignments/deadlines when the user asks to remove them
   */
  async remove_assignment({ course_code, remove_all = false }) {
    let query = supabase.from('assignments').delete();
    if (remove_all) {
      query = query.neq('id', '00000000-0000-0000-0000-000000000000'); // delete all
    } else if (course_code) {
      query = query.ilike('course_code', `%${course_code.toUpperCase()}%`);
    } else {
      // delete the latest one
      const { data: latest } = await supabase.from('assignments').select('id').order('created_at', { ascending: false }).limit(1);
      if (latest && latest[0]) {
        query = query.eq('id', latest[0].id);
      }
    }

    const { data, error } = await query.select();
    if (error) return { error: error.message };
    return { success: true, removed_count: data?.length || 0 };
  },

  /**
   * Search past messages, announcements, deadlines, payments, and reactions
   */
  async query_context({ person_name, course_code, group_name, query_type = 'general' }) {
    const results = {};

    let targetChatId = null;

    if (group_name) {
      // 1. Find group chat_id in monitored_chats
      const { data: group } = await supabase
        .from('monitored_chats')
        .select('chat_id, name')
        .ilike('name', `%${group_name.trim()}%`)
        .maybeSingle();

      if (group) {
        targetChatId = group.chat_id;
      } else {
        // Search live WhatsApp groups by title
        const liveGroups = await getWhatsAppGroups();
        const matched = liveGroups.find(g => 
          g.name.toLowerCase().includes(group_name.toLowerCase()) || 
          group_name.toLowerCase().includes(g.name.toLowerCase())
        );
        if (matched) targetChatId = matched.chat_id;
      }
    } else {
      // Default to the first active monitored group if one exists
      const { data: firstMonitored } = await supabase
        .from('monitored_chats')
        .select('chat_id, name')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      if (firstMonitored) {
        targetChatId = firstMonitored.chat_id;
      }
    }

    // Fetch messages from Supabase raw_messages
    let msgQuery = supabase
      .from('raw_messages')
      .select('body, sender_id, sender_name, timestamp, created_at, chat_id')
      .order('timestamp', { ascending: false })
      .limit(20);

    if (targetChatId) {
      msgQuery = msgQuery.eq('chat_id', targetChatId);
    }

    let { data: messages } = await msgQuery;

    // If local database has no messages for this group, query live WAHA chat messages directly
    if ((!messages || messages.length === 0) && targetChatId) {
      const liveChatMsgs = await getChatMessages(targetChatId, 15);
      if (liveChatMsgs && liveChatMsgs.length > 0) {
        messages = liveChatMsgs.map(m => ({
          body: m.body,
          sender_id: m.fromMe ? 'Bot' : (m.author || m.from),
          sender_name: m._data?.notifyName || null,
          timestamp: m.timestamp,
          chat_id: targetChatId
        }));
      }
    }

    // Fetch known contacts and resolve sender numbers to names
    const { data: allContacts } = await supabase.from('contacts').select('phone_number, display_name, role');
    const contactMap = {};
    if (allContacts) {
      for (const c of allContacts) {
        contactMap[c.phone_number] = `${c.display_name} (${c.role})`;
      }
    }

    const resolvedMessages = (messages || []).map(m => {
      const cleanSender = (m.sender_id || '').replace(/[^0-9]/g, '');
      const matchedContact = Object.keys(contactMap).find(p => cleanSender.includes(p) || p.includes(cleanSender));
      return {
        body: m.body,
        sender: matchedContact ? contactMap[matchedContact] : (m.sender_name || m.sender_id),
        timestamp: m.timestamp,
        chat_id: m.chat_id
      };
    });

    results.recent_group_messages = resolvedMessages;

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
