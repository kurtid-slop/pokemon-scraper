const puppeteer = require("puppeteer-extra");
const fs = require("fs");
const csv = require("csv-parser");

const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ======================================================
// Ad / tracker blocking
// ======================================================
//
// Bulbapedia pages pull in a heavy stack of ad and tracking
// iframes (AdThrive, DoubleClick, PubMatic, Google's video ad
// SDK, ...) that add a lot of load time but are irrelevant to
// the infobox data we're scraping. Aborting requests to these
// hosts, plus images/media/fonts, cuts page weight down a lot.

const BLOCKED_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "googleadservices.com",
  "adthrive.com",
  "imasdk.googleapis.com",
  "pubmatic.com",
  "amazon-adsystem.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "adnxs.com",
  "rubiconproject.com",
  "casalemedia.com",
  "openx.net",
  "indexww.com",
  "smartadserver.com",
  "moatads.com",
  "scorecardresearch.com",
  "quantserve.com",
  "connect.facebook.net",
  "facebook.com",
  "hotjar.com",
  "adsrvr.org",
  "bidswitch.net",
  "contextweb.com",
  "yieldmo.com",
  "sharethrough.com",
  "sovrn.com",
  "gumgum.com",
  "media.net",
  "33across.com",
  "adform.net",
  "adroll.com",
  "bluekai.com",
  "demdex.net",
  "everesttech.net",
  "mathtag.com",
  "rlcdn.com",
  "tapad.com",
];

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

function shouldBlockRequest(request) {
  if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
    return true;
  }

  let hostname = "";

  try {
    hostname = new URL(request.url()).hostname;
  } catch (error) {
    return false;
  }

  return BLOCKED_HOSTS.some((host) => hostname.includes(host));
}

// ======================================================
// Read Pokemon CSV
// ======================================================

function readPokemonCSV(filename) {
  return new Promise((resolve, reject) => {
    const pokemon = [];

    fs.createReadStream(filename)
      .pipe(
        csv({
          mapHeaders: ({ header }) =>
            header
              .replace(/^\uFEFF/, "")
              .trim()
              .toLowerCase(),
        }),
      )
      .on("data", (row) => {
        pokemon.push(row);
      })
      .on("end", () => {
        resolve(pokemon);
      })
      .on("error", reject);
  });
}

// ======================================================
// Name normalizer for resume/dedupe checks
// ======================================================
//
// The CSV name and the scraped page's canonical name don't
// always match exactly (e.g. CSV "Farfetchd" vs the page's
// real "Farfetch'd") even though they're the same Pokemon.
// Comparing exact strings for the resume/dedupe check let
// those slip through, causing the same Pokemon to be re-
// scraped (and re-appended) on every run. Compare normalized
// names instead.

function normalizeName(name) {
  if (!name) {
    return "";
  }

  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    // Map gender symbols to letters instead of stripping them -
    // Nidoran♀ and Nidoran♂ are different Pokemon, but stripping
    // ♀/♂ like other punctuation collapses them to the same
    // "nidoran" key, making the resume/dedupe logic think one is
    // already done once the other succeeds and skip it forever.
    .replace(/♀/g, "f")
    .replace(/♂/g, "m")
    .replace(/[^a-z0-9]/g, ""); // strip spaces, apostrophes, hyphens, etc.
}

// ======================================================
// Main
// ======================================================

