-- Twersky Database Schema for Supabase

-- 1. Raw Messages (Every group and direct message stored word-for-word)
CREATE TABLE IF NOT EXISTS raw_messages (
    id TEXT PRIMARY KEY,                       -- WAHA message ID
    chat_id TEXT NOT NULL,                     -- JID of group or DM (e.g. 12345@g.us)
    sender_id TEXT NOT NULL,                   -- SENDER JID (e.g. 23480...@c.us)
    sender_name TEXT,                          -- Pushname/display name if available
    body TEXT,                                 -- Exact message text
    has_media BOOLEAN DEFAULT FALSE,
    media_url TEXT,
    media_mimetype TEXT,
    timestamp BIGINT NOT NULL,                 -- Unix epoch timestamp
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_messages_chat_id ON raw_messages (chat_id);
CREATE INDEX IF NOT EXISTS idx_raw_messages_sender_id ON raw_messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_raw_messages_timestamp ON raw_messages (timestamp DESC);

-- 2. Monitored Chats & Linked Groups
CREATE TABLE IF NOT EXISTS monitored_chats (
    chat_id TEXT PRIMARY KEY,                  -- e.g. class_group@g.us
    name TEXT NOT NULL,                        -- e.g. "Class Group", "Youth Group", "Crew Group"
    is_active BOOLEAN DEFAULT TRUE,
    linked_chat_id TEXT REFERENCES monitored_chats(chat_id) ON DELETE SET NULL, -- Link crew group -> class group
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Identified Contacts (e.g. Wisdom = course rep)
CREATE TABLE IF NOT EXISTS contacts (
    phone_number TEXT PRIMARY KEY,             -- e.g. 2348012345678 or 2348012345678@c.us
    display_name TEXT NOT NULL,                -- e.g. "Wisdom"
    role TEXT NOT NULL,                        -- e.g. "course rep", "lecturer"
    trusted_for_class_changes BOOLEAN DEFAULT FALSE, -- "always trust course rep on class changes"
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Timetable Entries
CREATE TABLE IF NOT EXISTS timetable_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_code TEXT NOT NULL,                 -- e.g. "GT 301"
    day_of_week INT NOT NULL,                  -- 1 = Monday, 7 = Sunday
    start_time TIME NOT NULL,                  -- e.g. 08:00:00
    end_time TIME,                             -- e.g. 10:00:00
    venue TEXT,                                -- e.g. "Lecture Hall 2"
    is_cancelled_this_week BOOLEAN DEFAULT FALSE,
    cancellation_date DATE,                    -- Date for which it was cancelled
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Assignments & Deadlines
CREATE TABLE IF NOT EXISTS assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_code TEXT NOT NULL,                 -- e.g. "GT 301"
    title TEXT NOT NULL,                       -- e.g. "GT 301 Report"
    description TEXT,                          -- Details (e.g. "now includes results section")
    deadline_text TEXT,                        -- What was literally stated (e.g. "Monday morning")
    deadline_timestamp TIMESTAMPTZ,            -- Calculated timestamp by deterministic logic, or NULL if unspecified
    deadline_inferred BOOLEAN DEFAULT FALSE,   -- TRUE if inferred from timetable
    source_message_id TEXT REFERENCES raw_messages(id) ON DELETE SET NULL,
    source_sender_id TEXT,
    source_quote TEXT,                         -- Exact quote extracted from message
    status TEXT DEFAULT 'pending',             -- pending, done
    is_important BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Reminders (Decoupled: done vs stopped)
CREATE TABLE IF NOT EXISTS reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID REFERENCES assignments(id) ON DELETE CASCADE,
    course_code TEXT,                          -- Optional tie to a course
    topic TEXT NOT NULL,                       -- What to remind about (e.g. "Submit GT 301", "Print GT 301")
    interval_minutes INT NOT NULL DEFAULT 60,  -- Frequency (e.g. 30, 60, 1440)
    scheduled_times JSONB,                     -- Optional list of specific times (e.g. ["19:00", "07:00"])
    quiet_hours_start TIME DEFAULT '23:00:00',
    quiet_hours_end TIME DEFAULT '06:00:00',
    is_done BOOLEAN DEFAULT FALSE,             -- Task is completed
    is_stopped BOOLEAN DEFAULT FALSE,          -- Reminder loop stopped
    next_run_at TIMESTAMPTZ NOT NULL,
    last_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Conflicts (Prompting user before overwriting manual changes)
CREATE TABLE IF NOT EXISTS conflicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,                        -- "class_cancellation", "deadline_change"
    course_code TEXT NOT NULL,
    current_value TEXT NOT NULL,               -- e.g. "Cancelled by user"
    proposed_value TEXT NOT NULL,              -- e.g. "Holding on Monday per Course Rep"
    source_message_id TEXT REFERENCES raw_messages(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'pending',             -- pending, resolved_keep, resolved_overwrite
    created_at TIMESTAMPTZ DEFAULT NOW()
);
