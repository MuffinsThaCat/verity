# Pages the demo reads, kept so it works without a network

These are the Wikipedia pages (one file per page, named by the sha256 of the text) and the searches that found them (`q/`), as
`npm run warm` fetched them for the four demo articles. Each page is a pinned revision: its `url` field is the exact
`index.php?title=…&oldid=…` address, and its `contentHash` is the sha256 of the raw wikitext that address serves, so anyone can
check a file with `curl | shasum -a 256`.

The text is from Wikipedia and is available under the Creative Commons Attribution-ShareAlike 4.0 licence
(https://creativecommons.org/licenses/by-sa/4.0/). The authors of each page are listed in its history, reachable from the
revision address in the file. The code in this repository is MIT; these pages are not.

On first use the demo copies this directory to `data/cache` if that is empty (see `src/lib/brain.ts`), so `npm run demo:offline`
works straight after `npm install && npm run build && npm run fetch-node`. `npm run warm` adds whatever else is needed.

This is a snapshot of the seed claims and lies in `seed/` as they were when it was made. If you change one, or add an article, run
`VERITY_CACHE_DIR=seed-cache npm run warm` online to add its pages here (nothing is removed), and commit the result. Run offline, the
demo prints which seed texts have no cached search, so a stale snapshot is visible at startup.
