# Chris Connelly Calendar Sync — How It Works

Apps Script project ID: `1c0aov7lNdKpaTqKY7aw8gv2jElN5jFQWN46FqGNsnkiemZczzdAIEgKE`
Local copy (for reference/editing): `CentralStudio_SM_CalendarSync/` (cloned via `clasp`, kept outside the
`CentralStudio_SM` folder since `clasp` walks up looking for an existing `.clasp.json`
and refuses to clone into a directory nested under one).

## What it's for

Chris books his own studio time directly on his personal Google Calendar instead of
going through the Calendly form everyone else uses. This script is the bridge: it
watches Chris's calendar and copies his studio bookings onto the business calendar,
so they show up next to everyone else's bookings without Chris — or you — having to
do anything manually.

## What it does, step by step

1. **Looks ahead 6 months.** Each time it runs, it checks Chris's calendar (`chris@chrisconnellyphotography.com`) for every event between right now and 6 months out.

2. **Filters by address, not by title or keyword.** For each event, it checks the event's **Location** field. It only continues if that field contains the text `1095` — the street number of the studio. This is the safety net that keeps the script from copying over Chris's personal, non-studio events (dentist appointments, vacations, etc.) — only things he's booked *at the studio address* get synced.

3. **Checks for a duplicate.** Before creating anything, it looks at what's already on the business calendar during that same time window and checks whether an event with the exact same title already exists. If so, it skips — this is how re-running the sync repeatedly doesn't create duplicate copies.

4. **Creates the event.** If it's a new, address-matching booking, it creates an event on the business calendar named `[Chris Connelly] <original event title>`, with the same start time, end time, and location. The description records that it was synced, plus the original event's ID from Chris's calendar (invisible bookkeeping — see the cancellation section below for why it's there).

5. **Logs the booking to the sheet.** (Live as of this update.) In that same "new booking" moment, it also appends one row to the `bookings` tab of the dashboard's Google Sheet:
   - `Invitee Name`: `Chris Connelly`
   - `Invitee Email`: `chris@chrisconnellyphotography.com` (his calendar ID doubles as his real email, so this is populated — not blank — which also makes the dashboard's existing "Regular" badge work automatically, since that's computed from repeat emails)
   - `Event Type`: `4 Hour - Studio Rental` (all his sessions are 4-hour bookings)
   - `Event Date`: the event's start time
   - `Date Called`: `N/A` — this is what keeps the row out of the dashboard's "needs vetting call" section, using the same truthy-check the dashboard already relies on
   - `Total Paid`: `150` — Chris pre-pays a flat $150 rate, so this is filled in automatically at sync time rather than waiting for staff to close the booking out manually
   - `Booking Status`: `Upcoming`
   - `Notes`: an auto-generated note explaining it's synced with limited data, plus the original calendar event title for staff context
   - Everything else (phone, deposit amount, payment terms, intake question answers, etc.) is left blank — there's no data for these since Chris doesn't go through the Calendly form.

   The row is only written the first time a booking is found (inside the same "not already synced" check as the calendar event), so re-running the sync doesn't create duplicate rows.

   Columns are matched **by header name**, not by position — the script reads the sheet's actual header row at runtime and writes each value under the matching column name. If you ever reorder columns on the sheet, this won't silently write values into the wrong place.

   **Special-cased dashboard behavior for Chris:** normally, a booking with `Total Paid` set is considered "completed" and disappears from the dashboard immediately (`Code.js` in the main `CentralStudio_SM` project, both the "Needs a Call" and "Vetted Upcoming Rentals" sections). Since Chris's rows get `Total Paid` filled in right at sync time — before the rental has even happened — that default behavior was changed specifically for his email address (`CHRIS_AUTO_SYNC_EMAIL` in `CentralStudio_SM/Code.js`): his rows stay visible in "Vetted Upcoming Rentals" until the event's start time passes, then they drop off automatically, same as they would if staff had manually left them uncompleted and let the date pass. This is Chris-only — every other customer's bookings still disappear the instant `Total Paid` is set, unchanged.

