# The phone app's API

What the Android app uses. All requests carry `Authorization: Bearer <token>` from
sign-in. Errors are `{ "error": "<sentence to show as is>", "code"?: "<machine code>" }`.
A 401 means the token was revoked or the account changed: sign in again.
`scripts/smoke-stage6.mjs` exercises all of this.

## Sign in

`POST /api/auth/device` `{ email, password, deviceName, platform?: "android", appVersion? }` →
`201 { token, user, teams }`. Revoked under Fleet → Phones on the web.

## Sync

`GET /api/sync[?since=<cursor>]`. No cursor means everything. Keep the returned
`cursor` and send it next time.

| Field | Comes | The phone |
|---|---|---|
| `user` (with `preferences`: `map_colors` {driven, undriven: {color, opacity}} or null for the default, `shade_complete`, `complete_fill` {color, opacity} or null), `teams` (id, name, kind, role) | whole | replaces its copy; draw streets and finished areas in those colours |
| `drive_types` (key, label, `team_counts` {team: bool}) | whole | replaces |
| `vehicles` you may drive (incl. `permanent`, `checkout`) | whole | replaces |
| `areas` your teams track: metadata (id, name, level, color, `version` of the outline, `build_status`, `built_version`, `segment_count`, `bbox`, `team_ids`) | whole | replaces. `geometry` only on a full sync; otherwise, when `version` differs from yours, `GET /api/areas/:id` for the outline |
| `marks` (team_id, segment_id, kind, note) | changed since | upserts |
| `unmarked` (team_id, segment_id) | since | deletes |
| `place_ids` you can see | whole | drops any place not listed |
| `places` | changed since | upserts |
| `drives` you drove or uploaded (status, segment_count, `deleted`; once matched `street_count`, and `new_streets`/`new_m` it was first to sweep for you) | changed since | updates; once `matched`, drops the drive's provisional preview. Show streets, never segments |
| `coverage` {team: {reset, segments: [[segment id, first driven (unix s)]]}} | since, or whole when `reset` | adds; on `reset`, replaces that team's set first |

The cursor is a few seconds behind the server clock, so rows may arrive twice. Apply
everything as an upsert.

## Streets

- `GET /api/areas/:id/package` returns an area's segments (gzip JSON, `ETag` = build;
  send `If-None-Match` to get a 304). It answers 409 `not_built` while the street list
  is being made, and 413 `too_big` past 250,000 segments.
- `GET /api/segments?bbox=w,s,e,n` (at most 0.2° each way) returns the segments in a
  box. Use it for areas too big to package, loading cells as you drive or pan.

```
{ names: [..], highways: [..],
  segments: [[id, way_id, name_index|-1, highway_index, length_m, inside_m (packages only), polyline6]] }
```

A segment is a piece of an OSM way between intersections. Its id is stable across
monthly imports; pieces that disappear are simply absent from newer packages.

## Uploading

- `POST /api/drives` `{ id (uuid made on the phone), drive_type?, vehicle_id?, points: [[t, lat, lon, accuracy_m?, speed_mps?], ..] }`.
  `t` is in unix seconds. Send `Content-Encoding: gzip` for big bodies. It answers 201,
  or 200 `duplicate` for a retry. Drives recorded before the account existed are
  fine: they count for the personal team. A shared team only counts drives from
  while you were in it.
- `PUT /api/teams/:id/marks/:segmentId` `{ kind: "complete"|"excluded", note? }` sets a mark;
  `DELETE` removes it.
- `POST /api/places` `{ id (uuid from the phone), name, note?, lon, lat, drive_id?, team_ids? }`
  answers 201, or 200 `duplicate`. `PATCH /api/places/:id` edits (and `team_ids`
  replaces the sharing), `DELETE` removes. Photos: `POST /api/places/:id/photos?w=&h=`
  with the raw image.
- Vehicles: `POST /api/vehicles/:id/checkout`, `POST /api/vehicles/:id/return`.

## Reading

`GET /api/stats` (yours), `GET /api/teams/:id/stats`, `GET /api/achievements`,
`GET /api/drives`, `GET /api/drives/:id` (track, matched streets, teams it counts for),
`GET /api/segments/:id?team=` (a street's popup).

Basemap tiles come from `GET /api/tiles/osm/{z}/{x}/{y}`, which is the server's cache.
