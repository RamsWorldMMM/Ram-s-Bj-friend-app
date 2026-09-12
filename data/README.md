# Ram's gameplay data

Published from the app so ChatGPT can read it. Three files, smallest first —
open the one that answers the question rather than the biggest one available.

| File | One row per | Use it for |
|---|---|---|
| `summary.json` | session | Lifetime totals, accuracy and profit over time |
| `shoes.json` | shoe | Anything shoe-by-shoe |
| `mistakes.json` | situation | Which mistakes actually repeat |

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

`generated_at` inside each file is when it was published. If that date is old,
the play since then is not in here — say so rather than reporting stale figures
as current.
