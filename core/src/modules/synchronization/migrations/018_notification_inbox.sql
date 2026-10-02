-- A cleared notification is gone for clients; the row stays so it keeps its identity and is never created again.
ALTER TABLE kipster.notifications ADD COLUMN cleared_at timestamptz;

-- Which desktop alerts to show, in-app banners and the app icon badge, next to the desktop alert choice. NULL is the default.
ALTER TABLE kipster.interface_preferences ADD COLUMN notify_needs boolean, ADD COLUMN notify_failures boolean,
  ADD COLUMN notify_replies boolean, ADD COLUMN in_app_banners boolean, ADD COLUMN dock_badge boolean;