6. **Checks for cancellations, once an hour.** (Live as of this update — separate function, `checkForCancellations`, on its own hourly trigger.) His cancellation policy: cancel 72+ hours before the session and it's really cancelled; cancel with less notice than that and he's still billed. So every hour, for each upcoming synced booking:
   - If the session has already happened → never touched, no matter what.
   - If it's still findable anywhere on his calendar (even if he moved it to a different time — this is checked across the whole lookahead window, not just its original slot, so a *reschedule* isn't mistaken for a *cancellation*) → left alone.
   - If it's genuinely gone from his calendar but the session is **less than 72 hours away** → left alone on purpose. He's inside the no-cancellation window, so he's still billed, and the business calendar entry + sheet row need to stay as the record of that.
   - If it's gone **72+ hours before the session** → treated as a real, in-policy cancellation: the business calendar event is deleted, and the matching sheet row is deleted.

   This only works for bookings synced *after* this update — the "Source Event ID" stamped in the calendar description (step 4) is what makes the check possible. Anything synced before this existed has no ID to check against, so it's safely left alone rather than guessed at.

## What it does *not* do

- **No error alerts.** If something fails partway (e.g. a permissions issue, a calendar or sheet becoming inaccessible), the script just fails — nobody gets notified.
- **No partial-refund or notification logic.** The cancellation check only adds/removes records — it doesn't message Chris, adjust `Total Paid`, or handle a scenario where he's owed a partial refund. That's still a manual, human decision.

## Constraints to keep in mind

| Constraint | Why it matters |
|---|---|
| **Location must contain "1095"** | If Chris ever books without putting the studio address in the Location field, that event is silently skipped — no error, no sign anything was missed. Easy to miss unless you're specifically checking. |
| **6-month look-ahead window** | A booking made for 7+ months out won't be picked up until a later run brings it inside the 6-month window. Not usually an issue since the script presumably reruns on a schedule, but worth knowing if someone books far in advance. |
| **Duplicate check is by exact title match at the same time** | If the event's title changes between syncs (Chris renames it), the old copy won't be recognized as "the same" event and a second, duplicate copy could get created. |
| **One-directional, create-only** | Business calendar → nothing flows back to Chris's calendar. Business calendar entries are never edited or deleted by this script once created — only added. |
| **Run schedule isn't visible in the code** | How often this runs (hourly? daily?) is set as a time-based trigger inside the Apps Script project itself, not in the code we can see here. Worth checking in the Apps Script editor (Triggers tab) before relying on timing assumptions. |
| **First run after this update needs re-authorization** | The script now touches Google Sheets in addition to Calendar, so the next time it runs it will likely need you to re-approve its permissions in the Apps Script editor. |
| **`Event Type` is hardcoded to "4 Hour - Studio Rental"** | If Chris ever books a session that isn't 4 hours, the sheet row will still say "4 Hour - Studio Rental" — the actual event title is preserved in the Notes field, but not reflected in Event Type. |
| **`Total Paid` is hardcoded to $150** | If Chris's rate ever changes, or a particular booking is priced differently, the sheet row will still auto-log $150 — nothing here reads an actual price from the calendar event, since none is available. |
| **Auto-drop-off is timestamp-based, not midnight-based** | Chris's rows disappear from "Vetted Upcoming Rentals" once the event's exact start time passes, not at midnight on the event's day. If he has a booking starting at 6pm, it'll still show as upcoming earlier that same day. |
| **Cancellation detection needs the Source Event ID** | Only bookings synced after this update carry that ID. Anything synced before it (including everything from the June–Dec 2026 backfill) can't be auto-cancelled — deleting those, if needed, is still a manual job. |
| **72-hour cutoff is measured from when the hourly check runs, not the exact deletion moment** | Apps Script doesn't expose an exact "deleted at" timestamp, only "does it currently exist." Running hourly keeps this gap small, but in principle a cancellation made 72 hours and 5 minutes out could, in the worst case, not get caught until under an hour of notice remains — by which point the policy correctly treats it as too late to waive. |
| **Sheet row deletion is permanent** | A genuine 72+ hour cancellation deletes that row from the sheet outright — there's no "cancelled" record left behind, unlike how normal Calendly cancellations are handled (marked via Booking Status, not removed). |
