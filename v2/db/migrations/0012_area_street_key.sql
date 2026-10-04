-- Streets as people count them: every piece of an area's street list sharing a name is
-- one street (unnamed pieces count by their OpenStreetMap way). Worked out when the area
-- is built, so progress can count streets without joining names on every request.
ALTER TABLE area_segments ADD COLUMN street_key integer;

UPDATE area_segments a
   SET street_key = hashtext(coalesce(lower(w.name), 'way ' || s.way_id))
  FROM street_segments s LEFT JOIN street_ways w ON w.way_id = s.way_id
 WHERE s.id = a.segment_id;
