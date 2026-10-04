-- Sections: the numbered parts of a big neighborhood (Sienna Plantation Section 12).
-- A drawn section's parent is the team's drawn neighborhood it sits in.
ALTER TABLE areas DROP CONSTRAINT areas_level_check;
ALTER TABLE areas ADD CONSTRAINT areas_level_check
  CHECK (level IN ('state', 'county', 'city', 'neighborhood', 'section', 'custom'));
