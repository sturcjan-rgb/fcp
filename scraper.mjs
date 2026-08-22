// FC Písek TV — scraper
//
// Co dělá:
// 1. Stáhne stránku 3. ČFL A na tvcom.cz (server-rendered HTML) pro aktuální
//    a (dle nastavení) minulé sezóny.
// 2. Vyfiltruje jen zápasy FC Písku (podle "Písek" v názvu týmu — v ČFL A
//    hraje jen A-tým "FC Písek", takže shoda na "Písek" je bezpečná;
//    mládežnické "Sršni Písek" apod. jsou v jiných soutěžích a do výběru se
//    nepletou).
// 3. U zápasů, které ještě nemáme vyřešené (bez embed GUID), stáhne detail
//    zápasu a vytáhne z něj:
//      - <iframe src="//embed.tvcom.cz/{GUID}/">  (video)
//      - číslo kola ("X. kolo") z titulku sdílení, jako "phase".
// 4. VÝSLEDEK SLOUČÍ s tím, co už v data/matches.json bylo — nikdy ho celý
//    nepřepisuje. Tvcom defaultně ukazuje jen aktuální sezónu, takže bez
//    sloučení by scraper při přechodu na novou sezónu tiše smazal historii
//    té předchozí. Každému zápasu navíc přiřadí "season" (např. "2025/2026"),
//    podle kterého web nabízí přepínač sezón.
//
// Spouští se přes GitHub Actions (viz .github/workflows/scrape.yml), žádný
// ruční krok. Lokálně jde spustit přes: node scraper.mjs
//
// Hloubka zpětného scanu se řídí proměnnou prostředí SEASONS_BACK
// (výchozí 1 = aktuální + minulá sezóna). Pro jednorázové doplnění starší
// historie stačí při ručním spuštění workflow zadat vyšší číslo do políčka
// "seasons_back" — jednou vyřešený embed se pak už jen znovupoužije.

import fs from "node:fs";
import * as cheerio from "cheerio";

const BASE = "https://www.tvcom.cz";
const TEAM_MARK = "Písek";
const LEAGUE_LABEL = "3. ČFL A"; // fallback pro "phase", než se dopočte kolo
const OUT_PATH = "data/matches.json";
const REQUEST_DELAY_MS = 500; // ať na tvcom zbytečně nebušíme

// Cesta k soutěži na tvcomu (fotbal, 3. ČFL A, skupina A).
const LEAGUE_PATH = "/Zapasy/Sport-Fotbal/Soutez-Fortuna-CFL-A";
// Odkazy na detail zápasu obsahují tenhle fragment.
const MATCH_PATH = "/Zapas/Sport-Fotbal/Soutez-Fortuna-CFL-A/";

// Kolik sezón zpět kromě aktuální procházet. Výchozí 1; přepsatelné přes env
// (workflow_dispatch input -> env SEASONS_BACK) pro hlubší jednorázový backfill.
const SEASONS_BACK = Math.max(0, parseInt(process.env.SEASONS_BACK ?? "1", 10) || 0);

function seasonSlug(now, seasonsBack) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  let startYear = m >= 7 ? y : y - 1; // fotbalová sezóna běží červenec -> červen
  startYear -= seasonsBack;
  return `${startYear}-${startYear + 1}`;
}

// Adresy aktuální + N minulých sezón, počítané dynamicky podle dnešního data
// (kód se nemusí každý rok ručně upravovat).
function buildLeagueUrls(now) {
  return Array.from({ length: SEASONS_BACK + 1 }, (_, back) =>
    `${BASE}${LEAGUE_PATH}/Sezona-${seasonSlug(now, back)}/`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; FCPisekTV-Scraper/1.0; +https://www.fcpisek.cz)",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} pro ${url}`);
  }
  return await res.text();
}

// "5. 5. 2026" -> "2025/2026" (fotbalová sezóna běží červenec-červen)
function computeSeason(dateStr) {
  const [day, month, year] = dateStr.split(".").map((s) => parseInt(s.trim(), 10));
  return month >= 7 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
}

