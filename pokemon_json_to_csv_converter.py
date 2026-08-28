import csv
import json
import re
import unicodedata

# ======================================================
# Config
# ======================================================

SCRAPED_DATA_FILE = "pokemon-data.json"
POKEDEX_CSV_FILE = "Pokemon - Pokedex.csv"
OUTPUT_CSV_FILE = "pokemon-merged.csv"

# ======================================================
# Merge strategy
# ======================================================
#
# Both sources describe some of the same concepts (type,
# egg group, height/weight, evolution stage, gender). Per
# request, the freshly-scraped Bulbapedia value wins for
# anything overlapping; the Pokedex CSV's own stat/meta
# columns (which have no scraped equivalent) pass through
# untouched.

HEADER = [
    "#",
    "Name",
    "Primary Type",
    "Secondary Type",
    "Total",
    "HP",
    "Attack",
    "Defense",
    "Sp.Atk",
    "Sp.Def",
    "Speed",
    "Variant",
    "Generation",
    "Evolution Stage",
    "Category",
    "Pre-evolution",
    "Egg Group 1",
    "Egg Group 2",
    "Height (m)",
    "Weight (kg)",
    "Gender",
    "Catch Rate",
    "Catch Rate (%)",
    "Hatch Time",
    "Egg Obtainable",
    "Smash/Pass",
]

# The scraped "not obtainable" note lives inline in the hatch
# time text (e.g. "80 cycles Egg not obtainable"). Split it out
# into its own "Egg Obtainable" column instead.

EGG_NOT_OBTAINABLE_MARKER = "Egg not obtainable"

# The scraped catch rate comes back as e.g. "45 (11.9%)" - split
# into the raw 0-255 rate and its percentage.

CATCH_RATE_PATTERN = re.compile(r"^(\d+)\s*\((\d+(?:\.\d+)?)%\)$")

# The scraped gender ratio comes back as one of:
#   "87.5% male, 12.5% female"
#   "100% male"
#   "100% female"
#   "Gender unknown"          (genderless Pokemon)
# Split into a male chance, a female chance, and whether the
# Pokemon can be either gender at all.

GENDER_RATIO_BOTH_PATTERN = re.compile(
    r"^(\d+(?:\.\d+)?)% male, (\d+(?:\.\d+)?)% female$"
)
GENDER_RATIO_MALE_ONLY_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)% male$")
GENDER_RATIO_FEMALE_ONLY_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)% female$")

# Egg groups come back as one group ("Bug"), two joined by "and"
# ("Monster and Grass"), or - for a couple of Pokemon whose
# breeding eligibility depends on their form - two joined by "or"
# ("Water 1 or No Eggs Discovered"). Split on whichever connector
# is present into two columns.

EGG_GROUP_SEPARATORS = (" and ", " or ")

# The scraped height/weight are imperial (e.g. 2'04", 15.2 lbs.).
# Convert to metric, matching the 1-decimal-place precision the
# games themselves use (e.g. Bulbasaur is officially 0.7 m / 6.9
# kg - confirmed against the Pokedex CSV's own metric columns).

HEIGHT_PATTERN = re.compile(r"^(\d+)'(\d+)\"$")
METERS_PER_INCH = 0.0254  # exact, by definition

WEIGHT_PATTERN = re.compile(r"^([\d,]+(?:\.\d+)?) lbs\.$")
KG_PER_POUND = 0.45359237  # exact, by definition


def normalize_name(name):
    """
    Name normalizer used only for joining the two datasets -
    the Pokedex CSV has occasional formatting quirks (e.g.
    missing apostrophes/hyphens) that don't match the scraped
    page's official name exactly.
    """

    if not name:
        return ""

    # Strip accents
    name = unicodedata.normalize("NFD", name)
    name = "".join(
        char for char in name if unicodedata.category(char) != "Mn"
    )

    name = name.lower()

    # Map gender symbols to letters instead of stripping them -
    # Nidoran(f) and Nidoran(m) are different Pokemon, but
    # stripping the symbols like other punctuation would collapse
    # them to the same "nidoran" key and merge one into the other.
    name = name.replace("♀", "f").replace("♂", "m")

    # Strip spaces, apostrophes, hyphens, periods, etc.
    return re.sub(r"[^a-z0-9]", "", name)


