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

    // Use UPDATE if row already exists, INSERT only if not — avoids upsert conflict key mismatches
    let data, error;
    if (prefRow) {
      ({ data, error } = await supabase
        .from('monitored_chats')
        .update({ name: JSON.stringify(current) })
        .eq('chat_id', 'user_preferences')
        .select());
    } else {
      ({ data, error } = await supabase
        .from('monitored_chats')
        .insert({ chat_id: 'user_preferences', name: JSON.stringify(current), is_active: false })
        .select());
    }

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
    let targetChatId = null;
    const groupName = (name || '').trim();

    if (!groupName && !chat_id) {
      return { error: 'Please provide the name of the group to monitor.' };
    }

    // 1. Search live groups from WAHA by title (case-insensitive, normalized)
    const liveGroups = await getWhatsAppGroups();
    if (liveGroups && liveGroups.length > 0 && groupName) {
      const cleanTarget = groupName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const matched = liveGroups.find(g => {
        const cleanG = (g.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanG.includes(cleanTarget) || cleanTarget.includes(cleanG);
      });
      if (matched) {
        targetChatId = matched.chat_id;
      }
    }

    // 2. Check if already known in monitored_chats by name
    if (!targetChatId && groupName) {
      const { data: existing } = await supabase
        .from('monitored_chats')
        .select('chat_id')
        .ilike('name', `%${groupName}%`)
        .maybeSingle();
      if (existing) {
        targetChatId = existing.chat_id;
      }
    }

    // 3. Fallback: Check if recent raw_messages has this group directly
    if (!targetChatId && chat_id && chat_id.endsWith('@g.us')) {
      const { data: rawMsg } = await supabase
        .from('raw_messages')
        .select('chat_id')
        .eq('chat_id', chat_id)
        .limit(1)
        .maybeSingle();
      if (rawMsg) {
        targetChatId = rawMsg.chat_id;
      }
    }

    if (!targetChatId) {
      return {
        error: `Could not find a group matching "${groupName}". Please ensure the bot's second line is added to that group.`
      };
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
        chat_id: targetChatId,
        name: groupName || 'Group Chat',
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
    let reminderQuery = supabase.from('reminders').update({ is_done: true }).eq('is_done', false);

    // Filter out placeholder strings
    const cleanCourse = (course_code && !['general', 'null', 'none'].includes(course_code.toLowerCase())) 
      ? course_code.toUpperCase().trim() 
      : null;

    if (cleanCourse) {
      query = query.ilike('course_code', `%${cleanCourse}%`);
      reminderQuery = reminderQuery.ilike('course_code', `%${cleanCourse}%`);
    } else if (title) {
      query = query.ilike('title', `%${title}%`);
      reminderQuery = reminderQuery.ilike('topic', `%${title}%`);
    } else {
      // If user simply said "done" without specific course/title, resolve all currently active reminders
      reminderQuery = reminderQuery.eq('is_stopped', false);
    }

    const { data: updatedAssignments } = await query.select();
    const { data: updatedReminders } = await reminderQuery.select();

    return {
      success: true,
      message: 'Assignment marked as completed and reminders resolved.',
      completed_assignments: updatedAssignments?.length || 0,
      completed_reminders: updatedReminders?.length || 0
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
      const str = target_date.toLowerCase().trim();
      const numMap = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

      // "in X months" / "in four months time" / "next two months"
      const monthsMatch = str.match(/(?:in\s+(?:the\s+next\s+)?|next\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+months?(?:\s+(?:time|from\s+now))?/i);
      if (monthsMatch) {
        const count = parseInt(monthsMatch[1]) || numMap[monthsMatch[1].toLowerCase()] || 1;
        nextRun.setMonth(nextRun.getMonth() + count);
        nextRun.setHours(9, 0, 0, 0);

      // "next week" (plain — must come before the weeks regex so "next week" isn't swallowed)
      } else if (/^next\s+week$/.test(str) || str === 'next week') {
        nextRun.setDate(nextRun.getDate() + 7);
        nextRun.setHours(9, 0, 0, 0);

      // "in X weeks" / "next two weeks" / "in the next X weeks"
      } else if (str.match(/(?:in\s+(?:the\s+next\s+)?|next\s+)?(\d+|one|two|three|four|five|six|seven|eight)\s+weeks?(?:\s+(?:time|from\s+now))?/i)) {
        const wMatch = str.match(/(?:in\s+(?:the\s+next\s+)?|next\s+)?(\d+|one|two|three|four|five|six|seven|eight)\s+weeks?/i);
        const count = parseInt(wMatch[1]) || numMap[wMatch[1].toLowerCase()] || 1;
        nextRun.setDate(nextRun.getDate() + count * 7);
        nextRun.setHours(9, 0, 0, 0);

      // "in X days" / "in the next X days" / "X days from now"
      } else if (str.match(/(?:in\s+(?:the\s+next\s+)?)?(\d+|one|two|three|four|five|six|seven)\s+days?(?:\s+from\s+now)?/i)) {
        const dMatch = str.match(/(?:in\s+(?:the\s+next\s+)?)?(\d+|one|two|three|four|five|six|seven)\s+days?(?:\s+from\s+now)?/i);
        const count = parseInt(dMatch[1]) || numMap[dMatch[1].toLowerCase()] || 2;
        nextRun.setDate(nextRun.getDate() + count);
        nextRun.setHours(9, 0, 0, 0);

      // "in X hours"
      } else if (str.match(/in\s+(\d+|one|two|three|four|five)\s+hours?/i)) {
        const hMatch = str.match(/in\s+(\d+|one|two|three|four|five)\s+hours?/i);
        const count = parseInt(hMatch[1]) || numMap[hMatch[1].toLowerCase()] || 1;
        nextRun.setHours(nextRun.getHours() + count);

      // "tomorrow" / "morrow"
      } else if (str.includes('tomorrow') || str.includes('morrow')) {
        nextRun.setDate(nextRun.getDate() + 1);
        nextRun.setHours(8, 0, 0, 0);

      // "weekend" / "saturday" / "sunday"
      } else if (str.includes('weekend') || str.includes('sunday') || str.includes('saturday')) {
        const day = nextRun.getDay();
        const daysUntilSunday = (7 - day) % 7 || 7;
        nextRun.setDate(nextRun.getDate() + daysUntilSunday);
        nextRun.setHours(12, 0, 0, 0);

      // ISO / standard date string
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

    // Always deactivate existing active reminders for this topic or course so old intervals don't collide
    let oldQuery = supabase.from('reminders').update({ is_stopped: true }).eq('is_stopped', false);
    if (course_code) {
      oldQuery = oldQuery.ilike('course_code', `%${course_code}%`);
    } else if (topic) {
      oldQuery = oldQuery.ilike('topic', `%${topic}%`);
    }
    await oldQuery;

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
  async stop_reminders({ course_code, topic }) {
    let query = supabase.from('reminders').update({ is_stopped: true }).eq('is_stopped', false);

    const cleanCourse = (course_code && !['general', 'null', 'none'].includes(course_code.toLowerCase())) 
      ? course_code.toUpperCase().trim() 
      : null;

    if (cleanCourse) {
      query = query.ilike('course_code', `%${cleanCourse}%`);
    } else if (topic) {
      query = query.ilike('topic', `%${topic}%`);
    }
    // If neither is specified, stops all active reminders
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

    // Fetch messages from Supabase raw_messages (only from monitored groups)
    let msgQuery = supabase
      .from('raw_messages')
      .select('body, sender_id, sender_name, timestamp, created_at, chat_id')
      .order('timestamp', { ascending: false })
      .limit(20);

    if (targetChatId) {
      msgQuery = msgQuery.eq('chat_id', targetChatId);
    } else {
      const { data: activeMonitored } = await supabase
        .from('monitored_chats')
        .select('chat_id')
        .eq('is_active', true);
      const activeIds = (activeMonitored || []).map(g => g.chat_id).filter(id => id && id.endsWith('@g.us'));
      if (activeIds.length > 0) {
        msgQuery = msgQuery.in('chat_id', activeIds);
      }
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