function matchKey(m) {
  return `${m.date}|${m.time}|${m.home}|${m.away}`;
}

// Vyparsuje jeden <a href="/Zapas/Sport-Fotbal/Soutez-Fortuna-CFL-A/...">
// odkaz z textu odkazu. Formát textu tak, jak ho tvcom vykresluje:
//   "video 16. 8.17:00 FC Písek - FK Loko Praha Fotbal 3. ČFL A"
//   "video 8. 8.10:15 Povltavská FA - FC Písek Fotbal 3. ČFL A"
//   "video 16. 8. 202517:00 FC Písek - FK Loko Praha Fotbal 3. ČFL A"  (s rokem)
// Rok se v textu objevuje jen mimo "aktuální" rok zobrazení, jinak ho
// dopočítáváme ze sezóny v URL (Sezona-2026-2027). Číslo kola v listingu
// není — dopočítá se až z detailu zápasu (getMatchDetail).
export function parseMatchAnchor(href, rawText) {
  if (!href || !href.includes(MATCH_PATH)) {
    return null;
  }

  let text = rawText.replace(/\s+/g, " ").trim();
  text = text.replace(/^video\s*/i, "");
  text = text.replace(/Studio\s+Fotbal/i, "");

  const dateMatch = text.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?(\d{1,2}:\d{2})\s*(.+)$/);
  if (!dateMatch) return null;
  const [, day, month, yearInText, time, restRaw] = dateMatch;

  // Nejdřív odřízneme koncovku " Fotbal 3. ČFL A".
  const leagueTail = restRaw.match(/^(.*?)\s*Fotbal\s*3\.\s*ČFL\s*A\s*$/);
  if (!leagueTail) return null;
  let teamsPart = leagueTail[1].trim();

  // Pozor: některé názvy týmů samy obsahují " - " (na tvcomu v ČFL A je to
  // jen "SK Slavia Praha - fotbal"). Aby vnitřní pomlčka nekolidovala
  // s oddělovačem soupeřů " - ", takové názvy dočasně přepíšeme na variantu
  // bez pomlčky, rozdělíme podle " - " a pak je vrátíme zpět.
  const HYPHEN_NAME_ALIASES = [
    ["SK Slavia Praha - fotbal", "SK Slavia Praha fotbal"],
  ];
  for (const [orig, alias] of HYPHEN_NAME_ALIASES) {
    teamsPart = teamsPart.split(orig).join(alias);
  }
  const dashIdx = teamsPart.indexOf(" - ");
  if (dashIdx === -1) return null;
  const restore = (s) => {
    for (const [orig, alias] of HYPHEN_NAME_ALIASES) s = s.split(alias).join(orig);
    return s.trim();
  };
  const home = restore(teamsPart.slice(0, dashIdx));
  const away = restore(teamsPart.slice(dashIdx + 3));

  if (!home.includes(TEAM_MARK) && !away.includes(TEAM_MARK)) return null;

  let year = yearInText;
  if (!year) {
    const seasonMatch = href.match(/Sezona-(\d{4})-(\d{4})/);
    if (seasonMatch) {
      const [, y1, y2] = seasonMatch;
      year = Number(month) >= 7 ? y1 : y2; // červenec-prosinec => první rok sezóny
    }
  }
  if (!year) return null;

  const idMatch = href.match(/\/(\d+)-[^/]+\.htm$/);
  if (!idMatch) return null;

  return {
    id: idMatch[1],
    url: href.startsWith("http") ? href : BASE + href,
    date: `${Number(day)}. ${Number(month)}. ${year}`,
    time,
    home,
    away,
    us: home.includes(TEAM_MARK) ? "home" : "away",
  };
}

