-- Genexa OS: configuration rows. These are rules from the brief, not sample data.
-- The owner can edit them in the app; re-running this file never overwrites an edit.

insert into scoring_config (key, card, label, direction, green, amber, value, unit) values
  -- Tech
  ('tech_launch_sla_pct',      'tech', 'Launches live within 48h (Genexa time)',   'higher_better', 90, 70, null, '%'),
  ('tech_fix_sla_pct',         'tech', 'Fixes within 30 business minutes',         'higher_better', 80, 60, null, '%'),
  ('tech_broken_week1',        'tech', 'Launches broken in week 1',                'lower_better',   0,  1, null, 'count'),
  ('tech_eods_missed',         'tech', 'EODs missed (of 5 working days)',          'lower_better',   0,  1, null, 'count'),
  -- Media buyer
  ('media_exceptions_24h_pct', 'media_buyer', 'Ad exceptions resolved within 24h', 'higher_better', 90, 70, null, '%'),
  ('media_accounts_over_cpb',  'media_buyer', 'Accounts with 7d cost per booked over the red line', 'lower_better', 0, 2, null, 'count'),
  ('media_accounts_flagged_3d','media_buyer', 'Accounts flagged 3+ days running',  'lower_better',   0,  1, null, 'count'),
  ('media_book_cpb_change_pct','media_buyer', 'Book-wide 7d cost per booked vs previous 7d', 'lower_better', 10, 25, null, '%'),
  ('media_zero_spend_accounts','media_buyer', 'Live accounts with $0 spend 24h+',  'lower_better',   0,  0, null, 'count'),
  ('media_eods_missed',        'media_buyer', 'EODs missed (of 5 working days)',   'lower_better',   0,  1, null, 'count'),
  -- CSR
  ('csr_speed_to_lead_min',    'csr', 'Median speed to lead',                      'lower_better',   5, 15, null, 'min'),
  ('csr_book_rate_pct',        'csr', 'Book rate',                                 'higher_better', 35, 25, null, '%'),
  ('csr_confirmation_rate_pct','csr', 'Confirmation rate',                         'higher_better', 70, 50, null, '%'),
  ('csr_show_rate_pct',        'csr', 'Show rate of own bookings',                 'higher_better', 60, 40, null, '%'),
  ('csr_eods_missed',          'csr', 'EODs missed (of 7)',                        'lower_better',   1,  3, null, 'count'),
  -- Account verdict and client health
  ('cost_per_booked_7d',       'client_health', '7d cost per booked',              'lower_better',  71, 110, null, '$'),
  ('health_no_reply_days',     'client_health', 'Days since client reply',         'lower_better',   6, 13, null, 'days'),
  ('health_paid_not_launched_days', 'client_health', 'Days paid and not launched', 'lower_better',   6, 13, null, 'days'),
  ('health_outcomes_overdue_hours', 'client_health', 'Outcome overdue (amber at)', 'constant', null, null, 48, 'hours'),
  ('health_guarantee_window_days',  'client_health', 'Guarantee deadline window',  'constant', null, null, 7, 'days'),
  ('health_cpb_grace_days',    'client_health', 'Days live before cost per booked can turn a client red', 'constant', null, null, 14, 'days'),
  -- Constants
  ('sla_launch_hours',         'sla', 'Launch SLA (hours of Genexa time)',         'constant', null, null, 48, 'hours'),
  ('sla_fix_business_minutes', 'sla', 'Fix SLA (business minutes)',                'constant', null, null, 30, 'min'),
  ('sla_pause_max_hours',      'sla', 'Pause length that raises an exception',     'constant', null, null, 24, 'hours'),
  ('rev_share_rate',           'general', 'Revenue share',                         'constant', null, null, 0.05, 'ratio'),
  ('mrr_target',               'general', 'MRR target',                            'constant', null, null, 100000, '$'),
  ('task_deleted_similarity',  'general', 'Deleted-task match threshold',          'constant', null, null, 0.6, 'ratio'),
  ('speed_to_lead_target_min', 'general', 'Lead must be called within',            'constant', null, null, 5, 'min')
on conflict (key) do nothing;

-- Schedules drive staleness: a source is stale when its last success is older than 2x this.
insert into integration_sync_status (source, schedule_minutes) values
  ('cortana', 60),
  ('ghl', 15),
  ('whop', 60),
  ('mercury', 1440),
  ('fathom', 60),
  ('client_dashboard', 1440)
on conflict (source) do nothing;

insert into app_settings (key, value) values
  ('go_live_date', null),
  ('mrr_target_date', '"2026-12-31"')
on conflict (key) do nothing;
