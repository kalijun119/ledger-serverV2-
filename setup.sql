-- Run this once in your Supabase project's SQL Editor (left sidebar -> SQL Editor -> New query).
-- This creates the table that replaces server/data/users.json.

create table if not exists users (
  id serial primary key,
  name text not null,
  email text unique not null,
  password_hash text not null,
  security_question text not null,
  security_answer_hash text not null,
  joined_at timestamptz not null default now(),
  failed_attempts int not null default 0,
  locked_until timestamptz
);

-- Speeds up login lookups by email (which happen on every login attempt)
create index if not exists idx_users_email on users (email);