def split_hatch_time(hatch_time):
    """
    Some Pokemon's hatch time comes back as e.g.
    "80 cycles Egg not obtainable" - split that into a clean
    "80 cycles" and a separate obtainable flag.
    """

    if not hatch_time:
        return "", ""

    if EGG_NOT_OBTAINABLE_MARKER in hatch_time:
        cleaned = hatch_time.replace(EGG_NOT_OBTAINABLE_MARKER, "").strip()

        return cleaned, "No"

    return hatch_time, "Yes"


def split_catch_rate(catch_rate):
    """
    The scraped catch rate comes back as e.g. "45 (11.9%)" -
    split that into the raw 0-255 rate and its percentage.
    """

    if not catch_rate:
        return "", ""

    match = CATCH_RATE_PATTERN.match(catch_rate)

    if not match:
        return catch_rate, ""

    raw_rate, percentage = match.groups()

    return raw_rate, f"{percentage}%"


def classify_gender(gender_ratio):
    """
    Collapse the scraped gender ratio down to one of:
    "Male", "Female", "Both", "Neither".
    """

    if not gender_ratio or gender_ratio == "Gender unknown":
        return "Neither"

    if GENDER_RATIO_BOTH_PATTERN.match(gender_ratio):
        return "Both"

    if GENDER_RATIO_MALE_ONLY_PATTERN.match(gender_ratio):
        return "Male"

    if GENDER_RATIO_FEMALE_ONLY_PATTERN.match(gender_ratio):
        return "Female"

    # Unrecognized format - leave it as-is for manual review
    # rather than guessing.
    return gender_ratio


def split_egg_groups(egg_groups):
    """
    Egg groups come back as one group ("Bug"), two joined by
    "and" ("Monster and Grass"), or - for a couple of Pokemon
    whose breeding eligibility depends on their form - two
    joined by "or" ("Water 1 or No Eggs Discovered"). Split
    into two columns on whichever connector is present.
    """

    if not egg_groups:
        return "", ""

    for separator in EGG_GROUP_SEPARATORS:
        if separator in egg_groups:
            group1, group2 = egg_groups.split(separator, 1)

            return group1.strip(), group2.strip()

    return egg_groups, ""


def height_to_metric(height):
    """
    Convert the scraped imperial height (e.g. 2'04") to metric
    meters, rounded to 1 decimal place - matching the precision
    the games themselves use.
    """

    match = HEIGHT_PATTERN.match(height)

    if not match:
        return ""

    feet, inches = (int(value) for value in match.groups())

    meters = (feet * 12 + inches) * METERS_PER_INCH

    return f"{meters:.1f}"


def weight_to_metric(weight):
    """
    Convert the scraped imperial weight (e.g. 15.2 lbs., or
    1,543.2 lbs. for heavier Pokemon) to metric kilograms,
    rounded to 1 decimal place.
    """

    match = WEIGHT_PATTERN.match(weight)

    if not match:
        return ""

    pounds = float(match.group(1).replace(",", ""))

    kg = pounds * KG_PER_POUND

    return f"{kg:.1f}"


def resolve_final_stage(name, stage_by_name, preevo_by_name, cache, _chain=None):
    """
    "Final" isn't a number. Resolve it to one by walking back
    through pre-evolutions: a Pokemon's numeric stage is its
    pre-evolution's numeric stage + 1 (e.g. Venusaur's "final"
    becomes Ivysaur's "2" + 1 = "3").

    Returns None if the chain can't be resolved (missing/broken
    pre-evolution link, or a cycle) rather than guessing.
    """

    if name in cache:
        return cache[name]

    stage = stage_by_name.get(name, "")
    result = None

    if stage.isdigit():
        result = int(stage)
    elif stage == "final":
        _chain = _chain or set()

        preevo_name = preevo_by_name.get(name, "")

        if preevo_name and preevo_name not in _chain:
            _chain.add(name)

            preevo_stage = resolve_final_stage(
                preevo_name, stage_by_name, preevo_by_name, cache, _chain
            )

            if preevo_stage is not None:
                result = preevo_stage + 1

    cache[name] = result

    return result


