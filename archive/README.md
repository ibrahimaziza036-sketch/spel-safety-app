# Archived modules (not served)

Phase-1 launch = Dashboard + public Report form only. These pages were moved out
of `public/` so they are NOT served, but kept here to restore later.

- `public/incidents.html`, `public/js/incidents.js` — the staff "browse all incidents"
  list page. (The incident DETAIL page — public/incident.html — is still active,
  reachable from the dashboard.)

## Restore
Move files back into `public/` (and `public/js/`), then re-add the nav links in
`public/js/common.js` (Incidents + Admin).

Note: the incidents **API** (routes/incidents.js) and the **admin** page
(public/admin.html, reachable at /admin.html but hidden from the menu) remain active.
