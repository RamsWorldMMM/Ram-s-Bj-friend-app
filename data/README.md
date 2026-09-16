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

`reports.json` is the session report that used to be copied out of the app and
pasted in by hand. It holds what only makes sense inside one session: the mix
of hands dealt and actions chosen, how each box did, the longest runs, and
every mistake written out separately. For totals across all sessions read
`summary.json`; this file deliberately does not aggregate.

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
