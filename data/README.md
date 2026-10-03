# Ram's gameplay data

Published from the app so ChatGPT can read it. Three files, smallest first —
open the one that answers the question rather than the biggest one available.

| File | One row per | Use it for |
|---|---|---|
| `summary.json` | session | Lifetime totals, accuracy and profit over time |
| `shoes.json` | shoe | Anything shoe-by-shoe |
| `mistakes.json` | situation | Which mistakes actually repeat |
| `staking.json` | side-bet product | Whether varying the side-bet stakes helped |
| `reports.json` | session | One session in detail — hands, actions, boxes, streaks, every mistake |
| `deviations.json` | strategy departure | Every deviation, what was possible, and whether it changed the shoe |
| `rounds/index.json` | shoe | What raw shoe files exist and which are published |
| `rounds/<session>-shoe<n>.json` | round | The raw record of one shoe, in order |

`reports.json` is the session report that used to be copied out of the app and
pasted in by hand. It holds what only makes sense inside one session: the mix
of hands dealt and actions chosen, how each box did, the longest runs, and
every mistake written out separately. For totals across all sessions read
`summary.json`; this file deliberately does not aggregate.

`deviations.json` is the one to read about mistakes. For each departure from
basic strategy it records what was possible at that moment — the bankroll, and
whether Double or Split were affordable — and whether the choice changed the
order of the cards that followed. `shoe_effect` decides what can be said about
cost: `neutral` means the correct play would have used the same number of
cards, so the difference is exact arithmetic; `changed` means every later card
moved and the cost is permanently unknowable. Do not estimate one.

`rounds/` holds the raw chronological record, split one file per shoe — around
100 KB each, which reads whole. Start at `rounds/index.json` and open the shoe
you want. A shoe marked `published: false` has not been written yet, because
publishes are capped so one press cannot fire hundreds of commits; it is not
missing data.

`staking.json` answers one question: did varying the Pairs, Trilux and Trilux
Super stakes improve profit or reduce drawdown, against the same cards played
flat? The comparison is exact rather than simulated — a side bet is settled from
the dealt cards alone, before any decision and regardless of the stake, so the
same cards can be re-staked arithmetically. Compare against
`flat_at_same_average`, never against `flat_5` or `flat_10`: those lose less
simply because they are smaller bets.

**Read the `read_this_first` list inside each file before drawing conclusions.**
It states the things that are easy to get wrong, notably:

- A bankroll top-up is capital, not winnings. `session_pl` already excludes
  deposits, so it stays a true profit-and-loss figure.
- `played_to_cut_card: false` means the player stopped part-way through that
  shoe. It is a fragment and is **not** comparable with a completed shoe.
  Mistakes are far denser in fragments, and treating the two alike has already
  produced one false result.
- Side bets are settled the instant the cards are dealt, before any player
  decision, so nothing about how a hand was played can affect them.

When the files show zero sessions, no play has been published yet — that is an
empty record, not a record of losing. Say so rather than reporting the zeros
as results.

`generated_at` inside each file is when it was published. If that date is old,
the play since then is not in here — say so rather than reporting stale figures
as current.