def read_pokedex_csv(filename):
    with open(filename, "r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)

        rows = [
            {key.strip(): value for key, value in row.items()}
            for row in reader
        ]

    return rows


def main():
    # ==================================================
    # Load scraped data
    # ==================================================

    with open(SCRAPED_DATA_FILE, "r", encoding="utf-8") as file:
        scraped_data = json.load(file)

    print(f"Loaded {len(scraped_data)} scraped Pokemon.")

    # ==================================================
    # Load Pokedex CSV and index it by normalized name
    # ==================================================

    pokedex_rows = read_pokedex_csv(POKEDEX_CSV_FILE)

    print(f"Loaded {len(pokedex_rows)} Pokedex CSV rows.")

    pokedex_by_name = {
        normalize_name(row["Name"]): row for row in pokedex_rows
    }

    # ==================================================
    # Resolve "final" evolution stages to numbers
    # ==================================================

    stage_by_name = {
        pokemon["name"]: pokemon["evolutionStage"] for pokemon in scraped_data
    }
    preevo_by_name = {
        pokemon["name"]: pokemon["preEvolvePokemon"] for pokemon in scraped_data
    }
    final_stage_cache = {}

    # ==================================================
    # Join + merge each scraped Pokemon with its Pokedex row
    # ==================================================

    output_rows = []

    unmatched = 0
    unresolved_final = 0

    for pokemon in scraped_data:
        pokedex_row = pokedex_by_name.get(normalize_name(pokemon["name"]))

        if pokedex_row is None:
            print(f'  WARNING: no Pokedex CSV match for "{pokemon["name"]}".')

            unmatched += 1
            pokedex_row = {}

        hatch_time, egg_obtainable = split_hatch_time(pokemon["hatchTime"])
        catch_rate, catch_rate_percent = split_catch_rate(pokemon["catchRate"])
        egg_group_1, egg_group_2 = split_egg_groups(pokemon["eggGroups"])
        gender = classify_gender(pokemon["genderRatio"])

        evolution_stage = pokemon["evolutionStage"]

        if evolution_stage == "final":
            resolved = resolve_final_stage(
                pokemon["name"], stage_by_name, preevo_by_name, final_stage_cache
            )

            if resolved is not None:
                evolution_stage = str(resolved)
            else:
                print(
                    f'  WARNING: could not resolve a numeric evolution stage '
                    f'for "{pokemon["name"]}" (final, but its pre-evolution '
                    f"chain is missing or broken) - leaving it as \"final\"."
                )

                unresolved_final += 1

        output_rows.append(
            [
                pokedex_row.get("#", ""),
                pokemon["name"],
                # Scraped data wins for overlapping concepts.
                pokemon["primaryType"],
                pokemon["secondaryType"],
                # Pokedex-only stat columns pass through untouched.
                pokedex_row.get("Total", ""),
                pokedex_row.get("HP", ""),
                pokedex_row.get("Attack", ""),
                pokedex_row.get("Defense", ""),
                pokedex_row.get("Sp.Atk", ""),
                pokedex_row.get("Sp.Def", ""),
                pokedex_row.get("Speed", ""),
                # The scraped alternate-forms list (Mega, Gigantamax,
                # regional forms, ...) is what "Variant" holds here,
                # in place of the Pokedex CSV's own Variant tag.
                "; ".join(pokemon["forms"]),
                pokedex_row.get("Generation", ""),
                evolution_stage,
                pokedex_row.get("Category", ""),
                pokemon["preEvolvePokemon"],
                egg_group_1,
                egg_group_2,
                height_to_metric(pokemon["height"]),
                weight_to_metric(pokemon["weight"]),
                gender,
                catch_rate,
                catch_rate_percent,
                hatch_time,
                egg_obtainable,
                pokedex_row.get("Smash/Pass", ""),
            ]
        )

    # ==================================================
    # Sort by Pokedex number
    # ==================================================
    #
    # Scraped order reflects whatever order the scraper visited
    # pages in across its (possibly several, resumed) runs, not
    # the Pokedex number. The "#" column is the first field in
    # each output row - sort on that, numerically. Anything
    # without a Pokedex match (blank "#") sorts to the end
    # rather than crashing on int().

    output_rows.sort(
        key=lambda row: int(row[0]) if row[0].isdigit() else float("inf")
    )

    # ==================================================
    # Write output
    # ==================================================

    with open(OUTPUT_CSV_FILE, "w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)

        writer.writerow(HEADER)
        writer.writerows(output_rows)

    print(
        f"\nWrote {len(scraped_data)} rows to {OUTPUT_CSV_FILE} "
        f"({unmatched} unmatched against the Pokedex CSV, "
        f"{unresolved_final} unresolved \"final\" stage(s))."
    )


if __name__ == "__main__":
    main()
