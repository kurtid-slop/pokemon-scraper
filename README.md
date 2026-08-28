# Pokemon Scraper

Scrapes Pokemon data from Bulbapedia and converts it into a csv file.

## Requirements

- Node.js (v18+)
- Python 3

## Install

The Node dependencies are declared in `package.json` one level up (shared
with the rest of this repo), so run the install from the parent folder:

```bash
cd ..
npm install
```

This installs:

- `puppeteer` / `puppeteer-extra` / `puppeteer-extra-plugin-stealth` - browser automation used to scrape Bulbapedia
- `csv-parser` - reads `Pokemon - Pokedex.csv`

No extra install is needed for the Python side - `pokemon_json_to_csv_converter.py`
only uses the standard library.

## Usage

Run both commands from inside this `pokemon/` folder.

**1. Scrape Bulbapedia** (reads `Pokemon - Pokedex.csv`, writes `pokemon-data.json`):

```bash
node bulbapedia_scraper.js
```

Safe to stop and rerun - it resumes from whatever's already in
`pokemon-data.json` instead of starting over.

**2. Merge into one CSV** (reads `pokemon-data.json` + `Pokemon - Pokedex.csv`,
writes `pokemon-merged.csv`):

```bash
python3 pokemon_json_to_csv_converter.py
```

## Folder layout

- `Pokemon - Pokedex.csv` - source Pokedex data (stats, etc.)
- `pokemon-data.json` - scraped Bulbapedia data
- `pokemon-merged.csv` - final combined output
- `logs/` - past scraper run logs
- `backups/` - past `pokemon-data.json` snapshots
- `incomplete-csvs/` - past `Pokemon - Pokedex.csv` snapshots, from before corrections were applied
