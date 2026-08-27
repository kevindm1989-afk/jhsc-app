# Rudy & Sarah — RSVP + live admin page

The admin page now updates by itself when someone RSVPs. No refresh needed.

## Files

| File | What it is |
|---|---|
| `rsvp.html` | The guest-facing invitation and RSVP form |
| `admin.html` | Your private admin page — live guest list, full details, stats, email |
| `Code.gs` | The Google Apps Script backend (paste into your existing script project) |

## Setup — about two minutes

1. Open your RSVP spreadsheet ▸ **Extensions ▸ Apps Script**.
2. Replace the code there with the contents of `Code.gs`.
3. **Deploy ▸ Manage deployments ▸** pencil icon on the existing deployment ▸
   **Version: New version** ▸ **Deploy**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Keeping the same deployment keeps the same `/exec` URL, so neither HTML
     file needs editing.
4. Upload `rsvp.html` and `admin.html` wherever you host them.

Step 2–3 are optional but recommended — the pages read whatever format your
current script returns. The supplied `Code.gs` just makes it unambiguous, and
adds a lock so two guests RSVPing at the same second cannot overwrite each other.

## How the live update works

- The admin page polls the sheet every **15 seconds** and redraws if anything
  changed. New arrivals get a gold "New" badge, a toast, and a brief highlight.
- Polling **pauses while the tab is in the background** (the indicator reads
  "Paused") and catches up the moment you switch back, so it does not burn
  Apps Script quota overnight.
- If the RSVP page and the admin page are open on the same site, submitting an
  RSVP nudges the admin tab to refresh **immediately** rather than waiting for
  the next poll.
- The indicator in the header shows the state: green pulse = live, gold =
  paused, red = cannot reach the sheet (it keeps retrying).

To change the polling rate, edit `POLL_MS` near the top of the script block in
`admin.html`. 15000 = 15 seconds. Going below ~5000 is not advisable — Apps
Script has a daily quota.

## What else changed

- **Both pages now read the sheet the same way.** The admin page previously
  assumed rows-with-a-header while the RSVP page's own guest list assumed an
  array of objects — only one of those could ever be right, so one page was
  always showing nothing. Both now accept either format, and match columns by
  header *name*, so re-ordering the sheet columns can no longer swap Meal with
  Message.
- **A failed RSVP no longer looks like a success.** The form used to fire the
  request blind (`mode: 'no-cors'`) and show "With Gratitude" whether or not
  the row was written. It now confirms the write, and says so if it failed.
  If the response is unreadable it re-reads the sheet to check rather than
  re-posting, so a guest never ends up in the list twice.
- **Double-clicking Confirm submits once.** The button locks while sending.
- **Every submitted field is on the card.** No export needed — each response
  lists both guests by name with their own meal choice (vegetarian highlighted
  in gold), the party size, the email as a click-to-send link, the message and
  the time it came in.
- **Search covers everything**, not just names — type "vegetarian" to pull up
  every veg meal, or search inside guests' messages.
- **Vegetarian count counts meals, not responses.** A couple who chose
  "Standard / Vegetarian" counts as one vegetarian meal, which is the number
  the caterer actually needs.
- A blank guest count on an attending response now counts as 1 seat instead of 0.
- The public guest list shows names, attendance and messages only — never email
  addresses. Those stay on the admin page.
