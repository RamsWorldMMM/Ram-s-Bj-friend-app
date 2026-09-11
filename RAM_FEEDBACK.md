# Ram's feedback

## ✍️ Ram — write here

Add anything below. Rough notes are fine, no formatting needed. Date it if you
can. Everything you write gets picked up and worked on, and moves into the
tracker further down once it is handled.

**To edit on GitHub:** open this file, click the **pencil icon** at the top
right, type, then click **Commit changes** at the bottom.

```
--------------------------------------------------------------------------
DATE:
WHAT HAPPENED / WHAT YOU WANT:


WHERE IN THE APP (screen, button, moment):


HOW BAD (blocking / annoying / nice to have):


--------------------------------------------------------------------------
DATE:
WHAT HAPPENED / WHAT YOU WANT:


WHERE IN THE APP (screen, button, moment):


HOW BAD (blocking / annoying / nice to have):


--------------------------------------------------------------------------
```

*(Nothing written above this line yet.)*

---

# Tracker — what has already been handled

Everything below is a record of requests Ram has already raised and what
happened to them. Ram does not need to edit this part.


Every request Ram has raised, what happened to it, and what is still open.
Newest first within each section. Update this file when an item moves.

Build at last update: **v1.4.6**

---

## Done

### Buttons jumped while playing, causing wrong taps
> "suddenly it is showing one card up there, then the Double button and all
> going a bit down and quickly coming up, so it is causing pressing wrong button"

Anything that appeared above the action buttons shoved them mid-decision, then
snapped back when it auto-hid. A tap already travelling toward **Hit** landed on
**Double**, which doubles the wager and ends the hand.

Measured on a 360px phone, identical hand, only the element toggled:

| What appeared above the buttons | Buttons moved |
|---|---|
| Blackjack strip (auto-hid after 2.6s) | 80px |
| "Shoe complete — reshuffle" banner | 220px |
| Restore-session banner | whole page |
| Header stat strip wrapping to two lines | 18px |

Everything transient now lives in one dock **below** the table and above the
Session analysis panel. The header reserves both lines so changing numbers
cannot resize it. **Zero button movement across 20 rounds.**

### Say what the cards made, in words
> "when they get same or any sequence, system should be able to simply show it
> there saying you got sequence but different colour"

A note under the table names the combination and why it fell short:
`Sequence · in order, but different suits`, `Same suit · all one suit, not in
order`, three of a kind, straight flush, Mini Royal, suited trips, and the pair
type (Perfect / Colour / Mixed). Driven by the engine's own classifiers, so it
can never disagree with what was paid.

### Show whether the side bets hit
Same note now says what each staked bet did. Winners on their own line with the
amount, losers collapsed onto one. Bets he did not stake never appear. Headed
**settled at deal**, because these are decided as the cards land — before any
button is pressed — so it does not read as a second payout at settlement.

### Announce a hit immediately
> "when Ram hits Trilux or something, you are not showing quickly there"

A floating banner names the win the moment it lands. 30:1 and better get a
louder gold **BIG HIT** treatment. It is `position: fixed` so it cannot move the
buttons, and `pointer-events: none` so it cannot swallow a tap meant for one.
Capped at two rows so it never covers the dealer's up-card.

### Increase capital mid-session
Adding funds shifts the whole baseline — start, bankroll, high, low, peak — not
just the balance. So **Session P/L and drawdown do not move**, and the AI's
reconciliation still balances. A naive top-up would have read as profit and
flagged a data-integrity error. Refuses mid-round. Deposits are recorded with
amount, round and timestamp.

### Shoe-by-shoe event log
The app never recorded which shoe a round belonged to. Shoe number, position
within the shoe, a **shoe-end marker** and a per-round timestamp are now
captured. The end marker matters most: without it a shoe cut short by quitting
looked identical to one played to the cut card, and that alone produced a false
analytical result.

### Strategy and ENHC corrections
Soft 18 / Soft 19 doubling, `A,A` vs 10, and the ENHC dealer-completion flow.
Covered by 32 assertions in the browser suite.

---

## Open — needs a decision

1. **§13 Accuracy display** — `4999/5000` still renders as `100.0%`. Rounding an
   imperfect score to 100% is wrong. Display string only.
2. **§14 Reconciliation verdict in the report** — computed deterministically now,
   but the report text still leaves the verdict to the model.
3. **§19 Exposure split** — one "largest wager" number covers three different
   concepts: largest initial main, largest hand exposure after doubles and
   splits, and largest round exposure.
4. **§20 Side-bet stake / return / ROI per product** — needs per-product stake
   tracking. Today only net P/L per product exists.
5. **§18 Report scopes** — Round / Shoe / Session / **Lifetime**. Lifetime is
   newly possible now that every session is retained.
6. **§12 Immediate feedback as a mode** — feedback always shows after an action;
   the brief wants it opt-in.
7. **§23b Shoe replay** — the initial shoe order is still not captured, so rounds
   cannot be replayed for counterfactuals. Cheap now, costlier with every
   session played.

---

## Known gaps

- **Offline play never reaches the server.** Rounds played signed out stay in
  that browser only, and signing in afterwards does not upload them. Reproduced:
  5 rounds signed out, then signed in, server still had 0 sessions. Needs an
  outbox that queues regardless of auth state, plus a merge rule.
- **Live mode is hidden.** Set `SHOW_MODE_SWITCH = true` in `public/live.js` to
  bring the Practice/Live switch back. Nothing else needs changing.
- **Vertex credential is an `authorized_user` key**, not a service account. It is
  a personal gcloud login and will expire, stopping the AI analysis.
- **The original deployment's data.** The app at
  `whackedout-media-pvt-ltd.workers.dev` returns 0 sessions where it held 50
  sessions and 6,331 rounds on 9 September, and the account login returns a
  different user id. Most likely the Worker is bound to a different database
  rather than the data being deleted. Needs `wrangler d1 list` on **that**
  account; D1 Time Travel can restore up to 30 days if not.

---

## Ground rules

- **The game engine is not modified.** `public/index.html` carries only three
  changes from the original, all approved by Ram. Verify any time with
  `diff rams_bj_friend_v1_4_1_speed_flow_cards_steppers-18.html public/index.html`
  — it must show exactly 9 hunks. Everything else is layered from outside it.
- **Every change must work signed out as well as signed in.** Ram plays on a
  phone at a live table with unreliable signal and does not always sign in.
- **Nothing transient may render above the action buttons.** That is what caused
  the mis-taps.
