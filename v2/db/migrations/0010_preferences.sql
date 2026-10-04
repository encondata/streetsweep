-- Each person's own settings, such as the colours streets are drawn in. Free-form, so a
-- new preference needs no migration; the api validates what goes in.
ALTER TABLE users ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}';