async function getTeamMatches(leagueUrls) {
  const byId = new Map();

  for (const url of leagueUrls) {
    console.log(`  … prochází ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.warn(`  ! Sezónu se nepodařilo načíst (${url}): ${e.message}`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }
    const $ = cheerio.load(html);

    $(`a[href*="${MATCH_PATH}"]`).each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text();
      const parsed = parseMatchAnchor(href, text);
      if (parsed) byId.set(parsed.id, parsed);
    });

    await sleep(REQUEST_DELAY_MS);
  }

  return [...byId.values()];
}

// Z detailu zápasu vytáhne embed GUID videa a číslo kola.
// Kolo je jen v titulku sdílení, např. "... (3. ČFL A, 2. kolo)".
async function getMatchDetail(matchUrl) {
  const html = await fetchHtml(matchUrl);

  const embedMatch = html.match(/embed\.tvcom\.cz\/([a-f0-9-]{20,})\//i);
  const embed = embedMatch ? embedMatch[1] : null;

  // Kolo: hledáme "N. kolo" v titulku sdílení (bývá i URL-enkódované "%2c").
  let phase = null;
  const roundMatch = html.match(/(\d{1,2})\.?\s*kolo/i);
  if (roundMatch) phase = `${roundMatch[1]}. kolo`;

  return { embed, phase };
}

// Načte, co už v repu máme — napříč VŠEMI dosud viděnými sezónami.
function loadExisting() {
  const map = new Map();
  if (!fs.existsSync(OUT_PATH)) return map;
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    for (const m of prev) map.set(matchKey(m), m);
  } catch (e) {
    console.warn(`Nepodařilo se přečíst existující ${OUT_PATH}, začínám od nuly: ${e.message}`);
  }
  return map;
}

function toTimestamp(m) {
  const [d, mo, y] = m.date.split(".").map((s) => Number(s.trim()));
  const [hh, mm] = m.time.split(":").map(Number);
  return new Date(y, mo - 1, d, hh, mm).getTime();
}

async function main() {
  const now = new Date();
  const leagueUrls = buildLeagueUrls(now);
  console.log(`Stahuji rozpis 3. ČFL A (aktuální + ${SEASONS_BACK} zpět):`);
  const found = await getTeamMatches(leagueUrls);
  console.log(`Nalezeno ${found.length} zápasů FC Písku na tvcom.cz`);

  // Start: vše, co už máme uložené (klidně i z dřívějších sezón).
  const merged = loadExisting();
  console.log(`V repu už bylo ${merged.size} zápasů (napříč sezónami)`);

  for (const m of found) {
    const key = matchKey(m);
    const existing = merged.get(key);
    let embed = existing?.embed ?? null;
    // Kolo bereme z existujícího záznamu, pokud tam už je (a není to jen fallback).
    let phase = existing?.phase && existing.phase !== LEAGUE_LABEL ? existing.phase : null;

    // Detail stahujeme, jen když nám něco chybí (embed nebo kolo).
    if (!embed || !phase) {
      try {
        const detail = await getMatchDetail(m.url);
        embed = embed || detail.embed;
        phase = phase || detail.phase;
        await sleep(REQUEST_DELAY_MS);
      } catch (e) {
        console.warn(`  ! Nepodařilo se načíst detail (${m.url}): ${e.message}`);
      }
    }

    merged.set(key, {
      date: m.date,
      time: m.time,
      home: m.home,
      away: m.away,
      phase: phase || existing?.phase || LEAGUE_LABEL,
      us: m.us,
      season: computeSeason(m.date),
      ...(embed ? { embed } : {}),
    });
  }

  // Starším záznamům (z doby před zavedením "season") sezónu dopočítáme.
  for (const [key, m] of merged) {
    if (!m.season) merged.set(key, { ...m, season: computeSeason(m.date) });
  }

  const result = [...merged.values()].sort((a, b) => toTimestamp(b) - toTimestamp(a));

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");

  const withVideo = result.filter((m) => m.embed).length;
  const seasons = [...new Set(result.map((m) => m.season))].sort();
  console.log(`Uloženo ${OUT_PATH}: ${result.length} zápasů (sezóny: ${seasons.join(", ")}), ${withVideo} s videem.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Scraper selhal:", err);
    process.exit(1);
  });
}