(async () => {
  let browser;

  try {
    console.log("Launching browser...");

    browser = await puppeteer.launch({
      headless: false,
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1280,
      height: 800,
    });

    // Block ad/tracker requests and images/media/fonts to cut
    // page weight down.

    await page.setRequestInterception(true);

    page.on("request", (request) => {
      if (shouldBlockRequest(request)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log("Browser launched.");

    // ==================================================
    // Read CSV
    // ==================================================

    const pokemonList = await readPokemonCSV("Pokemon - Pokedex.csv");

    console.log(`Found ${pokemonList.length} Pokemon in CSV`);

    // ==================================================
    // SCRAPE EVERY POKEMON IN THE CSV
    // ==================================================
    //
    // Resume from wherever a previous run left off: anything
    // already saved in pokemon-data.json is loaded back in and
    // skipped, instead of re-scraping the whole CSV every time.

    let allData = [];

    if (fs.existsSync("pokemon-data.json")) {
      try {
        allData = JSON.parse(fs.readFileSync("pokemon-data.json", "utf8"));

        console.log(
          `Resuming: ${allData.length} Pokemon already scraped in pokemon-data.json.`,
        );
      } catch (error) {
        console.log(
          "WARNING: could not parse existing pokemon-data.json, starting fresh.",
        );

        allData = [];
      }
    }

    const scrapedNames = new Set(
      allData.map((entry) => normalizeName(entry.name)),
    );

    const remaining = pokemonList.filter(
      (pokemon) =>
        pokemon.name && !scrapedNames.has(normalizeName(pokemon.name)),
    ).length;

    console.log(`${remaining} Pokemon left to scrape.`);

    const failures = [];

    for (let i = 0; i < pokemonList.length; i++) {
      const pokemon = pokemonList[i];

      if (!pokemon.name) {
        console.log("ERROR: Pokemon name not found.");

        console.log(pokemon);

        continue;
      }

      const name = pokemon.name.trim();

      if (scrapedNames.has(normalizeName(name))) {
        continue;
      }

      // ==================================================
      // Create URL
      // ==================================================

      const encodedName = encodeURIComponent(name);

      const url =
        `https://bulbapedia.bulbagarden.net/wiki/` + `${encodedName}_(Pokémon)`;

      console.log(
        `\n[${i + 1}/${pokemonList.length}] ${name} -> ${url}`,
      );

      try {
        // ==================================================
        // Navigate
        // ==================================================

        await page.goto(url, {
          waitUntil: "domcontentloaded",

          timeout: 60000,
        });

        // Give the page a moment to finish rendering

        await new Promise((resolve) => setTimeout(resolve, 2000));

        // ==================================================
        // Sanity check: infobox present
        // ==================================================

        const infoboxExists = await page.$(".infobox");

        if (!infoboxExists) {
          console.log(`  WARNING: no infobox found for ${name}, skipping.`);

          failures.push({ name, url, reason: "No infobox found" });

          continue;
        }

        // ==================================================
        // Extract basic information
        // ==================================================

        const data = await page.evaluate(() => {
        // ==================================================
        // Helper
        // ==================================================

        function clean(text) {
          if (!text) {
            return "";
          }

          return text.replace(/\s+/g, " ").trim();
        }

        /*
         * Collect an article section's content nodes: everything
         * after the given heading (matched by its "id") up to the
         * next H2/H3 section boundary. Used to scope extraction
         * to e.g. the real "Forms" or "Evolution" section instead
         * of searching the whole page, which risks matching an
         * unrelated paragraph elsewhere that happens to mention
         * similar wording.
         */

        function getSectionNodes(headingId) {
          const headline = document.querySelector(
            `.mw-headline[id="${headingId}"]`,
          );

          if (!headline) {
            return [];
          }

          const heading = headline.closest("h1, h2, h3, h4, h5, h6");

          if (!heading) {
            return [];
          }

          const nodes = [];

          let node = heading.nextElementSibling;

          while (node && node.tagName !== "H2" && node.tagName !== "H3") {
            nodes.push(node);

            node = node.nextElementSibling;
          }

          return nodes;
        }

        // ==================================================
        // INFOBOX
        // ==================================================

        const infobox = document.querySelector(".infobox");

        // ==================================================
        // Generic infobox value finder
        // ==================================================

        function getInfoboxValue(label) {
          if (!infobox) {
            return "";
          }

          const rows = infobox.querySelectorAll("tr");

          for (const row of rows) {
            const labelCell = row.querySelector(":scope > th");

            if (!labelCell) {
              continue;
            }

            const rowLabel = clean(labelCell.innerText);

            if (rowLabel.toLowerCase().includes(label.toLowerCase())) {
              const valueCell = row.querySelector(":scope > td");

              if (valueCell) {
                return clean(valueCell.innerText);
              }
            }
          }

          return "";
        }

        // ==================================================
        // POKEMON NAME
        // ==================================================

        let pokemonName =
          document.querySelector("#firstHeading")?.innerText || "";

        pokemonName = clean(pokemonName).replace(/\s*\(Pokémon\)/i, "");

        // ==================================================
        // PRIMARY / SECONDARY TYPE
        // ==================================================

        let types = [];

        const validTypes = [
          "Normal",
          "Fire",
          "Water",
          "Electric",
          "Grass",
          "Ice",
          "Fighting",
          "Poison",
          "Ground",
          "Flying",
          "Psychic",
          "Bug",
          "Rock",
          "Ghost",
          "Dragon",
          "Dark",
          "Steel",
          "Fairy",
        ];

        if (infobox) {
          const links = infobox.querySelectorAll("a");

          for (const link of links) {
            const text = clean(link.innerText);

            if (validTypes.includes(text) && !types.includes(text)) {
              types.push(text);
            }
          }
        }

        const primaryType = types[0] || "";

        const secondaryType = types[1] || "";

        // ==================================================
        // ALL FORMS
        // ==================================================

        let forms = [];

        /*
         * Every Pokemon with alternate forms gets a "Forms"
         * section (H3, id="Forms") in the article body. How
         * that section is laid out depends on how many named
         * forms there are:
         *
         *  - Two or more named forms (Mega, Gigantamax, multiple
         *    regional forms, Formes, Styles, Cloaks, ...) get
         *    one H4 subheading per form, e.g. Venusaur ->
         *    "Mega Venusaur", "Gigantamax Venusaur".
         *
         *  - Exactly one alternate form (most single regional
         *    forms, Primal Reversion, ...) usually gets no H4 -
         *    the form is only named in the section's opening
         *    paragraph, e.g. "Rattata has a regional form:
         *    Alolan Rattata." or "Groudon can undergo Primal
         *    Reversion and become Primal Groudon."
         *
         * Handle both: collect H4s first, and only if none are
         * found, fall back to parsing the opening paragraph(s).
         *
         * Note: a handful of Pokemon (e.g. Arceus, whose 18
         * Plate-based forms are only shown as a type-icon table)
         * don't name their forms in prose at all, so this will
         * still come back empty for those.
         */

        const formsSectionNodes = getSectionNodes("Forms");

        // Primary: named H4 subsections.

        for (const sectionNode of formsSectionNodes) {
          if (sectionNode.tagName !== "H4") {
            continue;
          }

          const headline = sectionNode.querySelector(".mw-headline");

          const formName = clean(
            headline ? headline.innerText : sectionNode.innerText,
          );

          if (formName && !forms.includes(formName)) {
            forms.push(formName);
          }
        }

        // Fallback: parse the opening paragraph(s) for Pokemon
        // with only one alternate form (no H4s).

        if (forms.length === 0) {
          const paragraphText = formsSectionNodes
            .filter((sectionNode) => sectionNode.tagName === "P")
            .map((sectionNode) => clean(sectionNode.innerText))
            .join(" ");

          const listMatch = paragraphText.match(/forms?:\s*(.+?)\./i);

          const becomeMatch = paragraphText.match(
            /\b(?:become|Mega Evolve into|Gigantamax into)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)/,
          );

          const rawList = listMatch
            ? listMatch[1]
            : becomeMatch
              ? becomeMatch[1]
              : "";

          if (rawList) {
            const candidates = rawList
              .split(/,| and /i)
              .map((candidate) => clean(candidate))
              .filter(Boolean);

            for (const candidate of candidates) {
              if (!forms.includes(candidate)) {
                forms.push(candidate);
              }
            }
          }
        }

        // Remove the Pokemon's normal name
        forms = forms.filter((form) => form !== pokemonName);

        // ==================================================
        // WEIGHT
        // ==================================================

        let weight = "";

        const elements = document.querySelectorAll("*");

        for (const element of elements) {
          /*
           * Only look at elements that contain
           * text directly rather than containers.
           */

          if (element.children.length !== 0) {
            continue;
          }

          const text = clean(element.innerText);

          if (text.includes("lbs.")) {
            weight = text;
            break;
          }
        }

        // ==================================================
        // GENDER RATIO
        // ==================================================

        let genderRatio = "";

        /*
         * Same method as EGG GROUPS above: find the label link
         * by its title, walk up to the label's own TD, then read
         * the value table nested inside that TD.
         *
         * The previous approach read the title attribute of the
         * category link (e.g. "seven males to one female")
         * instead of the displayed percentages, and picking the
         * "last cell" of the row would risk grabbing the hidden
         * "Unknown" cell that sits alongside the real value.
         */

        const genderElement = document.querySelector(
          '[title="List of Pokémon by gender ratio"]',
        );

        if (genderElement) {
          const labelCell = genderElement.closest("td");

          if (labelCell) {
            const valueTable = labelCell.querySelector("table");

            if (valueTable) {
              genderRatio = clean(valueTable.innerText);
            }
          }
        }

        // ==================================================
        // CATCH RATE
        // ==================================================

        let catchRate = "";

        const catchRateElement = document.querySelector('[title="Catch rate"]');

        if (catchRateElement) {
          const row = catchRateElement.closest("tr");

          if (row) {
            const cells = row.querySelectorAll("th, td");

            if (cells.length >= 2) {
              catchRate = clean(cells[cells.length - 1].innerText);
            }
          }
        }

        // ==================================================
        // HATCH TIME / EGG CYCLE
        // ==================================================

        let hatchTime = "";

        const eggCycleElement = document.querySelector('[title="Egg cycle"]');

        if (eggCycleElement) {
          const row = eggCycleElement.closest("tr");

          if (row) {
            const cells = row.querySelectorAll("th, td");

            if (cells.length >= 2) {
              hatchTime = clean(cells[cells.length - 1].innerText);
            }
          }
        }

        // ==================================================
        // EGG GROUPS
        // ==================================================

        let eggGroups = "";

        /*
         * Find the "Egg Groups" header link.
         *
         * Note: the link's title attribute is "Egg Group"
         * (singular) even though the visible label reads
         * "Egg Groups".
         *
         * Egg Groups and Hatch Time live side-by-side as two
         * TDs inside the same TR of a nested sub-table, each
         * containing its own nested value table. Walking up to
         * the row and grabbing the last cell (as other fields
         * on this page do) would actually return the Hatch Time
         * value here, since it comes last in document order.
         * Instead, walk up only to the label's own TD and read
         * the value table nested inside that TD.
         *
         * A handful of Pokemon (e.g. Greninja, whose Ash-Greninja
         * form can't breed) have a footnote-style <sup> link
         * butted directly against the text with no space, e.g.
         * "...No Eggs Discovered<sup>Ash-Greninja</sup>". Left in
         * place, innerText concatenates it straight onto the
         * value ("No Eggs DiscoveredAsh-Greninja"). Strip <sup>
         * footnotes out of a clone before reading the text.
         */

        const eggGroupElement = document.querySelector('[title="Egg Group"]');

        if (eggGroupElement) {
          const labelCell = eggGroupElement.closest("td");

          if (labelCell) {
            const valueTable = labelCell.querySelector("table");

            if (valueTable) {
              const valueTableClone = valueTable.cloneNode(true);

              valueTableClone
                .querySelectorAll("sup")
                .forEach((sup) => sup.remove());

              eggGroups = clean(valueTableClone.innerText);
            }
          }
        }

        // ==================================================
        // HEIGHT
        // ==================================================

        let height = "";

        /*
         * The "Height" label's title attribute is unreliable —
         * on most pages it links to "List of Pokémon by height"
         * (title="List of Pokémon by height") rather than
         * title="Height", so matching on title alone misses it.
         *
         * The Height/Weight cell also holds a nested table with
         * hidden rows for the Pokémon's other forms, so walking
         * up to the row and grabbing the last cell (like other
         * fields on this page do) would risk pulling a hidden
         * alt-form's value instead.
         *
         * Mirror the WEIGHT approach above instead: scan leaf
         * elements for the imperial height format (e.g. 2'04"),
         * taking the first match, since the real value always
         * appears in the DOM before the hidden alt-form rows.
         *
         * Some pages typeset the feet/inches marks as Unicode
         * prime characters (′ ″) instead of plain quotes, and not
         * even consistently within one value (e.g. "1′08\""). A
         * straight-quotes-only pattern misses these, which used
         * to make the scan fall through to a hidden alt-form's
         * placeholder "0'0\"" instead - accept either character
         * for each mark, and normalize the match to plain quotes.
         */

        const heightPattern = /^\d+['′]\d+["″]$/;

        for (const element of elements) {
          if (element.children.length !== 0) {
            continue;
          }

          const text = clean(element.innerText);

          if (heightPattern.test(text)) {
            height = text.replace(/['′]/g, "'").replace(/["″]/g, '"');
            break;
          }
        }

        // ==================================================
        // EVOLUTION
        // ==================================================

        let evolutionStage = "";
        let preEvolvePokemon = "";

        /*
         * Scope strictly to the real "Evolution" section (H3,
         * id="Evolution") instead of scanning the whole page for
         * any paragraph that happens to mention "evolve" - other
         * sections (Pokemon GO notes, trivia, anime appearances,
         * ...) often do too, and matching the wrong paragraph
         * there used to produce garbage pre-evolutions. E.g.
         * Melmetal's used to come back as "Pokemon GO", pulled
         * from an unrelated "In Pokemon GO, it evolves from
         * Meltan" sentence describing a different game section
         * entirely, elsewhere on the page.
         *
         * Within the real section, only accept links to genuine
         * Pokemon species pages (title ending in " (Pokémon)") as
         * a pre-evolution candidate. The previous "take the first
         * link in the sentence" approach also grabbed non-species
         * links that precede the actual species link, e.g.
         * Sirfetch'd's "evolves from Galarian Farfetch'd" links
         * "Galarian" to the general regional-form concept page
         * before linking "Farfetch'd" to its species page, and
         * the old code came back with "Galarian" instead.
         *
         * The word "evolves" itself is sometimes a link to the
         * general /wiki/Evolution concept page (title="Evolution")
         * and sometimes plain text - inconsistent across Pokemon
         * pages. A literal "evolves from" string match misses the
         * linked case (there's a closing </a> between the two
         * words), which previously made the search skip past the
         * real sentence into a later, unrelated one. E.g. Graveler
         * has "Graveler <a>evolves</a> from <a>Geodude</a>..." for
         * its own evolution, but also an unlinked "It evolves from
         * Alolan Geodude..." sentence about its regional form
         * further down - missing the first match meant landing on
         * the second, which has no link to pull a name from at all.
         * Allow an optional closing tag between "evolves" and
         * "from"/"into" so the real (usually earlier, usually
         * linked) sentence is found first.
         */

        const FROM_PATTERN = /evolves\s*(?:<\/[a-z0-9]+>)?\s*from/i;

        // Tolerate "intro" too - a genuine typo on at least one
        // real Bulbapedia page (Nuzleaf's: "evolves intro
        // Shiftry"), not something a formatting fix can work
        // around.

        const INTO_PATTERN = /evolves\s*(?:<\/[a-z0-9]+>)?\s*intr?o/i;

        function findPreEvolutionName(html) {
          const keywordMatch = html.match(FROM_PATTERN);

          if (!keywordMatch) {
            return "";
          }

          // Only look shortly after the keyword, not the rest of
          // the section - a fixed window rather than "until the
          // next period", since Pokemon names/abbreviations that
          // contain a period themselves (e.g. "Mime Jr.", inside
          // the very title="Mime Jr. (Pokémon)" attribute this is
          // meant to find) would otherwise cut the window short
          // before reaching the closing "(Pokémon)" it needs.

          let remaining = html
            .slice(keywordMatch.index + keywordMatch[0].length)
            .slice(0, 200)
            .replace(/^\s+/, "");

          /*
           * Walk past any leading non-species link (e.g. Sirfetch'd's
           * "evolves from Galarian Farfetch'd" links "Galarian" to
           * the general regional-form concept page before linking
           * "Farfetch'd" to its actual species page) to find the
           * real species link, if there is one immediately here.
           */

          for (let hop = 0; hop < 5; hop++) {
            const linkMatch = remaining.match(
              /^<a\s[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/,
            );

            if (!linkMatch) {
              break;
            }

            const speciesMatch = linkMatch[1].match(/^(.+?)\s*\(Pokémon\)$/);

            if (speciesMatch) {
              return speciesMatch[1];
            }

            remaining = remaining
              .slice(linkMatch[0].length)
              .replace(/^\s+/, "");
          }

          /*
           * No linked species name immediately here. Bulbapedia
           * sometimes leaves the pre-evolution as plain, unlinked
           * text if it was already linked earlier on the same page
           * (e.g. Wyrdeer: "Wyrdeer evolves from Stantler." with no
           * link at all; Kleavor: "Kleavor evolves from Scyther. It
           * is one of Scyther's final forms, the other being
           * <a>Scizor</a>." - the *real* pre-evolution isn't linked,
           * but a different, wrong species a few words later is).
           * Take only the leading capitalized word as the name
           * rather than scanning ahead for any link, precisely to
           * avoid latching onto an unrelated one like that.
           */

          const textMatch = remaining.match(/^([A-Z][a-zA-Z'ʼ♀♂-]*)/);

          return textMatch ? textMatch[1] : "";
        }

        const evolutionParagraphs = getSectionNodes("Evolution").filter(
          (node) => node.tagName === "P",
        );

        const evolutionHTML = evolutionParagraphs
          .map((paragraph) => paragraph.innerHTML)
          .join(" ");

        const hasFrom = FROM_PATTERN.test(evolutionHTML);

        const hasInto = INTO_PATTERN.test(evolutionHTML);

        if (hasFrom) {
          preEvolvePokemon = findPreEvolutionName(evolutionHTML);
        }

        if (hasFrom && hasInto) {
          evolutionStage = "2";
        } else if (hasInto) {
          evolutionStage = "1";
        } else if (hasFrom) {
          evolutionStage = "final";
        }

        // ==================================================
        // NOT KNOWN TO EVOLVE
        // ==================================================

        if (!evolutionStage) {
          evolutionStage = "1";
        }

        // ==================================================
        // RETURN
        // ==================================================

        return {
          name: pokemonName,

          primaryType: primaryType,

          secondaryType: secondaryType,

          forms: forms,

          evolutionStage: evolutionStage,

          preEvolvePokemon: preEvolvePokemon,

          eggGroups: eggGroups,

          height: height,

          weight: weight,

          genderRatio: genderRatio,

          catchRate: catchRate,

          hatchTime: hatchTime,
        };
      });

        console.log(`  OK: ${JSON.stringify(data)}`);

        allData.push(data);

        // Track it immediately so a duplicate CSV row for the
        // same Pokemon (e.g. Enamorus has separate Incarnate/
        // Therian Form rows that both resolve to the same page)
        // gets skipped within this same run too, not just on a
        // future resume.

        scrapedNames.add(normalizeName(data.name));

        // ==================================================
        // Save progress after every Pokemon
        // ==================================================
        //
        // Written incrementally (not just once at the end) so
        // that a crash or interruption partway through this
        // ~1000+ page run doesn't lose everything scraped so far.

        fs.writeFileSync(
          "pokemon-data.json",
          JSON.stringify(allData, null, 2),
        );
      } catch (error) {
        console.log(`  ERROR scraping ${name}: ${error.message}`);

        failures.push({ name, url, reason: error.message });
      }
    }

    // ==================================================
    // Summary
    // ==================================================

    console.log("\n==============================");

    console.log(
      `Done. Scraped ${allData.length}/${pokemonList.length} Pokemon.`,
    );

    console.log(`Saved to pokemon-data.json`);

    if (failures.length > 0) {
      console.log(`\n${failures.length} failure(s):`);

      for (const failure of failures) {
        console.log(`  - ${failure.name}: ${failure.reason}`);
      }

      fs.writeFileSync(
        "pokemon-failures.json",
        JSON.stringify(failures, null, 2),
      );
    }

    console.log("==============================\n");

    await browser.close();
  } catch (error) {
    console.error("\nFATAL ERROR:");

    console.error(error);

    if (browser) {
      console.log("Browser left open for debugging.");

      await new Promise(() => {});
    }
  }
})();
